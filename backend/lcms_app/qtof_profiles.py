"""Lazy, read-only QTOF profile access; never used by quadrupole readers.

RLE interpretation adapted from rainbow-api 1.5.2, Evan Shi and Eugene Kwan,
rainbow/agilent/masshunter.py. SPDX-License-Identifier: LGPL-3.0-or-later.
See third_party/rainbow/NOTICE.md and the accompanying license texts.
"""
from pathlib import Path
import struct
import numpy as np
from qtof_reader import read_records, calibration_flags, calibrate


def decode_rle(blob, count):
    if not 0 < count <= 1_000_000 or len(blob) < 24:
        raise ValueError('Invalid QTOF profile size')
    header, leading = struct.unpack_from('<Ii', blob, 16)
    if header != (0x90000000 | count) or leading > 0 or -leading > count:
        raise ValueError('Unsupported QTOF profile encoding (expected validated RLE)')
    values = np.zeros(count, dtype=float)
    index, offset, width = -leading, 24, 4
    unpackers = {1: struct.Struct('<b'), 2: struct.Struct('<h'), 4: struct.Struct('<i')}
    while offset < len(blob):
        if offset + width > len(blob):
            raise ValueError('Truncated QTOF profile token')
        value = unpackers[width].unpack_from(blob, offset)[0]
        offset += width
        if value >= 0:
            if index >= count:
                raise ValueError('QTOF profile exceeds declared point count')
            values[index] = value
            index += 1
        else:
            zeros, flag = divmod(-value, 4)
            if flag not in (1, 2, 3) or index + zeros > count:
                raise ValueError('Invalid QTOF profile run-length token')
            index += zeros
            width = {1: 1, 2: 2, 3: 4}[flag]
    return values


class QtofProfileSource:
    """Only an index is kept at import. Decode selected MS1 scans on demand."""
    def __init__(self, bundle, context):
        bundle = Path(bundle)
        indexes = [p for p in bundle.glob('*.MSScan.bin') if not p.name.startswith('._')]
        if len(indexes) != 1:
            raise ValueError('Expected one QTOF scan index')
        stem = indexes[0].name[:-len('.MSScan.bin')]
        self.profile = bundle / (stem+'.MSProfile.bin')
        self.calibration = bundle / (stem+'.MSMassCal.bin')
        self.records = read_records(indexes[0], context['schema'])
        self.flags = calibration_flags(context['calibration'])
        self.available = self.profile.is_file() and any(
            r['MSLevel'] == 1 and r['IonPolarity'] == 0 and r['spectra'][0]['PointCount'] > 0
            for r in self.records)

    def window(self, start, end):
        if not self.available or not np.isfinite([start, end]).all() or end <= start:
            raise ValueError('Choose a valid time window containing QTOF MS1 profiles')
        selected = [r for r in self.records if r['MSLevel'] == 1 and r['IonPolarity'] == 0
                    and start <= r['ScanTime'] <= end and r['spectra'][0]['PointCount'] > 0]
        if not selected:
            raise ValueError('No measured QTOF MS1 profiles in this time window')
        if len(selected) > 180:
            raise ValueError('Profile fitting is limited to 180 MS1 scans; select a narrower elution window')
        profile_size, cal_size = self.profile.stat().st_size, self.calibration.stat().st_size
        with self.profile.open('rb') as profiles, self.calibration.open('rb') as calibration:
            for record in selected:
                block = record['spectra'][0]
                offset, size, count = (int(block[k]) for k in ('SpectrumOffset', 'ByteCount', 'PointCount'))
                if offset < 68 or not 24 <= size <= 16_000_000 or offset+size > profile_size:
                    raise ValueError('Invalid or incomplete QTOF profile block')
                cal_offset = int(record['MassCalOffset'])
                if cal_offset < 72 or cal_offset+84 > cal_size or record['CalibrationID'] not in self.flags:
                    raise ValueError('Missing QTOF profile calibration')
                calibration.seek(cal_offset)
                if struct.unpack('<i', calibration.read(4))[0] != 10:
                    raise ValueError('Unsupported QTOF profile calibration')
                row = np.frombuffer(calibration.read(80), dtype='<f8')
                profiles.seek(offset)
                blob = profiles.read(size)
                y = decode_rle(blob, count)
                start_tof, delta_tof = struct.unpack_from('<dd', blob)
                if not np.isfinite([start_tof, delta_tof]).all() or delta_tof <= 0:
                    raise ValueError('Invalid QTOF profile flight-time axis')
                x = calibrate(start_tof+np.arange(count)*delta_tof, row, self.flags[record['CalibrationID']])
                error = max(abs(x[0]-block['MinX']), abs(x[-1]-block['MaxX']))
                if (not np.isfinite(x).all() or np.any(x <= 0) or np.any(np.diff(x) <= 0)
                        or error > .002 or y.max() != block['MaxY']):
                    raise ValueError('QTOF profile does not match recorded calibration/intensity bounds')
                yield {'scan_id': record['ScanID'], 'time': record['ScanTime'], 'mz': x, 'intensities': y}
