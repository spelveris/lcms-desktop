"""Synthetic instrument fixtures only; no research data is distributed."""
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile
import xml.etree.ElementTree as ET

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from data_reader import SampleData, _SIRSLT_MSSCAN_FIELDS, _SIRSLT_MSSCAN_RECORD
from qtof_reader import calibrate, inspect_qtof, is_digest_method, read_records

BASE = [('ScanID', 'i'), ('ScanMethodID', 'i'), ('TimeSegmentID', 'i'),
        ('ScanTime', 'd'), ('MSLevel', 'h'), ('ScanType', 'i'), ('TIC', 'd'),
        ('BasePeakMZ', 'd'), ('BasePeakValue', 'd'), ('CalibrationID', 'h'),
        ('CycleNumber', 'i'), ('IonMode', 'i'), ('IonPolarity', 'h'),
        ('Fragmentor', 'f'), ('CollisionEnergy', 'f'), ('MzOfInterest', 'd'),
        ('MzIsolationWidth', 'f'), ('AbundanceLimit', 'd'), ('SamplingPeriod', 'd'),
        ('Threshold', 'd'), ('ChargeState', 'h'), ('ChromScaleFactor', 'f'),
        ('MassCalOffset', 'q'), ('ActualsOffset', 'q'), ('NumOfActualsPerScan', 'h'),
        ('DDScanID', 'i'), ('DDScanID2', 'i'), ('DDScanID3', 'i')]
BLOCK = [('SpectrumFormatID', 'h'), ('SpectrumOffset', 'q'), ('ByteCount', 'i'),
         ('PointCount', 'i'), ('UncompressedByteCount', 'i'), ('MinX', 'd'),
         ('MaxX', 'd'), ('MinY', 'd'), ('MaxY', 'd'), ('MeasuredNoise', 'd'),
         ('OneDataRangeDeltaYOffset', 'i')]


def pack(fields, values):
    return struct.pack('<' + ''.join(t for _, t in fields), *(values.get(n, 0) for n, _ in fields))


def schema_xml():
    types = {'i': 'int', 'h': 'short', 'd': 'double', 'f': 'float', 'q': 'long'}
    def fields(items):
        return ''.join(f'<xs:element name="{n}" type="xs:{types[t]}"/>' for n, t in items)
    # Preserve the nested structure rather than assuming a fixed struct.
    return ('<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">'
            '<xs:complexType name="ScanRecordType"><xs:sequence>' + fields(BASE[:-3]) +
            '<xs:element name="DD" type="DependentType"/>'
            '<xs:element name="SpectrumParamValues" type="SpectrumParamsType" maxOccurs="unbounded"/>'
            '</xs:sequence></xs:complexType>'
            '<xs:complexType name="DependentType"><xs:sequence>' + fields(BASE[-3:]) +
            '</xs:sequence></xs:complexType>'
            '<xs:complexType name="SpectrumParamsType"><xs:sequence>' + fields(BLOCK) +
            '</xs:sequence></xs:complexType></xs:schema>')


def make_bundle(root, method='Protein_Digest', name='sample.sirslt'):
    bundle = root / name
    bundle.mkdir()
    (bundle / 'sample.acaml').write_text(f'<Root><Path>{method}.amx</Path></Root>')
    with ZipFile(bundle / 'sample.dx', 'w') as archive:
        archive.writestr('MSData/Devices.xml', '<Devices><Device><Name>TOF/Q-TOF</Name><ModelNumber>Test QTOF</ModelNumber></Device></Devices>')
        archive.writestr('MSData/MSScan.xsd', schema_xml())
        archive.writestr('MSData/DefaultMassCal.xml', '<DefaultMassCalibration><DefaultCalibration DefaultCalibrationID="1"><Step><CalibrationFormula>Polynomial</CalibrationFormula><ValueUseFlags>3</ValueUseFlags></Step></DefaultCalibration></DefaultMassCalibration>')
    scans = bytearray(228)
    struct.pack_into('<I', scans, 0x58, 228)
    peaks = bytearray(68)
    calibration = bytearray(72)
    # Non-contiguous calibration blocks test the recorded offsets, not ordinals.
    for i, (level, polarity, parent, empty) in enumerate([(1, 0, 0, False), (2, 0, 10, False), (1, 1, 0, False), (2, 0, 999, True)]):
        row = [1 + i * 0.01, 0, 0, 100, 0.1, 0.01, 0, 0, 0, 0]
        tof = np.array([10., 20., 30.])
        mz = (row[0] * tof) ** 2 - (0.1 + 0.01 * tof)
        intensity = np.array([0.25, 12.5, 3.75], dtype='<f4') * (i + 1)
        blob = b'' if empty else tof.astype('<f8').tobytes() + intensity.tobytes()
        values = dict(ScanID=10+i, ScanTime=1+i*0.1, MSLevel=level, IonPolarity=polarity,
                      TIC=0 if empty else float(intensity.sum()), CalibrationID=1,
                      MassCalOffset=len(calibration), DDScanID=parent, MzOfInterest=99.8 if level == 2 else 0,
                      CollisionEnergy=15 if level == 2 else 0)
        calibration.extend(struct.pack('<i10d', 10, *row) + bytes(16))
        scans.extend(pack(BASE, values))
        scans.extend(pack(BLOCK, dict(SpectrumFormatID=1)))
        scans.extend(pack(BLOCK, dict(SpectrumFormatID=2, SpectrumOffset=-1 if empty else len(peaks),
            PointCount=0 if empty else len(tof), ByteCount=len(blob), MinX=mz[0], MaxX=mz[-1])))
        peaks.extend(blob)
    (bundle / 'sample.MSScan.bin').write_bytes(scans)
    (bundle / 'sample.MSPeak.bin').write_bytes(peaks)
    (bundle / 'sample.MSMassCal.bin').write_bytes(calibration)
    # Must not mistake the QTOF RLE profile for the quadrupole profile encoding.
    (bundle / 'sample.MSProfile.bin').write_bytes(b'not a quadrupole profile')
    return bundle


class QtofReaderTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)

    def load(self, **kwargs):
        bundle = make_bundle(self.root, **kwargs)
        sample = SampleData(str(bundle))
        self.assertTrue(sample.load(), sample.error)
        return sample

    def test_dual_block_schema_calibration_fractional_intensities_and_separation(self):
        sample = self.load()
        self.assertEqual(struct.calcsize('<'+''.join(t for _, t in BASE+BLOCK+BLOCK)), _SIRSLT_MSSCAN_RECORD.size)
        self.assertTrue(sample.qtof_info['is_protein_digest'])
        self.assertEqual(sample.qtof_info['scan_counts'], {'1': 2, '2': 2})
        self.assertEqual(sample.qtof_info['empty_scans'], 1)
        self.assertEqual(len(sample.ms_times_pos), 1)
        np.testing.assert_allclose(sample.ms_scans_pos[0][:, 0], [99.8, 399.7, 899.6])
        np.testing.assert_allclose(sample.ms_scans_pos[0][:, 1], [.25, 12.5, 3.75])
        np.testing.assert_allclose(sample.ms_scans_neg[0][:, 0], [(1.02*10)**2-.2, (1.02*20)**2-.3, (1.02*30)**2-.4])
        self.assertEqual(sample.qtof_channels[(0, 2)].metadata[0]['parent_scan_id'], 10)
        self.assertIsNone(sample.qtof_channels[(0, 2)].metadata[1]['parent_scan_id'])
        np.testing.assert_allclose(server.analysis.extract_eic(sample, 99.8, .001), [.25])
        _, summed = server.analysis.sum_spectra_in_range(sample, 0, 5)
        self.assertAlmostEqual(float(summed.sum()), 16.5)

    def test_polynomial_sparse_orders_and_clamped_range(self):
        tof = np.array([2., 3., 4.])
        row = np.array([2., 1., 2.5, 3.5, .1, .01, 0, 0, 0, 0])
        np.testing.assert_allclose(calibrate(tof, row, 5), (2*(tof-1))**2 - (.1+.01*np.clip(tof,2.5,3.5)**2))

    def test_digest_gate_uses_recorded_method_not_name(self):
        for name in ['Protein_Digest', 'protein digestion', r'C:\Methods\Peptide_Mapping.amx', 'PeptideMapping']:
            self.assertTrue(is_digest_method(name), name)
        for name in [None, '', 'Intact_Mass', 'undigested', 'C4', 'Intact_Protein_Digest']:
            self.assertFalse(is_digest_method(name), name)
        sample = self.load(method='Intact_Mass', name='peptide_mapping_digest.sirslt')
        self.assertFalse(sample.qtof_info['is_protein_digest'])
        with patch.object(server, '_get_sample', return_value=sample):
            with self.assertRaises(server.HTTPException) as error:
                server.qtof_scans('fixture', 'positive')
            self.assertEqual(error.exception.status_code, 404)

    def test_api_returns_exact_measured_scans_and_authoritative_parent(self):
        sample = self.load()
        with patch.object(server, '_get_sample', return_value=sample):
            result = server.qtof_scans('fixture', 'positive')
            self.assertEqual([s['scan_id'] for s in result['ms1']], [10])
            self.assertEqual([s['scan_id'] for s in result['ms2']], [11, 13])
            fragment = server.qtof_spectrum('fixture', 11, 'positive')
            self.assertEqual(fragment['ms_level'], 2)
            self.assertEqual(fragment['parent_scan_id'], 10)
            self.assertEqual(fragment['intensities'], [.5, 25., 7.5])
            self.assertEqual(server.qtof_spectrum('fixture', 13, 'positive')['mz'], [])
            for scan_id, polarity in [(11, 'negative'), (999, 'positive'), (10, 'invalid')]:
                with self.assertRaises(server.HTTPException):
                    server.qtof_spectrum('fixture', scan_id, polarity)

    def test_corrupt_spectra_and_calibration_fail_closed(self):
        for suffix, mode in [('MSPeak', 'truncate'), ('MSMassCal', 'truncate'), ('MSScan', 'truncate'), ('MSMassCal', 'badcount'), ('MSMassCal', 'wrongmass')]:
            with self.subTest(suffix=suffix, mode=mode):
                bundle = make_bundle(self.root, name=f'{suffix}-{mode}.sirslt')
                path = bundle / f'sample.{suffix}.bin'
                content = bytearray(path.read_bytes())
                if mode == 'truncate': content = content[:80]
                if mode == 'badcount': struct.pack_into('<i', content, 72, 9)
                if mode == 'wrongmass': struct.pack_into('<d', content, 76, 2.)
                path.write_bytes(content)
                sample = SampleData(str(bundle))
                self.assertFalse(sample.load())
                self.assertIn('QTOF', sample.error)

    def test_legacy_quadrupole_profile_path_unchanged(self):
        bundle = self.root / 'old-machine.sirslt'; bundle.mkdir()
        with ZipFile(bundle / 'sample.dx', 'w') as archive:
            archive.writestr('MSData/Devices.xml', '<Devices><Device><Name>Quadrupole</Name></Device></Devices>')
        profile = struct.pack('<dd3I', 100., .1, 10, 20, 30)
        (bundle / 'sample.MSProfile.bin').write_bytes(profile)
        header = bytearray(228); struct.pack_into('<I', header, 0x58, 228)
        values = dict(ScanID=1, ScanTime=1., MSLevel=1, TIC=60., ByteCount=len(profile), PointCount=3, SpectrumFormatID=1)
        (bundle / 'sample.MSScan.bin').write_bytes(header + pack(_SIRSLT_MSSCAN_FIELDS, values))
        sample = SampleData(str(bundle))
        self.assertTrue(sample.load(), sample.error)
        self.assertIsNone(sample.qtof_info)
        np.testing.assert_array_equal(sample.ms_scans[0], [10.,20.,30.])
        np.testing.assert_allclose(sample.ms_mz_axis, [100.,100.1,100.2])

    def test_legacy_d_still_delegates_to_existing_rainbow_precision(self):
        sample = SampleData(str(self.root / 'old.d'))
        with patch('data_reader.rb.read', side_effect=RuntimeError('fixture')) as reader, patch.object(sample, '_fallback_read', return_value=None):
            sample.load()
        reader.assert_called_once_with(sample.folder_path, prec=1)


if __name__ == '__main__':
    unittest.main()
