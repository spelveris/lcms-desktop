"""Known-mass controls, weak species, residual accounting and opt-in contracts."""
import copy
import inspect
import io
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from pypdf import PdfReader

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
import charge_profile as cp


def mixture(masses=(20000.1234, 20054.1234), heights=(1., .12)):
    x = np.arange(1000., 2200., .02)
    y = np.full(len(x), 12.)
    candidates = []
    charges = list(range(10, 19))
    for mass, amplitude in zip(masses, heights):
        centres = [mass/z + 1.007276 for z in charges]
        strengths = [amplitude*1e5*np.exp(-.5*((z-14)/2.5)**2) for z in charges]
        for centre, height in zip(centres, strengths):
            y += height*np.exp(-.5*((x-centre)/.09)**2)
        candidates.append(dict(mass=mass, intensity=sum(strengths), charge_states=charges,
            ion_mzs=centres, ion_charges=charges, ion_intensities=strengths))
    return x, y, candidates


class ChargeProfileTests(unittest.TestCase):
    def reconstruct(self, x, y, candidates, **settings):
        return cp.reconstruct(x, y, candidates, use_monoisotopic=True, noise_cutoff=100., **settings)

    def test_known_mass_and_minor_adduct_survive_with_full_precision(self):
        x, y, candidates = mixture()
        old = copy.deepcopy(candidates); original = y.copy()
        result = self.reconstruct(x, y, candidates)
        self.assertEqual(len(result['components']), 2)
        for component, expected in zip(result['components'], [20000.1234, 20054.1234]):
            self.assertLess(abs(component['mass']-expected), .01)
            self.assertEqual(component['charge_states'], list(range(10, 19)))
            self.assertTrue(component['charge_profile'])
        self.assertEqual(candidates, old)
        np.testing.assert_array_equal(y, original)
        profile = result['fitted_profile']
        self.assertEqual(profile['method'], 'charge-profile')
        self.assertTrue(np.all(np.diff(profile['mass']) > 0))

    def test_unrelated_large_spike_remains_unassigned_and_is_not_projected(self):
        x, y, candidates = mixture()
        at = int(np.argmin(abs(x-1055.2)))
        y[at] += 1e7
        result = self.reconstruct(x, y, candidates)
        check = result['fit_check']
        self.assertEqual(check['predicted'][at], 0.)
        self.assertEqual(check['residual'][at], y[at])
        np.testing.assert_allclose(np.array(check['predicted'])+check['residual'], y, rtol=0, atol=1e-10)
        self.assertGreater(result['unexplained_fraction'], .5)
        self.assertLess(max(result['fitted_profile']['mass']), 20100)

    def test_one_peak_cannot_create_a_multi_charge_component(self):
        x, y, candidates = mixture(masses=(20000.,), heights=(1.,))
        ion = candidates[0]
        ion['ion_charges'] = [10]; ion['ion_mzs'] = ion['ion_mzs'][:1]; ion['ion_intensities'] = [1e5]
        result = self.reconstruct(x, y, candidates)
        self.assertEqual(result['components'], [])
        np.testing.assert_array_equal(result['fit_check']['residual'], y)

    def test_coincident_dominant_ion_cannot_override_the_remaining_series(self):
        x, y, candidates = mixture(masses=(20000.1234,), heights=(1.,))
        centre=candidates[0]['ion_mzs'][0]
        y += 1e8*np.exp(-.5*((x-centre)/.09)**2)
        result=self.reconstruct(x,y,candidates)
        self.assertEqual(len(result['components']),1)
        self.assertNotIn(10,result['components'][0]['charge_states'])
        self.assertLess(abs(result['components'][0]['mass']-20000.1234),.01)
        apex=int(np.argmax(y))
        self.assertEqual(result['fit_check']['predicted'][apex],0.)

    def test_complete_detector_and_profile_workflow_retains_weak_adduct(self):
        x,y,_=mixture()
        result=server._run_report_deconvolution(x,y,{
            'intact_method':'charge-profile','include_singly_charged':False,
            'min_charge':8,'max_charge':22,'min_peaks':4,'pwhh':.3,'noise_cutoff':100,
            'low_mw':18000,'high_mw':22000,'use_monoisotopic':True})
        self.assertEqual(len(result),2)
        self.assertLess(abs(result[0]['mass']-20000.1234),.01)
        self.assertLess(abs(result[1]['mass']-20054.1234),.01)

    def test_centroid_cutoff_and_charge_shape_agreement_have_effect(self):
        x, y, candidates = mixture(masses=(20000.,), heights=(1.,))
        for z in range(10, 19):
            y += 1e4*np.exp(-.5*((x-(20004./z+1.007276))/.07)**2)
        low = self.reconstruct(x, y, candidates, centroid_cutoff=.15)
        high = self.reconstruct(x, y, candidates, centroid_cutoff=.8)
        self.assertGreater(abs(low['components'][0]['mass']-high['components'][0]['mass']), .05)
        tolerant = self.reconstruct(x, y, candidates, profile_agreement=.1)
        strict = self.reconstruct(x, y, candidates, profile_agreement=1.)
        self.assertTrue(tolerant['components'])
        self.assertEqual(strict['components'], [])

    def test_no_signal_invalid_inputs_and_invalid_settings(self):
        x = np.arange(10., 20., .1); y = np.zeros(len(x))
        self.assertEqual(self.reconstruct(x, y, [])['components'], [])
        for bad_x, bad_y in [(x[::-1], y), (x, y[:-1]), (x, y-1), (x*float('nan'), y)]:
            with self.assertRaises(ValueError): self.reconstruct(bad_x, bad_y, [])
        for settings in [dict(centroid_cutoff=1), dict(centroid_cutoff=0), dict(profile_agreement=1.01), dict(pwhh=0)]:
            with self.assertRaises(ValueError): self.reconstruct(x, y, [], **settings)

    def test_api_opt_in_preserves_calculation_input_and_default_dispatch(self):
        x, y, candidates = mixture()
        sample = SimpleNamespace(ms_scans=[np.c_[x, y]], qtof_info=None, _debug_info={'sirslt_ms_source':'MSProfile.bin'})
        args = {name:p.default.default for name,p in inspect.signature(server.deconvolute).parameters.items()}
        args.update(path='test.sirslt', start=1., end=2., include_singly_charged=False,
                    intact_method='charge-profile', use_monoisotopic=True, noise_cutoff=100.)
        with patch.object(server, '_get_sample', return_value=sample), \
             patch.object(server, '_sum_agilent_centroid_cdf_spectra', return_value=(x,y)), \
             patch.object(server.analysis, 'deconvolute_protein_local_lcms_machine_like', return_value=candidates):
            result = server.deconvolute(**args)
            self.assertEqual(result['workflow']['id'], 'charge-profile')
            np.testing.assert_array_equal(result['spectrum']['intensities'], y)
            self.assertTrue(result['components'][0]['charge_profile'])
            with patch.object(cp, 'reconstruct', side_effect=AssertionError('Default must not opt in')):
                default = server.deconvolute(**{**args, 'intact_method':'envelope'})
            self.assertNotIn('fitted_profile', default['spectrum'])

    def test_all_three_instrument_families_use_storage_appropriate_math(self):
        _,_,candidates=mixture()
        points=sorted((mz,height) for c in candidates for mz,height in zip(c['ion_mzs'],c['ion_intensities']))
        x,y=np.array(points).T
        # These are acquired centroid coordinates, not sampled Gaussian shapes.
        for family,path,debug,info in [
            ('legacy','old.D',{},None),
            ('proiq','new.sirslt',{'sirslt_ms_source':'MSPeak.bin'},None),
            ('qtof','also.sirslt',{}, {'instrument':'G6545XT','is_protein_digest':False,'acquisition_method':'Intact'})]:
            sample=SimpleNamespace(ms_times=np.array([1.5]),ms_mz_axis=None,ms_scans=[np.c_[x,y]],
                                   qtof_info=info,_debug_info=debug)
            self.assertEqual(server._deconvolution_family(sample,path),family)
            args={name:p.default.default for name,p in inspect.signature(server.deconvolute).parameters.items()}
            args.update(path=path,start=1.,end=2.,intact_method='charge-profile',use_monoisotopic=True,noise_cutoff=100.)
            with patch.object(server,'_get_sample',return_value=sample), \
                 patch.object(server,'_sum_agilent_centroid_cdf_spectra',return_value=None), \
                 patch.object(server.analysis,'sum_spectra_in_range',return_value=(x,y)), \
                 patch.object(server.analysis,'deconvolute_protein_local_lcms_machine_like',return_value=candidates), \
                 patch.object(server.qtof_deconvolution,'measured_window_spectrum',return_value=None):
                result=server.deconvolute(**args)
            self.assertEqual(result['workflow']['input_kind'],'centroid')
            self.assertEqual(len(result['components']),2)
            self.assertLess(abs(result['components'][0]['mass']-20000.1234),1e-8)
            np.testing.assert_array_equal(result['spectrum']['mz'],x)
            self.assertTrue(result['spectrum']['fitted_profile']['sticks'])
            check=result['fit_check']
            np.testing.assert_allclose(np.array(check['predicted'])+check['residual'],y)

    def test_centroid_sum_preserves_exact_nearby_coordinates_and_identical_scan_counts(self):
        points=np.array([[500.123456789,10.],[500.123456799,20.],[800.,5.]])
        sample=SimpleNamespace(ms_times=np.array([1.,1.1]),ms_mz_axis=None,ms_scans=[points,points.copy()])
        x,y=cp.sum_centroids(sample,.9,1.2)
        np.testing.assert_array_equal(x,points[:,0])
        np.testing.assert_array_equal(y,points[:,1]*2)
        with self.assertRaisesRegex(ValueError,'Narrow the time window'):cp.sum_centroids(sample,.9,1.2,limit=2)

    def test_centroid_reconstruction_uses_all_compatible_survey_observations(self):
        _,_,candidates=mixture(masses=(20000.1234,),heights=(1.,))
        observations=sorted((mz+offset,height/2) for mz,height in zip(candidates[0]['ion_mzs'],candidates[0]['ion_intensities'])
                            for offset in [-.000001,.000001])
        x,y=np.array(observations).T
        result=cp.reconstruct_centroids(x,y,candidates,use_monoisotopic=True,noise_cutoff=100)
        self.assertEqual(len(result['components']),1)
        self.assertLess(abs(result['components'][0]['mass']-20000.1234),1e-8)
        np.testing.assert_array_equal(result['fit_check']['predicted'],y)
        self.assertEqual(result['unexplained_fraction'],0.)

    def test_identical_profile_blank_yields_no_mass_and_wrong_instrument_blank_is_rejected(self):
        x,y,candidates=mixture()
        sample=SimpleNamespace(ms_scans=[np.c_[x,y]],qtof_info=None,
                               _debug_info={'sirslt_ms_source':'MSProfile.bin'})
        qtof=SimpleNamespace(ms_scans=[np.c_[x,y]],qtof_info={'instrument':'G6545XT'})
        args={name:p.default.default for name,p in inspect.signature(server.deconvolute).parameters.items()}
        args.update(path='sample.sirslt',background_path='blank.sirslt',start=1.,end=2.,intact_method='charge-profile')
        with patch.object(server,'_get_sample',return_value=sample), \
             patch.object(server,'_sum_agilent_centroid_cdf_spectra',return_value=(x,y)), \
             patch.object(server.analysis,'deconvolute_protein_local_lcms_machine_like',return_value=candidates):
            result=server.deconvolute(**args)
        self.assertEqual(result['components'],[])
        self.assertTrue(all(v==0 for v in result['spectrum']['intensities']))
        np.testing.assert_array_equal(result['raw_spectrum']['intensities'],y)
        with patch.object(server,'_get_sample',side_effect=[sample,qtof]):
            with self.assertRaises(server.HTTPException) as caught:server.deconvolute(**args)
        self.assertIn('same instrument family',caught.exception.detail)

    def test_dense_pdf_uses_reconstructed_curve_not_all_charge_projection(self):
        x, y, candidates = mixture()
        result = self.reconstruct(x, y, candidates)
        plot = server.plot_runtime.get('plotting')
        spectrum = {'mz':x.tolist(),'intensities':y.tolist(),'fitted_profile':result['fitted_profile']}
        with patch.object(plot,'_build_dense_zero_charge_profile',side_effect=AssertionError('must not reproject')):
            fig = plot.create_dense_deconvoluted_mass_profile_figure('Known mass', spectrum)
        try:
            pdf = plot.export_figure_pdf(fig,tight=False)
            text = PdfReader(io.BytesIO(pdf)).pages[0].extract_text()
            self.assertIn('Charge-constrained profile',text)
            self.assertIn('20,000.',text)
            self.assertIn(f"{result['components'][0]['mass']:,.2f} Da",text)
            self.assertEqual(len(fig.axes[0].lines[0].get_ydata()),len(result['fitted_profile']['mass']))
        finally:server.plt.close(fig)

    def test_centroid_pdf_draws_only_transformed_measured_sticks(self):
        _,_,candidates=mixture()
        points=np.array(sorted((mz,height) for c in candidates for mz,height in zip(c['ion_mzs'],c['ion_intensities'])))
        result=cp.reconstruct_centroids(points[:,0],points[:,1],candidates,use_monoisotopic=True,noise_cutoff=100)
        plot=server.plot_runtime.get('plotting')
        with patch.object(plot,'_build_dense_zero_charge_profile',side_effect=AssertionError('must not project all charges')):
            fig=plot.create_dense_deconvoluted_mass_profile_figure('Centroid',{'fitted_profile':result['fitted_profile']})
        try:
            self.assertEqual(len(fig.axes[0].lines),0)
            self.assertEqual(len(fig.axes[0].collections[0].get_segments()),len(result['fitted_profile']['mass']))
            text=PdfReader(io.BytesIO(plot.export_figure_pdf(fig,tight=False))).pages[0].extract_text()
            self.assertIn('Charge-assigned centroid masses',text)
        finally:server.plt.close(fig)

    def test_centroid_labels_keep_the_component_centroid_when_it_falls_between_sticks(self):
        plot=server.plot_runtime.get('plotting')
        peaks=plot._dense_profile_label_peaks(np.array([19999.7,19999.8,20000.5,20054.]),
            np.array([0.,100.,0.,10.]),[19990.,20060.],assigned_masses=[20000.,20054.],stick_assignments=True)
        self.assertEqual(peaks[0]['label_mass'],20000.)
        self.assertEqual(peaks[0]['mass'],19999.8)
        self.assertEqual(peaks[0]['intensity'],100.)


if __name__ == '__main__': unittest.main()
