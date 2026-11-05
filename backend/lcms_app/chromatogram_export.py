"""Prepare the complete plotted chromatogram data for per-panel downloads."""
import csv
import io
from itertools import zip_longest
import re
import numpy as np

COLORS = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
          '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf']


def prepare_chromatogram(payload):
    kind = str(payload.get('kind', '')).lower()
    polarity = str(payload.get('polarity') or '').lower()
    background_subtracted = payload.get('background_subtracted') is True
    if kind not in {'uv', 'tic'} or polarity not in {'', 'positive', 'negative'}:
        raise ValueError('Choose a UV chromatogram or a positive/negative TIC')
    raw_traces = payload.get('traces')
    if not isinstance(raw_traces, list) or not 1 <= len(raw_traces) <= 32:
        raise ValueError('One or more chromatogram traces are required (maximum 32)')
    if kind == 'tic' and len(raw_traces) != 1:
        raise ValueError('Export each TIC polarity separately')
    traces = []
    for index, raw in enumerate(raw_traces):
        if not isinstance(raw, dict):
            raise ValueError('Invalid chromatogram trace')
        try:
            times = np.asarray(raw.get('times', []), dtype=float)
            intensities = np.asarray(raw.get('intensities', []), dtype=float)
        except (TypeError, ValueError) as exc:
            raise ValueError('Chromatogram values must be numeric') from exc
        if (times.ndim != 1 or intensities.ndim != 1 or times.size == 0
                or times.size != intensities.size or not np.isfinite(times).all()
                or not np.isfinite(intensities).all() or np.any(np.diff(times) < 0)):
            raise ValueError('Times and intensities must be finite, equally sized, non-empty ordered arrays')
        if kind == 'uv':
            try:
                wavelength = float(raw.get('wavelength') if raw.get('wavelength') is not None else raw.get('nm'))
            except (TypeError, ValueError) as exc:
                raise ValueError('Each UV trace needs its measured wavelength') from exc
            if not np.isfinite(wavelength) or wavelength <= 0:
                raise ValueError('Invalid UV wavelength')
            label = f'{wavelength:g} nm'
            column = f'UV absorbance at {label} (mAU)'
        else:
            label = f'{polarity.capitalize()} TIC' if polarity else 'TIC'
            column = f'{label} intensity (counts)'
        if background_subtracted:
            column = f'Background-subtracted {column}'
        color = str(raw.get('color') or COLORS[index % len(COLORS)])
        if not re.fullmatch(r'#[0-9a-fA-F]{6}', color):
            color = COLORS[index % len(COLORS)]
        traces.append({'times': times, 'intensities': intensities,
                       'label': label, 'column': column, 'color': color})
    default_title = 'UV Chromatogram' if kind == 'uv' else label
    return {'kind': kind, 'polarity': polarity, 'traces': traces,
            'title': str(payload.get('title') or default_title),
            'y_label': 'Absorbance (mAU)' if kind == 'uv' else 'Intensity (counts)'}


def chromatogram_csv(traces, *, x_label='Elution time (min)'):
    """Keep each channel's original pairs, including unequal or duplicate coordinates."""
    output = io.StringIO(newline='')
    writer = csv.writer(output)
    headers = []
    for trace in traces:
        time_label = x_label
        if len(traces) > 1:
            time_label += f" - {trace['label']}"
        headers.extend([time_label, trace['column']])
    writer.writerow(headers)
    # Independent time columns avoid interpolation, invented zero observations,
    # precision loss from rounded timestamp joins, and dropped duplicate times.
    channels = [zip(trace['times'], trace['intensities']) for trace in traces]
    for observations in zip_longest(*channels):
        row = []
        for pair in observations:
            row.extend(['', ''] if pair is None else [float(pair[0]), float(pair[1])])
        writer.writerow(row)
    return output.getvalue().encode('utf-8')


def time_change_csv(traces, signal_kind):
    """Export each sample's coordinates and intensity before display normalization."""
    signal_columns = {'uv': 'UV absorbance (mAU)', 'tic': 'TIC intensity (counts)',
                      'eic': 'EIC intensity (counts)'}
    x_label = 'Elution time (min)' if signal_kind in signal_columns else 'm/z'
    y_label = signal_columns.get(signal_kind, 'Intensity (counts)')
    channels = []
    for index, trace in enumerate(traces, 1):
        if not isinstance(trace, dict):
            raise ValueError('Invalid Time Change trace')
        try:
            x = np.asarray(trace.get('x', []), dtype=float)
            y = np.asarray(trace.get('intensities', []), dtype=float)
        except (TypeError, ValueError) as exc:
            raise ValueError('Time Change coordinates and intensities must be numeric') from exc
        if x.ndim != 1 or y.ndim != 1 or x.size != y.size:
            raise ValueError('Time Change coordinates and intensities must be equally sized lists')
        finite = np.isfinite(x) & np.isfinite(y)
        if finite.any():
            label = str(trace.get('label') or f'Sample {index}')
            channels.append({'times': x[finite], 'intensities': y[finite],
                             'label': label, 'column': f'{y_label} - {label}'})
    if not channels:
        raise ValueError('No Time Change data available for export')
    return chromatogram_csv(channels, x_label=x_label)
