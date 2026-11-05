"""Per-panel exports retain measured precision and a fixed physical axis box."""
import copy
import csv
import io
from pathlib import Path
import sys
from unittest.mock import patch
import unittest
import numpy as np
from PIL import Image
from pypdf import PdfReader

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from chromatogram_export import prepare_chromatogram


def payload(kind='uv', polarity=None):
    trace = {'times': [.000012345678901, .123456789012345, .25],
             'intensities': [-.001234567890123, 3.141592653589793, .000000123456789]}
    if kind == 'uv':
        trace['wavelength'] = 278.
    else:
        trace['intensities'] = [123.456789012345, 2000000.125, 7500.5]
    return {'kind': kind, 'polarity': polarity, 'traces': [trace],
            'format': 'csv', 'sample_name': 'Synthetic sample',
            'style': {'fig_width': 6., 'line_width': .8, 'show_grid': False}}


def axis_size(fig):
    _, _, width, height = fig.axes[0].get_position().bounds
    fw, fh = fig.get_size_inches()
    return np.array([width*fw, height*fh])


class SingleChromatogramExportTests(unittest.TestCase):
    def test_deconvolution_chromatogram_axes_and_fonts_match_mass_exports_exactly(self):
        plotting = server.plot_runtime.get('plotting')
        for width in [6., 8., 12.]:
            reference = plotting.create_deconvoluted_masses_figure('reference.d',
                [{'mass': 20000., 'intensity': 100.}], {'fig_width': width, 'deconv_show_peak_labels': False})
            try:
                for kind in ['uv', 'tic']:
                    data = payload(kind)
                    data['style'].update(fig_width=width, x_axis_width_multiplier=1,
                        selection_window={'start': .05, 'end': .2})
                    fig = plotting.create_single_chromatogram_export_figure(prepare_chromatogram(data),
                        'Sample_with_a_long_name_'*5, data['style'])
                    try:
                        np.testing.assert_allclose(axis_size(fig),axis_size(reference),rtol=0,atol=1e-12)
                        self.assertEqual(fig.axes[0].xaxis.label.get_fontsize(),reference.axes[0].xaxis.label.get_fontsize())
                        np.testing.assert_array_equal(fig.axes[0].lines[0].get_xdata(),data['traces'][0]['times'])
                        bounds=fig.axes[0].transData.inverted().transform(fig.axes[0].patches[0].get_extents().get_points())
                        np.testing.assert_allclose(bounds[:,0],[.05,.2],atol=1e-12)
                    finally:
                        server.plt.close(fig)
            finally:
                server.plt.close(reference)

    def test_jpg_has_white_background_and_the_same_physical_canvas_as_pdf(self):
        for kind in ['uv', 'tic']:
            data=payload(kind);data.update(format='pdf',dpi=200)
            data['style'].update(x_axis_width_multiplier=1,selection_window={'start':.05,'end':.2})
            pdf=PdfReader(io.BytesIO(server.export_single_chromatogram(data).body)).pages[0]
            for spelling in ['jpg','jpeg']:
                data['format']=spelling
                response=server.export_single_chromatogram(data)
                image=Image.open(io.BytesIO(response.body))
                self.assertEqual(response.media_type,'image/jpeg')
                self.assertTrue(response.headers['content-disposition'].endswith('.jpg"'))
                self.assertEqual(image.format,'JPEG');self.assertEqual(image.mode,'RGB')
                self.assertEqual(image.getpixel((0,0)),(255,255,255))
                np.testing.assert_allclose(image.size,[float(pdf.mediabox.width)/72*200,
                    float(pdf.mediabox.height)/72*200],atol=1.01)

    def test_background_subtracted_csv_keeps_signed_full_precision_data_and_labels(self):
        data=payload();data['background_subtracted']=True
        rows=list(csv.reader(io.StringIO(server.export_single_chromatogram(data).body.decode())))
        self.assertEqual(rows[0],['Elution time (min)','Background-subtracted UV absorbance at 278 nm (mAU)'])
        np.testing.assert_array_equal(np.array(rows[1:],float)[:,1],data['traces'][0]['intensities'])

    def test_csv_round_trips_full_precision_and_labels_without_loading_a_run_or_renderer(self):
        for kind, polarity, header in [('uv', None, 'UV absorbance at 278 nm (mAU)'),
                                       ('tic', 'positive', 'Positive TIC intensity (counts)'),
                                       ('tic', 'negative', 'Negative TIC intensity (counts)')]:
            data = payload(kind, polarity)
            original = copy.deepcopy(data)
            with patch.object(server, '_get_sample', side_effect=AssertionError('Do not reopen the sample')), \
                 patch.object(server, 'plotting', object()):
                response = server.export_single_chromatogram(data)
            rows = list(csv.reader(io.StringIO(response.body.decode())))
            self.assertEqual(rows[0], ['Elution time (min)', header])
            np.testing.assert_array_equal(np.array(rows[1:], dtype=float)[:, 0], data['traces'][0]['times'])
            np.testing.assert_array_equal(np.array(rows[1:], dtype=float)[:, 1], data['traces'][0]['intensities'])
            self.assertEqual(data, original)

    def test_multiple_wavelengths_retain_unequal_and_duplicate_times_without_interpolation(self):
        data = payload()
        data['traces'][0]['times'] = [0., .5, .5]
        data['traces'].append({'wavelength': 214., 'times': [.1, .9], 'intensities': [7., 9.]})
        response = server.export_single_chromatogram(data)
        rows = list(csv.reader(io.StringIO(response.body.decode())))
        self.assertEqual(rows[0], ['Elution time (min) - 278 nm', 'UV absorbance at 278 nm (mAU)',
                                   'Elution time (min) - 214 nm', 'UV absorbance at 214 nm (mAU)'])
        self.assertEqual([float(r[0]) for r in rows[1:]], [0., .5, .5])
        self.assertEqual([r[2:] for r in rows[1:]], [['0.1', '7.0'], ['0.9', '9.0'], ['', '']])

    def test_missing_invalid_or_mismatched_data_is_rejected_instead_of_truncated(self):
        cases = [dict(payload(), traces=[]), dict(payload(), format='gif'),
                 dict(payload(), kind='eic'), dict(payload(), polarity='both')]
        for times, values in [([0, 1], [1]), ([0, np.nan], [1, 2]), ([1, 0], [1, 2])]:
            data = payload(); data['traces'][0].update(times=times, intensities=values); cases.append(data)
        for data in cases:
            with self.assertRaises(server.HTTPException) as error:
                server.export_single_chromatogram(data)
            self.assertEqual(error.exception.status_code, 400)

    def test_axis_width_is_exactly_double_deconvolution_with_identical_height_and_fonts(self):
        plotting = server.plot_runtime.get('plotting')
        for width in [6., 8., 12.]:
            data = payload(); data['style']['fig_width'] = width
            reference = plotting.create_deconvoluted_masses_figure('reference.d',
                [{'mass': 20000., 'intensity': 100.}], {'fig_width': width, 'deconv_show_peak_labels': False})
            fig = plotting.create_single_chromatogram_export_figure(prepare_chromatogram(data), 'Synthetic', data['style'])
            try:
                np.testing.assert_allclose(axis_size(fig), axis_size(reference)*[2., 1.], rtol=0, atol=1e-12)
                for getter in ['get_xlabel', 'get_ylabel']:
                    self.assertTrue(getattr(fig.axes[0], getter)())
                self.assertEqual(fig.axes[0].xaxis.label.get_fontsize(), reference.axes[0].xaxis.label.get_fontsize())
                self.assertEqual(fig.axes[0].title.get_fontsize(), reference.axes[0].title.get_fontsize())
                self.assertEqual(fig.axes[0].get_xticklabels()[0].get_fontsize(), reference.axes[0].get_xticklabels()[0].get_fontsize())
                self.assertFalse(any(line.get_visible() for line in fig.axes[0].get_xgridlines()))
                np.testing.assert_array_equal(fig.axes[0].lines[0].get_xdata(), data['traces'][0]['times'])
                np.testing.assert_array_equal(fig.axes[0].lines[0].get_ydata(), data['traces'][0]['intensities'])
            finally:
                server.plt.close(fig); server.plt.close(reference)

    def test_long_names_and_legends_fit_without_changing_axis_size(self):
        plotting = server.plot_runtime.get('plotting')
        data = payload()
        data['traces'] *= 3
        prepared = prepare_chromatogram(data)
        short = plotting.create_single_chromatogram_export_figure(prepared, 'Short', data['style'])
        long = plotting.create_single_chromatogram_export_figure(prepared, 'Long_sample_name_'*14, data['style'])
        try:
            np.testing.assert_allclose(axis_size(short), axis_size(long), rtol=0, atol=1e-12)
            long.canvas.draw()
            bounds = long.axes[0].get_tightbbox(long.canvas.get_renderer())
            fw, fh = long.get_size_inches()*long.dpi
            self.assertGreaterEqual(bounds.x0, 0)
            self.assertGreaterEqual(bounds.y0, 0)
            self.assertLessEqual(bounds.x1, fw)
            self.assertLessEqual(bounds.y1, fh)
        finally:
            server.plt.close(short); server.plt.close(long)

    def test_pdf_has_editable_embedded_text_and_vector_paths_without_images(self):
        data = payload('tic', 'negative'); data.update(format='pdf', filename_base='negative TIC')
        response = server.export_single_chromatogram(data)
        self.assertEqual(response.media_type, 'application/pdf')
        page = PdfReader(io.BytesIO(response.body)).pages[0]
        text = page.extract_text()
        self.assertIn('Elution time (min)', text)
        self.assertIn('Intensity (counts)', text)
        self.assertIn('Negative TIC', text)
        self.assertEqual(len(page.images), 0)
        content = page.get_contents().get_data()
        self.assertIn(b' l\n', content)
        fonts = [value.get_object() for value in page['/Resources']['/Font'].get_object().values()]
        self.assertTrue(fonts)
        for font in fonts:
            self.assertNotEqual(font['/Subtype'], '/Type3')
            descendant = font['/DescendantFonts'][0].get_object()
            self.assertIn('/FontFile2', descendant['/FontDescriptor'].get_object())
        from matplotlib.font_manager import findfont
        try:
            findfont('Arial', fallback_to_default=False)
        except ValueError:
            pass
        else:
            self.assertTrue(all('Arial' in str(font['/BaseFont']) for font in fonts))

    def test_png_and_pdf_use_the_same_uncropped_canvas_at_the_requested_dpi(self):
        data = payload(); data.update(dpi=200, format='pdf')
        pdf = server.export_single_chromatogram(data)
        page = PdfReader(io.BytesIO(pdf.body)).pages[0]
        data['format'] = 'png'
        png = server.export_single_chromatogram(data)
        image = Image.open(io.BytesIO(png.body))
        np.testing.assert_allclose(image.size, [float(page.mediabox.width)/72*200,
                                               float(page.mediabox.height)/72*200], atol=1.01)


if __name__ == '__main__':
    unittest.main()
