import sys
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from zipfile import ZipFile
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lcms_app'))
from peptide_mapping import AA, PROTON, WATER, parse_fasta, digest, digest_with_site_search, fragments, match_fragments, analyze, bioconfirm_references


class PeptideMappingTests(unittest.TestCase):
    def make_sample(self, scans, msms=None):
        survey=SimpleNamespace(metadata=[{'scan_id':i+1,'time':float(i)} for i in range(len(scans))],scans=scans)
        channels={(0,1):survey}
        if msms is not None: channels[(0,2)]=msms
        return SimpleNamespace(qtof_info={'is_protein_digest':True},qtof_channels=channels)

    def test_ms1_includes_all_charges_starting_at_one_without_claiming_msms_coverage(self):
        peptide=digest(parse_fasta('PEPTIDER'),0,[])[0][0]
        peaks=np.array(sorted(((peptide['mass']+z*PROTON)/z,100.) for z in range(1,7)))
        result=analyze(self.make_sample([peaks]),{'fasta':'PEPTIDER','missed_cleavages':0})
        self.assertEqual({r['charge'] for r in result['matches']},{1,2,3,4,5,6})
        self.assertTrue(all(r['evidence']=='ms1' and not r['fragments'] for r in result['matches']))
        self.assertTrue(all(r['explained_intensity_pct'] is None for r in result['matches']))
        self.assertEqual(result['coverage'][0]['percent'],0)

    def test_ms1_repeated_scans_keep_strongest_exact_observation_and_rt_span(self):
        peptide=digest(parse_fasta('PEPTIDER'),0,[])[0][0]
        mz=peptide['mass']+PROTON
        scans=[np.array([[mz,100.]]),np.array([[mz*(1+2e-6),500.]]),np.array([[mz,80.]])]
        rows=analyze(self.make_sample(scans),{'fasta':'PEPTIDER'})['matches']
        self.assertEqual(len(rows),1)
        row=rows[0];self.assertEqual(row['scan_id'],2);self.assertEqual(row['observation_count'],3)
        self.assertEqual((row['time_start'],row['time_end']),(0.,2.))
        self.assertEqual(row['precursor_mz'],scans[1][0,0]);self.assertAlmostEqual(row['precursor_error_ppm'],2.)

    def test_fragment_default_is_20_ppm_but_can_be_widened_explicitly(self):
        peptide=digest(parse_fasta('PEPTIDER'),0,[])[0][0]
        scan=np.array(sorted((mass*(1+30e-6),100.) for _,mass,_ in fragments(peptide['residue_masses'],1)))
        msms=SimpleNamespace(metadata=[{'scan_id':99,'time':1.,'precursor_mz':peptide['mass']+PROTON}],scans=[scan])
        sample=self.make_sample([],msms)
        result=analyze(sample,{'fasta':'PEPTIDER'})
        self.assertEqual(result['settings']['fragment_ppm'],20)
        self.assertEqual(result['matches'],[])
        self.assertTrue(analyze(sample,{'fasta':'PEPTIDER','fragment_ppm':50})['matches'])

    def test_ms_and_msms_coverage_are_distinct_unique_residue_unions(self):
        fasta='AAAAAKGGGGGR'
        peptides=digest(parse_fasta(fasta),0,[])[0]
        first,second=peptides
        msms=SimpleNamespace(metadata=[{'scan_id':99,'time':1.,'precursor_mz':first['mass']+PROTON}],
            scans=[np.array(sorted((mass,100.) for _,mass,_ in fragments(first['residue_masses'],1)))])
        sample=self.make_sample([np.array([[second['mass']+PROTON,100.]])]*3,msms)
        result=analyze(sample,{'fasta':fasta,'missed_cleavages':0})
        coverage=result['coverage'][0]
        self.assertEqual(coverage['ms_percent'],100)
        self.assertEqual(coverage['msms_percent'],50)
        self.assertEqual(coverage['ms_only_percent'],50)
        self.assertEqual(len(coverage['ms_positions']),12)

    def test_site_search_finds_gg_on_lysine_without_a_written_position(self):
        fasta='LIFAGKQLEDGR'
        fixed={'chain':'A','position':6,'delta':114.04292747,'block_cleavage':True}
        peptide=digest(parse_fasta(fasta),0,[fixed])[0][0]
        channel=SimpleNamespace(metadata=[{'scan_id':99,'time':1.,'precursor_mz':peptide['mass']+PROTON}],
            scans=[np.array(sorted((mass,100.) for _,mass,_ in fragments(peptide['residue_masses'],1)))])
        sample=self.make_sample([np.array([[peptide['mass']+PROTON,100.]])],channel)
        search={'chain':'A','search_all':True,'kind':'gg','position':1,'delta':0}
        result=analyze(sample,{'fasta':fasta,'modifications':[search],'missed_cleavages':0})
        self.assertEqual(result['settings']['searched_modification_sites'],1)
        hits=[r for r in result['matches'] if any(m.get('variable') for m in r['modifications'])]
        self.assertEqual(len(hits),1);self.assertEqual(hits[0]['modifications'][0]['residue'],6)
        self.assertTrue(hits[0]['site_search']);self.assertEqual(search['position'],1)
        self.assertEqual(hits[0]['evidence'],'msms');self.assertTrue(hits[0]['remnant_fragment_ions'])

    def test_mass_only_never_generates_unknown_site_candidates_or_their_coverage(self):
        fasta='AAKAAKAAAAR';chains=parse_fasta(fasta)
        search={'chain':'A','residues':'K','delta':114.04292747,'block_cleavage':True}
        peptides,_,_=digest_with_site_search(chains,3,[],[search])
        candidates=[p for p in peptides if p['sequence']==fasta and any(m['variable'] for m in p['modifications'])]
        self.assertEqual({p['modifications'][0]['residue'] for p in candidates},{3,6})
        mass=candidates[0]['mass']
        result=analyze(self.make_sample([np.array([[(mass+2*PROTON)/2,100.]])]),
            {'fasta':fasta,'missed_cleavages':3,'modifications':[{**search,'kind':'gg','search_all':True}]})
        hits=[r for r in result['matches'] if r['sequence']==fasta]
        self.assertEqual(hits,[])
        self.assertFalse(any(r['site_search'] for r in result['matches']))
        self.assertEqual(result['coverage'][0]['ms_percent'],0)
        self.assertEqual(result['coverage'][0]['msms_percent'],0)

    def test_custom_site_search_uses_selected_residues_all_chains_and_respects_fixed_sites(self):
        chains=parse_fasta('>one\nAAAAAKSTAAAR\n>two\nAAAAAKSTAAAR')
        fixed=[{'chain':'A','position':7,'delta':57.,'block_cleavage':False}]
        search={'chain':'*','residues':'ST','delta':42.010565,'block_cleavage':False}
        candidates,_,count=digest_with_site_search(chains,1,fixed,[search])
        self.assertEqual(count,3)
        for candidate in candidates:
            for mod in candidate['modifications']:
                if mod['variable']:self.assertIn(candidate['sequence'][mod['residue']-1],'ST')

    def test_site_search_rejects_unknown_chemistry_invalid_residues_and_combinatorial_requests(self):
        sample=self.make_sample([])
        valid={'chain':'A','kind':'gg','search_all':True}
        for modifications in [[{'chain':'A','search_all':True,'delta':None}],
                              [{'chain':'A','search_all':True,'delta':42.,'residues':'?'}],
                              [valid,valid]]:
            with self.assertRaises(ValueError):analyze(sample,{'fasta':'AAAAAK','modifications':modifications})
        with self.assertRaisesRegex(ValueError,'400'):
            analyze(sample,{'fasta':'AK'*401,'modifications':[valid]})

    def test_ms1_ppm_noise_filters_and_sequence_ambiguity(self):
        mass=digest(parse_fasta('PEPTIDER'),0,[])[0][0]['mass']
        sample=self.make_sample([np.array([[mass+PROTON,100.]])])
        rows=analyze(sample,{'fasta':'>one\nPEPTIDER\n>two\nPEPTLDER'})['matches']
        self.assertEqual(len(rows),2);self.assertTrue(all(r['ambiguous_scan'] for r in rows))
        for scan in [np.array([[(mass+PROTON)*(1+30e-6),100.]]),np.array([[mass+PROTON,.5],[200.,100.]])]:
            self.assertEqual(analyze(self.make_sample([scan]),{'fasta':'PEPTIDER'})['matches'],[])

    def test_msms_charge_one_is_found_and_takes_precedence_over_ms_only(self):
        peptide=digest(parse_fasta('PEPTIDER'),0,[])[0][0]
        mz=peptide['mass']+PROTON
        ions=fragments(peptide['residue_masses'],1)
        channel=SimpleNamespace(metadata=[{'scan_id':99,'time':1.,'precursor_mz':mz}],
            scans=[np.array(sorted((mass,100.) for _,mass,_ in ions))])
        result=analyze(self.make_sample([np.array([[mz,100.]])],channel),{'fasta':'PEPTIDER'})
        self.assertEqual(len(result['matches']),1);row=result['matches'][0]
        self.assertEqual(row['evidence'],'msms');self.assertEqual(row['charge'],1)
        self.assertTrue(all('^2+' not in f['ion'] for f in row['fragments']))
        self.assertEqual(result['coverage'][0]['percent'],100.)

    def test_ms1_ggisok_mass_and_unresolved_modification_exclusion(self):
        fasta='LIFAGKQLEDGR';mod={'chain':'A','position':6,'delta':114.04292747,'block_cleavage':True}
        peptide=digest(parse_fasta(fasta),0,[mod])[0][0]
        sample=self.make_sample([np.array([[peptide['mass']+PROTON,100.]])])
        result=analyze(sample,{'fasta':fasta,'modifications':[{**mod,'kind':'gg'}],'missed_cleavages':0})
        self.assertEqual(len(result['matches']),1);self.assertEqual(result['matches'][0]['modifications'][0]['residue'],6)
        result=analyze(sample,{'fasta':fasta,'modifications':[{**mod,'delta':None}],'missed_cleavages':0})
        self.assertEqual(result['matches'],[]);self.assertEqual(result['excluded_modified_peptides'],1)

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
