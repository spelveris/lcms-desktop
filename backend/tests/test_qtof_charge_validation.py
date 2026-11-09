"""Public synthetic charge envelopes; no specimen-specific mass exclusions."""
import copy
import inspect
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
import qtof_deconvolution as qd


def component(mass, heights, charges=None):
    charges = list(range(47, 47+len(heights))) if charges is None else list(charges)
    return dict(mass=mass, mass_std=2., intensity=float(sum(heights)),
                charge_states=charges, num_charges=len(charges),
                ion_charges=charges, ion_mzs=[mass/z+1.00784 for z in charges],
                ion_intensities=list(heights))


class ChargeValidationTests(unittest.TestCase):
    def test_inconsistent_comb_rejected_at_any_mass_but_real_high_mass_retained(self):
        smooth = 10000*np.exp(-.5*((np.arange(19)-7)/4)**2)
        comb = [10000 if z%4 == 0 else 1100 for z in range(63, 85)]
        original = [component(148600., smooth), component(198347., comb, range(63,85)),
                    component(25000., comb, range(63,85)), component(198100., smooth)]
        before = copy.deepcopy(original)
        accepted, diagnostics = qd.validate_charge_envelopes(original)
        self.assertEqual([c['mass'] for c in accepted], [148600., 198100.])
        self.assertEqual([c['mass'] for c in diagnostics['rejected']], [198347., 25000.])
        self.assertEqual(original, before)
        for after, old in zip(accepted, [original[0], original[3]]):
            for key, value in old.items(): self.assertEqual(after[key], value)

    def test_truncated_monotonic_tail_and_minor_adduct_do_not_need_gaussian_shape(self):
        tail = np.exp(.015*np.arange(10)**2)*1000
        main = component(14861., tail)
        adduct = component(14915., tail*.12)
        self.assertEqual(server.analysis._gaussian_fit_r2(main['ion_charges'], main['ion_intensities']), 0.)
        accepted, diagnostics = qd.validate_charge_envelopes([main, adduct])
        self.assertEqual(len(accepted), 2)
        self.assertFalse(diagnostics['rejected'])
        self.assertTrue(all(c['charge_envelope_check']['neighbour_agreement'] > .9 for c in accepted))

    def test_duplicate_maxima_do_not_vote_twice_and_cutoff_can_be_disabled(self):
        comb = component(197400., [10000 if z%4==0 else 1000 for z in range(16)])
        duplicate = copy.deepcopy(comb)
        for key in ['ion_mzs', 'ion_charges', 'ion_intensities']: duplicate[key] *= 3
        self.assertEqual(qd.validate_charge_envelopes([comb])[1]['rejected'][0]['neighbour_agreement'],
                         qd.validate_charge_envelopes([duplicate])[1]['rejected'][0]['neighbour_agreement'])
        self.assertEqual(qd.validate_charge_envelopes([comb], 0)[0], [comb])
        short = component(9000., [10000, 2000], [6,7])
        self.assertEqual(qd.validate_charge_envelopes([short])[0], [short])

    def test_api_and_reports_validate_only_qtof_and_keep_measured_spectrum(self):
        bad = component(197400., [10000 if z%4==0 else 1000 for z in range(16)])
        mz, y = np.array([2000., 2000.1, 2000.2]), np.array([1., 20., 1.])
        args = {k:v.default.default for k,v in inspect.signature(server.deconvolute).parameters.items()}
        args.update(path='same-extension.sirslt', start=1., end=2., high_mw=220000., include_singly_charged=False)
        for qtof in [True, False]:
            info = {'instrument':'G6545XT', 'is_protein_digest':False, 'acquisition_method':'Intact_Mass'} if qtof else None
            sample = SimpleNamespace(ms_scans=[], qtof_info=info, qtof_channels={})
            with patch.object(server, '_get_sample', return_value=sample), \
                 patch.object(server.analysis, 'sum_spectra_in_range', return_value=(mz,y)), \
                 patch.object(server.analysis, 'deconvolute_protein_local_lcms_machine_like', return_value=[bad]), \
                 patch.object(server, '_sum_agilent_centroid_cdf_spectra', return_value=None):
                result = server.deconvolute(**args)
                report = server._run_report_deconvolution(mz,y,{'high_mw':220000., 'include_singly_charged':False},qtof=qtof)
            self.assertEqual(len(result['components']), 0 if qtof else 1)
            self.assertEqual(len(report), 0 if qtof else 1)
            np.testing.assert_array_equal(result['spectrum']['mz'], mz)
            np.testing.assert_array_equal(result['spectrum']['intensities'], y)
            if qtof: self.assertEqual(result['charge_validation']['rejected'][0]['mass'],197400.)
            else: self.assertIsNone(result['charge_validation'])


if __name__ == '__main__': unittest.main()
