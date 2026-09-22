"""Exercise the bundled native search engine with synthetic, offline spectra."""
from pathlib import Path
import hashlib
import tempfile
from types import SimpleNamespace
import numpy as np


def run():
    from database_search import DatabaseSearchStore, engine_path
    from peptide_mapping import AA, fragments, PROTON, WATER
    sequence='ACDEFGHIK'
    masses=np.array([AA[aa] for aa in sequence])
    peaks=np.array(sorted((mz,1000.+i) for i,(_,mz,_) in enumerate(fragments(masses,2))))
    mz=(masses.sum()+WATER)/2+PROTON
    channel=SimpleNamespace(scans=[peaks.copy() for _ in range(8)],
                            metadata=[dict(scan_id=i+1,time=(i+1)/10,precursor_mz=float(mz)) for i in range(8)])
    sample=SimpleNamespace(qtof_info={'is_protein_digest':True},qtof_channels={(0,2):channel})
    with tempfile.TemporaryDirectory(prefix='catrupole-comet-smoke-') as tmp:
        root=Path(tmp);fasta=root/'synthetic.fasta'
        fasta.write_text('>sp|SYNTHETIC|TEST Synthetic protein\nACDEFGHIK\n>sp|OTHER|TEST\nMPEPTIDERKLMNPQRSTVWY\n')
        class Databases:
            def search_database(self,key):return fasta,dict(sha256=hashlib.sha256(fasta.read_bytes()).hexdigest())
        store=DatabaseSearchStore(root,Databases(),lambda _:sample)
        try:
            store.start({'database_id':'synthetic','path':'synthetic'})
            store.thread.join(60)
            if store.status()['job']['state']!='complete':raise RuntimeError(store.status())
            result=store.results(store.job['id'])
            if not any(row['sequence']==sequence for row in result['psms']):raise RuntimeError('Synthetic peptide was not recovered')
            if result['accepted_psms']!=0:raise RuntimeError('Small synthetic search must not claim 1% confidence')
            return dict(database_search_smoke='passed',native_engine=str(engine_path().name),engine_version=result['engine_version'])
        finally:
            store.close();store.thread.join(10)
