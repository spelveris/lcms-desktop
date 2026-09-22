"""Offline fixtures only; tests never download a public proteome or read samples."""
import gzip
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
from threading import Event
import unittest
from unittest.mock import patch
from urllib.error import URLError, HTTPError
import ssl

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lcms_app'))
import protein_databases as databases


def release_xml(payload, database_id='human', **overrides):
    _, _, filename = databases._source(database_id)
    values = dict(filename=filename, size=len(payload), checksum=hashlib.md5(payload).hexdigest(), release='2026_03')
    values.update(overrides)
    return (f'<metalink xmlns="http://www.metalinker.org/"><version>{values["release"]}</version>'
            f'<files><file name="{values["filename"]}"><size>{values["size"]}</size><verification>'
            f'<hash type="md5">{values["checksum"]}</hash></verification></file></files></metalink>').encode()


class NetworkFixture:
    def __init__(self, database_id='human', fasta=None, **overrides):
        self.calls = []
        taxon = databases.CATALOG[database_id]['taxon']
        self.fasta = fasta if fasta is not None else f'>sp|P00001|TEST Test protein OX={taxon}\nPEPTIDER\n>tr|P00002|TEST Other OX={taxon}\nACDEXUO\n'.encode()
        self.payload = gzip.compress(self.fasta)
        self.manifest = release_xml(self.payload, database_id, **overrides)
        self.entered, self.resume = Event(), Event()
        self.block = False

    def __call__(self, url):
        self.calls.append(url)
        if url.endswith('RELEASE.metalink'):
            return io.BytesIO(self.manifest)
        if self.block:
            self.entered.set()
            if not self.resume.wait(5):
                raise RuntimeError('Test did not release download')
        return io.BytesIO(self.payload)


class ProteinDatabaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        catalog = {key: dict(item, minimum_entries=1) for key, item in databases.CATALOG.items()}
        self.patch = patch.dict(databases.CATALOG, catalog)
        self.patch.start(); self.addCleanup(self.patch.stop)
        self.network = NetworkFixture()
        self.store = databases.ProteinDatabaseStore(self.root, self.network)
        self.addCleanup(self.finish)

    def finish(self):
        self.network.resume.set()
        self.store.close()
        if self.store._thread:
            self.store._thread.join(5)

    def download(self, database_id='human'):
        self.store.start(database_id)
        self.store._thread.join(5)
        self.assertFalse(self.store._thread.is_alive())
        return self.store.snapshot()

    def row(self, database_id='human', store=None):
        return next(item for item in (store or self.store).snapshot()['databases'] if item['id'] == database_id)

    def test_catalog_is_offline_and_does_not_create_directories(self):
        status = self.store.snapshot()
        self.assertEqual(set(databases.CATALOG), {'human', 'ecoli-k12', 'yeast', 'chinese-hamster'})
        self.assertTrue(status['spectrum_search_available'])
        self.assertFalse(self.store.root.exists())
        self.assertEqual(self.network.calls, [])
        self.assertFalse(any(item['installed'] for item in status['databases']))

    def test_handshake_timeout_retries_official_mirror_and_preserves_provenance(self):
        def network(url):
            if url.startswith(databases.BASE_URL): raise URLError(TimeoutError('TLS handshake timed out'))
            return self.network(url)
        self.store._open=network
        with patch.object(self.store._cancel,'wait',return_value=False):status=self.download()
        self.assertEqual(status['job']['state'],'complete')
        saved=self.row()['saved']
        self.assertTrue(saved['source_url'].startswith(databases.BASE_URL))
        self.assertTrue(saved['download_url'].startswith(databases.MIRROR_URL))
        self.assertTrue(all(url.startswith(databases.MIRROR_URL) for url in self.network.calls))
        path, metadata=self.store.search_database('human');self.assertEqual(path.read_bytes(),self.network.fasta)

    def test_retry_never_disables_certificates_or_retries_integrity_failure(self):
        self.assertFalse(databases._transient_network_error(URLError(ssl.SSLCertVerificationError('certificate failed'))))
        self.assertFalse(databases._transient_network_error(ValueError('checksum mismatch')))
        self.assertFalse(databases._transient_network_error(HTTPError('https://ftp.uniprot.org/',404,'missing',{},None)))
        self.assertTrue(databases._transient_network_error(TimeoutError('read timed out')))
        with self.assertRaises(ValueError):self.store.search_database('../human')

    def test_two_failed_servers_fall_back_to_swiss_mirror(self):
        calls=[]
        def network(url):
            calls.append(url)
            if not url.startswith(databases.SWISS_MIRROR_URL): raise HTTPError(url,503,'unavailable',{},None)
            return self.network(url)
        self.store._open=network
        status=self.download()
        self.assertEqual(status['job']['state'],'complete')
        self.assertEqual(status['job']['attempt'],3)
        self.assertTrue(self.row()['saved']['download_url'].startswith(databases.SWISS_MIRROR_URL))
        self.assertEqual(len(calls),4)

    def test_all_failed_servers_stop_without_installing_a_partial_database(self):
        calls=[]
        def network(url):
            calls.append(url);raise TimeoutError('TLS timed out')
        self.store._open=network
        status=self.download()
        self.assertEqual(status['job']['state'],'failed')
        self.assertIn('three official',status['job']['error'])
        self.assertEqual(len(calls),3)
        self.assertFalse(self.row()['installed'])
        self.assertFalse((self.store.root/'.partial-human').exists())

    def test_atomic_install_keeps_original_fasta_and_provenance_not_gzip(self):
        status = self.download()
        self.assertEqual(status['job']['state'], 'complete')
        row = self.row(); saved = row['saved']
        self.assertTrue(row['installed'])
        self.assertEqual(saved['protein_count'], 2)
        self.assertEqual(saved['uniprot_release'], '2026_03')
        self.assertEqual(saved['bytes'], len(self.network.fasta))
        self.assertEqual(saved['sha256'], hashlib.sha256(self.network.fasta).hexdigest())
        self.assertEqual(Path(saved['path']).read_bytes(), self.network.fasta)
        self.assertEqual({path.name for path in Path(saved['path']).parent.iterdir()}, {'proteins.fasta', 'metadata.json'})
        self.assertFalse((self.store.root / '.partial-human').exists())
        self.assertEqual(len(self.network.calls), 2)

    def test_all_human_cell_lines_share_one_database_across_restarts(self):
        self.download()
        original = Path(self.row()['saved']['path']).read_bytes()
        human_presets = [preset for preset in databases.PRESETS if preset['database_id'] == 'human']
        self.assertGreaterEqual(len(human_presets), 8)
        for preset in human_presets:
            self.store.select(preset['id']); self.store.start(preset['database_id'])
        self.assertEqual(len(self.network.calls), 2)
        with patch.dict('os.environ', {'LCMS_APP_VERSION': '9.9.9'}):
            restarted = databases.ProteinDatabaseStore(self.root, lambda _: self.fail('Restart must work offline'))
            self.assertEqual(restarted.selected_preset, human_presets[-1]['id'])
            self.assertTrue(self.row(store=restarted)['installed'])
            restarted.start('human')
            self.assertEqual(Path(self.row(store=restarted)['saved']['path']).read_bytes(), original)
        self.assertEqual([p.name for p in self.store.root.iterdir() if p.is_dir()], ['human'])

    def test_wrong_ids_and_renderer_urls_paths_are_rejected(self):
        for value in [None, {}, [], '../outside', '/tmp/test', 'https://other.example/data', 'HEK293']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.store.start(value)
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.store.select(value)
        self.assertFalse(self.store.root.exists())

    def test_selection_alone_does_not_download_or_touch_other_data(self):
        reference = self.root / 'reference-settings.json'; reference.write_text('existing reference')
        self.store.select('yeast')
        self.assertEqual(self.network.calls, [])
        self.assertEqual(reference.read_text(), 'existing reference')
        self.assertEqual(json.loads((self.store.root / 'settings.json').read_text()), {'selected_preset': 'yeast'})

    def test_failure_preserves_other_database_and_retries_cleanly(self):
        self.download()
        self.network = NetworkFixture('yeast', checksum='0' * 32)
        self.store._open = self.network
        status = self.download('yeast')
        self.assertEqual(status['job']['state'], 'failed')
        self.assertTrue(self.row()['installed']); self.assertFalse(self.row('yeast')['installed'])
        self.assertFalse((self.store.root / '.partial-yeast').exists())
        self.network = NetworkFixture('yeast'); self.store._open = self.network
        self.assertEqual(self.download('yeast')['job']['state'], 'complete')
        self.assertTrue(self.row('yeast')['installed'])

    def test_cancel_and_duplicate_clicks_do_not_install_partial_files(self):
        self.network.block = True
        self.store.start('human')
        self.assertTrue(self.network.entered.wait(2))
        first_thread = self.store._thread
        self.store.start('human')
        self.assertIs(self.store._thread, first_thread)
        with self.assertRaises(ValueError): self.store.start('yeast')
        self.assertFalse(self.row()['installed'])
        self.store.cancel('human'); self.network.resume.set(); first_thread.join(5)
        self.assertEqual(self.store.snapshot()['job']['state'], 'cancelled')
        self.assertFalse((self.store.root / 'human').exists())
        self.assertFalse((self.store.root / '.partial-human').exists())

    def test_application_shutdown_cancels_instead_of_marking_complete(self):
        self.network.block = True; self.store.start('human')
        self.assertTrue(self.network.entered.wait(2))
        self.store.close(); self.network.resume.set(); self.store._thread.join(5)
        self.assertEqual(self.store.snapshot()['job']['state'], 'cancelled')

    def test_interrupted_previous_partial_is_removed_only_on_explicit_retry(self):
        stage = self.store.root / '.partial-human'; stage.mkdir(parents=True)
        (stage / 'download.fasta.gz').write_bytes(b'interrupted download')
        restarted = databases.ProteinDatabaseStore(self.root, self.network)
        self.assertFalse(self.row(store=restarted)['installed'])
        self.assertTrue(stage.exists())
        self.assertEqual(self.download()['job']['state'], 'complete')
        self.assertFalse(stage.exists())

    def test_unexpected_partial_files_are_not_deleted(self):
        stage = self.store.root / '.partial-human'; stage.mkdir(parents=True)
        personal = stage / 'personal.txt'; personal.write_text('keep me')
        self.assertEqual(self.download()['job']['state'], 'failed')
        self.assertEqual(personal.read_text(), 'keep me')
        self.assertEqual(self.network.calls, [])

    def test_corrupted_saved_file_is_detected_without_deleting_it(self):
        self.download()
        fasta = Path(self.row()['saved']['path'])
        fasta.write_bytes(self.network.fasta.replace(b'PEPTIDER', b'PEPTIDEK'))
        restarted = databases.ProteinDatabaseStore(self.root, self.network)
        row = self.row(store=restarted)
        self.assertFalse(row['installed']); self.assertTrue(row['saved']['invalid'])
        with self.assertRaisesRegex(ValueError, 'left untouched'): restarted.start('human')
        self.assertTrue(fasta.exists())

    def test_truncation_and_bad_fasta_never_appear_installed(self):
        for fasta in [b'<html>server error</html>', b'>sp|P1|TEST OX=9606\n',
                      b'>sp|P1|TEST OX=10090\nPEPTIDER\n', b'>sp|P1|TEST OX=9606\nPEP123\n']:
            self.network = NetworkFixture(fasta=fasta); self.store._open = self.network
            self.assertEqual(self.download()['job']['state'], 'failed')
            self.assertFalse(self.row()['installed'])
        self.network = NetworkFixture(); self.network.payload = self.network.payload[:-3]; self.store._open = self.network
        self.assertEqual(self.download()['job']['state'], 'failed')

    def test_uniprot_metadata_and_redirects_are_strictly_bounded(self):
        for changes in [dict(size=0), dict(size=databases.MAX_DOWNLOAD + 1), dict(checksum='x'),
                        dict(filename='wrong.fasta.gz'), dict(release='unknown')]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                databases.parse_release(release_xml(self.network.payload, **changes), 'UP000005640_9606.fasta.gz')
        for payload in [b'<!DOCTYPE test><metalink/>', b'<!ENTITY test>', b'x' * 1_000_001]:
            with self.assertRaises(ValueError): databases.parse_release(payload, 'file')
        for url in ['http://ftp.uniprot.org/file', 'https://other.example/file',
                    databases.BASE_URL.replace('ftp.uniprot.org', 'ftp.uniprot.org.evil.example'),
                    'https://user:secret@ftp.uniprot.org/file', 'file:///tmp/file']:
            with self.assertRaises(ValueError): databases._safe_url(url)
        self.assertEqual(databases._safe_url(databases.BASE_URL + 'Eukaryota/UP000005640/RELEASE.metalink'),
                         databases.BASE_URL + 'Eukaryota/UP000005640/RELEASE.metalink')

    def test_unpacked_size_limit_and_gzip_corruption_are_rejected(self):
        with patch.object(databases, 'MAX_FASTA', 10):
            self.assertEqual(self.download()['job']['state'], 'failed')
        self.network.payload = b'not gzip'
        self.network.manifest = release_xml(self.network.payload)
        self.assertEqual(self.download()['job']['state'], 'failed')

    def test_corrupt_settings_do_not_prevent_startup(self):
        self.store.root.mkdir(); (self.store.root / 'settings.json').write_text('broken JSON')
        self.assertEqual(databases.ProteinDatabaseStore(self.root).snapshot()['selected_preset'], '')

    def test_failed_settings_write_preserves_previous_selection_and_cleans_temporary(self):
        self.store.select('hela')
        with patch.object(databases.os, 'replace', side_effect=OSError('Disk unavailable')):
            with self.assertRaises(OSError): self.store.select('yeast')
        self.assertEqual(self.store.selected_preset, 'hela')
        self.assertEqual(json.loads((self.store.root / 'settings.json').read_text())['selected_preset'], 'hela')
        self.assertEqual({p.name for p in self.store.root.iterdir()}, {'settings.json'})

    def test_api_uses_persistent_user_data_root_not_app_installation(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        import server
        with patch.object(server, '_protein_database_store', None), patch.dict('os.environ', {'LCMS_USER_DATA_DIR': str(self.root)}):
            status = server.protein_database_status()
            self.assertEqual(status['directory'], str(self.root / 'databases'))
            selected = server.protein_database_select({'preset_id': 'hela'})
            self.assertEqual(selected['selected_preset'], 'hela')
            with self.assertRaises(server.HTTPException): server.protein_database_select({'preset_id': []})
            with self.assertRaises(server.HTTPException): server.protein_database_download('../bad')


if __name__ == '__main__': unittest.main()
