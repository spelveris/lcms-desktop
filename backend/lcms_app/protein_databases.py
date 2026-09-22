"""Optional, persistent UniProt sequence downloads. This is not a spectrum search.

Only the catalog below can be downloaded; neither URLs nor destination paths
come from the renderer. Completed databases are independent of app versions.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
import gzip
import hashlib
from http.client import IncompleteRead
import json
import os
from pathlib import Path
import re
import ssl
from urllib.error import HTTPError, URLError
import tempfile
from threading import Event, RLock, Thread
import time
from urllib.parse import urlsplit
from urllib.request import Request, HTTPSHandler, HTTPRedirectHandler, build_opener
import xml.etree.ElementTree as ET


BASE_URL = 'https://ftp.uniprot.org/pub/databases/uniprot/current_release/knowledgebase/reference_proteomes/'
MIRROR_URL = 'https://ftp.ebi.ac.uk/pub/databases/uniprot/current_release/knowledgebase/reference_proteomes/'
SWISS_MIRROR_URL = 'https://ftp.expasy.org/databases/uniprot/current_release/knowledgebase/reference_proteomes/'
DOWNLOAD_SOURCES = (BASE_URL, MIRROR_URL, SWISS_MIRROR_URL)
SOURCE_LABELS = {BASE_URL:'UniProt (USA)', MIRROR_URL:'UniProt EBI (UK)', SWISS_MIRROR_URL:'UniProt ExPASy (Switzerland)'}
CATALOG = {
    'human': dict(label='Human', organism='Homo sapiens', proteome='UP000005640', taxon=9606,
                  domain='Eukaryota', estimated_download_mb=8, minimum_entries=10000),
    'ecoli-k12': dict(label='E. coli K-12', organism='Escherichia coli (K-12)', proteome='UP000000625', taxon=83333,
                      domain='Bacteria', estimated_download_mb=1, minimum_entries=1000),
    'yeast': dict(label='Yeast — S. cerevisiae S288c', organism='Saccharomyces cerevisiae (S288c)',
                  proteome='UP000002311', taxon=559292, domain='Eukaryota', estimated_download_mb=2, minimum_entries=1000),
    'chinese-hamster': dict(label='Chinese hamster / CHO', organism='Cricetulus griseus',
                            proteome='UP001108280', taxon=10029, domain='Eukaryota', estimated_download_mb=8, minimum_entries=10000),
}
PRESETS = [
    dict(id='human', label='Human — general', database_id='human', group='Human'),
    *[dict(id=key, label=f'{label} → Human', database_id='human', group='Human cell lines')
      for key, label in [('hek293', 'HEK293'), ('hek293t', 'HEK293T'), ('hela', 'HeLa'),
                         ('a549', 'A549'), ('u2os', 'U2OS'), ('mcf7', 'MCF-7'), ('jurkat', 'Jurkat')]],
    dict(id='ecoli-k12', label='E. coli — K-12 reference', database_id='ecoli-k12', group='Other organisms'),
    dict(id='yeast', label='Yeast — Saccharomyces cerevisiae (S288c)', database_id='yeast', group='Other organisms'),
    dict(id='cho', label='CHO → Chinese hamster', database_id='chinese-hamster', group='Other organisms'),
]
ACTIVE_STATES = {'connecting', 'retrying', 'downloading', 'verifying', 'installing', 'cancelling'}
MAX_DOWNLOAD = 100_000_000
MAX_FASTA = 500_000_000
CHUNK = 128 * 1024
STAGING_FILES = ('download.fasta.gz', 'proteins.fasta', 'metadata.json')


class DownloadCancelled(Exception):
    pass


def _source(database_id):
    if not isinstance(database_id, str) or database_id not in CATALOG:
        raise ValueError('Choose a supported protein database.')
    item = CATALOG[database_id]
    directory = BASE_URL + f"{item['domain']}/{item['proteome']}/"
    filename = f"{item['proteome']}_{item['taxon']}.fasta.gz"
    return item, directory, filename


def _safe_url(url):
    parsed = urlsplit(url)
    if (parsed.scheme != 'https' or parsed.hostname not in ('ftp.uniprot.org', 'ftp.ebi.ac.uk', 'ftp.expasy.org')
            or parsed.port not in (None, 443) or parsed.username or parsed.password
            or not any(url.startswith(base) for base in DOWNLOAD_SOURCES)):
        raise ValueError('The database download must stay on the official UniProt HTTPS server.')
    return url


class _UniProtRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _safe_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def open_uniprot(url):
    # Use an explicit CA bundle as frozen Python does not necessarily have the
    # development machine's OpenSSL certificate paths, particularly on macOS.
    import certifi
    context = ssl.create_default_context(cafile=certifi.where())
    opener = build_opener(HTTPSHandler(context=context), _UniProtRedirect())
    request = Request(_safe_url(url), headers={'User-Agent': 'CATrupole protein-database downloader',
                                              'Accept-Encoding': 'identity'})
    return opener.open(request, timeout=20)


def _transient_network_error(error):
    if isinstance(error, HTTPError):
        return error.code in (408, 429, 500, 502, 503, 504)
    reason = error.reason if isinstance(error, URLError) else error
    if isinstance(reason, ssl.SSLCertVerificationError):
        return False  # Never hide an authentication failure by disabling TLS.
    return isinstance(reason, (TimeoutError, ConnectionError, IncompleteRead)) or isinstance(error, URLError)


def parse_release(content, filename):
    if len(content) > 1_000_000 or b'<!DOCTYPE' in content.upper() or b'<!ENTITY' in content.upper():
        raise ValueError('Invalid UniProt release metadata.')
    root = ET.fromstring(content)
    ns = {'m': 'http://www.metalinker.org/'}
    release = root.findtext('m:version', namespaces=ns)
    if not release or not re.fullmatch(r'\d{4}_\d{2}', release):
        raise ValueError('UniProt did not provide a valid release version.')
    entry = next((node for node in root.findall('m:files/m:file', ns) if node.get('name') == filename), None)
    if entry is None:
        raise ValueError('The selected protein FASTA is absent from this UniProt release.')
    size = int(entry.findtext('m:size', namespaces=ns) or 0)
    md5 = entry.findtext("m:verification/m:hash[@type='md5']", namespaces=ns) or ''
    if not 0 < size <= MAX_DOWNLOAD or not re.fullmatch('[0-9a-fA-F]{32}', md5):
        raise ValueError('Invalid UniProt download size or checksum.')
    return release, size, md5.lower()


def _atomic_json(path, value):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent,
                                         prefix='.settings-', suffix='.tmp', delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(value, stream, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        # Close the handle before cleanup, including on a failed write (Windows).
        if temporary is not None:
            temporary.unlink(missing_ok=True)


@contextmanager
def _process_lock(path):
    """Also protect staging if two development backends share one data folder."""
    if path.is_symlink():
        raise ValueError('The database lock must not be a symbolic link.')
    with path.open('a+b') as stream:
        if stream.tell() == 0:
            stream.write(b'0'); stream.flush()
        stream.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise ValueError('Another CATrupole process is downloading this database.') from error
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == 'nt':
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def _clear_staging(stage):
    """Remove only our three known partial files; never recursively erase a folder."""
    if stage.is_symlink():
        raise ValueError('The partial database folder must not be a symbolic link.')
    if stage.exists():
        if any(child.name not in STAGING_FILES for child in stage.iterdir()):
            raise ValueError(f'Unexpected files in {stage}; these were left untouched.')
        for name in STAGING_FILES:
            (stage / name).unlink(missing_ok=True)
        stage.rmdir()


class ProteinDatabaseStore:
    def __init__(self, user_data_dir, opener=None):
        self.root = Path(user_data_dir) / 'databases'
        self._open = opener or open_uniprot
        self._lock = RLock()
        self._thread = None
        self._cancel = Event()
        self._job = None
        self._verified = {}
        self.selected_preset = ''
        try:
            settings = self.root / 'settings.json'
            if settings.stat().st_size < 65536:
                selected = json.loads(settings.read_text(encoding='utf-8')).get('selected_preset')
                if selected in {preset['id'] for preset in PRESETS}:
                    self.selected_preset = selected
        except (OSError, ValueError, AttributeError):
            pass

    def _installed(self, database_id):
        destination = self.root / database_id
        if not destination.exists():
            return None
        fasta, metadata_path = destination / 'proteins.fasta', destination / 'metadata.json'
        try:
            if destination.is_symlink() or fasta.is_symlink() or metadata_path.is_symlink():
                raise ValueError('Linked database files are not managed by CATrupole.')
            if metadata_path.stat().st_size > 65536:
                raise ValueError('Invalid database metadata size.')
            metadata = json.loads(metadata_path.read_text(encoding='utf-8'))
            size = fasta.stat().st_size
            item, directory, filename = _source(database_id)
            if (metadata['schema_version'] != 1 or metadata['database_id'] != database_id
                    or metadata['source_url'] != directory + filename
                    or metadata['bytes'] != size or not 0 < size <= MAX_FASTA
                    or metadata['protein_count'] < item['minimum_entries']
                    or not re.fullmatch('[0-9a-f]{64}', metadata['sha256'])):
                raise ValueError('Incomplete database metadata or file.')
            signature = (fasta.stat().st_mtime_ns, fasta.stat().st_ctime_ns, size, metadata['sha256'])
            if self._verified.get(database_id) != signature:
                digest = hashlib.sha256()
                with fasta.open('rb') as stream:
                    for chunk in iter(lambda: stream.read(CHUNK), b''):
                        digest.update(chunk)
                if digest.hexdigest() != metadata['sha256']:
                    raise ValueError('Saved FASTA checksum does not match.')
                self._verified[database_id] = signature
            return dict(metadata, path=str(fasta))
        except (OSError, ValueError, KeyError, TypeError) as error:
            return {'invalid': True, 'path': str(destination), 'error': str(error)}

    def snapshot(self):
        with self._lock:
            databases = []
            for database_id, item in CATALOG.items():
                installed = self._installed(database_id)
                databases.append(dict(item, id=database_id, installed=bool(installed and not installed.get('invalid')),
                                      saved=installed, scope='Reference proteome: main representative protein sequences'))
            return dict(directory=str(self.root), selected_preset=self.selected_preset,
                        presets=[dict(p) for p in PRESETS], databases=databases,
                        job=dict(self._job) if self._job else None, spectrum_search_available=True)

    def select(self, preset_id):
        if not isinstance(preset_id, str) or preset_id not in {preset['id'] for preset in PRESETS}:
            raise ValueError('Choose an organism or cell line from the dropdown.')
        with self._lock:
            self.root.mkdir(parents=True, exist_ok=True)
            _atomic_json(self.root / 'settings.json', {'selected_preset': preset_id})
            self.selected_preset = preset_id
            return self.snapshot()

    def search_database(self, database_id):
        _source(database_id)
        with self._lock:
            saved = self._installed(database_id)
            if not saved or saved.get('invalid'):
                raise ValueError('Download a verified protein database before searching.')
            return self.root / database_id / 'proteins.fasta', dict(saved)

    def start(self, database_id):
        _source(database_id)
        with self._lock:
            if self._job and self._job['state'] in ACTIVE_STATES:
                if self._job['database_id'] == database_id:
                    return self.snapshot()
                raise ValueError('Finish or cancel the current database download first.')
            installed = self._installed(database_id)
            if installed and not installed.get('invalid'):
                return self.snapshot()  # Never redownload a database during app updates.
            if installed:
                raise ValueError(f'The existing database is damaged. Move {self.root / database_id} aside before downloading again; it was left untouched.')
            self._cancel = Event()
            self._job = dict(database_id=database_id, state='connecting', downloaded_bytes=0, total_bytes=None, error=None)
            self._thread = Thread(target=self._worker, args=(database_id,), daemon=True, name='protein-database-download')
            self._thread.start()
            return self.snapshot()

    def cancel(self, database_id):
        _source(database_id)
        with self._lock:
            if self._job and self._job['database_id'] == database_id and self._job['state'] in ACTIVE_STATES:
                self._cancel.set()
                self._job['state'] = 'cancelling'
            return self.snapshot()

    def close(self):
        self._cancel.set()

    def _check_cancel(self):
        if self._cancel.is_set():
            raise DownloadCancelled()

    def _progress(self, **changes):
        with self._lock:
            self._check_cancel()
            self._job.update(changes)

    def _worker(self, database_id):
        stage = self.root / f'.partial-{database_id}'
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            with _process_lock(self.root / f'.{database_id}.lock'):
                # Recovery only touches this download's explicitly named files.
                _clear_staging(stage)
                stage.mkdir()
                try:
                    if (self.root / database_id).exists():
                        raise ValueError('A database already exists here; it was left untouched.')
                    for attempt, base in enumerate(DOWNLOAD_SOURCES, 1):
                        self._progress(state='connecting', attempt=attempt, max_attempts=len(DOWNLOAD_SOURCES),
                                       source=SOURCE_LABELS[base], downloaded_bytes=0, total_bytes=None)
                        try:
                            metadata = self._download(database_id, stage, base)
                            break
                        except Exception as error:
                            if not _transient_network_error(error):
                                raise
                            if attempt == len(DOWNLOAD_SOURCES):
                                raise ValueError('Could not download from the three official UniProt servers (USA, UK, Switzerland). Check your connection and retry.') from error
                            self._progress(state='retrying')
                            if self._cancel.wait(attempt):
                                raise DownloadCancelled()
                    self._progress(state='installing')
                    (stage / 'download.fasta.gz').unlink()
                    (stage / 'metadata.json').write_text(json.dumps(metadata, indent=2), encoding='utf-8')
                    with self._lock:
                        self._check_cancel()
                        # Both FASTA and provenance appear together, only after verification.
                        os.replace(stage, self.root / database_id)
                        self._job['state'] = 'complete'
                finally:
                    _clear_staging(stage)
        except DownloadCancelled:
            with self._lock:
                self._job['state'] = 'cancelled'
        except Exception as error:
            with self._lock:
                self._job.update(state='failed', error=str(error) or type(error).__name__)

    def _download(self, database_id, stage, base=BASE_URL):
        item, directory, filename = _source(database_id)
        source_url = directory + filename
        directory = base + directory[len(BASE_URL):]
        self._check_cancel()
        with self._open(directory + 'RELEASE.metalink') as response:
            release, expected_size, expected_md5 = parse_release(response.read(1_000_001), filename)
        self._progress(state='downloading', total_bytes=expected_size)
        received = 0
        md5 = hashlib.md5(usedforsecurity=False)  # UniProt's published transport checksum; HTTPS authenticates the source.
        started = time.monotonic()
        with self._open(directory + filename) as response, (stage / 'download.fasta.gz').open('wb') as output:
            while True:
                self._check_cancel()
                if time.monotonic() - started > 900:
                    raise ValueError('Download timed out. Check your connection and try again.')
                chunk = response.read(CHUNK)
                if not chunk:
                    break
                received += len(chunk)
                if received > expected_size or received > MAX_DOWNLOAD:
                    raise ValueError('The UniProt download is larger than its published size.')
                output.write(chunk); md5.update(chunk)
                self._progress(downloaded_bytes=received)
            output.flush(); os.fsync(output.fileno())
        if received != expected_size or md5.hexdigest() != expected_md5:
            raise ValueError('Download verification failed. UniProt may be updating its release; please try again.')
        self._progress(state='verifying')
        count, size, sequence_length = 0, 0, 0
        sha256 = hashlib.sha256()
        with gzip.open(stage / 'download.fasta.gz', 'rb') as source, (stage / 'proteins.fasta').open('wb') as output:
            while True:
                self._check_cancel()
                line = source.readline(65537)
                if not line:
                    break
                size += len(line)
                if size > MAX_FASTA or len(line) > 65536:
                    raise ValueError('The FASTA exceeds the supported database size.')
                value = line.strip()
                if value.startswith(b'>'):
                    if count and not sequence_length:
                        raise ValueError('The FASTA contains an empty protein sequence.')
                    if not re.match(rb'^>(?:sp|tr)\|[^|]+\|', value) or not re.search(rb'\bOX=' + str(item['taxon']).encode() + rb'\b', value):
                        raise ValueError('The FASTA does not match the selected UniProt organism.')
                    count += 1; sequence_length = 0
                elif value:
                    if not count or not re.fullmatch(rb'[ACDEFGHIKLMNPQRSTVWYBXZJUO*]+', value):
                        raise ValueError('The download is not a valid protein FASTA.')
                    sequence_length += len(value)
                output.write(line); sha256.update(line)
            output.flush(); os.fsync(output.fileno())
        if count < item['minimum_entries'] or not sequence_length:
            raise ValueError('The downloaded reference proteome is incomplete.')
        return dict(schema_version=1, database_id=database_id, proteome=item['proteome'], taxon=item['taxon'],
                    source_url=source_url, download_url=directory + filename, uniprot_release=release, compressed_md5=expected_md5,
                    sha256=sha256.hexdigest(), bytes=size, download_bytes=received, protein_count=count,
                    downloaded_at=datetime.now(timezone.utc).isoformat(),
                    attribution='UniProt Consortium — CC BY 4.0; reference FASTA unchanged',
                    license_url='https://creativecommons.org/licenses/by/4.0/')
