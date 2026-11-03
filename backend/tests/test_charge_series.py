"""Charge-series evidence tests; all spectra and masses here are synthetic."""
import sys
from pathlib import Path
import unittest
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server

analysis = server.analysis

PROTON = 1.00784


def ions(charges, intensities, mass=16000.):
    return [{'charge': z, 'intensity': y, 'mz': mass/z+PROTON,
             'mass': mass, 'index': i} for i, (z, y) in enumerate(zip(charges, intensities))]


def supported(points, **kwargs):
    params = dict(min_peaks=3, contig_min=3, noise_cutoff=100., abundance_cutoff=.05)
    return analysis._has_supported_charge_series(points, **{**params, **kwargs})


class ChargeSeriesTests(unittest.TestCase):
    def test_weak_anchor_cannot_borrow_an_isolated_dominant_peak(self):
        for mass in [8100., 16000., 43500.]:
            points = ions(range(8, 16), [1000, 1200, 1400, 90000, 1800, 1600, 1200, 1000], mass)
            self.assertFalse(supported(points))

    def test_several_above_threshold_coincidences_still_need_distributed_intensity(self):
        self.assertFalse(supported(ions([14, 15, 16], [6000., 100000., 6000.])))
        self.assertTrue(supported(ions([14, 15, 16], [60000., 100000., 60000.])))

    def test_distinct_charges_not_multiple_local_maxima_count_as_support(self):
        self.assertFalse(supported(ions([10, 10, 10, 11, 11], [900, 800, 700, 900, 800])))

    def test_sparse_series_is_not_rescued_by_a_short_consecutive_pair(self):
        self.assertFalse(supported(ions([5, 10, 11, 17, 23, 27, 31, 40], [1000]*8)))
        self.assertFalse(supported(ions([5, 6, 7, 10, 15], [1000]*5)))

    def test_weak_consecutive_core_cannot_validate_stronger_disconnected_assignments(self):
        # Six consecutive charges satisfy count and effective-charge tests,
        # but the isolated spike still carries most of the measured intensity.
        for mass in [8100., 16800., 43500.]:
            points = ions([8, 9, 10, 11, 12, 13, 19, 21],
                          [6000, 8000, 14000, 10000, 6000, 4000, 5000, 64000], mass)
            self.assertFalse(supported(points))
            self.assertEqual(analysis._supported_charge_series(
                points, min_peaks=3, contig_min=3, noise_cutoff=100., abundance_cutoff=.05), [])

    def test_supported_series_can_include_weak_disconnected_tail_charges(self):
        self.assertTrue(supported(ions([8, 9, 10, 11, 12, 13, 19, 21],
                                      [6000, 8000, 14000, 10000, 6000, 4000, 1000, 900])))

    def test_dominant_peak_with_real_adjacent_support_is_retained(self):
        self.assertTrue(supported(ions(range(8, 14), [1000, 1500, 5500, 1000, 500, 500])))

    def test_weak_coherent_series_is_accepted_independently_of_other_species(self):
        self.assertTrue(supported(ions([8, 9, 10, 11], [300, 500, 450, 280])))

    def test_broad_non_gaussian_envelope_can_have_strong_charge_support(self):
        points = ions(range(20, 45), [400+100*((z*7) % 9) for z in range(20, 45)])
        self.assertTrue(supported(points))

    def test_explicit_two_charge_mode_retains_unequal_but_supported_ions(self):
        self.assertTrue(supported(ions([8, 9], [1000, 600]), min_peaks=2, contig_min=2))
        self.assertFalse(supported(ions([8, 9], [10000, 600]), min_peaks=2, contig_min=2))

    def test_gaussian_score_pairs_each_intensity_with_its_actual_charge(self):
        z = np.arange(8, 17)
        intensity = 1e4*np.exp(-.5*((z-12)/2.)**2)
        order = np.argsort(intensity)[::-1]
        self.assertAlmostEqual(analysis._gaussian_fit_r2(z[order], intensity[order]), 1., places=10)
        self.assertEqual(analysis._gaussian_fit_r2([1, 2, 3, 4], np.exp(np.array([1, 4, 9, 16]))), 0.)

    def test_full_deconvolution_keeps_two_proteins_and_excludes_impurity_alias(self):
        mz = np.arange(100., 2500., .02)
        intensity = np.zeros_like(mz)
        truth = [36123.4, 37654.3]
        for mass, scale in zip(truth, [150000., 100000.]):
            for z in range(21, 42):
                height = scale*np.exp(-.5*((z-31)/4.)**2)
                intensity += height*np.exp(-.5*((mz-(mass/z+PROTON))/.15)**2)
        impurity_mz = 723.25
        false_mass = (impurity_mz-PROTON)*17
        for z in [9, 12, 14, 15, 16, 17, 18, 19, 25, 31, 33, 39, 43]:
            height = 8000000. if z == 17 else 10000.
            intensity += height*np.exp(-.5*((mz-(false_mass/z+PROTON))/.15)**2)
        original = intensity.copy()
        result = analysis.deconvolute_protein_local_lcms_machine_like(
            mz, intensity, min_charge=2, max_charge=50, min_peaks=3,
            abundance_cutoff=.05, low_mw=500., high_mw=50000.)
        for mass in truth:
            self.assertTrue(any(abs(c['mass']-mass)<2 for c in result), (mass, result))
        self.assertFalse(any(abs(c['mass']-false_mass)<20 for c in result))
        self.assertFalse(any(abs(ion-impurity_mz)<.3 for c in result for ion in c['ion_mzs']))
        np.testing.assert_array_equal(intensity, original)


if __name__ == '__main__':
    unittest.main()
