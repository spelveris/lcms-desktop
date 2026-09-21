"""Original per-channel UV times must survive OpenLab import and analysis."""
import inspect
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from data_reader import SampleData


class UvChannelTests(unittest.TestCase):
    def sample(self, channels):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        parsed = {}
        for index, (wavelength, times, values) in enumerate(channels):
            path = root / f'{index}.CH'
            path.touch()
            parsed[str(path)] = SimpleNamespace(detector='FID',
                metadata={'unit':'mAU', 'signal':f'VWD1,Wavelength={wavelength} nm'},
                xlabels=np.array(times, dtype=float), ylabels=np.array(['']),
                data=np.array(values, dtype=float).reshape(-1, 1))
        sample = SampleData(str(root))
        with patch('rainbow.agilent.chemstation.parse_file', side_effect=lambda path, **kwargs:parsed[path]):
            sample._load_sirslt_uv(root)
        return sample

    def call(self, function, sample, **overrides):
        params = {key:parameter.default.default for key, parameter in inspect.signature(function).parameters.items()}
        params.update(path='fixture', **overrides)
        with patch.object(server, '_get_sample', return_value=sample):
            return function(**params)

    def test_unequal_lengths_preserve_every_original_time_and_value(self):
        sample = self.sample([(214, [0,1,2], [1,4,2]), (278, [0,2], [.1,.3])])
        np.testing.assert_array_equal(sample.uv_wavelengths, [214,278])
        for wavelength, times, values in [(214,[0,1,2],[1,4,2]), (278,[0,2],[.1,.3])]:
            trace = sample.get_uv_trace(wavelength)
            np.testing.assert_array_equal(trace[0], times)
            np.testing.assert_array_equal(trace[1], values)
            self.assertEqual(trace[2], wavelength)
        self.assertTrue(np.isnan(sample.uv_data[1,1]))  # No invented 278 nm point.
        self.assertTrue(sample._debug_info['sirslt_uv_independent_time_axes'])
        self.assertNotIn('sirslt_uv_combine_error', sample._debug_info)

    def test_equal_lengths_with_different_times_do_not_use_the_first_axis(self):
        sample = self.sample([(214,[0,1,2],[1,2,3]),(278,[.2,1.2,2.2],[4,5,6])])
        np.testing.assert_array_equal(sample.get_uv_trace(278)[0],[.2,1.2,2.2])
        self.assertEqual(np.isfinite(sample.uv_data).sum(),6)

    def test_equal_axes_keep_original_matrix_and_legacy_d_reader_still_works(self):
        sample = self.sample([(214,[0,1],[1,2]),(278,[0,1],[3,4])])
        np.testing.assert_array_equal(sample.uv_data,[[1,3],[2,4]])
        self.assertNotIn('sirslt_uv_independent_time_axes', sample._debug_info)
        sample.uv_channels = []  # Existing .d reader uses a shared matrix.
        times, values, wavelength = sample.get_uv_trace(280)
        np.testing.assert_array_equal(times,[0,1]);np.testing.assert_array_equal(values,[3,4])
        self.assertEqual(wavelength,278)
        self.assertIsNone(sample.get_uv_trace(194));self.assertIsNone(sample.get_uv_trace(float('nan')))

    def test_uv_endpoint_returns_matching_arrays_and_actual_recorded_wavelength(self):
        sample = self.sample([(214,[0,1,2],[1,2,3]),(278,[.1,2.1],[4,5])])
        result = self.call(server.uv_chromatogram,sample,wavelength=280)
        self.assertEqual(result,{'times':[.1,2.1],'intensities':[4,5],'wavelength':278})
        with self.assertRaises(server.HTTPException):self.call(server.uv_chromatogram,sample,wavelength=194)

    def test_peak_area_and_peak_detection_receive_the_selected_channel_times(self):
        sample = self.sample([(214,[0,1,2],[1,2,3]),(278,[.2,1.3,2.4],[4,8,2])])
        with patch.object(server.analysis,'calculate_peak_area',return_value=4.5) as calculate:
            self.assertEqual(self.call(server.peak_area,sample,data_type='uv',wavelength=278,start=0,end=3)['area'],4.5)
        np.testing.assert_array_equal(calculate.call_args.args[0],[.2,1.3,2.4])
        np.testing.assert_array_equal(calculate.call_args.args[1],[4,8,2])
        with patch.object(server.analysis,'find_peaks',return_value=[]) as find:
            self.call(server.find_chromatogram_peaks,sample,data_type='uv',wavelength=278)
        np.testing.assert_array_equal(find.call_args.args[0],[.2,1.3,2.4])

    def test_background_subtraction_uses_each_channels_own_axis(self):
        sample = self.sample([(214,[0,1,2],[10,10,10]),(278,[.5,1.5],[8,10])])
        blank = self.sample([(214,[0,1,2],[1,1,1]),(278,[0,1,2],[2,4,6])])
        with patch.object(server,'_get_sample',side_effect=lambda path:sample if path=='sample' else blank):
            result = server.background_subtraction({'sample_path':'sample','background_path':'blank','wavelengths':[278]})
        trace = result['uv']['wavelengths'][0]
        self.assertEqual(trace['times'],[.5,1.5]);self.assertEqual(trace['intensities'],[5.,5.])

    def test_export_figures_use_original_uv_pairs_without_resampling(self):
        import matplotlib
        matplotlib.use('Agg')
        import plotting
        import matplotlib.pyplot as plt
        sample = self.sample([(214,[0,1,2],[1,2,3]),(278,[.1,2.1],[4,5])])
        for factory in [plotting.create_single_sample_figure,plotting.create_single_sample_export_figure]:
            figure = factory(sample, uv_wavelengths=[278], uv_smoothing=0)
            try:
                np.testing.assert_array_equal(figure.axes[0].lines[0].get_xdata(),[.1,2.1])
                np.testing.assert_array_equal(figure.axes[0].lines[0].get_ydata(),[4,5])
            finally:plt.close(figure)


if __name__ == '__main__':unittest.main()
