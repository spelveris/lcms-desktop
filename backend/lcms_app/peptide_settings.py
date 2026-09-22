"""Editable, supported digest-method settings (not a BioConfirm emulation)."""
import math

DEFAULTS = {
    'ms1_mz_min': 350., 'ms1_mz_max': 2000., 'ms1_peak_min': 100.,
    'peptide_min_length': 5, 'peptide_max_length': 70,
    'terminal_truncation': True, 'charge_min': 1, 'charge_max': 6,
    'fragment_min_relative_percent': 0., 'fragment_min_intensity': 0.,
    'fragment_peak_limit': 0,
}


def method_settings(raw=None):
    if raw is None:
        raw = {}
    if not isinstance(raw, dict) or set(raw) - DEFAULTS.keys():
        raise ValueError('Unknown peptide method setting')
    result = {**DEFAULTS, **raw}
    bounds = {'ms1_mz_min': (0, 10000), 'ms1_mz_max': (1, 10000),
              'ms1_peak_min': (0, 1e15), 'peptide_min_length': (5, 70),
              'peptide_max_length': (5, 70), 'charge_min': (1, 6), 'charge_max': (1, 6),
              'fragment_min_relative_percent': (0, 100), 'fragment_min_intensity': (0, 1e15),
              'fragment_peak_limit': (0, 10000)}
    integers = {'peptide_min_length', 'peptide_max_length', 'charge_min', 'charge_max', 'fragment_peak_limit'}
    for key, (low, high) in bounds.items():
        value = result[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
            raise ValueError(f'{key}: use a finite number from {low:g} to {high:g}')
        if key in integers:
            if int(value) != value:
                raise ValueError(f'{key} must be a whole number')
            result[key] = int(value)
    for low, high in [('ms1_mz_min', 'ms1_mz_max'), ('peptide_min_length', 'peptide_max_length'), ('charge_min', 'charge_max')]:
        if result[low] > result[high] or (low == 'ms1_mz_min' and result[low] == result[high]):
            raise ValueError(f'{low} must not exceed {high}')
    if not isinstance(result['terminal_truncation'], bool):
        raise ValueError('Terminal truncation must be true or false')
    return result
