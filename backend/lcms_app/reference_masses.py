"""Read-only QTOF reference-ion diagnostics and reversible analysis exclusion.

These are m/z masks, not chemical identifications or a second recalibration.
Raw acquisition arrays are never changed. HP-0921 and purine positive masses:
https://www.agilent.com/cs/library/usermanuals/public/Q-TOF_Verification_MH10.0.pdf
"""
from copy import copy
import json
from pathlib import Path
from threading import RLock
from zipfile import ZipFile, BadZipFile
import xml.etree.ElementTree as ET
import numpy as np

ISOTOPE_SPACING = 1.00335483507
PRESETS = [
    {'mz': 922.009798, 'polarity': 'positive', 'charge': 1, 'name': 'HP-0921'},
    {'mz': 121.050873, 'polarity': 'positive', 'charge': 1, 'name': 'Purine'},
]


def normalize_policy(value=None):
    value = {} if value is None else value
    if not isinstance(value, dict):
        raise ValueError('Invalid reference-ion settings')
    mode = value.get('mode', 'auto')
    if mode not in {'auto', '922', '121+922', 'custom', 'off'}:
        raise ValueError('Unknown reference-ion mode')
    ppm = float(value.get('ppm', 20))
    if not np.isfinite(ppm) or not 1 <= ppm <= 50:
        raise ValueError('Reference tolerance must be between 1 and 50 ppm')
    isotopes = value.get('isotopes', True)
    if not isinstance(isotopes, bool):
        raise ValueError('Reference isotope exclusion must be true or false')
    targets = value.get('targets', [])
    if not isinstance(targets, list) or len(targets) > 16:
        raise ValueError('Use at most 16 reference ions')
    clean = []
    for target in targets:
        if not isinstance(target, dict):
            raise ValueError('Invalid reference ion')
        mz = float(target.get('mz', 0))
        charge = float(target.get('charge', 1))
        polarity = target.get('polarity', 'positive')
        if not np.isfinite(mz) or not 1 <= mz <= 100000:
            raise ValueError('Reference m/z must be between 1 and 100000')
        if not np.isfinite(charge) or charge != int(charge) or not 1 <= charge <= 6:
            raise ValueError('Reference charge must be a whole number from 1 to 6')
        if polarity not in {'positive', 'negative'}:
            raise ValueError('Reference polarity must be positive or negative')
        clean.append({'mz': mz, 'polarity': polarity, 'charge': int(charge), 'name': 'Custom reference'})
    if mode == 'custom' and not clean:
        raise ValueError('Enter at least one custom reference m/z')
    return {'mode': mode, 'ppm': ppm, 'isotopes': isotopes, 'targets': clean}


def read_method_references(bundle, method=None):
    """Read only the selected saved acquisition method, not disabled list entries."""
    result = {'references': [], 'auto_recalibration': False, 'source': 'not available'}
    paths = sorted(p for p in Path(bundle).glob('*.amx') if not p.name.startswith('._'))
    name = str(method or '').replace('\\', '/').split('/')[-1]
    matching = [p for p in paths if p.stem.lower() == Path(name).stem.lower()]
    paths = matching or paths
    if len(paths) != 1:
        result['warning'] = 'No unambiguous saved reference-ion method; select a reference manually.'
        return result
    try:
        with ZipFile(paths[0]) as archive:
            entries = [i for i in archive.infolist() if i.filename.startswith('DeviceMethodSettings/LCQTOFDriver')
                       and not i.filename.endswith('.chk')]
            if len(entries) != 1 or entries[0].file_size > 1024 * 1024:
                raise ValueError('Unsupported reference-ion method metadata')
            blob = archive.read(entries[0])
            # Some OpenLab files declare UTF-16 while actually storing UTF-8.
            encoding = 'utf-16' if blob.startswith((b'\xff\xfe', b'\xfe\xff')) or b'\x00' in blob[:80] else 'utf-8-sig'
            root = ET.fromstring(blob.decode(encoding))
        for node in root.iter():
            node.tag = node.tag.rsplit('}', 1)[-1]
        recal = next(root.iter('massRecalibration'), None)
        if recal is None:
            return result
        result['source'] = 'saved acquisition method'
        result['auto_recalibration'] = (recal.findtext('enableAutoRecalibration', '').lower() == 'true')
        for tag, polarity in [('refMasses', 'positive'), ('refMassesNeg', 'negative')]:
            for node in recal.findall(f'{tag}/masses'):
                if node.get('isEnabled', 'true').lower() != 'true':
                    continue
                mz = float(node.text)
                if not np.isfinite(mz) or not 1 <= mz <= 100000:
                    continue
                result['references'].append({'mz': mz, 'polarity': polarity, 'charge': 1, 'name': 'Method reference'})
        if len(result['references']) > 16:
            raise ValueError('Too many method reference ions')
    except (OSError, BadZipFile, ET.ParseError, UnicodeError, ValueError, TypeError) as exc:
        result.update(references=[], warning=f'Reference method could not be read: {type(exc).__name__}')
    return result


def selected_targets(sample, policy):
    if policy['mode'] == 'off':
        return []
    if policy['mode'] in {'922', '121+922'}:
        return [dict(t) for t in PRESETS[:1 if policy['mode'] == '922' else 2]]
    if policy['mode'] == 'custom':
        return policy['targets']
    method = sample.qtof_info.get('reference_method', {})
    return method.get('references', []) if method.get('auto_recalibration') else []


def exclusion_mask(mz, targets, ppm, isotopes):
    mask = np.zeros(np.shape(mz), dtype=bool)
    for target in targets:
        for offset in range(4 if isotopes else 1):
            center = target['mz'] + offset * ISOTOPE_SPACING / target['charge']
            mask |= np.abs(mz - center) <= center * ppm * 1e-6
    return mask


def reference_report(sample, policy, targets):
    """Detect peaks on RAW MS1 scans; configuration alone is not detection."""
    candidates = [*targets, *sample.qtof_info.get('reference_method', {}).get('references', []), *PRESETS]
    rows, seen = [], set()
    selected = {(t['polarity'], t['mz'], t['charge']) for t in targets}
    for target in candidates:
        key = (target['polarity'], target['mz'], target['charge'])
        if key in seen:
            continue
        seen.add(key)
        channel = sample.qtof_channels.get((0 if target['polarity'] == 'positive' else 1, 1))
        observed, intensities, times = [], [], []
        scans = channel.scans if channel is not None else []
        for index, scan in enumerate(scans):
            hits = np.flatnonzero(exclusion_mask(scan[:, 0], [target], policy['ppm'], False) & (scan[:, 1] > 0))
            if len(hits):
                peak = hits[np.argmax(scan[hits, 1])]
                observed.append(float(scan[peak, 0])); intensities.append(float(scan[peak, 1]))
                times.append(float(channel.times[index]))
        median = float(np.median(observed)) if observed else None
        rows.append({**target, 'selected': key in selected, 'found': bool(observed),
                     'matched_scans': len(observed), 'total_scans': len(scans),
                     'observed_mz': median, 'error_ppm': (median-target['mz'])/target['mz']*1e6 if median is not None else None,
                     'max_intensity': max(intensities, default=0),
                     'time_range': [min(times), max(times)] if times else None})
    return rows


def filter_sample(sample, policy=None):
    """New analysis view sharing unaffected arrays; original sample stays raw."""
    if getattr(sample, 'qtof_info', None) is None:
        return sample
    policy = normalize_policy(policy)
    targets = selected_targets(sample, policy)
    output = copy(sample)
    output.qtof_info = dict(sample.qtof_info)
    output.qtof_channels = {}
    removed_peaks = removed_scans = 0
    for (polarity, level), channel in sample.qtof_channels.items():
        applicable = [t for t in targets if t['polarity'] == ('positive' if polarity == 0 else 'negative')]
        filtered = copy(channel)
        scans, metadata, times, tic = [], [], [], []
        for index, (scan, meta) in enumerate(zip(channel.scans, channel.metadata)):
            precursor = meta.get('precursor_mz')
            if level > 1 and precursor and exclusion_mask(np.array([precursor]), applicable, policy['ppm'], policy['isotopes'])[0]:
                removed_scans += 1
                continue  # Reference-selected MS/MS must never become a peptide candidate.
            mask = exclusion_mask(scan[:, 0], applicable, policy['ppm'], policy['isotopes'])
            count = int(mask.sum()); removed_peaks += count
            scans.append(scan[~mask] if count else scan)
            metadata.append(meta); times.append(channel.times[index])
            # Preserve the instrument's TIC apart from the removed centroid counts.
            tic.append(max(0., float(channel.tic[index]) - float(scan[mask, 1].sum())))
        filtered.scans, filtered.metadata = scans, metadata
        filtered.times, filtered.tic = np.asarray(times), np.asarray(tic)
        output.qtof_channels[(polarity, level)] = filtered
        if level == 1:
            suffix = 'pos' if polarity == 0 else 'neg'
            for field, value in [('times', filtered.times), ('scans', scans), ('tic', filtered.tic)]:
                setattr(output, f'{"tic" if field == "tic" else "ms_"+field}_{suffix}', value)
    suffix = 'pos' if getattr(sample, 'ms_times_pos', None) is not None else 'neg'
    for field in ['ms_times', 'ms_scans', 'tic']:
        setattr(output, field, getattr(output, f'{field}_{suffix}', getattr(sample, field, None)))
    report = {'policy': policy, 'targets': targets, 'detections': reference_report(sample, policy, targets),
              'removed_peaks': removed_peaks, 'removed_msms_scans': removed_scans,
              'method': sample.qtof_info.get('reference_method', {}),
              'active': bool(targets), 'raw_files_unchanged': True}
    output.qtof_info['reference_filter'] = report
    return output


class ReferenceSettingsStore:
    """Local app preferences only; never stored beside research data."""
    def __init__(self, path):
        self.path = Path(path)
        self.lock = RLock()
        self.values = None

    def _load(self):
        if self.values is not None:
            return
        if not self.path.exists():
            self.values = {}; return
        if self.path.stat().st_size > 2 * 1024 * 1024:
            raise ValueError('Reference settings file is too large')
        data = json.loads(self.path.read_text(encoding='utf-8'))
        if not isinstance(data, dict):
            raise ValueError('Invalid saved reference settings')
        self.values = {path: normalize_policy(value) for path, value in data.items()}

    def get(self, path):
        with self.lock:
            self._load()
            return normalize_policy(self.values.get(path))

    def set(self, path, value):
        value = normalize_policy(value)
        with self.lock:
            self._load()
            updated = {**self.values, path: value}
            text = json.dumps(updated, ensure_ascii=False)
            if len(text.encode('utf-8')) > 2 * 1024 * 1024:
                raise ValueError('Too many saved reference settings')
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_suffix('.tmp')
            temporary.write_text(text, encoding='utf-8')
            temporary.replace(self.path)
            self.values = updated
        return value
