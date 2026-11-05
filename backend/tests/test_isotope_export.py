import sys
from pathlib import Path
import unittest
from unittest.mock import patch
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import server


class IsotopeExportTests(unittest.TestCase):
    def test_qtof_labels_have_two_decimals_without_rounding_data_or_legacy_labels(self):
        import copy
        plot=server.plotting
        legacy={'mass':58968.512345678,'intensity':100.,'ion_mzs':[1000.1],'ion_charges':[59],'ion_intensities':[100.]}
        qtof={**legacy,'mass_display_decimals':2}
        original=copy.deepcopy(qtof)
        self.assertEqual(plot._component_mass_label(legacy),'58968.5')
        self.assertEqual(plot._component_mass_label(qtof),'58968.51')
        self.assertEqual(plot._component_mass_label({**qtof,'isotope_aware':True}),'58968.51')
        self.assertEqual(plot._component_mass_label({**legacy,'isotope_aware':True}),'58968.512346')
        self.assertEqual(plot._normalize_deconvolution_component(qtof)['mass_display_decimals'],2)
        fig=server.plt.figure();ax=fig.add_subplot(111)
        try:
            plot._plot_deconvoluted_masses_panel(ax,[legacy|{'intensity':1},qtof],x_max_da=65000)
            self.assertIn('58968.51',[t.get_text() for t in ax.texts])
        finally:server.plt.close(fig)
        self.assertEqual(qtof,original)

    def test_measured_isotope_export_has_unrounded_sticks_and_da_axis(self):
        spectrum={'mz':[1001.234567890123],'intensities':[123.4],
                  'isotope_profile':[{'mass':10002.27291423502,'intensity':123.4}]}
        fig=server.plotting.create_dense_deconvoluted_mass_profile_figure('Synthetic',spectrum,{'fig_width':6})
        try:
            ax=fig.axes[0];self.assertEqual(ax.get_xlabel(),'Neutral mass (Da)')
            self.assertEqual(ax.collections[0].get_segments()[0][1][0],spectrum['isotope_profile'][0]['mass'])
            self.assertEqual(len(ax.lines),0)
            self.assertTrue(server.plotting.export_figure_pdf(fig).startswith(b'%PDF'))
        finally:server.plt.close(fig)

    def test_raw_qtof_spectrum_exports_centroid_sticks_not_a_connected_profile(self):
        spectrum={'mz':[500.123456789,501.1268],'intensities':[100.,50.],'representation':'calibrated centroid sticks'}
        fig=server.plotting.create_deconvolution_mass_spectrum_figure('Synthetic',spectrum)
        try:
            self.assertEqual(len(fig.axes[0].lines),0)
            np.testing.assert_array_equal([segment[1][0] for segment in fig.axes[0].collections[0].get_segments()],spectrum['mz'])
        finally:server.plt.close(fig)

    def test_mass_spectrum_pdf_doubles_only_the_physical_x_axis(self):
        spectrum = {'mz': [900., 1000., 1200.], 'intensities': [3., 12., 5.]}
        style = {'fig_width': 6}
        plot = server.plotting
        standard = plot.create_deconvolution_mass_spectrum_figure('Synthetic', spectrum, style=style)

        def axis_size(fig):
            axis = fig.axes[0].get_position()
            return axis.width * fig.get_figwidth(), axis.height * fig.get_figheight()

        try:
            original_width, original_height = axis_size(standard)
            original_xlim = standard.axes[0].get_xlim()
            render_pdf = plot.export_figure_pdf

            def check_figure(fig, **options):
                width, height = axis_size(fig)
                self.assertAlmostEqual(width, 2 * original_width)
                self.assertAlmostEqual(height, original_height)
                self.assertEqual(fig.axes[0].get_xlim(), original_xlim)
                self.assertEqual(fig.axes[0].xaxis.label.get_fontsize(), standard.axes[0].xaxis.label.get_fontsize())
                return render_pdf(fig, **options)

            with patch.object(plot, 'export_figure_pdf', side_effect=check_figure) as export:
                response = server.export_deconvolution_spectrum({'sample_name': 'Synthetic',
                    'spectrum': spectrum, 'style': style, 'format': 'pdf'})
                export.assert_called_once()
            self.assertTrue(response.body.startswith(b'%PDF'))
        finally:
            server.plt.close(standard)
