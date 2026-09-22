import csv
import io
import math
from pathlib import Path
import sys
import tempfile
from threading import Event
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import numpy as np

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'lcms_app'))
import database_search as search


class DatabaseSearchTests(unittest.TestCase):
    def test_settings_are_separate_bounded_and_preparation_dependent(self):
        settings=search.normalize_settings({})
        self.assertFalse(settings['semi_tryptic']);self.assertFalse(settings['fixed_iam'])
        self.assertEqual(settings['fragment_bin_da'],.02)
        self.assertTrue(search.normalize_settings({'preparation':{'iam':True}})['fixed_iam'])
        for payload in [{'preparation':{'reduced':False}}, {'settings':{'q_threshold':float('nan')}},
                        {'settings':{'missed_cleavages':1.5}}, {'settings':{'charge_min':6,'charge_max':1}},
                        {'preparation':{'iam':True},'variable_modifications':{'iam':True}},
                        {'modifications':[{'kind':'gg','position':48}]}, {'settings':{'fasta':'invented'}}]:
            with self.subTest(payload=payload),self.assertRaises(ValueError): search.normalize_settings(payload)

    def test_small_target_only_search_cannot_claim_zero_error(self):
        rows=[dict(evalue=i/1000,decoy=False) for i in range(10)]
        search.qvalues(rows,'q')
        self.assertTrue(all(row['q']>=.1 for row in rows))

    def test_q_values_group_ties_and_are_monotone(self):
        rows=[dict(evalue=1.,decoy=False),dict(evalue=1.,decoy=True),dict(evalue=2.,decoy=False)]
        search.qvalues(rows,'q')
        self.assertEqual(rows[0]['q'],rows[1]['q'])
        self.assertLessEqual(rows[1]['q'],rows[2]['q'])
        self.assertEqual([r['q'] for r in rows],[1.,1.,1.])
        rows=[dict(evalue=i,decoy=i>=150) for i in range(160)]
        search.qvalues(rows,'q');self.assertAlmostEqual(rows[0]['q'],1/150)
        self.assertEqual(rows[-1]['q'],11/150)

    def test_export_uses_only_measured_msms_and_precise_values(self):
        with tempfile.TemporaryDirectory() as tmp:
            scan=np.column_stack([np.arange(10)+123.123456789,np.arange(10)+100])
            channel=SimpleNamespace(metadata=[dict(scan_id=73,time=1.234567,precursor_mz=789.123456789)],scans=[scan])
            sample=SimpleNamespace(qtof_info={'is_protein_digest':True},qtof_channels={(0,2):channel,(0,1):object()})
            path=Path(tmp)/'data.mgf';scans,skipped=search.export_measured(sample,path,Event())
            self.assertEqual(skipped,0);self.assertEqual(set(scans),{73})
            text=path.read_text();self.assertIn('PEPMASS=789.123456789',text);self.assertNotIn('CHARGE=',text)
            self.assertIn('123.123456789 100',text);self.assertNotIn('FASTA',text)
            cancelled=Event();cancelled.set()
            with self.assertRaises(search.SearchCancelled):search.export_measured(sample,path,cancelled)
            sample.qtof_info['is_protein_digest']=False
            with self.assertRaises(ValueError):search.export_measured(sample,path,Event())

    def test_one_charge_winner_per_scan_and_decoy_wins_equal_score(self):
        fields=['scan','num','charge','e-value','xcorr','protein','plain_peptide','modified_peptide','modifications','ions_matched','calc_neutral_mass','exp_neutral_mass']
        base=dict(scan=1,num=1,charge=2,xcorr=2,protein='sp|P1|TEST',plain_peptide='PEPTIDER',modified_peptide='-.PEPTIDER.-',modifications='-',ions_matched=10,calc_neutral_mass=1000,exp_neutral_mass=1000)
        with tempfile.TemporaryDirectory() as tmp:
            file=Path(tmp)/'results.txt';fasta=Path(tmp)/'db.fasta';fasta.write_text('>sp|P1|TEST\nPEPTIDER\n')
            with file.open('w') as stream:
                stream.write('CometVersion 2026.02 rev. 2\n');writer=csv.DictWriter(stream,fields,delimiter='\t');writer.writeheader()
                writer.writerow({**base,'e-value':.001})
                writer.writerow({**base,'charge':3,'protein':'DECOY_sp|P1|TEST','e-value':.001,'xcorr':1})
                writer.writerow({**base,'scan':2,'e-value':.0001})
            result=search.parse_results(file,{i:dict(scan_id=i,time=1.,precursor_mz=500.) for i in (1,2)},fasta,search.normalize_settings({}))
            self.assertEqual(result['reported_scans'],2);self.assertEqual(result['decoy_winners'],1)
            self.assertEqual(result['target_winners'],1);self.assertEqual(result['accepted_psms'],0)
            self.assertEqual(result['psms'][0]['scan_id'],2)

    def test_fasta_associations_preserve_full_reference_not_observed_sequence_claim(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'proteins.fasta';path.write_text('>sp|P1|A Description\nPEPT\nIDER\n>sp|P2|B\nABCDEFG\n')
            records=search.read_fasta(path)
            self.assertEqual(records['sp|P1|A']['sequence'],'PEPTIDER')
            self.assertEqual(records['sp|P1|A']['header'],'sp|P1|A Description')

    def test_target_cannot_inherit_a_decoy_winners_peptide_q(self):
        fields=['scan','num','charge','e-value','xcorr','protein','plain_peptide','modified_peptide','modifications','ions_matched','calc_neutral_mass','exp_neutral_mass']
        base=dict(num=1,charge=2,xcorr=2,protein='sp|P1|TEST',plain_peptide='PEPTIDER',modified_peptide='-.PEPTIDER.-',modifications='-',ions_matched=10,calc_neutral_mass=1000,exp_neutral_mass=1000)
        with tempfile.TemporaryDirectory() as tmp:
            file=Path(tmp)/'results.txt';fasta=Path(tmp)/'db.fasta';fasta.write_text('>sp|P1|TEST\nPEPTIDER\n')
            with file.open('w') as stream:
                stream.write('CometVersion 2026.02 rev. 2\n');writer=csv.DictWriter(stream,fields,delimiter='\t');writer.writeheader()
                writer.writerow({**base,'scan':1,'e-value':.001,'protein':'DECOY_sp|P1|TEST'})
                writer.writerow({**base,'scan':2,'e-value':.01})
            # Isolate propagation from estimation: even a low decoy-unit q must
            # not become a target peptide-level acceptance.
            def qvalues(rows,field):
                for row in rows:row[field]=.001
            with patch.object(search,'qvalues',qvalues):
                result=search.parse_results(file,{i:dict(scan_id=i,time=1.,precursor_mz=500.) for i in (1,2)},fasta,search.normalize_settings({}))
            self.assertEqual(result['psms'][0]['peptide_q'],1.)
            self.assertEqual(result['accepted_peptides'],0)

    def test_changed_reference_policy_refuses_old_results(self):
        store=search.DatabaseSearchStore('/unused',None,lambda _:SimpleNamespace(qtof_info={'reference_filter':{'mode':'new'}}))
        store.result=dict(id='one',path='sample',reference_filter={'mode':'old'})
        with self.assertRaisesRegex(ValueError,'Reference-ion settings changed'):store.results('one')

    def test_missing_database_or_engine_never_starts_process(self):
        class Databases:
            def search_database(self,key): raise ValueError('Missing verified database')
        with tempfile.TemporaryDirectory() as tmp:
            store=search.DatabaseSearchStore(tmp,Databases(),lambda _:None)
            with self.assertRaisesRegex(ValueError,'verified'):store.start({'path':'file','database_id':'human'})
            self.assertIsNone(store.thread)


if __name__=='__main__':unittest.main()
