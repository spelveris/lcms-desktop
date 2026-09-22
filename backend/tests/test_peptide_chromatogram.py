"""Synthetic acquisition data only; extraction must not alter mapping evidence."""
from copy import deepcopy
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from data_reader import SampleData
from peptide_mapping import precursor_chromatogram
from qtof_reader import QtofChannel
from reference_masses import PRESETS


def fixture():
    sample=SampleData('/synthetic-digest.sirslt')
    sample.qtof_info={'instrument':'Synthetic QTOF','is_protein_digest':True,'reference_method':{}}
    scans=[np.array([[500.,1.]]),np.array([[499.994,500.],[499.999,2.],[500.004,3.],[500.006,800.]]),
           np.empty((0,2)),np.array([[500.,4.],[501.,900.]])]
    channel=QtofChannel(np.array([.125,.5,1.75,3.]),np.array([100.,1500.,50.,1000.]),scans,
                        [{'scan_id':i,'time':t,'ms_level':1} for i,t in enumerate([.125,.5,1.75,3.])])
    sample.qtof_channels={(0,1):channel,
        (0,2):QtofChannel(np.array([.6]),np.array([1e9]),[np.array([[500.,1e9]])],[{'scan_id':10,'time':.6,'ms_level':2}]),
        (1,1):QtofChannel(np.array([.7]),np.array([1e8]),[np.array([[500.,1e8]])],[{'scan_id':11,'time':.7,'ms_level':1}])}
    sample.ms_times_pos=sample.ms_times=channel.times
    sample.ms_scans_pos=sample.ms_scans=channel.scans
    sample.tic_pos=sample.tic=channel.tic
    return sample


class PeptideChromatogramTests(unittest.TestCase):
    def test_whole_run_tic_uses_recorded_values_not_centroid_sum(self):
        channel=fixture().qtof_channels[0,1]
        result=precursor_chromatogram(channel)
        self.assertEqual(result['times'],[.125,.5,1.75,3.])
        self.assertEqual(result['tic'],[100.,1500.,50.,1000.])
        self.assertNotIn('xic',result)

    def test_xic_sums_only_centroids_in_window_per_survey_without_smoothing_or_cropping(self):
        channel=fixture().qtof_channels[0,1];before=deepcopy(channel)
        result=precursor_chromatogram(channel,500.,10.)
        self.assertEqual(result['xic'],[1.,5.,0.,4.])
        self.assertEqual(result['times'],channel.times.tolist())
        self.assertEqual((result['target_mz'],result['ppm']),(500.,10.))
        for a,b in zip(channel.scans,before.scans):np.testing.assert_array_equal(a,b)
        self.assertEqual(precursor_chromatogram(channel,500.,20.)['xic'],[1.,1305.,0.,4.])
        self.assertEqual(precursor_chromatogram(channel,700.,10.)['xic'],[0.,0.,0.,0.])

    def test_precise_ppm_boundaries_are_inclusive(self):
        left,right=500.-500.*10e-6,500.+500.*10e-6
        channel=QtofChannel(np.array([1.]),np.array([10.]),[np.array([[left,2.],[right,3.]])],[{'time':1.,'scan_id':1}])
        self.assertEqual(precursor_chromatogram(channel,500.,10.)['xic'],[5.])

    def test_biomolecule_envelope_union_does_not_count_overlapping_windows_twice(self):
        channel=fixture().qtof_channels[0,1]
        result=precursor_chromatogram(channel,500.,10.,[500.,500.,500.001,501.])
        self.assertEqual(result['xic'],[1.,805.,0.,904.])
        self.assertEqual(result['tic'],channel.tic.tolist())
        for targets in [[],[0],[float('nan')],[True],[1]*65,'500']:
            with self.subTest(targets=targets),self.assertRaises(ValueError):
                precursor_chromatogram(channel,None,10.,targets)

    def test_endpoint_uses_only_positive_ms1_not_msms_or_other_polarity(self):
        sample=fixture()
        with patch.object(server,'_get_sample',return_value=sample):
            result=server.peptide_chromatogram(path='fixture',target_mz=500.,ppm=10.)
        self.assertEqual(result['times'],[.125,.5,1.75,3.]);self.assertEqual(result['xic'],[1.,5.,0.,4.])
        self.assertEqual((result['ms_level'],result['polarity']),(1,'positive'))

    def test_endpoint_retains_shared_reference_exclusion_without_touching_raw_data(self):
        sample=fixture();channel=sample.qtof_channels[0,1];mz=PRESETS[0]['mz']
        for index,scan in enumerate(channel.scans):
            channel.scans[index]=np.array(sorted([*scan.tolist(),[mz,10.]]))
        before=deepcopy(channel.scans)
        settings=SimpleNamespace(get=lambda _path:{'mode':'922'})
        with patch.object(server,'_get_raw_sample',return_value=sample),patch.object(server,'_reference_settings',return_value=settings),patch.dict(server._reference_view_cache,{},clear=True):
            result=server.peptide_chromatogram(path='fixture',target_mz=mz,ppm=10.)
        self.assertEqual(result['xic'],[0.,0.,0.,0.])
        self.assertEqual(result['tic'],[90.,1490.,40.,990.])
        for a,b in zip(channel.scans,before):np.testing.assert_array_equal(a,b)

    def test_invalid_targets_tolerances_and_missing_data_fail_clearly(self):
        channel=fixture().qtof_channels[0,1]
        for target in [0,-1,float('nan'),float('inf'),True]:
            with self.subTest(target=target),self.assertRaises(ValueError):precursor_chromatogram(channel,target)
        for ppm in [0,-1,501,float('nan'),float('inf'),True]:
            with self.subTest(ppm=ppm),self.assertRaises(ValueError):precursor_chromatogram(channel,500.,ppm)
        with self.assertRaises(ValueError):precursor_chromatogram(None)
        channel.times=np.array([1.])
        with self.assertRaises(ValueError):precursor_chromatogram(channel)
        sample=fixture();sample.qtof_info['is_protein_digest']=False
        with patch.object(server,'_get_sample',return_value=sample),self.assertRaises(server.HTTPException):
            server.peptide_chromatogram(path='fixture',target_mz=500.,ppm=10.)


if __name__=='__main__':unittest.main()
