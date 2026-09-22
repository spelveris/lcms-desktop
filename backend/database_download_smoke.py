"""Small offline packaged-runtime check, using synthetic protein records only."""
import gzip
import hashlib
import io
import json
from pathlib import Path
import ssl
import tempfile


def run():
    import certifi
    from protein_databases import ProteinDatabaseStore, CATALOG
    ssl.create_default_context(cafile=certifi.where())
    count = CATALOG['ecoli-k12']['minimum_entries']
    fasta = ''.join(f'>sp|TEST{i:05d}|SYNTHETIC OX=83333\nPEPTIDER\n' for i in range(count)).encode()
    payload = gzip.compress(fasta)
    manifest = (f'<metalink xmlns="http://www.metalinker.org/"><version>2026_03</version><files>'
                f'<file name="UP000000625_83333.fasta.gz"><size>{len(payload)}</size><verification>'
                f'<hash type="md5">{hashlib.md5(payload).hexdigest()}</hash></verification></file></files></metalink>').encode()
    with tempfile.TemporaryDirectory(prefix='catrupole-database-smoke-') as directory:
        store = ProteinDatabaseStore(directory, lambda url: io.BytesIO(manifest if url.endswith('RELEASE.metalink') else payload))
        store.select('ecoli-k12'); store.start('ecoli-k12'); store._thread.join(20)
        try:
            if store.snapshot()['job']['state'] != 'complete':
                raise RuntimeError(json.dumps(store.snapshot()['job']))
            restarted = ProteinDatabaseStore(directory, lambda _: (_ for _ in ()).throw(RuntimeError('Unexpected network access')))
            row = next(item for item in restarted.snapshot()['databases'] if item['id'] == 'ecoli-k12')
            if not row['installed'] or Path(row['saved']['path']).read_bytes() != fasta:
                raise RuntimeError('Database did not survive an offline restart unchanged.')
            restarted.start('ecoli-k12')
            return {'database_download_smoke': 'passed', 'offline_restart': True, 'certificate_bundle': Path(certifi.where()).is_file()}
        finally:
            store.close()
            store._thread.join(2)
