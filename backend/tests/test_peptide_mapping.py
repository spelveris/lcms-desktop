import sys
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from zipfile import ZipFile
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lcms_app'))
from peptide_mapping import AA, PROTON, WATER, parse_fasta, digest, fragments, match_fragments, analyze, bioconfirm_references


class PeptideMappingTests(unittest.TestCase):
    def test_known_masses_and_fragments(self):
        masses=np.array([AA[a] for a in 'PEPTIDE'])
        self.assertAlmostEqual((masses.sum()+WATER+2*PROTON)/2,400.6872584803735,places=5)
        ions={label:mass for label,mass,_ in fragments(masses,1)}
        self.assertAlmostEqual(ions['b3+'],324.15539725264904,places=5)
        self.assertAlmostEqual(ions['y4+'],477.219119708098,places=5)

    def test_trypsin_and_missed_cleavage_count(self):
        chains=parse_fasta('AAAAAKGGGGGRPPPPPKTTTTTR')
        zero,_=digest(chains,0,[])
        self.assertEqual({p['sequence'] for p in zero},{'AAAAAK','GGGGGRPPPPPK','TTTTTR'})
        one,_=digest(chains,1,[])
        self.assertIn('AAAAAKGGGGGRPPPPPK',{p['sequence'] for p in one})
        self.assertNotIn('AAAAAKGGGGGRPPPPPKTTTTTR',{p['sequence'] for p in one})

    def test_glygly_modification_blocks_cut_and_shifts_only_containing_fragments(self):
        chains=parse_fasta('LIFAGKQLEDGR')
        mod={'chain':'A','position':6,'delta':114.04292747,'block_cleavage':True}
        peptides,_=digest(chains,0,[mod])
        self.assertEqual(len(peptides),1)
        shifted={label:mass for label,mass,_ in fragments(peptides[0]['residue_masses'],1)}
        plain={label:mass for label,mass,_ in fragments(np.array([AA[a] for a in chains[0]['sequence']]),1)}
        self.assertEqual(shifted['b5+'],plain['b5+'])
        self.assertAlmostEqual(shifted['b6+']-plain['b6+'],114.04292747)
        self.assertAlmostEqual(shifted['y5+'],plain['y5+'])
        self.assertAlmostEqual(shifted['y7+']-plain['y7+'],114.04292747)
        mod['delta']=None
        peptides,excluded=digest(chains,0,[mod])
        self.assertEqual(peptides,[]);self.assertEqual(excluded,1)

    def test_repeated_chains_remain_shared_not_uniquely_assigned(self):
        fasta='>one\nPEPTIDER\n>two\nPEPTIDER'
        peptide=digest(parse_fasta(fasta),0,[])[0][0]
        self.assertEqual(len(peptide['locations']),2)
        ions=fragments(peptide['residue_masses'],1)
        scan=np.array(sorted((mass,100.) for _,mass,_ in ions))
        channel=SimpleNamespace(metadata=[{'scan_id':9,'time':1.,'precursor_mz':(peptide['mass']+2*PROTON)/2}],scans=[scan])
        sample=SimpleNamespace(qtof_info={'is_protein_digest':True},qtof_channels={(0,2):channel})
        result=analyze(sample,{'fasta':fasta,'missed_cleavages':0})
        self.assertEqual(len(result['matches']),1)
        self.assertEqual(len(result['matches'][0]['locations']),2)
        self.assertEqual([c['percent'] for c in result['coverage']],[100.,100.])
        self.assertIn('Shared/repeated',result['warning'])
        channel.scans=[np.array([[100.,100.],[200.,100.]])]
        self.assertEqual(analyze(sample,{'fasta':fasta})['matches'],[])

    def test_one_measured_peak_cannot_count_as_multiple_matching_ions(self):
        matches,_=match_fragments(np.array([[100.,10.]]), [('b1+',100.,1),('y2+',100.,2)],50)
        self.assertEqual(len(matches),1)

    def test_ggisok_preset_is_fixed_and_requires_lysine(self):
        sample=SimpleNamespace(qtof_info={'is_protein_digest':True},qtof_channels={(0,2):SimpleNamespace(metadata=[],scans=[])})
        mod={'chain':'A','position':6,'kind':'gg','delta':0,'block_cleavage':False}
        result=analyze(sample,{'fasta':'LIFAGKQLEDGR','modifications':[mod],'missed_cleavages':0})
        self.assertEqual(result['candidate_peptides'],1)
        self.assertEqual(mod['delta'],0)  # no mutation of the submitted definition
        mod['position']=5
        with self.assertRaisesRegex(ValueError,'lysine'):analyze(sample,{'fasta':'LIFAGKQLEDGR','modifications':[mod]})
        mod['position']=6.5
        with self.assertRaisesRegex(ValueError,'whole'):analyze(sample,{'fasta':'LIFAGKQLEDGR','modifications':[mod]})

    def test_invalid_reference_and_options_are_rejected(self):
        for text in ['', 'PEP?TIDE','PEPTIDE*','PEPTIDE123']:
            with self.assertRaises(ValueError):parse_fasta(text)
        sample=SimpleNamespace(qtof_info={'is_protein_digest':True},qtof_channels={(0,2):SimpleNamespace(metadata=[],scans=[])})
        for options in [{'fragment_ppm':float('nan')},{'missed_cleavages':4},{'precursor_ppm':0},{'modifications':[{'chain':'B','position':50,'delta':114}]}]:
            with self.assertRaises(ValueError):analyze(sample,{'fasta':'PEPTIDE',**options})

    def test_imports_method_xml_without_loading_proprietary_binary_objects(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder=root/'run_BioConfirm_Results'/'Version4';folder.mkdir(parents=True)
            (folder/'bioconfirm.bin').write_bytes(b'Never deserialize this')
            xml='<Method><ParameterSet><Parameters><Parameter id="SequenceName"><Value>Reference</Value></Parameter><Parameter id="ChainSequences"><Value><String>PEPTIDER</String></Value></Parameter></Parameters></ParameterSet></Method>'
            with ZipFile(folder/'method.bcpmx','w') as z:z.writestr('bioconfirm.xml',xml)
            refs=bioconfirm_references(root)
            self.assertEqual(len(refs),1);self.assertEqual(parse_fasta(refs[0]['fasta'])[0]['sequence'],'PEPTIDER')


if __name__=='__main__':unittest.main()
