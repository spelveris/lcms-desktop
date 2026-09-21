"""Synthetic QTOF grid, intensity-scale and API regression checks."""
import inspect
import sys
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
analysis = server.analysis


class QtofGridTests(unittest.TestCase):
    def sample(self, peaks, qtof=True):
        return SimpleNamespace(qtof_info={} if qtof else None, ms_times=np.array([1.]),
            ms_scans=[np.array(peaks)], ms_mz_axis=None, tic=np.array([sum(p[1] for p in peaks)]))

    def test_fixed_fine_grid_preserves_counts_and_limits_rounding_error(self):
        points=np.array([[400.12349,1.25],[400.12351,3.5],[400.12348,2.]])
        mz,intensity=analysis.sum_qtof_centroids(np.array([1.]),[points],0,2)
        np.testing.assert_allclose(np.diff(mz),.001,atol=1e-12)
        self.assertAlmostEqual(intensity.sum(),6.75)
        np.testing.assert_allclose(mz[intensity>0],[400.123,400.124])
        np.testing.assert_allclose(intensity[intensity>0],[3.25,3.5])
        self.assertTrue(all(np.min(abs(mz-value)) <= .000500001 for value in points[:,0]))
        self.assertEqual(intensity[0],0);self.assertEqual(intensity[-1],0)
        np.testing.assert_array_equal(points,[[400.12349,1.25],[400.12351,3.5],[400.12348,2.]])

    def test_empty_time_range_single_point_and_invalid_data(self):
        self.assertEqual(len(analysis.sum_qtof_centroids(np.array([1.]),[np.array([[100.,1.]])],2,3)[0]),0)
        mz,counts=analysis.sum_qtof_centroids(np.array([1.]),[np.array([[100.,1.]])],0,2)
        self.assertEqual(len(mz),3);self.assertEqual(counts.tolist(),[0.,1.,0.])
        for bad in [[[100.,-1.]],[[float('nan'),1.]],[[100001.,1.]],[[1.,1.],[20000.,1.]]]:
            with self.assertRaises(ValueError):analysis.sum_qtof_centroids(np.array([1.]),[np.array(bad)],0,2)

    def test_only_redundant_display_zeros_are_removed(self):
        mz=np.arange(15)*.001;counts=np.array([0,0,0,10,2,0,0,0,0,0,5,0,0,0,0])
        compact,values=analysis.compact_spectrum_zero_runs(mz,counts)
        self.assertLess(len(compact),len(mz));self.assertEqual(values.sum(),counts.sum())
        np.testing.assert_allclose(np.interp(mz,compact,values),counts)

    def test_legacy_summation_path_remains_unchanged(self):
        sample=self.sample([[400.1234,2.],[500.5678,3.]],False)
        expected=analysis.sum_spectra_from_channel(sample.ms_times,sample.ms_scans,None,0,2)
        actual=analysis.sum_spectra_in_range(sample,0,2)
        for left,right in zip(expected,actual):np.testing.assert_array_equal(left,right)

    def test_smoothing_retains_old_threshold_scale_on_fine_grid(self):
        coarse=np.arange(10000,10201)*.01;fine=np.arange(100000,102001)*.001
        c=np.zeros(len(coarse));f=np.zeros(len(fine));c[100]=f[1000]=10000.
        old=analysis._smooth_spectrum(coarse,c,.6)
        new=analysis._smooth_spectrum(fine,f,.6,.01)
        self.assertAlmostEqual(float(new.max()/old.max()),1.,places=3)
        np.testing.assert_array_equal(analysis._smooth_spectrum(fine,f,0,.01),f)

    def test_vectorized_peak_finder_preserves_plateau_and_tie_behavior(self):
        def previous(values,distance):
            indexes=[i for i in range(1,len(values)-1) if values[i]>=values[i-1] and values[i]>=values[i+1]]
            blocked=set();result=[]
            for index in sorted(indexes,key=lambda i:values[i],reverse=True):
                if index in blocked:continue
                result.append(index);blocked.update(range(index-distance+1,index+distance))
            return sorted(result)
        values=np.random.default_rng(7).integers(0,10,1000)
        for distance in [2,3,20,600]:
            self.assertEqual(analysis._find_peaks_simple(values,distance),previous(values,distance))

    def test_api_keeps_full_grid_for_calculations_and_compacts_only_display(self):
        sample=self.sample([[400.,100.],[410.,50.]])
        blank=self.sample([[400.,20.],[410.,10.]])
        params={name:parameter.default.default for name,parameter in inspect.signature(server.deconvolute).parameters.items()}
        params.update(path='/sample.sirslt',background_path='/blank.sirslt',start=0,end=2,min_input_mz=0,include_singly_charged=False)
        with patch.object(server,'_get_sample',side_effect=lambda path:sample if path=='/sample.sirslt' else blank), \
             patch.object(analysis,'deconvolute_protein_local_lcms_machine_like',return_value=[]) as calculate:
            result=server.deconvolute(**params)
        args,kwargs=calculate.call_args
        np.testing.assert_allclose(np.diff(args[0]),.001,atol=1e-12)
        self.assertAlmostEqual(args[1].sum(),120.)
        self.assertGreater(len(args[0]),len(result['spectrum']['mz']))
        self.assertEqual(kwargs['smoothing_reference_step'],.01)
        self.assertEqual(result['spectrum']['mz_grid_step'],.001)
        self.assertEqual(result['spectrum_source'],'qtof_centroid_grid')


if __name__=='__main__':unittest.main()
