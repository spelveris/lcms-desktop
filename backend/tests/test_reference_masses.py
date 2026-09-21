"""Synthetic calibrants only; no real acquisition data in the test suite."""
from copy import deepcopy
import inspect
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from data_reader import SampleData
from qtof_reader import QtofChannel
from reference_masses import (PRESETS, ISOTOPE_SPACING, normalize_policy, read_method_references,
                              filter_sample, exclusion_mask, ReferenceSettingsStore)


def sample_fixture():
    sample = SampleData('/fixture.sirslt')
    reference = dict(PRESETS[0])
    sample.qtof_info = {'is_protein_digest': True, 'instrument': 'Synthetic QTOF',
                       'reference_method': {'auto_recalibration': True, 'references': [reference]}}
    mz = reference['mz']
    scans = [np.array([[500., 100.], [mz, 1000.], [mz+ISOTOPE_SPACING, 40.], [mz+.1, 20.]])]
    survey = QtofChannel(np.array([1.]), np.array([1160.]), scans, [{'scan_id': 1, 'time': 1., 'ms_level': 1}])
    fragments = QtofChannel(np.array([1.1, 1.2, 1.3]), np.array([1100., 1100., 1100.]),
        [np.array([[200., 100.], [mz, 1000.]]) for _ in range(3)],
        [{'scan_id': i+2, 'time': 1.1+i*.1, 'ms_level': 2, 'precursor_mz': precursor, 'parent_scan_id': 1}
         for i, precursor in enumerate([mz, 500., mz+ISOTOPE_SPACING])])
    negative = QtofChannel(np.array([1.]), np.array([1000.]), [np.array([[mz, 1000.]])], [{'scan_id': 5, 'time': 1.}])
    sample.qtof_channels = {(0, 1): survey, (0, 2): fragments, (1, 1): negative}
    sample.ms_times_pos = sample.ms_times = survey.times
    sample.ms_scans_pos = sample.ms_scans = survey.scans
    sample.tic_pos = sample.tic = survey.tic
    sample.ms_times_neg, sample.ms_scans_neg, sample.tic_neg = negative.times, negative.scans, negative.tic
    return sample


class ReferenceMassTests(unittest.TestCase):
    def test_auto_masks_all_analysis_channels_without_changing_original_data(self):
        raw = sample_fixture(); original = deepcopy(raw)
        filtered = filter_sample(raw)
        np.testing.assert_array_equal(filtered.ms_scans[0], raw.ms_scans[0][[0, 3]])
        np.testing.assert_array_equal(filtered.tic, [120.])
        np.testing.assert_array_equal(filtered.ms_scans_neg[0], raw.ms_scans_neg[0])
        channel = filtered.qtof_channels[(0, 2)]
        self.assertEqual([m['scan_id'] for m in channel.metadata], [3])
        np.testing.assert_array_equal(channel.scans[0], [[200., 100.]])
        self.assertEqual(filtered.qtof_info['reference_filter']['removed_msms_scans'], 2)
        for key, channel in raw.qtof_channels.items():
            for a, b in zip(channel.scans, original.qtof_channels[key].scans): np.testing.assert_array_equal(a, b)
        self.assertNotIn('reference_filter', raw.qtof_info)
        restored = filter_sample(raw, {'mode': 'off'})
        for key, channel in restored.qtof_channels.items():
            self.assertEqual(channel.metadata, raw.qtof_channels[key].metadata)
            for a, b in zip(channel.scans, raw.qtof_channels[key].scans): np.testing.assert_array_equal(a, b)

    def test_detection_requires_measured_monoisotopic_signal_not_just_configuration(self):
        raw = sample_fixture()
        report = filter_sample(raw).qtof_info['reference_filter']
        ion = next(r for r in report['detections'] if r['mz'] == PRESETS[0]['mz'])
        self.assertTrue(ion['found']); self.assertEqual(ion['matched_scans'], 1); self.assertEqual(ion['error_ppm'], 0)
        raw.qtof_channels[(0, 1)].scans = [np.array([[500., 10.]])]
        report = filter_sample(raw).qtof_info['reference_filter']
        ion = next(r for r in report['detections'] if r['mz'] == PRESETS[0]['mz'])
        self.assertTrue(ion['selected']); self.assertFalse(ion['found']); self.assertIsNone(ion['observed_mz'])

    def test_ppm_is_exact_not_rounded_grid_and_isotope_charge_is_respected(self):
        target = {'mz': 922.009798, 'charge': 2}
        centers = np.array([target['mz']*(1+19e-6), target['mz']*(1+21e-6), target['mz']+ISOTOPE_SPACING/2])
        np.testing.assert_array_equal(exclusion_mask(centers, [target], 20, False), [True, False, False])
        np.testing.assert_array_equal(exclusion_mask(centers, [target], 20, True), [True, False, True])

    def test_unknown_method_does_not_automatically_label_an_analyte_as_reference(self):
        raw = sample_fixture(); raw.qtof_info['reference_method'] = {}
        result = filter_sample(raw)
        self.assertFalse(result.qtof_info['reference_filter']['active'])
        self.assertEqual(result.qtof_info['reference_filter']['removed_peaks'], 0)
        self.assertTrue(result.qtof_info['reference_filter']['detections'][0]['found'])
        self.assertTrue(filter_sample(raw, {'mode': '922'}).qtof_info['reference_filter']['active'])
        legacy = SampleData('/legacy.d'); self.assertIs(filter_sample(legacy), legacy)

    def test_method_parser_ignores_disabled_references_and_handles_openlab_encoding(self):
        with tempfile.TemporaryDirectory() as tmp:
            xml = '<?xml version="1.0" encoding="utf-16"?><MSAcqMethod><massRecalibration><enableAutoRecalibration>true</enableAutoRecalibration><refMasses><masses isEnabled="false">121.050873</masses><masses>922.009798</masses></refMasses><refMassesNeg><masses>1033.988109</masses></refMassesNeg></massRecalibration></MSAcqMethod>'
            with ZipFile(Path(tmp)/'Acquisition.amx', 'w') as z: z.writestr('DeviceMethodSettings/LCQTOFDriver%25231', xml.encode())
            result = read_method_references(tmp, 'Acquisition')
            self.assertEqual([r['mz'] for r in result['references']], [922.009798, 1033.988109])
            self.assertEqual(result['references'][1]['polarity'], 'negative')
            self.assertTrue(result['auto_recalibration'])
            with ZipFile(Path(tmp)/'Other.amx', 'w') as z: z.writestr('DeviceMethodSettings/LCQTOFDriver%25231', xml.encode())
            self.assertEqual(read_method_references(tmp)['references'], [])
            self.assertEqual(len(read_method_references(tmp, 'Acquisition.amx')['references']), 2)

    def test_validation_and_local_settings_survive_restart(self):
        for value in [{'ppm': float('nan')}, {'ppm': 0}, {'mode': 'wrong'}, {'isotopes': 'false'},
                      {'mode': 'custom'}, {'mode': 'custom', 'targets': [{'mz': 922, 'charge': 1.5}]},
                      {'mode': 'custom', 'targets': [{'mz': float('inf')}]}]:
            with self.assertRaises(ValueError): normalize_policy(value)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'preferences.json'; store = ReferenceSettingsStore(path)
            self.assertEqual(store.get('sample')['mode'], 'auto'); self.assertFalse(path.exists())
            store.set('sample', {'mode': 'off'})
            self.assertEqual(ReferenceSettingsStore(path).get('sample')['mode'], 'off')

    def test_all_api_analysis_getters_share_filtered_view_and_setting_change_restores_raw(self):
        raw = sample_fixture()
        with tempfile.TemporaryDirectory() as tmp, patch.object(server, '_get_raw_sample', return_value=raw), \
             patch.object(server, '_reference_store', ReferenceSettingsStore(Path(tmp)/'preferences.json')), \
             patch.object(server, '_reference_view_cache', {}):
            filtered = server._get_sample('/fixture.sirslt')
            self.assertIs(server._get_sample('/fixture.sirslt'), filtered)
            spectrum = server.ms_spectrum('/fixture.sirslt', 1.)
            self.assertEqual(len(spectrum['mz']), 2)
            summed = server.summed_spectrum('/fixture.sirslt', 0., 2., 'positive')
            self.assertAlmostEqual(sum(summed['intensities']), 120.)
            scans = server.qtof_scans('/fixture.sirslt', 'positive')
            self.assertEqual([m['scan_id'] for m in scans['ms2']], [3])
            with self.assertRaises(server.HTTPException): server.qtof_spectrum('/fixture.sirslt', 2, 'positive')
            params = {name: p.default.default for name, p in inspect.signature(server.deconvolute).parameters.items()}
            params.update(path='/fixture.sirslt', start=0, end=2, include_singly_charged=False, min_input_mz=0)
            with patch.object(server.analysis, 'deconvolute_protein_local_lcms_machine_like', return_value=[]) as calc:
                server.deconvolute(**params)
            self.assertAlmostEqual(calc.call_args.args[1].sum(), 120.)
            server.set_reference_masses({'path': '/fixture.sirslt', 'policy': {'mode': 'off'}})
            self.assertEqual(len(server.ms_spectrum('/fixture.sirslt', 1.)['mz']), 4)

    def test_custom_reference_precursor_is_not_a_peptide_mapping_candidate(self):
        from peptide_mapping import parse_fasta, digest, fragments, PROTON
        peptide = digest(parse_fasta('PEPTIDER'), 0, [])[0][0]
        mz = peptide['mass']+PROTON
        raw = sample_fixture()
        raw.qtof_channels[(0, 2)] = QtofChannel(np.array([1.]), np.array([1400.]),
            [np.array(sorted((mass, 100.) for _, mass, _ in fragments(peptide['residue_masses'], 1)))],
            [{'scan_id': 2, 'time': 1., 'precursor_mz': mz}])
        with tempfile.TemporaryDirectory() as tmp, patch.object(server, '_get_raw_sample', return_value=raw), \
             patch.object(server, '_reference_store', ReferenceSettingsStore(Path(tmp)/'preferences.json')), \
             patch.object(server, '_reference_view_cache', {}):
            payload = {'path': '/fixture.sirslt', 'fasta': 'PEPTIDER'}
            self.assertTrue(server.peptide_mapping_analyze(payload)['matches'])
            server.set_reference_masses({'path': '/fixture.sirslt', 'policy': {'mode': 'custom', 'targets': [{'mz': mz}]}})
            self.assertEqual(server.peptide_mapping_analyze(payload)['matches'], [])

    def test_reference_preview_checks_pending_selection_without_saving_or_changing_analysis(self):
        raw = sample_fixture()
        with tempfile.TemporaryDirectory() as tmp, patch.object(server, '_get_raw_sample', return_value=raw), \
             patch.object(server, '_reference_store', ReferenceSettingsStore(Path(tmp)/'preferences.json')), \
             patch.object(server, '_reference_view_cache', {}):
            preview = server.preview_reference_masses({'path': '/fixture.sirslt', 'policy': {'mode': 'off'}})
            self.assertFalse(preview['active'])
            self.assertTrue(server.reference_masses('/fixture.sirslt')['active'])
            self.assertFalse((Path(tmp)/'preferences.json').exists())


if __name__ == '__main__': unittest.main()
