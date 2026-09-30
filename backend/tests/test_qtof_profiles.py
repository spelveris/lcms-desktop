"""QTOF-only profile decoder and experimental reconstruction regressions."""
import inspect
import io
import struct
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import numpy as np
from pypdf import PdfReader
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from qtof_profiles import decode_rle
import qtof_profile_fit as pf


def blob(tokens, count=8, leading=0):
    return struct.pack('<ddIi', 10., .001, 0x90000000|count, -leading)+tokens


class ProfileTests(unittest.TestCase):
    def test_packaged_smoke_entrypoint(self):
        self.assertEqual(pf.smoke_test()['profile_reconstruction'], 'ok')

    def test_rle_literal_first_and_width_changes_keep_zeros(self):
        # literal 40000, then zero-run length 2 + one-byte width, literal 12.
        b=blob(struct.pack('<ii', 40000, -9)+struct.pack('<b', 12), leading=1)
        np.testing.assert_array_equal(decode_rle(b,8),[0,40000,0,0,12,0,0,0])
        b=blob(struct.pack('<i',-1)+struct.pack('<bb',5,-2)+struct.pack('<hh',1000,-3)+struct.pack('<i',60000))
        np.testing.assert_array_equal(decode_rle(b,8),[5,1000,60000,0,0,0,0,0])

    def test_rle_rejects_truncation_count_errors_and_bad_tokens(self):
        for b,n in [(blob(struct.pack('<i',7))[:-1],8), (blob(struct.pack('<i',-4)),8),
                    (blob(struct.pack('<i',-41)),8), (blob(struct.pack('<i',7)),7),
                    (blob(struct.pack('<ii',7,8),count=1),1), (blob(b'',leading=9),8)]:
            with self.assertRaises(ValueError):decode_rle(b,n)

    def test_average_profiles_integrates_calibrated_axis_not_sampling_density(self):
        x=np.linspace(600,601,101);y=x*0+12
        source=SimpleNamespace(window=lambda a,b:iter([
            {'mz':x,'intensities':y,'scan_id':1,'time':1.},
            {'mz':x[::2],'intensities':y[::2]*2,'scan_id':2,'time':1.1}]))
        edges=np.arange(600,601.001,.05)
        value,covered,count,apex=pf.average_profiles(SimpleNamespace(qtof_profile_source=source),.9,1.2,edges)
        np.testing.assert_allclose(value,18*.05,atol=1e-10)
        self.assertEqual(count,2);self.assertTrue(covered.all());self.assertEqual(apex['scan_id'],2)
        np.testing.assert_array_equal(y,x*0+12)

    def test_forward_operator_conserves_counts_and_signed_residual(self):
        mz=np.arange(900.025,1800,.05)
        g=pf.Geometry(9990,10050,mz,np.arange(6,11))
        ops=pf.charge_operators(g)
        for a in ops:np.testing.assert_allclose(np.asarray(a.sum(axis=0)).ravel(),1.,atol=1e-10)
        p=np.zeros(len(g.masses));p[10]=1e4;p[40]=700
        q=np.array([.1,.2,.4,.2,.1]);y=pf.combine(ops,q)@p
        original=y.copy();r=pf.reconstruct(y,g)
        np.testing.assert_allclose(r['predicted']+r['residual'],y,atol=1e-10)
        np.testing.assert_array_equal(y,original)
        self.assertEqual(r['mass'][np.argmax(r['profile'])],g.masses[10])
        self.assertGreater(r['profile'][40],0)
        self.assertTrue(np.all(r['profile']>=0))

    def test_reference_profile_wings_and_policy_off(self):
        s=SimpleNamespace(qtof_info={'reference_filter':{'targets':[{'mz':922.009798,'charge':1,'polarity':'positive'}],
            'policy':{'ppm':10,'isotopes':False}}})
        mz=np.array([921.,921.9,922.009798,922.2,923.])
        np.testing.assert_array_equal(pf.reference_mask(s,mz),[False,True,True,True,False])
        s.qtof_info['reference_filter']['targets']=[]
        self.assertFalse(pf.reference_mask(s,mz).any())

    def test_non_qtof_and_digest_cannot_enter_profile_mode(self):
        for info in [None,{'instrument':'G6120'},{'instrument':'G6545XT','is_protein_digest':True,'acquisition_method':'Protein_Digest'}]:
            with self.assertRaisesRegex(ValueError,'metadata-confirmed'):
                pf.run(SimpleNamespace(qtof_info=info),1,2)

    def test_api_keeps_envelope_assignments_and_does_not_mutate_legacy_request(self):
        s=SimpleNamespace(qtof_info={'instrument':'G6545XT','is_protein_digest':False,'acquisition_method':'Intact'},
            ms_scans=[np.array([[1000.,100.]])],qtof_channels={})
        args={k:v.default.default for k,v in inspect.signature(server.deconvolute).parameters.items()}
        args.update(path='file.sirslt',start=1.,end=2.,intact_method='profile',include_singly_charged=False)
        component={'mass':9990.,'intensity':100.,'charge_states':[8,9,10],'ion_mzs':[1000.],
                   'ion_charges':[10],'ion_intensities':[100.]}
        response={'components':[component.copy()], 'spectrum':{'mz':[1000.],'intensities':[100.]}}
        with patch.object(server,'_get_sample',return_value=s), \
             patch.object(server.analysis,'sum_spectra_in_range',return_value=(np.array([1000.]),np.array([100.]))), \
             patch.object(server.analysis,'deconvolute_protein_local_lcms_machine_like',return_value=[component]), \
             patch.object(server.qtof_deconvolution,'measured_window_spectrum',return_value=None), \
             patch.object(pf,'run',return_value=response) as fitting:
            result=server.deconvolute(**args)
        self.assertEqual(result['components'][0]['mass'],9990.)
        self.assertEqual(fitting.call_args.kwargs['reference_components'][0]['mass'],9990.)
        self.assertEqual(args['intact_method'],'profile')

    def test_fitted_profile_pdf_uses_supplied_curve_without_projection_or_smoothing(self):
        plot=server.plot_runtime.get('plotting')
        spectrum={'mz':[1000.], 'intensities':[100.], 'fitted_profile':{
            'mass':[9999.,10000.,10001.,10002.], 'intensity':[0.,100.,10.,0.], 'range':[9998.,10003.]}}
        with patch.object(plot,'_build_dense_zero_charge_profile',side_effect=AssertionError('must not reproject')):
            f=plot.create_dense_deconvoluted_mass_profile_figure('Synthetic',spectrum,{'fig_width':12})
        try:
            np.testing.assert_array_equal(f.axes[0].lines[0].get_ydata(),[0.,100.,10.,0.])
            text=PdfReader(io.BytesIO(plot.export_figure_pdf(f,tight=False))).pages[0].extract_text()
            self.assertIn('Experimental profile fit',text)
            self.assertIn('10,000.00 Da',text)
        finally:server.plt.close(f)


if __name__=='__main__':unittest.main()
