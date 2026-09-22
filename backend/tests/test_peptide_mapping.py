import sys
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from zipfile import ZipFile
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lcms_app'))
from peptide_mapping import AA, PROTON, WATER, IAM_DELTA, preparation_modifications, parse_fasta, digest, digest_with_site_search, fragments, match_fragments, analyze as analyze_method, bioconfirm_references
from ms1_features import ISOTOPE, expected_envelope, find_features, link_msms


def analyze(sample, payload):
    # Regression fixtures include tiny synthetic envelopes and m/z below 350.
    # Explicitly retain the previous method for these existing engine checks;
    # test_peptide_settings exercises the new real-acquisition defaults.
    return analyze_method(sample, {'fragment_ppm':20, 'ms1_min_relative_percent':5,
        'method':{'ms1_mz_min':0, 'ms1_mz_max':10000, 'ms1_peak_min':0, 'terminal_truncation':False}, **payload})


def feature_scans(peptide, charges=(1,), apex=100., background=0., profile=(0,.2,.7,1,.7,.2,0), shift_ppm=0.):
    # Synthetic elemental envelopes, rather than isolated matching mass peaks.
    model=expected_envelope(peptide)
    assert model is not None
    offsets,abundance,_=model
    result=[]
    for factor in profile:
        peaks=[(((peptide['mass']+offset)/z+PROTON)*(1+shift_ppm*1e-6),apex*factor*height)
               for z in charges for offset,height in zip(offsets,abundance)]
        if background:peaks.append((200.,background))
        result.append(np.array(sorted(peaks)))
    return result


class PeptideMappingTests(unittest.TestCase):
    def assert_precursor_target(self, row, expected):
        self.assertAlmostEqual(row['theoretical_precursor_mz'], expected, places=10)
        self.assertAlmostEqual(row['precursor_error_ppm'],
            (row['precursor_mz']-row['theoretical_precursor_mz'])/row['theoretical_precursor_mz']*1e6, places=8)

    def test_iam_and_reduction_use_free_cysteine_masses_once(self):
        chains=parse_fasta('AACCAAR')
        base=digest(chains,0,[])[0][0]
        mods,prep=preparation_modifications(chains,[],{'iam':True,'reduced':True})
        peptide=digest(chains,0,mods)[0][0]
        self.assertAlmostEqual(peptide['mass']-base['mass'],2*IAM_DELTA)
        self.assertEqual([m['formula'] for m in mods],['C2H3NO','C2H3NO'])
        self.assertIn('no extra hydrogen',prep['description'])
        explicit=preparation_modifications(chains,[mods[0]],{'iam':True})[0]
        self.assertEqual(len(explicit),2)
        scans=feature_scans(peptide)
        result=analyze(self.make_sample(scans),{'fasta':'AACCAAR','preparation':{'iam':True}})
        self.assertTrue(result['matches']);self.assertTrue(result['settings']['preparation']['iam'])
        for row in result['matches']:
            self.assert_precursor_target(row,(peptide['mass']+expected_envelope(peptide)[0][row['isotope_offset']])/row['charge']+PROTON)
        self.assertFalse(analyze(self.make_sample(scans),{'fasta':'AACCAAR'})['matches'])

    def test_unreduced_linked_peptides_excluded_not_given_invented_linear_masses(self):
        chains=parse_fasta('AACCAAR')
        mods,prep=preparation_modifications(chains,[],{'reduced':False,'iam':True,'disulfides':'A:3-A:4'})
        self.assertTrue(all(m['delta'] is None for m in mods))
        self.assertEqual(digest(chains,0,mods),([],1))
        for prep in [{'reduced':False},{'reduced':False,'disulfides':'A:1-A:4'},
                     {'reduced':False,'disulfides':'A:3-A:3'},{'reduced':False,'disulfides':'A:3-A:4,A:3-A:4'},
                     {'iam':'yes'},{'reduced':False,'disulfides':'bad'}]:
            with self.assertRaises(ValueError):preparation_modifications(chains,[],prep)
        with self.assertRaisesRegex(ValueError,'conflicts'):
            preparation_modifications(chains,[{'chain':'A','position':3,'delta':42}],{'iam':True})

    def make_sample(self, scans, msms=None):
        survey=SimpleNamespace(metadata=[{'scan_id':i+1,'time':float(i)*.01} for i in range(len(scans))],scans=scans)
        channels={(0,1):survey}
        if msms is not None: channels[(0,2)]=msms
        return SimpleNamespace(qtof_info={'is_protein_digest':True},qtof_channels=channels)

    def test_ms1_includes_all_charges_starting_at_one_without_claiming_msms_coverage(self):
        peptide=digest(parse_fasta('PEPTIDER'),0,[])[0][0]
        result=analyze(self.make_sample(feature_scans(peptide,charges=range(1,7))),{'fasta':'PEPTIDER','missed_cleavages':0})
        self.assertEqual({r['charge'] for r in result['matches']},{1,2,3,4,5,6})
        self.assertTrue(all(r['evidence']=='ms1' and not r['fragments'] for r in result['matches']))
        self.assertTrue(all(r['explained_intensity_pct'] is None for r in result['matches']))
        self.assertEqual(result['coverage'][0]['percent'],0)
        for row in result['matches']:
            self.assert_precursor_target(row,(peptide['mass']+expected_envelope(peptide)[0][row['isotope_offset']])/row['charge']+PROTON)

    def test_ms1_repeated_scans_keep_strongest_exact_observation_and_rt_span(self):
        peptide=digest(parse_fasta('PEPTIDER'),0,[])[0][0]
        mz=peptide['mass']+PROTON
        scans=feature_scans(peptide,apex=500.,shift_ppm=2.)
        rows=analyze(self.make_sample(scans),{'fasta':'PEPTIDER'})['matches']
        self.assertEqual(len(rows),1)
        row=rows[0];self.assertEqual(row['scan_id'],4);self.assertEqual(row['observation_count'],5)
        self.assertEqual(row['core_observation_count'],3)
        self.assertEqual((row['time_start'],row['time_end']),(.01,.05))
        self.assertEqual(row['precursor_mz'],scans[3][0,0]);self.assertAlmostEqual(row['precursor_error_ppm'],2.)
        self.assert_precursor_target(row,mz)

    def test_single_scan_or_isolated_mz_never_makes_ms1_coverage_even_at_zero_cutoffs(self):
        peptide=digest(parse_fasta('PEPTIDER'),0,[])[0][0]
        envelope=feature_scans(peptide)
        cases=[envelope[3:4],feature_scans(peptide,profile=(0,0,0,1,0,0,0)),
               [scan[:1] for scan in envelope],feature_scans(peptide,profile=(1,1,1,1,1,1,1))]
        for scans in cases:
            with self.subTest(scans=len(scans)):
                result=analyze(self.make_sample(scans),{'fasta':'PEPTIDER','ms1_min_relative_percent':0,'ms1_min_intensity':0})
                self.assertEqual(result['matches'],[]);self.assertEqual(result['coverage'][0]['ms_percent'],0)

    def test_short_charge_one_two_isotope_envelope_is_retained_and_offsets_deduplicated(self):
        peptide=digest(parse_fasta('AAAAAK'),0,[])[0][0]
        scans=[s[:2] for s in feature_scans(peptide)]
        rows=analyze(self.make_sample(scans),{'fasta':'AAAAAK'})['matches']
        self.assertEqual(len(rows),1);self.assertEqual(rows[0]['charge'],1)
        self.assertEqual(rows[0]['isotope_count'],2);self.assertEqual(rows[0]['observation_count'],5)
        self.assertTrue(rows[0]['ms1_supported'])

    def test_composition_model_has_known_mono_and_first_isotope_proportions(self):
        peptide=digest(parse_fasta('PEPTIDER'),0,[])[0][0]
        offsets,abundance,_=expected_envelope(peptide)
        self.assertAlmostEqual(peptide['mass'],955.461075,places=5)
        self.assertAlmostEqual(offsets[1],1.002888,places=5)
        self.assertAlmostEqual(abundance[1],.486386,places=4)
        peptide['modifications']=[{'residue':1,'delta':42.}]
        self.assertIsNone(expected_envelope(peptide))

    def test_flat_background_threshold_jitter_and_noncoeluting_isotopes_do_not_count(self):
        peptide=digest(parse_fasta('PEPTIDER'),0,[])[0][0]
        # A threshold crossing is not a chromatographic peak: only 4% contrast.
        scans=feature_scans(peptide,profile=(.96,.97,.99,1,.99,.97,.96))
        self.assertEqual(analyze(self.make_sample(scans),{'fasta':'PEPTIDER'})['matches'],[])
        scans=feature_scans(peptide)
        for j,scan in enumerate(scans):scan[1:,1]=feature_scans(peptide)[(j+3)%7][1:,1]
        self.assertEqual(analyze(self.make_sample(scans),{'fasta':'PEPTIDER'})['matches'],[])

    def test_small_secondary_ripples_do_not_duplicate_a_chromatographic_feature(self):
        peptide=digest(parse_fasta('PEPTIDER'),0,[])[0][0]
        scans=feature_scans(peptide,profile=(0,.2,.6,.8,1,.9,.95,.8,.6,.2,0))
        result=analyze(self.make_sample(scans),{'fasta':'PEPTIDER'})
        self.assertEqual(len(result['matches']),1)
        self.assertEqual(result['matches'][0]['scan_id'],5)

    def test_dominant_mono_peak_does_not_hide_an_incorrect_isotope_ratio(self):
        peptide=digest(parse_fasta('AAAAAK'),0,[])[0][0]
        scans=feature_scans(peptide)
        for scan in scans:scan[1:,1]*=.15
        self.assertEqual(analyze(self.make_sample(scans),{'fasta':'AAAAAK'})['matches'],[])

    def test_interleaving_higher_charge_pattern_is_not_a_charge_one_peptide(self):
        peptide=digest(parse_fasta('PEPTIDER'),0,[])[0][0]
        scans=feature_scans(peptide)
        from peptide_mapping import ISOTOPE
        for j,scan in enumerate(scans):
            extra=np.array([[peptide['mass']+PROTON+ISOTOPE*step,scan[0,1]*.8] for step in [-.5,.5,1.5]])
            scans[j]=np.array(sorted(np.concatenate((scan,extra)).tolist()))
        self.assertEqual(analyze(self.make_sample(scans),{'fasta':'PEPTIDER'})['matches'],[])

    def test_two_retention_features_are_separate_and_msms_links_only_its_parent(self):
        peptide=digest(parse_fasta('PEPTIDER'),0,[])[0][0]
        scans=feature_scans(peptide)+feature_scans(peptide)
        msms=SimpleNamespace(metadata=[{'scan_id':99,'time':.031,'parent_scan_id':4,'precursor_mz':peptide['mass']+PROTON}],
            scans=[np.array(sorted((mass,100.) for _,mass,_ in fragments(peptide['residue_masses'],1)))])
        result=analyze(self.make_sample(scans,msms),{'fasta':'PEPTIDER'})
        self.assertEqual(len(result['matches']),2)
        fragment,survey=result['matches']
        self.assertTrue(fragment['ms1_supported']);self.assertEqual(fragment['precursor_link'],'recorded parent')
        self.assertEqual(fragment['precursor_feature']['scan_id'],4)
        self.assertEqual(survey['evidence'],'ms1');self.assertEqual(survey['scan_id'],11)
        self.assertNotIn('_survey_ids',survey)
        self.assertEqual(result['coverage'][0]['ms_percent'],100.)

    def test_wrong_parent_or_distant_msms_does_not_hide_a_feature_or_claim_a_link(self):
        peptide=digest(parse_fasta('PEPTIDER'),0,[])[0][0]
        ions=np.array(sorted((mass,100.) for _,mass,_ in fragments(peptide['residue_masses'],1)))
        for parent,time in [(999,.031),(4,1.)]:
            channel=SimpleNamespace(metadata=[{'scan_id':99,'time':time,'parent_scan_id':parent,'precursor_mz':peptide['mass']+PROTON}],scans=[ions])
            result=analyze(self.make_sample(feature_scans(peptide),channel),{'fasta':'PEPTIDER'})
            self.assertEqual(len(result['matches']),2)
            row=next(r for r in result['matches'] if r['evidence']=='msms')
            self.assertFalse(row['ms1_supported']);self.assertEqual(row['precursor_link'],'unconfirmed')

    def test_missing_parent_uses_explicitly_labelled_local_inference_and_charge_must_match(self):
        from peptide_mapping import peptide_signature
        peptide=digest(parse_fasta('PEPTIDER'),0,[])[0][0]
        sample=self.make_sample(feature_scans(peptide))
        for charge,expected in [(1,True),(2,False)]:
            features=find_features(sample.qtof_channels[0,1],[peptide],10)
            row={k:v for k,v in peptide.items() if k!='residue_masses'} | {'time':.031,'precursor_mz':peptide['mass']+PROTON,'charge':charge}
            remaining=link_msms(features,[row],10,peptide_signature)
            self.assertEqual(row['ms1_supported'],expected)
            if expected:self.assertEqual(row['precursor_link'],'mass/charge/RT inferred')
            self.assertEqual(len(remaining),0 if expected else 1)

    def test_variable_site_features_do_not_create_mass_only_site_evidence(self):
        fasta='LIFAGKQLEDGR'
        mod={'chain':'A','position':6,'delta':114.04292747,'formula':'C4H6N2O2','kind':'gg','block_cleavage':True}
        peptide=digest(parse_fasta(fasta),0,[mod])[0][0]
        result=analyze(self.make_sample(feature_scans(peptide)),{'fasta':fasta,'modifications':[{'chain':'*','kind':'gg','search_all':True}]})
        self.assertFalse(any(r['site_search'] for r in result['matches']))
        self.assertEqual(result['coverage'][0]['ms_percent'],0)

    def test_changing_dda_survey_rate_is_not_mistaken_for_missing_scans(self):
        peptide=digest(parse_fasta('PEPTIDER'),0,[])[0][0]
        empty=np.empty((0,2));sample=self.make_sample([empty]*100+feature_scans(peptide))
        for i,meta in enumerate(sample.qtof_channels[0,1].metadata):
            meta['time']=i*.002 if i<100 else .2+(i-100)*.03
        self.assertTrue(analyze(sample,{'fasta':'PEPTIDER'})['matches'])

    def test_aligned_isotope_spacing_does_not_relax_reported_precursor_ppm(self):
        peptide=digest(parse_fasta('PEPTIDER'),0,[])[0][0]
        scans=feature_scans(peptide,shift_ppm=8.)
        for scan in scans:scan[0,0]=(peptide['mass']+PROTON)*(1+12e-6)
        rows=analyze(self.make_sample(scans),{'fasta':'PEPTIDER','precursor_ppm':10})['matches']
        self.assertEqual(len(rows),1);self.assertEqual(rows[0]['isotope_offset'],1)
        self.assertLessEqual(abs(rows[0]['precursor_error_ppm']),10)
        self.assert_precursor_target(rows[0],peptide['mass']+expected_envelope(peptide)[0][1]+PROTON)
        self.assertEqual(analyze(self.make_sample(feature_scans(peptide,shift_ppm=12.)),{'fasta':'PEPTIDER','precursor_ppm':10})['matches'],[])

    def test_packaged_feature_smoke_contract(self):
        from ms1_features import smoke_test
        self.assertEqual(smoke_test()['status'],'ok')

    def test_legacy_twenty_ppm_method_can_be_widened_explicitly(self):
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
        sample=self.make_sample(feature_scans(second),msms)
        result=analyze(sample,{'fasta':fasta,'missed_cleavages':0})
        coverage=result['coverage'][0]
        self.assertEqual(coverage['ms_percent'],50) # unlinked MS/MS does not invent an MS1 feature
        self.assertEqual(coverage['msms_percent'],50)
        self.assertEqual(coverage['ms_only_percent'],50)
        self.assertEqual(len(coverage['ms_positions']),6)

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
        peptide=digest(parse_fasta('PEPTIDER'),0,[])[0][0];mass=peptide['mass']
        sample=self.make_sample(feature_scans(peptide))
        rows=analyze(sample,{'fasta':'>one\nPEPTIDER\n>two\nPEPTLDER'})['matches']
        self.assertEqual(len(rows),2);self.assertTrue(all(r['ambiguous_scan'] for r in rows))
        for scan in [np.array([[(mass+PROTON)*(1+30e-6),100.]]),np.array([[mass+PROTON,.5],[200.,100.]])]:
            self.assertEqual(analyze(self.make_sample([scan]),{'fasta':'PEPTIDER'})['matches'],[])

    def test_explicit_five_percent_threshold_is_adjustable_and_updates_coverage(self):
        peptide=digest(parse_fasta('PEPTIDER'),0,[])[0][0]
        sample=self.make_sample(feature_scans(peptide,apex=4.,background=100.))
        strict=analyze(sample,{'fasta':'PEPTIDER'})
        self.assertEqual(strict['settings']['ms1_min_relative_percent'],5)
        self.assertEqual(strict['matches'],[])
        self.assertEqual(strict['coverage'][0]['ms_percent'],0)
        relaxed=analyze(sample,{'fasta':'PEPTIDER','ms1_min_relative_percent':1})
        self.assertEqual(len(relaxed['matches']),1)
        self.assertEqual(relaxed['matches'][0]['precursor_relative_intensity_pct'],4)
        self.assertEqual(relaxed['coverage'][0]['ms_percent'],100)
        self.assertEqual(relaxed['coverage'][0]['msms_percent'],0)

    def test_ms1_requires_both_intensity_cutoffs_and_preserves_measured_arrays(self):
        peptide=digest(parse_fasta('PEPTIDER'),0,[])[0][0];mz=peptide['mass']+PROTON
        scans=feature_scans(peptide,apex=10.,background=100.)
        originals=[s.copy() for s in scans];sample=self.make_sample(scans)
        result=analyze(sample,{'fasta':'PEPTIDER','ms1_min_relative_percent':5,'ms1_min_intensity':6})
        row=result['matches'][0]
        self.assertEqual(row['observation_count'],5)
        self.assertEqual(row['scan_id'],4)
        self.assertEqual(row['precursor_mz'],mz)
        self.assertEqual(row['precursor_intensity'],10)
        self.assertEqual(row['precursor_relative_intensity_pct'],10)
        self.assertEqual(result['settings']['ms1_min_intensity'],6)
        self.assertEqual(analyze(sample,{'fasta':'PEPTIDER','ms1_min_relative_percent':11})['matches'],[])
        self.assertEqual(analyze(sample,{'fasta':'PEPTIDER','ms1_min_intensity':11})['matches'],[])
        self.assertEqual(analyze(sample,{'fasta':'PEPTIDER','ms1_min_relative_percent':0,'ms1_min_intensity':0})['matches'][0]['observation_count'],5)
        for original,current in zip(originals,scans):np.testing.assert_array_equal(original,current)

    def test_ms1_threshold_boundaries_are_inclusive_and_invalid_values_rejected(self):
        peptide=digest(parse_fasta('PEPTIDER'),0,[])[0][0]
        sample=self.make_sample(feature_scans(peptide,apex=5.,background=100.))
        self.assertTrue(analyze(sample,{'fasta':'PEPTIDER','ms1_min_relative_percent':5,'ms1_min_intensity':5})['matches'])
        for key,values in [('ms1_min_relative_percent',[-1,101,float('nan'),float('inf'),None,True,'']),
                           ('ms1_min_intensity',[-1,1e16,float('nan'),float('inf'),None,False,''])]:
            for value in values:
                with self.subTest(key=key,value=value),self.assertRaisesRegex(ValueError,'MS-only'):
                    analyze(sample,{'fasta':'PEPTIDER',key:value})

    def test_ms1_thresholds_do_not_change_msms_assignments_or_coverage(self):
        peptide=digest(parse_fasta('PEPTIDER'),0,[])[0][0]
        channel=SimpleNamespace(metadata=[{'scan_id':99,'time':1.,'precursor_mz':peptide['mass']+PROTON}],
            scans=[np.array(sorted((mass,100.) for _,mass,_ in fragments(peptide['residue_masses'],1)))])
        sample=self.make_sample([np.array([[peptide['mass']+PROTON,100.]])],channel)
        before=analyze(sample,{'fasta':'PEPTIDER'})
        after=analyze(sample,{'fasta':'PEPTIDER','ms1_min_relative_percent':100,'ms1_min_intensity':1e15})
        self.assertEqual(after['matches'],before['matches'])
        self.assertEqual(after['coverage'],before['coverage'])

    def test_msms_charge_one_is_found_and_takes_precedence_over_ms_only(self):
        peptide=digest(parse_fasta('PEPTIDER'),0,[])[0][0]
        mz=peptide['mass']+PROTON
        ions=fragments(peptide['residue_masses'],1)
        channel=SimpleNamespace(metadata=[{'scan_id':99,'time':1.,'precursor_mz':mz}],
            scans=[np.array(sorted((mass,100.) for _,mass,_ in ions))])
        result=analyze(self.make_sample([np.array([[mz,100.]])],channel),{'fasta':'PEPTIDER'})
        self.assertEqual(len(result['matches']),1);row=result['matches'][0]
        self.assertEqual(row['evidence'],'msms');self.assertEqual(row['charge'],1)
        self.assert_precursor_target(row,mz)
        self.assertTrue(all('^2+' not in f['ion'] for f in row['fragments']))
        self.assertEqual(result['coverage'][0]['percent'],100.)

    def test_msms_theoretical_precursor_includes_modifications_charge_and_assigned_isotope(self):
        fasta='LIFAGKQLEDGR'
        mod={'chain':'A','position':6,'kind':'gg','delta':114.04292747,'formula':'C4H6N2O2','block_cleavage':True}
        peptide=digest(parse_fasta(fasta),0,[mod])[0][0]
        for z in (1,2,4):
            for isotope in (0,1,2):
                with self.subTest(charge=z,isotope=isotope):
                    theory=(peptide['mass']+z*PROTON+isotope*ISOTOPE)/z
                    measured=theory*(1-3.5e-6)
                    scan=np.array(sorted((mass,100.) for _,mass,_ in fragments(peptide['residue_masses'],min(2,z))))
                    channel=SimpleNamespace(metadata=[{'scan_id':99,'time':1.,'precursor_mz':measured}],scans=[scan])
                    rows=analyze(self.make_sample([],channel),{'fasta':fasta,'modifications':[mod],'missed_cleavages':0})['matches']
                    self.assertEqual(len(rows),1);row=rows[0]
                    self.assertEqual((row['charge'],row['isotope_offset']),(z,isotope))
                    self.assertEqual(row['precursor_mz'],measured)
                    self.assert_precursor_target(row,theory)
                    self.assertAlmostEqual(row['precursor_error_ppm'],-3.5)

    def test_ms1_ggisok_mass_and_unresolved_modification_exclusion(self):
        fasta='LIFAGKQLEDGR';mod={'chain':'A','position':6,'delta':114.04292747,'formula':'C4H6N2O2','block_cleavage':True}
        peptide=digest(parse_fasta(fasta),0,[mod])[0][0]
        sample=self.make_sample(feature_scans(peptide))
        result=analyze(sample,{'fasta':fasta,'modifications':[{**mod,'kind':'gg'}],'missed_cleavages':0})
        self.assertEqual(len(result['matches']),1);self.assertEqual(result['matches'][0]['modifications'][0]['residue'],6)
        row=result['matches'][0]
        self.assert_precursor_target(row,(peptide['mass']+expected_envelope(peptide)[0][row['isotope_offset']])/row['charge']+PROTON)
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
