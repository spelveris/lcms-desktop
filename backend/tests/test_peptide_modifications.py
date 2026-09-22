import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import numpy as np

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'lcms_app'))
from modification_formula import formula_mass
from peptide_mapping import parse_fasta,digest,fragments,PROTON,analyze
from peptide_settings import method_settings
from peptide_modifications import variable_settings,expand_common,localize_sites


class VariableChemistryTests(unittest.TestCase):
    def base(self,sequence='ACMNQAR'):
        return digest(parse_fasta(sequence),0,[])[0][0]

    def expand(self,base,formula,**options):
        mass=base['mass']+formula_mass(formula)['delta']
        channel=SimpleNamespace(metadata=[{'precursor_mz':mass/2+PROTON}],scans=[np.array([[100.,1.]])])
        return expand_common([base],variable_settings(options),channel,method_settings({'ms1_mz_min':0}),10)[0]

    def test_combinations_keep_every_isobaric_site_and_exact_net_formula(self):
        base=self.base()
        rows=self.expand(base,'C2H2N0O3',iam=True,oxidation=True,deamidation=True)
        combined=[p for p in rows if len(p['modifications'])==3]
        self.assertEqual(len(combined),2)
        self.assertEqual({tuple(m['residue'] for m in p['modifications']) for p in combined},{(2,3,4),(2,3,5)})
        for p in combined:
            self.assertAlmostEqual(p['mass']-base['mass'],57.021463735+15.994914620+.984015585,places=6)
            self.assertTrue(all(m['variable'] for m in p['modifications']))
            self.assertEqual({m['kind'] for m in p['modifications']},{'iam','oxidation','deamidation'})

    def test_multiple_deamidations_and_limit(self):
        base=self.base('ANQNQAR')
        rows=self.expand(base,'H-2N-2O2',deamidation=True)
        self.assertEqual(sum(len(p['modifications'])==2 for p in rows),6)
        self.assertEqual(len(self.expand(base,'H-2N-2O2',deamidation=True,max_per_peptide=1)),1)

    def test_fixed_sites_are_not_modified_twice(self):
        fixed=digest(parse_fasta('ACMNQAR'),0,[{'chain':'A','position':2,'kind':'custom','formula':'C2H3NO','delta':57.021463735}])[0][0]
        self.assertEqual(len(self.expand(fixed,'C2H3NO',iam=True)),1)

    def test_invalid_settings_and_explicit_limits(self):
        for options in [{'iam':1},{'max_per_peptide':5},{'max_per_peptide':True},{'unknown':True}]:
            with self.assertRaises(ValueError):variable_settings(options)
        with patch('peptide_modifications.MAX_SITE_VARIANTS',0):
            with self.assertRaisesRegex(ValueError,'site variants'):self.expand(self.base(),'O',oxidation=True)
        with patch('peptide_modifications.MAX_CANDIDATES',1):
            with self.assertRaisesRegex(ValueError,'peptide candidates'):self.expand(self.base(),'O',oxidation=True)

    def test_no_msms_means_no_unknown_site_candidates(self):
        base=self.base()
        self.assertEqual(expand_common([base],variable_settings({'deamidation':True}),None,method_settings(),10),([base],0))
        sample=SimpleNamespace(qtof_info={'is_protein_digest':True},qtof_channels={(0,1):SimpleNamespace(metadata=[],scans=[])})
        with self.assertRaisesRegex(ValueError,'fixed.*variable|Fixed.*variable'):
            analyze(sample,{'fasta':'ACMNQAR','preparation':{'iam':True},'variable_modifications':{'iam':True}})

    def test_combined_search_matches_measured_fragments_without_ms_only_site_claims(self):
        base=self.base('ACMNQAR')
        candidates=self.expand(base,'C2H2O3',iam=True,oxidation=True,deamidation=True)
        target=next(p for p in candidates if tuple(m['residue'] for m in p['modifications'])==(2,3,4))
        scan=np.array(sorted((mz,100.) for _,mz,_ in fragments(target['residue_masses'],2)))
        channel=SimpleNamespace(scans=[scan],metadata=[{'scan_id':5,'time':1.,'precursor_mz':target['mass']/2+PROTON}])
        sample=SimpleNamespace(qtof_info={'is_protein_digest':True},qtof_channels={(0,2):channel})
        result=analyze(sample,{'fasta':base['sequence'],'missed_cleavages':0,
            'method':{'terminal_truncation':False,'ms1_mz_min':0},
            'variable_modifications':{'iam':True,'oxidation':True,'deamidation':True}})
        hits=[r for r in result['matches'] if tuple(m['residue'] for m in r['modifications'])==(2,3,4)]
        self.assertEqual(len(hits),1)
        self.assertTrue(all(m['localized'] for m in hits[0]['modifications']))
        self.assertEqual(result['coverage'][0]['ms_percent'],0)
        self.assertTrue(all(r['evidence']=='msms' for r in result['matches']))

    def test_localization_requires_discriminating_cuts_even_when_rival_fails_score(self):
        rows=self.expand(self.base('AAANQAAR'),'H-1N-1O',deamidation=True)
        candidates=[p for p in rows if p['modifications']]
        target=next(p for p in candidates if p['modifications'][0]['residue']==4)
        def hit(bonds):
            return {'modifications':[dict(m) for m in target['modifications']],
                    'fragments':[{'ion':ion,'bond':bond,'observed_mz':mz,'theoretical_mz':mz}
                        for ion,mz,bond in fragments(target['residue_masses'],1) if ion.startswith('b') and bond in bonds]}
        ambiguous=hit({5,6})
        localize_sites(ambiguous,target,candidates,20)
        self.assertFalse(ambiguous['modifications'][0]['localized'])
        localized=hit({4,5})
        localize_sites(localized,target,candidates,20)
        self.assertTrue(localized['modifications'][0]['localized'])
        one=hit({4})
        localize_sites(one,target,candidates,20)
        self.assertFalse(one['modifications'][0]['localized'])


if __name__=='__main__':unittest.main()
