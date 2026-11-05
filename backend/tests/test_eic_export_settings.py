"""EIC window values survive extraction and vector PDF exports."""
import csv
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import numpy as np
from PIL import Image
from pypdf import PdfReader

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from data_reader import SampleData


class EicExportSettingsTests(unittest.TestCase):
    def sample(self):
        sample = SampleData('synthetic.D')
        sample.ms_times_pos = sample.ms_times = np.array([0., .5, 1.])
        sample.ms_mz_axis_pos = sample.ms_mz_axis = np.array([499.5, 499.9, 500., 500.1, 500.5])
        profile = np.array([1., 2., 4., 8., 16.])
        sample.ms_scans_pos = sample.ms_scans = np.array([profile, 2*profile, profile])
        return sample

    def settings(self, width):
        return {'target_mz': 500., 'mz_window': width, 'ion_mode': 'positive', 'smoothing': 0}

    def assert_pdf(self, response, width):
        reader = PdfReader(io.BytesIO(response.body))
        self.assertEqual(len(reader.pages), 1)
        self.assertEqual(json.loads(reader.metadata['/Keywords'])['mz_window'], width)
        self.assertEqual(len(reader.pages[0].images), 0)
        self.assertTrue(reader.pages[0].extract_text().strip())

    def test_single_sample_pdf_uses_exact_zero_and_explicit_windows_without_fallback(self):
        sample = self.sample()
        factory = server.plotting.create_eic_comparison_figure
        for width, expected in [(0., [4., 8., 4.]), (.1, [14., 28., 14.]), (2.5, [31., 62., 31.])]:
            observed = []
            def capture(*args, **kwargs):
                fig = factory(*args, **kwargs)
                observed.append(fig.axes[0].lines[0].get_ydata().copy())
                return fig
            with patch.object(server, '_get_sample', return_value=sample), \
                 patch.object(server.plotting, 'create_eic_comparison_figure', side_effect=capture):
                response = server.export_single_sample({'path': 'synthetic.D', 'format': 'pdf',
                    'kind': 'eic-overlay', 'mz_window': width,
                    'mz_targets': [{'mz': 500., 'polarity': 'positive'}],
                    'settings': {'eic_smoothing': 0, 'fig_width': 6.}})
            np.testing.assert_array_equal(observed[0], expected)
            self.assert_pdf(response, width)

    def test_time_change_and_uptake_pdfs_keep_the_recorded_window_in_metadata(self):
        for width in [0., 2.5]:
            response = server.export_time_change({'format': 'pdf', 'eic_settings': self.settings(width),
                'traces': [{'label': 'Synthetic', 'x': [0., .5, 1.], 'intensities': [0., 10., 0.]}],
                'style': {'signal_kind': 'eic', 'fig_width': 6.}})
            self.assert_pdf(response, width)
            response = server.export_uptake_assay_cc({'format': 'pdf', 'eic_settings': self.settings(width),
                'points': [{'x': 0., 'y': 1.}, {'x': 10., 'y': 11.}],
                'style': {'fig_width': 6.}})
            self.assert_pdf(response, width)

    def test_time_change_csv_preserves_sample_pairs_without_resampling_or_normalizing(self):
        traces = [
            {'label': 'First, "A".D', 'x': [0.1234567890123, 0.5, 0.5], 'intensities': [12.25, 0, -3]},
            {'label': 'Second.D', 'x': [0.1, 0.35], 'intensities': [24.5, 1.5]},
        ]
        for kind, x_label, y_label in [
            ('tic', 'Elution time (min)', 'TIC intensity (counts)'),
            ('uv', 'Elution time (min)', 'UV absorbance (mAU)'),
            ('eic', 'Elution time (min)', 'EIC intensity (counts)'),
            ('ms', 'm/z', 'Intensity (counts)'),
        ]:
            with self.subTest(kind=kind):
                response = server.export_time_change({'format': 'csv', 'filename_base': f'{kind}_overlap',
                    'traces': traces, 'style': {'signal_kind': kind, 'normalize': True}})
                self.assertTrue(response.headers['content-type'].startswith('text/csv'))
                self.assertIn(f'{kind}_overlap.csv', response.headers['content-disposition'])
                header, *rows = csv.reader(io.StringIO(response.body.decode('utf-8')))
                self.assertEqual(header, [f'{axis} - {trace["label"]}' for trace in traces
                                         for axis in (x_label, y_label)])
                self.assertEqual(rows, [['0.1234567890123', '12.25', '0.1', '24.5'],
                                        ['0.5', '0.0', '0.35', '1.5'], ['0.5', '-3.0', '', '']])

    def test_time_change_jpg_uses_pdf_dimensions_and_an_opaque_white_background(self):
        payload = {'filename_base': 'tic_overlap', 'dpi': 144,
            'traces': [{'label': 'Sample A', 'x': [0, 1, 2], 'intensities': [1, 8, 4]},
                       {'label': 'Sample B', 'x': [0, 0.75, 2.25], 'intensities': [1, 5, 2]}],
            'style': {'signal_kind': 'tic', 'fig_width': 6, 'normalize': True,
                      'x_offset_step': 0, 'y_offset_step': 0, 'offset_guide': False}}
        pdf = server.export_time_change({**payload, 'format': 'pdf'})
        jpg = server.export_time_change({**payload, 'format': 'jpg'})
        self.assertEqual(jpg.headers['content-type'], 'image/jpeg')
        self.assertIn('tic_overlap.jpg', jpg.headers['content-disposition'])
        page = PdfReader(io.BytesIO(pdf.body)).pages[0]
        with Image.open(io.BytesIO(jpg.body)) as image:
            self.assertEqual(image.format, 'JPEG')
            self.assertEqual(image.mode, 'RGB')
            self.assertEqual(image.getpixel((0, 0)), (255, 255, 255))
            for pixels, points in zip(image.size, (page.mediabox.width, page.mediabox.height)):
                self.assertAlmostEqual(pixels, float(points) * 2, delta=1)


if __name__ == '__main__':
    unittest.main()
