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
        qtof_channels={(0,1):channel},ms_scans=channel.scans)
    return sample,neutral


class IsotopeAwareTests(unittest.TestCase):
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
        params.update(path='synthetic.sirslt',start=.9,end=1.1,background_path=None)
        with patch.object(server,'_get_sample',return_value=s),patch.object(server.analysis,'sum_spectra_in_range',side_effect=AssertionError('Must not rebin')):
            result=server.deconvolute(**params)
        self.assertEqual(result['workflow']['id'],'qtof-isotope-aware')
        serialized=server._serialize_deconvolution_components(result['components'])
        self.assertEqual(serialized[0]['envelopes'],result['components'][0]['envelopes'])
        self.assertIsNone(serialized[0]['r2'])


if __name__=='__main__': unittest.main()
