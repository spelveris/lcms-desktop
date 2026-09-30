import copy
import io
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from matplotlib.text import Annotation
from matplotlib.transforms import Bbox
from pypdf import PdfReader

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class DenseProfileExportTests(unittest.TestCase):
    def setUp(self):
        self.plot = server.plot_runtime.get('plotting')
        self.x = np.arange(18450., 19150., .1) + .05
        self.y = sum(height * np.exp(-.5*((self.x-mass)/2.)**2)
                     for mass, height in [(18791.23, 100), (18845.12, 23), (18898.91, 10), (18952.82, 5.7)])
        self.spectrum = {'mz': [1001.123456789], 'intensities': [123456.789]}
        self.style = {'fig_width': 6, 'deconv_x_min_da': 18450, 'deconv_x_max_da': 19150,
                      'deconv_profile_selected_mass': 18791.23456789}

    def figure(self, **style):
        with patch.object(self.plot, '_build_dense_zero_charge_profile', return_value=(self.x, self.y)):
            return self.plot.create_dense_deconvoluted_mass_profile_figure('Synthetic.d', self.spectrum, self.style | style)

    def test_main_and_minor_profile_peaks_have_two_decimal_da_leaders(self):
        fig = self.figure()
        try:
            labels = [t for t in fig.axes[0].texts if isinstance(t, Annotation)]
            self.assertEqual(len(labels), 4)
            self.assertEqual(labels[0].get_text(), '18,791.25 Da')
            self.assertEqual(labels[0].get_fontweight(), 'bold')
            for label in labels:
                self.assertRegex(label.get_text(), r'^\d{2},\d{3}\.\d{2} Da$')
                self.assertIsNotNone(label.arrow_patch)
                self.assertEqual(label.get_fontsize(), 6)
            pdf = self.plot.export_figure_pdf(fig, tight=False)
            text = PdfReader(io.BytesIO(pdf)).pages[0].extract_text()
            self.assertIn('18,791.25 Da', text)
            self.assertIn('18,845.15 Da', text)
        finally:
            server.plt.close(fig)

    def test_annotations_leave_data_ranges_and_axis_dimensions_unchanged(self):
        before = copy.deepcopy((self.spectrum, self.style))
        old = self.figure(deconv_show_peak_labels=False)
        new = self.figure()
        try:
            np.testing.assert_array_equal(old.axes[0].lines[0].get_xdata(), new.axes[0].lines[0].get_xdata())
            np.testing.assert_array_equal(old.axes[0].lines[0].get_ydata(), new.axes[0].lines[0].get_ydata())
            self.assertEqual(old.axes[0].get_xlim(), new.axes[0].get_xlim())
            self.assertEqual(old.axes[0].get_position().bounds, new.axes[0].get_position().bounds)
            np.testing.assert_array_equal(old.get_size_inches(), new.get_size_inches())
            self.assertEqual(new.axes[0].get_ylim(), (0., 130.))
            self.assertEqual(before, (self.spectrum, self.style))
        finally:
            server.plt.close(old); server.plt.close(new)

    def test_label_boxes_fit_inside_axes_and_do_not_overlap(self):
        for width in [6, 8, 12]:
            fig = self.figure(fig_width=width)
            try:
                fig.canvas.draw(); renderer = fig.canvas.get_renderer()
                ax = fig.axes[0]; bounds = ax.get_window_extent(renderer)
                boxes = [t.get_bbox_patch().get_window_extent(renderer)
                         for t in ax.texts if isinstance(t, Annotation)]
                self.assertGreaterEqual(len(boxes), 3)
                for i, box in enumerate(boxes):
                    self.assertTrue(bounds.contains(box.x0, box.y0))
                    self.assertTrue(bounds.contains(box.x1, box.y1))
                    for other in boxes[i+1:]:
                        self.assertFalse(box.overlaps(other))
            finally:
                server.plt.close(fig)

    def test_flat_empty_and_offscreen_profiles_have_no_false_labels(self):
        for x, y in [(np.array([]), np.array([])), (self.x, self.x*0), (self.x, self.x*0+1)]:
            self.assertEqual(self.plot._dense_profile_label_peaks(x, y, [18450, 19150]), [])
        self.assertEqual(self.plot._dense_profile_label_peaks(self.x, self.y, [20000, 21000]), [])

    def test_export_endpoint_includes_editable_labels_without_browser_annotations(self):
        with patch.object(self.plot, '_build_dense_zero_charge_profile', return_value=(self.x, self.y)):
            response = server.export_deconvoluted_masses({'variant': 'dense-profile', 'format': 'pdf',
                'sample_name': 'Synthetic.d', 'spectrum': self.spectrum, 'style': self.style})
        self.assertEqual(response.media_type, 'application/pdf')
        text = PdfReader(io.BytesIO(response.body)).pages[0].extract_text()
        self.assertIn('18,791.25 Da', text)


if __name__ == '__main__':
    unittest.main()
