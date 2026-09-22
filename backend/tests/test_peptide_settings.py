"""Screenshot-aligned method controls and retention-time feature identity."""
import unittest
from copy import deepcopy
from types import SimpleNamespace
import numpy as np
import test_peptide_mapping as fixtures
from peptide_mapping import analyze, digest, parse_fasta, fragments, match_fragments, PROTON
from peptide_settings import method_settings, DEFAULTS
feature_scans = fixtures.feature_scans


class MethodTests(unittest.TestCase):
    make_sample = fixtures.PeptideMappingTests.make_sample

    def test_screenshot_numerical_defaults_and_editable_tolerance(self):
        peptide=digest(parse_fasta('PEPTIDER'),0,[])[0][0]
        scan=np.array(sorted((mz*(1+30e-6),100.) for _,mz,_ in fragments(peptide['residue_masses'],1)))
        msms=SimpleNamespace(scans=[scan],metadata=[{'scan_id':50,'time':1.,'precursor_mz':peptide['mass']+PROTON}])
        sample=self.make_sample([],msms)
        result=analyze(sample,{'fasta':'PEPTIDER'})
        self.assertEqual(result['settings']['method'],DEFAULTS)
        self.assertEqual(result['settings']['fragment_ppm'],50)
        self.assertEqual(result['settings']['precursor_ppm'],10)
        self.assertEqual(result['settings']['missed_cleavages'],2)
        self.assertEqual(result['settings']['ms1_min_relative_percent'],0)
        self.assertTrue(result['matches'])
        self.assertEqual(analyze(sample,{'fasta':'PEPTIDER','fragment_ppm':20})['matches'],[])

    def test_default_seed_floor_and_mz_window_do_not_modify_raw_scans(self):
        peptide=digest(parse_fasta('PEPTIDER'),0,[])[0][0]
        sample=self.make_sample(feature_scans(peptide,charges=(1,2,3),apex=99))
        before=deepcopy(sample.qtof_channels[0,1].scans)
        self.assertEqual(analyze(sample,{'fasta':'PEPTIDER'})['matches'],[])
        result=analyze(sample,{'fasta':'PEPTIDER','method':{'ms1_peak_min':50}})
        self.assertEqual({r['charge'] for r in result['matches']},{1,2})  # +3 is below 350.
        all_charges=analyze(sample,{'fasta':'PEPTIDER','method':{'ms1_peak_min':50,'ms1_mz_min':0}})
        self.assertEqual({r['charge'] for r in all_charges['matches']},{1,2,3})
        for old,new in zip(before,sample.qtof_channels[0,1].scans):np.testing.assert_array_equal(old,new)

    def test_one_terminal_truncation_not_both_and_editable_lengths(self):
        chains=parse_fasta('PEPTIDER')
        full={p['sequence'] for p in digest(chains,0,[],method_settings({'terminal_truncation':False}))[0]}
        semi={p['sequence'] for p in digest(chains,0,[],method_settings())[0]}
        self.assertEqual(full,{'PEPTIDER'})
        self.assertIn('EPTIDER',semi);self.assertIn('PEPTIDE',semi)
        self.assertNotIn('EPTIDE',semi)
        bounded=digest(chains,0,[],method_settings({'peptide_min_length':6,'peptide_max_length':6}))[0]
        self.assertTrue(bounded);self.assertTrue(all(len(p['sequence'])==6 for p in bounded))
        self.assertTrue(all(chains[0]['sequence'][loc['start']-1:loc['end']]==p['sequence'] for p in bounded for loc in p['locations']))

    def test_msms_filters_are_off_until_explicitly_enabled(self):
        theory=[('b1+',100.,1),('b2+',200.,2)]
        scan=np.array([[100.,1.],[200.,1000.]])
        self.assertEqual(len(match_fragments(scan,theory,50,method_settings())[0]),2)
        for setting in [{'fragment_min_intensity':10},{'fragment_min_relative_percent':5},{'fragment_peak_limit':1}]:
            self.assertEqual([m['ion'] for m in match_fragments(scan,theory,50,method_settings(setting))[0]],['b2+'])

    def test_invalid_settings_fail_not_silently_coerced(self):
        for raw in [{'charge_min':2,'charge_max':1},{'ms1_mz_min':2000,'ms1_mz_max':350},
                    {'ms1_peak_min':float('nan')},{'fragment_peak_limit':1.5},{'terminal_truncation':'yes'},
                    {'charge_max':True},{'agilent_score':80},{'peptide_min_length':71}]:
            with self.subTest(raw=raw),self.assertRaises(ValueError):method_settings(raw)

    def test_biomolecule_groups_coeluting_charges_but_separates_repeated_peaks(self):
        peptide=digest(parse_fasta('PEPTIDER'),0,[])[0][0]
        scans=feature_scans(peptide,charges=(1,2),apex=1000)+feature_scans(peptide,charges=(1,2),apex=1000)
        result=analyze(self.make_sample(scans),{'fasta':'PEPTIDER'})
        rows=result['matches'];self.assertEqual(len(rows),4)
        groups={r['biomolecule']['id']:r['biomolecule'] for r in rows}
        self.assertEqual(len(groups),2)
        self.assertTrue(all(g['charges']==[1,2] for g in groups.values()))
        left,right=sorted(groups.values(),key=lambda g:g['apex_time'])
        self.assertLess(left['time_end'],right['time_start'])
        self.assertTrue(all(not any(k.startswith('_') for k in r) for r in rows))

    def test_msms_keeps_exact_measured_scan_and_links_only_local_biomolecule(self):
        peptide=digest(parse_fasta('PEPTIDER'),0,[])[0][0]
        scans=feature_scans(peptide,charges=(1,2),apex=1000)+feature_scans(peptide,charges=(1,2),apex=1000)
        spectrum=np.array(sorted((mz,100.) for _,mz,_ in fragments(peptide['residue_masses'],1)))
        msms=SimpleNamespace(scans=[spectrum,spectrum],metadata=[
            {'scan_id':99,'time':.031,'parent_scan_id':4,'precursor_mz':peptide['mass']+PROTON},
            {'scan_id':100,'time':.2,'parent_scan_id':999,'precursor_mz':peptide['mass']+PROTON}])
        result=analyze(self.make_sample(scans,msms),{'fasta':'PEPTIDER'})
        first,last=[r for r in result['matches'] if r['evidence']=='msms']
        self.assertTrue(first['biomolecule']['confirmed']);self.assertEqual(first['scan_id'],99)
        self.assertEqual(first['biomolecule']['charges'],[1,2])
        self.assertFalse(last['biomolecule']['confirmed'])
        self.assertNotEqual(first['biomolecule']['id'],last['biomolecule']['id'])


if __name__ == '__main__':unittest.main()
