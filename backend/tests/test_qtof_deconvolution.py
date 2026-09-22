"""Synthetic public-data tests; no research files or sequences required."""
import inspect
import sys
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import server
import qtof_deconvolution as qd


def synthetic_sample():
    from brainpy import isotopic_variants
    composition={'C':500,'H':800,'N':140,'O':150,'S':4}
    neutral=list(isotopic_variants(composition,charge=0,npeaks=20))[0].mz
    peaks=[]
    for z in [8,9,10]:
        peaks.extend((p.mz,p.intensity*1e6) for p in isotopic_variants(composition,charge=z,npeaks=20) if p.intensity>1e-5)
    scan=np.array(sorted(peaks))
    channel=SimpleNamespace(metadata=[{'scan_id':1,'time':1.},{'scan_id':2,'time':1.01}],scans=[scan,scan.copy()])
    sample=SimpleNamespace(qtof_info={'instrument':'G6545XT','is_protein_digest':False,'acquisition_method':'Intact_Mass'},
        qtof_channels={(0,1):channel},ms_scans=channel.scans,
        ms_times=np.array([1.,1.01]),ms_mz_axis=None)
    return sample,neutral


class IsotopeAwareTests(unittest.TestCase):
    def test_envelope_display_uses_local_measured_peaks_without_refitting(self):
        import copy
        c={'mass':14861.3,'ion_mzs':[1352.0293354,1239.446568,1144.189815],
           'ion_intensities':[35625.,26778.,22237.], 'ion_charges':[11,12,13]}
        before=copy.deepcopy(c)
        mz=np.array([1143.,1144.101,1144.19,1239.446,1239.525,1352.029,1352.116,1353.])
        intensity=np.array([9e8,163281.,0.,0.,181024.,0.,334400.,9e8])
        original=intensity.copy()
        server.analysis.add_charge_display_peaks([c],mz,intensity,.6)
        self.assertEqual([p['mz'] for p in c['ion_display_peaks']],[1352.116,1239.525,1144.101])
        self.assertEqual([p['intensity'] for p in c['ion_display_peaks']],[334400.,181024.,163281.])
        for key,value in before.items():self.assertEqual(c[key],value)
        np.testing.assert_array_equal(intensity,original)
        serialized=server._sort_serialized_deconvolution_results([c])[0]
        self.assertEqual(serialized['ion_display_peaks'],c['ion_display_peaks'])

    def test_display_regions_stop_at_other_assignments_and_do_not_reach_distant_peaks(self):
        a={'ion_mzs':[500.], 'ion_charges':[10]}
        b={'ion_mzs':[500.2], 'ion_charges':[10]}
        empty={'ion_mzs':[800.]}
        isotope={'isotope_aware':True,'ion_mzs':[900.]}
        server.analysis.add_charge_display_peaks([a,b,empty,isotope],
            np.array([499.95,500.15,500.2,801.]),np.array([12.,1000.,300.,999999.]),.6)
        self.assertEqual(a['ion_display_peaks'][0]['mz'],499.95)
        self.assertEqual(b['ion_display_peaks'][0]['mz'],500.15)
        self.assertEqual(empty['ion_display_peaks'],[None])
        self.assertNotIn('ion_display_peaks',isotope)
        server.analysis.add_charge_display_peaks([empty],np.array([800.]),np.array([0.]),.6)
        self.assertEqual(empty['ion_display_peaks'],[None])

    def test_export_charge_marker_uses_measured_bin_height_not_fitted_centre(self):
        import matplotlib.pyplot as plt
        component={'mass':14861.,'intensity':100.,'charge_states':[11],
                   'ion_mzs':[1352.03],'ion_charges':[11],'ion_intensities':[35000.]}
        mz=np.array([1352.,1352.03,1352.116,1352.5]);y=np.array([0.,0.,334400.,0.])
        server.analysis.add_charge_display_peaks([component],mz,y,.6)
        figure=server.plotting.create_ion_selection_figure(mz,y,[component],{'show_grid':False})
        try:
            segment=figure.axes[0].collections[0].get_segments()[0]
            np.testing.assert_array_equal(segment,[[1352.116,0.],[1352.116,334400.]])
            self.assertEqual(figure.axes[0].texts[0].xy,(1352.116,334400.))
        finally:plt.close(figure)

    def test_measured_marker_metadata_is_added_for_both_qtof_and_legacy_envelope_results(self):
        s,_=synthetic_sample()
        component={'mass':1000.,'intensity':100.,'ion_mzs':[500.1],
                   'ion_charges':[2],'ion_intensities':[100.]}
        params={n:p.default.default for n,p in inspect.signature(server.deconvolute).parameters.items()}
        params.update(path='qtof-name-is-not-metadata.sirslt',start=.9,end=1.1,include_singly_charged=False)
        for qtof in [True,False]:
            if not qtof:s.qtof_info=None
            with patch.object(server,'_get_sample',return_value=s), \
                 patch.object(server.analysis,'sum_spectra_in_range',return_value=(np.array([500.,500.1,500.2]),np.array([0.,100.,0.]))), \
                 patch.object(server.analysis,'deconvolute_protein_local_lcms_machine_like',return_value=[component]):
                result=server.deconvolute(**params)
            self.assertEqual(result['components'][0]['ion_display_peaks'][0]['mz'],500.1)
            self.assertEqual(result['components'][0]['ion_mzs'],component['ion_mzs'])
            self.assertEqual(result['components'][0]['mass'],component['mass'])

    def test_legacy_report_gets_same_display_peak_without_changing_fitting_defaults(self):
        component={'mass':18790.9,'intensity':100.,'ion_mzs':[940.55],
                   'ion_charges':[20],'ion_intensities':[95.]}
        mz=np.array([940.3,940.4,940.5,940.6,940.7,940.8])
        y=np.array([5.,20.,90.,100.,30.,5.])
        with patch.object(server.analysis,'deconvolute_protein_local_lcms_machine_like',return_value=[component]) as fitter:
            result=server._run_report_deconvolution(mz,y,{'include_singly_charged':False},qtof=False)
        self.assertEqual(result[0]['ion_display_peaks'][0]['mz'],940.6)
        self.assertEqual(result[0]['ion_display_peaks'][0]['intensity'],100.)
        self.assertEqual(result[0]['ion_mzs'],[940.55])
        self.assertEqual(result[0]['mass'],18790.9)
        self.assertEqual(fitter.call_args.kwargs['pwhh'],.6)
        self.assertIsNone(fitter.call_args.kwargs['smoothing_reference_step'])

    def test_metadata_not_filename_enables_only_this_instrument_intact_workflow(self):
        s,_=synthetic_sample();self.assertTrue(qd.is_intact_qtof(s))
        for change in [{'instrument':'G6120'},{'instrument':'G6546'},{'is_protein_digest':True},
                       {'acquisition_method':'Protein_Digest'},{'acquisition_method':''}]:
            other=SimpleNamespace(qtof_info={**s.qtof_info,**change})
            self.assertFalse(qd.is_intact_qtof(other))
        self.assertFalse(qd.is_intact_qtof(SimpleNamespace(qtof_info=None)))

    def test_known_formula_multiple_charges_raw_coordinates_and_all_scans(self):
        s,mass=synthetic_sample();original=s.ms_scans[0].copy()
        result=qd.run(s,.9,1.1)
        self.assertEqual(result['workflow']['scans_analyzed'],2)
        self.assertTrue(result['components'])
        c=result['components'][0]
        self.assertLess(abs(c['mass']-mass)/mass*1e6,3.)
        self.assertEqual(c['charge_states'],[8,9,10])
        self.assertEqual(c['scan_count'],2);self.assertIsNone(c['r2'])
        np.testing.assert_array_equal(s.ms_scans[0],original)
        np.testing.assert_array_equal(result['spectrum']['mz'],original[:,0])
        self.assertIsNone(result['spectrum']['mz_grid_step'])
        for peak in result['spectrum']['isotope_profile']:
            self.assertIn(peak['mz'],original[:,0])
            self.assertEqual(peak['mass'],(peak['mz']-qd.PROTON)*peak['charge'])

    def test_blank_subtraction_never_moves_measured_centroids_and_empty_result_is_allowed(self):
        s,_=synthetic_sample();result=qd.run(s,.9,1.1,background=s)
        self.assertEqual(result['components'],[])
        self.assertEqual(result['spectrum']['isotope_profile'],[])
        self.assertTrue(all(v==0 for v in result['spectrum']['intensities']))
        self.assertEqual(result['raw_spectrum']['mz'],result['spectrum']['mz'])
        raw=np.array([[500.123456789,10.],[700.7654321,5.]])
        sub=qd.subtract_centroids(raw,np.array([[500.1235,3.],[701.,5.]]))
        np.testing.assert_array_equal(sub[:,0],raw[:,0]);np.testing.assert_array_equal(sub[:,1],[7.,5.])
        with self.assertRaisesRegex(ValueError,'background must cover'):qd.run(s,.9,1.1,background=SimpleNamespace(qtof_channels={(0,1):SimpleNamespace(metadata=[{'time':2.}],scans=[raw])}))

    def test_unstructured_peaks_do_not_get_arbitrary_charge_projections(self):
        s,_=synthetic_sample();s.qtof_channels[(0,1)].scans=[np.array([[400.,1000.],[650.,2000.],[923.,1500.]])]*2
        self.assertEqual(qd.run(s,.9,1.1)['components'],[])

    def test_api_dispatch_and_serialization_preserve_isotope_evidence(self):
        s,_=synthetic_sample()
        params={n:p.default.default for n,p in inspect.signature(server.deconvolute).parameters.items()}
        params.update(path='synthetic.sirslt',start=.9,end=1.1,background_path=None,intact_method='isotope')
        with patch.object(server,'_get_sample',return_value=s),patch.object(server.analysis,'sum_spectra_in_range',side_effect=AssertionError('Must not rebin')):
            result=server.deconvolute(**params)
        self.assertEqual(result['workflow']['id'],'qtof-isotope-aware')
        serialized=server._serialize_deconvolution_components(result['components'])
        self.assertEqual(serialized[0]['envelopes'],result['components'][0]['envelopes'])
        self.assertIsNone(serialized[0]['r2'])

    def test_default_restores_time_window_sum_and_legacy_parameters(self):
        s,_=synthetic_sample()
        params={n:p.default.default for n,p in inspect.signature(server.deconvolute).parameters.items()}
        params.update(path='synthetic.sirslt',start=.9,end=1.1,background_path=None,include_singly_charged=False)
        with patch.object(server,'_get_sample',return_value=s), \
             patch.object(qd,'run',side_effect=AssertionError('Isotope fitting must be opt-in')), \
             patch.object(server.analysis,'deconvolute_protein_local_lcms_machine_like',return_value=[]) as old:
            result=server.deconvolute(**params)
        self.assertEqual(result['workflow']['id'],'qtof-envelope')
        self.assertEqual(result['spectrum']['mz_grid_step'],.001)
        self.assertAlmostEqual(sum(result['spectrum']['intensities']),sum(scan[:,1].sum() for scan in s.ms_scans),places=5)
        self.assertEqual(old.call_args.kwargs['pwhh'],.6)
        self.assertEqual(old.call_args.kwargs['max_charge'],50)
        np.testing.assert_array_equal(result['measured_spectrum']['mz'],s.ms_scans[0][:,0])
        np.testing.assert_array_equal(result['measured_spectrum']['intensities'],s.ms_scans[0][:,1]*2)

    def test_raw_inspection_preserves_nearby_coordinates_and_bounds_without_downsampling(self):
        s,_=synthetic_sample()
        s.qtof_channels[(0,1)].scans=[np.array([[500.123456789,10.]]),np.array([[500.123456799,20.]])]
        raw=qd.measured_window_spectrum(s,.9,1.1)
        self.assertEqual(raw['mz'],[500.123456789,500.123456799])
        self.assertEqual(raw['intensities'],[10.,20.])
        self.assertTrue(raw['before_background_subtraction'])
        self.assertIsNone(qd.measured_window_spectrum(s,.9,1.1,limit=1))
        self.assertIsNone(qd.measured_window_spectrum(s,2,3))

    def test_optional_mode_rejects_unsupported_instruments_and_invalid_modes(self):
        s,_=synthetic_sample();self.assertFalse(qd.use_isotope_workflow(s))
        self.assertTrue(qd.use_isotope_workflow(s,'isotope'))
        for other,mode in [(SimpleNamespace(qtof_info=None),'isotope'),(s,'automatic-isotopes')]:
            with self.assertRaises(ValueError):qd.use_isotope_workflow(other,mode)

    def test_ion_export_uses_the_displayed_subtracted_spectrum_in_default_mode(self):
        s,_=synthetic_sample();s.name='Synthetic'
        from matplotlib.figure import Figure
        payload={'path':'synthetic','start':.9,'end':1.1,'format':'pdf','components':[{'mass':1000}],
                 'spectrum':{'mz':[500.123456789,501.234567891],'intensities':[0.,3.]}}
        with patch.object(server,'_get_sample',return_value=s), \
             patch.object(server.plotting,'create_ion_selection_figure',return_value=Figure()) as draw, \
             patch.object(server.plotting,'export_figure_pdf',return_value=b'%PDF-test'), \
             patch.object(server.analysis,'sum_spectra_in_range',side_effect=AssertionError('Do not replace displayed blank subtraction')):
            server.export_ion_selection(payload)
        np.testing.assert_array_equal(draw.call_args.args[0],payload['spectrum']['mz'])
        np.testing.assert_array_equal(draw.call_args.args[1],[0.,3.])

    def test_report_rejects_cached_results_from_the_other_analysis_mode(self):
        s,_=synthetic_sample();s.uv_data=None
        with patch.object(server,'_get_sample',return_value=s),self.assertRaises(server.HTTPException) as cm:
            server.export_report_pdf({'path':'synthetic','deconv_results':[{'mass':1000.,'isotope_aware':True}]})
        self.assertEqual(cm.exception.status_code,400)

    def test_integer_multiple_mass_flags_require_shared_ions_and_do_not_delete_results(self):
        rows=[{'mass':10000.,'ion_mzs':[501.,1001.,1251.]},
              {'mass':20000.,'ion_mzs':[501.,1001.,1251.]},
              {'mass':30000.,'ion_mzs':[601.,1101.,1351.]}]
        qd.flag_charge_ambiguities(rows)
        self.assertEqual(len(rows),3)
        self.assertTrue(rows[0]['review_flags']);self.assertTrue(rows[1]['review_flags'])
        self.assertEqual(rows[2]['review_flags'],[])


if __name__=='__main__': unittest.main()
