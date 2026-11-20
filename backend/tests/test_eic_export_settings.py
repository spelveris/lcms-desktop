"""EIC window values survive extraction and vector PDF exports."""
import csv
import copy
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from fastapi import HTTPException
import numpy as np
from PIL import Image
from pypdf import PdfReader

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from data_reader import SampleData


class EicExportSettingsTests(unittest.TestCase):
    def assert_names_three_points_from_own_lines(self, fig):
        fig.canvas.draw()
        labels = sorted((text for text in fig.axes[0].texts
                         if str(text.get_gid()).startswith('timechange-trace-label-')),
                        key=lambda text: int(text.get_gid().rsplit('-', 1)[-1]))
        for label in labels:
            endpoint = fig.axes[0].transData.transform(label.xy)
            box = label.get_window_extent(renderer=fig.canvas.get_renderer())
            self.assertAlmostEqual((box.x0 - endpoint[0]) * 72.0 / fig.dpi, 3.0)
            self.assertAlmostEqual((box.y0 + box.y1) / 2, endpoint[1])
            self.assertEqual(label.get_position(), (3, 0))
            self.assertIsNone(label.arrow_patch)

    def assert_even_trace_end_spacing(self, fig):
        fig.canvas.draw()
        labels = sorted((text for text in fig.axes[0].texts
                         if str(text.get_gid()).startswith('timechange-trace-label-')),
                        key=lambda text: int(text.get_gid().rsplit('-', 1)[-1]))
        lines = {line.get_label(): line for line in fig.axes[0].lines}
        ends = []
        for label in labels:
            line = lines[label.get_text()]
            endpoint = (line.get_xdata()[-1], line.get_ydata()[-1])
            np.testing.assert_allclose(label.xy, endpoint, rtol=0, atol=1e-9)
            ends.append(fig.axes[0].transData.transform(endpoint)[1])
        gaps = np.diff(ends) * 72.0 / fig.dpi
        if len(gaps):
            np.testing.assert_allclose(gaps, gaps[0], rtol=0, atol=1e-9)
        self.assert_names_three_points_from_own_lines(fig)
        return gaps

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

    def test_time_change_pdf_and_jpg_use_manual_y_limits_for_all_signal_kinds_and_views(self):
        traces = [{'label': 'Sample A', 'x': [0, 1, 2], 'intensities': [-3, 8, 4]},
                  {'label': 'Sample B', 'x': [0, 0.75, 2.25], 'intensities': [1, 5, 2]}]
        factory = server.plotting.create_time_change_offset_figure
        for kind in ['ms', 'tic', 'eic', 'uv']:
            for diagonal in [False, True]:
                for export_format in ['pdf', 'jpg']:
                    with self.subTest(kind=kind, diagonal=diagonal, format=export_format):
                        observed = []
                        def capture(*args, **kwargs):
                            fig = factory(*args, **kwargs)
                            observed.append(fig.axes[0].get_ylim())
                            return fig
                        style = {'signal_kind': kind, 'y_min': -5., 'y_max': 20.,
                                 'normalize': True, 'fig_width': 6.,
                                 'x_offset_step': .1 if diagonal else 0,
                                 'y_offset_step': 10 if diagonal else 0,
                                 'offset_angle_degrees': 45 if diagonal else None,
                                 'offset_guide': diagonal}
                        with patch.object(server.plotting, 'create_time_change_offset_figure', side_effect=capture):
                            response = server.export_time_change({'format': export_format,
                                'dpi': 72, 'traces': traces, 'style': style})
                        self.assertTrue(response.body)
                        self.assertEqual(observed, [(-5., 20.)])
        self.assertEqual(traces[0]['intensities'], [-3, 8, 4])

    def test_time_change_automatic_and_one_sided_y_limits_remain_ordered(self):
        traces = [{'x': [0, 1, 2], 'intensities': [-3, 8, 4]}]
        style = {'signal_kind': 'uv', 'x_offset_step': 0, 'y_offset_step': 0}
        baseline = server.plotting.create_time_change_offset_figure(traces, style)
        try:
            automatic = baseline.axes[0].get_ylim()
        finally:
            server.plt.close(baseline)
        for limits, fixed_min, fixed_max in [
            ({'y_min': None, 'y_max': ''}, None, None),
            ({'y_min': 0}, 0, None),
            ({'y_max': 4}, None, 4),
            ({'y_min': 1000}, 1000, None),
            ({'y_max': -1000}, None, -1000),
        ]:
            with self.subTest(limits=limits):
                fig = server.plotting.create_time_change_offset_figure(traces, {**style, **limits})
                try:
                    bottom, top = fig.axes[0].get_ylim()
                    self.assertLess(bottom, top)
                    if fixed_min is not None:
                        self.assertEqual(bottom, fixed_min)
                    if fixed_max is not None:
                        self.assertEqual(top, fixed_max)
                    if fixed_min is None and fixed_max is None:
                        self.assertEqual((bottom, top), automatic)
                finally:
                    server.plt.close(fig)

    def test_time_change_rejects_invalid_graph_limits_and_csv_retains_full_data(self):
        traces = [{'x': [0, 1, 2], 'intensities': [-3, 8, 4]}]
        for limits in [{'y_min': 10, 'y_max': 10}, {'y_min': 11, 'y_max': 10},
                       {'y_min': float('nan')}, {'y_max': float('inf')},
                       {'y_min': 'invalid'}, {'y_max': True}]:
            with self.subTest(limits=limits):
                with self.assertRaises(HTTPException) as error:
                    server.export_time_change({'format': 'pdf', 'traces': traces, 'style': limits})
                self.assertEqual(error.exception.status_code, 400)
        response = server.export_time_change({'format': 'csv', 'traces': traces,
            'style': {'signal_kind': 'uv', 'y_min': 0, 'y_max': 5}})
        rows = list(csv.reader(io.StringIO(response.body.decode())))
        self.assertEqual(rows[1:], [['0.0', '-3.0'], ['1.0', '8.0'], ['2.0', '4.0']])

    def test_diagonal_eic_pdf_names_are_editable_and_only_translate_displayed_trace_shapes(self):
        names = ['Sample_A.D', 'Sample_B.D', 'Sample_C.D', 'Sample_D.D', 'Sample_E.D',
                 'Sample_with_a_long_experiment_name_06.D',
                 'Sample_with_a_long_experiment_name_07.D',
                 'Sample_with_a_long_experiment_name_08.D']
        traces = [{'label': name, 'x': [0, 1, 2, 8], 'intensities': [0, 18000, 4000, 0]}
                  for name in names]
        original_traces = copy.deepcopy(traces)
        style = {'signal_kind': 'eic', 'fig_width': 6, 'x_offset_step': .3375,
                 'y_offset_step': 1350, 'offset_angle_degrees': 45, 'y_min': 0, 'y_max': 45000}
        factory = server.plotting.create_time_change_offset_figure
        normal = factory(traces, style)
        named = factory(traces, {**style, 'trace_labels': True})
        try:
            self.assertIsNotNone(normal.axes[0].get_legend())
            self.assertIsNone(named.axes[0].get_legend())
            self.assertEqual(named.axes[0].get_ylim(), (0., 45000.))
            self.assertEqual(len(normal.axes[0].lines), len(named.axes[0].lines))
            shifts = {}
            for before, after in zip(normal.axes[0].lines, named.axes[0].lines):
                np.testing.assert_array_equal(before.get_xdata(), after.get_xdata())
                self.assertEqual(before.get_linewidth(), after.get_linewidth())
                self.assertEqual(before.get_color(), after.get_color())
                self.assertEqual(before.get_linestyle(), after.get_linestyle())
                self.assertEqual(before.get_alpha(), after.get_alpha())
                if before.get_label() in names:
                    delta = np.asarray(after.get_ydata()) - before.get_ydata()
                    np.testing.assert_allclose(delta, delta[0], rtol=0, atol=1e-9)
                    shifts[before.get_label()] = delta[0]
            np.testing.assert_allclose(
                np.asarray(named.axes[0].lines[-1].get_ydata()) - normal.axes[0].lines[-1].get_ydata(),
                [shifts[name] for name in names], rtol=0, atol=1e-9,
            )
            self.assertEqual(traces, original_traces)
            for fig in [normal, named]:
                fig.canvas.draw()
            np.testing.assert_allclose(normal.axes[0].bbox.bounds, named.axes[0].bbox.bounds,
                                       rtol=0, atol=1e-9)
            self.assertEqual(normal.get_figheight(), named.get_figheight())
            self.assertEqual(normal.axes[0].get_xlim(), named.axes[0].get_xlim())
            for before, after in [(normal.axes[0].title, named.axes[0].title),
                                  (normal.axes[0].xaxis.label, named.axes[0].xaxis.label),
                                  (normal.axes[0].yaxis.label, named.axes[0].yaxis.label)]:
                self.assertEqual(before.get_fontsize(), after.get_fontsize())
                self.assertEqual(before.get_fontfamily(), after.get_fontfamily())
            labels = [text for text in named.axes[0].texts
                      if str(text.get_gid()).startswith('timechange-trace-label-')]
            self.assertEqual({text.get_text() for text in labels}, set(names))
            lines = {line.get_label(): line for line in named.axes[0].lines}
            for text in labels:
                line = lines[text.get_text()]
                self.assertEqual(text.xy, (line.get_xdata()[-1], line.get_ydata()[-1]))
                self.assertGreaterEqual(text.get_position()[0], 3.0 - 1e-9)
                self.assertIsNone(text.arrow_patch)
                self.assertEqual(text.get_fontsize(), normal.axes[0].get_legend().get_texts()[0].get_fontsize())
                box = text.get_window_extent(renderer=named.canvas.get_renderer())
                self.assertGreaterEqual(box.x0, 0)
                self.assertGreaterEqual(box.y0, 0)
                self.assertLessEqual(box.x1, named.bbox.x1)
                self.assertLessEqual(box.y1, named.bbox.y1)
            self.assert_even_trace_end_spacing(named)
            again = factory(traces, style)
            try:
                self.assertEqual(again.axes[0].get_ylim(), normal.axes[0].get_ylim())
                for before, after in zip(normal.axes[0].lines, again.axes[0].lines):
                    np.testing.assert_array_equal(before.get_xdata(), after.get_xdata())
                    np.testing.assert_array_equal(before.get_ydata(), after.get_ydata())
            finally:
                server.plt.close(again)
        finally:
            server.plt.close(normal)
            server.plt.close(named)
        response = server.export_time_change({'format': 'pdf', 'traces': traces,
            'style': {**style, 'trace_labels': True}, 'eic_settings': self.settings(.3)})
        self.assert_pdf(response, .3)
        text = PdfReader(io.BytesIO(response.body)).pages[0].extract_text()
        for name in names:
            self.assertIn(name, text)

    def test_long_and_crowded_direct_names_preserve_original_plot_size_and_style(self):
        traces = [{'label': f'Experiment $A_{index}_with_a_long_complete_sample_name.D',
                   'x': [0, 1, 8], 'intensities': [0, 10 + index, .01 * index]}
                  for index in range(20)]
        style = {'signal_kind': 'eic', 'fig_width': 6, 'trace_labels': True,
                 'x_offset_step': .01, 'y_offset_step': 5, 'offset_guide': False,
                 'y_min': -5, 'y_max': 150}
        fig = server.plotting.create_time_change_offset_figure(traces, style)
        normal = server.plotting.create_time_change_offset_figure(traces, {**style, 'trace_labels': False})
        try:
            fig.canvas.draw()
            normal.canvas.draw()
            np.testing.assert_allclose(fig.axes[0].bbox.bounds, normal.axes[0].bbox.bounds,
                                       rtol=0, atol=1e-9)
            self.assertEqual(fig.get_figheight(), normal.get_figheight())
            labels = sorted(fig.axes[0].texts, key=lambda text: text.get_window_extent().y0)
            self.assertEqual(len(labels), len(traces))
            self.assertEqual(fig.axes[0].get_ylim(), (-5., 150.))
            for label in labels:
                box = label.get_window_extent()
                self.assertLessEqual(box.x1, fig.bbox.x1)
                self.assertLessEqual(box.y1, fig.bbox.y1)
                self.assertGreaterEqual(box.y0, 0)
                self.assertGreaterEqual(label.get_position()[0], 3.0 - 1e-9)
                self.assertIsNone(label.arrow_patch)
            self.assert_even_trace_end_spacing(fig)
        finally:
            server.plt.close(fig)
            server.plt.close(normal)

    def test_direct_names_follow_last_visible_crossing_and_omit_fully_hidden_runs(self):
        traces = [{'label': 'Clipped.D', 'x': [0, 1, 2], 'intensities': [-5, 5, 20]},
                  {'label': 'Hidden.D', 'x': [0, 1, 2], 'intensities': [20, 25, 30]}]
        style = {'signal_kind': 'eic', 'trace_labels': True,
                 'x_offset_step': 0, 'y_offset_step': 0, 'y_min': 0, 'y_max': 10}
        fig = server.plotting.create_time_change_offset_figure(traces, style)
        empty = server.plotting.create_time_change_offset_figure([], style)
        try:
            self.assertEqual(len(fig.axes[0].texts), 1)
            label = fig.axes[0].texts[0]
            self.assertEqual(label.get_text(), 'Clipped.D')
            np.testing.assert_allclose(label.xy, [1 + 5 / 15, 10])
            self.assertIsNone(label.arrow_patch)
            self.assertEqual(label.get_position(), (3, 0))
            self.assertEqual(fig.axes[0].get_ylim(), (0., 10.))
            self.assertEqual(empty.axes[0].texts[0].get_text(), 'No time-change data')
        finally:
            server.plt.close(fig)
            server.plt.close(empty)

    def test_nearly_coincident_trace_ends_keep_direct_names_and_a_finite_page(self):
        traces = [{'label': name, 'x': [0, 1, 2], 'intensities': [0, 10, tail]}
                  for name, tail in [('First.D', 0.), ('Second.D', 1e-9)]]
        style = {'signal_kind': 'eic', 'x_offset_step': .3, 'y_offset_step': 0,
                 'offset_guide': False, 'y_min': -5, 'y_max': 15}
        normal = server.plotting.create_time_change_offset_figure(traces, style)
        named = server.plotting.create_time_change_offset_figure(traces, {**style, 'trace_labels': True})
        try:
            self.assertAlmostEqual(named.get_figheight(), normal.get_figheight())
            self.assertEqual(len(named.axes[0].texts), 2)
            for label in named.axes[0].texts:
                self.assertIsNone(label.arrow_patch)
                self.assertGreaterEqual(label.get_position()[0], 3.0 - 1e-9)
            self.assert_even_trace_end_spacing(named)
        finally:
            server.plt.close(normal)
            server.plt.close(named)

    def test_uneven_trace_ends_have_equal_rows_and_keep_each_name_three_points_away(self):
        traces = [{'label': f'Run {index}.D', 'x': [0, 1, end], 'intensities': [0, 25, tail]}
                  for index, (end, tail) in enumerate([(8.05, .1), (8.0, .8), (8.3, -.2), (8.18, .5)])]
        style = {'signal_kind': 'eic', 'trace_labels': True, 'x_offset_step': .3375,
                 'y_offset_step': 4, 'y_min': -5, 'y_max': 50, 'offset_guide': False}
        fig = server.plotting.create_time_change_offset_figure(traces, style)
        try:
            gaps = self.assert_even_trace_end_spacing(fig)
            self.assertGreater(gaps[0], 0)
            self.assertEqual(fig.axes[0].get_ylim(), (-5., 50.))
        finally:
            server.plt.close(fig)

    def test_automatic_named_rows_fit_complete_peaks_at_readable_fixed_physical_pitch(self):
        traces = [{'label': f'Run {index}.D', 'x': [0, 1, 2, 8],
                   'intensities': [0, 18000 + 500 * index, 4000, .2 * index]}
                  for index in range(8)]
        original_traces = copy.deepcopy(traces)
        style = {'signal_kind': 'eic', 'fig_width': 6, 'x_offset_step': .3375,
                 'y_offset_step': 1000, 'offset_guide': False}
        normal = server.plotting.create_time_change_offset_figure(traces, style)
        named = server.plotting.create_time_change_offset_figure(traces, {**style, 'trace_labels': True})
        try:
            normal.canvas.draw()
            named.canvas.draw()
            np.testing.assert_allclose(normal.axes[0].bbox.bounds, named.axes[0].bbox.bounds,
                                       rtol=0, atol=1e-9)
            self.assertEqual(normal.get_figheight(), named.get_figheight())
            self.assertEqual(normal.axes[0].get_xlim(), named.axes[0].get_xlim())
            self.assertGreater(named.axes[0].get_ylim()[1], normal.axes[0].get_ylim()[1])
            gaps = self.assert_even_trace_end_spacing(named)
            heights = [label.get_window_extent().height * 72.0 / named.dpi
                       for label in named.axes[0].texts]
            self.assertGreaterEqual(gaps[0], max(heights) + 3.0 - 1e-9)
            lower, upper = named.axes[0].get_ylim()
            for line in named.axes[0].lines:
                self.assertGreaterEqual(float(np.min(line.get_ydata())), lower - 1e-9)
                self.assertLessEqual(float(np.max(line.get_ydata())), upper + 1e-9)
            self.assertEqual(traces, original_traces)
        finally:
            server.plt.close(normal)
            server.plt.close(named)

    def test_named_rows_keep_manual_limits_when_complete_shapes_cannot_fit(self):
        traces = [{'label': f'Run {index}.D', 'x': [0, 1, 2], 'intensities': [-5, 5, 20 + index]}
                  for index in range(3)]
        style = {'signal_kind': 'eic', 'trace_labels': True, 'x_offset_step': .3,
                 'y_offset_step': 0, 'y_min': 0, 'y_max': 10, 'offset_guide': False}
        fig = server.plotting.create_time_change_offset_figure(traces, style)
        try:
            self.assertEqual(fig.axes[0].get_ylim(), (0., 10.))
            self.assert_even_trace_end_spacing(fig)
            self.assertEqual(len(fig.axes[0].texts), len(traces))
            for line in fig.axes[0].lines:
                self.assertGreaterEqual(line.get_ydata()[-1], 0)
                self.assertLessEqual(line.get_ydata()[-1], 10)
        finally:
            server.plt.close(fig)


if __name__ == '__main__':
    unittest.main()
