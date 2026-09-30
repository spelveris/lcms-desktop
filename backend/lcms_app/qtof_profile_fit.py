"""Experimental main-region profile reconstruction, not Agilent MaxEnt.

Average measured profile area on a 0.05 m/z grid; fit one nonnegative mass
distribution and a shared charge envelope. Signed residuals are retained.
The finite grid is not isotope resolution. No post-fit smoothing is applied.
This module never changes legacy readers, Expert defaults or peptide analysis.
"""
from dataclasses import dataclass
import numpy as np
from scipy.integrate import cumulative_trapezoid
from scipy.optimize import minimize
from scipy.sparse import coo_matrix
from qtof_deconvolution import is_intact_qtof

PROTON = 1.00784
MZ_STEP = .05
MAX_ITER = 600


def smoke_test():
    """Exercise the decoder and sparse optimizer in the packaged executable."""
    import struct
    from qtof_profiles import decode_rle
    decoded = decode_rle(struct.pack('<ddIiii', 10., .001, 0x90000004, 0, 5, -5), 4)
    np.testing.assert_array_equal(decoded, [5., 0., 0., 0.])
    g = Geometry(9990., 10050., np.arange(900.025, 1800., MZ_STEP), np.arange(6, 11))
    p = np.zeros(len(g.masses)); p[10] = 10000.; p[40] = 700.
    y = combine(charge_operators(g), np.array([.1, .2, .4, .2, .1]))@p
    fit = reconstruct(y, g)
    if np.argmax(fit['profile']) != 10 or fit['profile'][40] <= 0:
        raise RuntimeError('Packaged profile reconstruction failed its synthetic check')
    np.testing.assert_allclose(fit['predicted']+fit['residual'], y, atol=1e-10)
    return {'profile_decoder': 'ok', 'profile_reconstruction': 'ok'}


@dataclass
class Geometry:
    low: float
    high: float
    mz: np.ndarray
    charges: np.ndarray
    step: float = 1.

    @property
    def masses(self):
        return np.arange(self.low, self.high, self.step)+self.step/2


def infer_envelope(y, g):
    mass = g.masses
    csum = np.r_[0., np.cumsum(y)]
    def integral(width):
        left = (mass[None, :]-width)/g.charges[:, None]+PROTON
        right = (mass[None, :]+width)/g.charges[:, None]+PROTON
        lo = np.clip(np.floor((left-g.mz[0]+MZ_STEP/2)/MZ_STEP).astype(int), 0, len(y))
        hi = np.clip(np.ceil((right-g.mz[0]+MZ_STEP/2)/MZ_STEP).astype(int), 0, len(y))
        return csum[hi]-csum[lo]
    signal = np.maximum(integral(12.)-(integral(40.)-integral(20.))*.6, 0.)
    score = np.sqrt(signal).sum(axis=0)
    k = int(np.argmax(score))
    q = signal[:, k]
    if q.sum() <= 0:
        raise ValueError('No supported charge-envelope seed in the selected mass range')
    return float(mass[k]), q/q.sum()


def charge_operators(g):
    ops = []
    mass = g.masses
    for z in g.charges:
        left = (mass-g.step/2)/z+PROTON
        right = (mass+g.step/2)/z+PROTON
        first = np.floor((left-g.mz[0]+MZ_STEP/2)/MZ_STEP).astype(int)
        last = np.floor((right-g.mz[0]+MZ_STEP/2)/MZ_STEP).astype(int)
        rows, cols, values = [], [], []
        for off in range(int(np.max(last-first))+1):
            j = first+off
            edge = g.mz[0]-MZ_STEP/2+j*MZ_STEP
            overlap = np.maximum(0., np.minimum(right, edge+MZ_STEP)-np.maximum(left, edge))
            valid = (j >= 0) & (j < len(g.mz)) & (overlap > 1e-12)
            rows.extend(j[valid]); cols.extend(np.flatnonzero(valid)); values.extend(overlap[valid]*z/g.step)
        ops.append(coo_matrix((values, (rows, cols)), shape=(len(g.mz), len(mass))).tocsr())
    return ops


def combine(ops, q):
    result = ops[0]*q[0]
    for op, weight in zip(ops[1:], q[1:]):
        if weight:
            result = result+op*weight
    return result.tocsr()


def nonnegative_fit(a, y, usable):
    # Excluded reference bins carry no objective weight, not fabricated zeros.
    a = a.multiply(usable[:, None]).tocsr()
    y = y*usable
    scale = max(float(y.max()), 1e-20)
    inv = 1/np.sqrt(np.maximum(np.asarray(a.power(2).sum(axis=0)).ravel(), 1e-12))
    aa = a.multiply(inv).tocsr(); transpose = aa.T.tocsr(); yy = y/scale
    def objective(x):
        residual = aa@x-yy
        delta = .003
        loss = np.where(residual < -delta, -delta*residual-.5*delta**2, .5*residual**2)
        return float(loss.sum()), transpose@np.maximum(residual, -delta)
    result = minimize(objective, np.zeros(a.shape[1]), jac=True, bounds=[(0., None)]*a.shape[1],
                      method='L-BFGS-B', options={'maxiter': MAX_ITER, 'ftol': 1e-12, 'gtol': 1e-8, 'maxls': 30})
    return result.x*inv*scale, bool(result.success)


def reconstruct(y, g, usable=None):
    usable = np.ones(len(y), dtype=bool) if usable is None else np.asarray(usable, dtype=bool)
    seed, q = infer_envelope(y*usable, g)
    ops = charge_operators(g)
    converged = []
    p, ok = nonnegative_fit(combine(ops, q), y, usable); converged.append(ok)
    from scipy.sparse import csr_matrix
    for _ in range(8):
        b = csr_matrix(np.column_stack([op@p for op in ops]))
        qq, ok = nonnegative_fit(b, y, usable); converged.append(ok)
        if qq.sum() <= 0:
            break
        q = qq/qq.sum()
        p, ok = nonnegative_fit(combine(ops, q), y, usable); converged.append(ok)
    predicted = combine(ops, q)@p
    residual = y-predicted
    denominator = max(float(y[usable].sum()), 1e-20)
    return {'mass': g.masses, 'profile': p, 'predicted': predicted, 'residual': residual,
            'q': q, 'seed': seed, 'converged': all(converged),
            'unexplained_fraction': float(np.maximum(residual[usable], 0).sum()/denominator),
            'overshoot_fraction': float(np.maximum(-residual[usable], 0).sum()/denominator)}


def average_profiles(sample, start, end, edges):
    source = getattr(sample, 'qtof_profile_source', None)
    if source is None:
        raise ValueError('This QTOF run has no supported measured profile data')
    total = np.zeros(len(edges)-1); coverage = np.zeros(len(total), dtype=int)
    count = 0; apex = None; apex_area = -1.
    for scan in source.window(start, end):
        x, y = scan['mz'], scan['intensities']
        integral = np.r_[0., cumulative_trapezoid(y, x)]
        values = np.diff(np.interp(edges, x, integral))
        inside = (edges[:-1] >= x[0]) & (edges[1:] <= x[-1])
        total += values*inside; coverage += inside
        area = float(values.sum())
        if area > apex_area:
            apex, apex_area = scan, area
        count += 1
    if not count:
        raise ValueError('No QTOF profiles in the selected time window')
    return total/count, coverage == count, count, apex


def reference_mask(sample, mz):
    report = (sample.qtof_info or {}).get('reference_filter') or {}
    policy = report.get('policy') or {}
    excluded = np.zeros(len(mz), dtype=bool)
    for target in report.get('targets', []):
        if target.get('polarity') != 'positive':
            continue
        for offset in range(4 if policy.get('isotopes', True) else 1):
            center = target['mz']+offset*1.00335483507/target['charge']
            # Profile peaks have wings, unlike centroid sticks. Keep this
            # exclusion explicit and mask the fit objective across these bins.
            width = max(.25, center*float(policy.get('ppm', 10))*1e-6)
            excluded |= abs(mz-center) <= width+MZ_STEP/2
    return excluded


def run(sample, start, end, low=500., high=50000., background=None, reference_components=None):
    if not is_intact_qtof(sample):
        raise ValueError('Profile fitting requires metadata-confirmed G6545XT intact data')
    if not np.isfinite([low, high]).all() or not 500 <= low < high <= 150000:
        raise ValueError('Profile fit mass limits must be between 500 and 150,000 Da')
    if background is not None and not is_intact_qtof(background):
        raise ValueError('Profile background must also be a supported intact QTOF run')
    edges = np.arange(600., 3200.+MZ_STEP/2, MZ_STEP)
    mz = edges[:-1]+MZ_STEP/2
    observed, usable, scans, apex = average_profiles(sample, start, end, edges)
    raw = observed.copy(); blank = None
    excluded = reference_mask(sample, mz)
    if background is not None:
        blank, bg_usable, _, _ = average_profiles(background, start, end, edges)
        usable &= bg_usable
        excluded |= reference_mask(background, mz)
        observed = np.maximum(observed-blank, 0.)
    usable &= ~excluded
    if not np.any(observed[usable] > 0):
        raise ValueError('No positive non-reference profile signal remains')
    charges = np.arange(2, 101)
    coarse = Geometry(low, high, mz, charges, step=max(5., (high-low)/5000))
    references = [c for c in (reference_components or []) if low <= c['mass'] <= high and len(c.get('charge_states', [])) >= 3]
    seed = float(max(references, key=lambda c:c['intensity'])['mass']) if references else infer_envelope(observed*usable, coarse)[0]
    half = min(2500., max(500., seed*.04))
    fit_low, fit_high = max(low, np.floor(seed-half)), min(high, np.ceil(seed+half))
    g = Geometry(fit_low, fit_high, mz, charges)
    result = reconstruct(observed, g, usable)
    p = result['profile']
    if not np.isfinite(p).all() or p.max() <= 0:
        raise ValueError('No profile fit obtained; retain charge-envelope mode')
    # Local grid maxima are NOT promoted to separate proteins. Keep the
    # established envelope assignments explicitly as reference markers.
    components = [{k:v for k,v in c.items() if k != 'ion_display_peaks'}
                  for c in (reference_components or [])]
    # Do not call a derived average or a fitted curve "raw measured data".
    # The native apex is displayed separately with peak-preserving selection.
    x, y = apex['mz'], apex['intensities']
    take = (x >= 600) & (x <= 3200) & ~reference_mask(sample, x)
    x, y = x[take], y[take]
    if len(x) > 40000:
        stride = int(np.ceil(len(x)/18000))
        selected = [0, len(x)-1]
        for first in range(0, len(x), stride):
            last = min(len(x), first+stride)
            selected.extend([first+int(np.argmin(y[first:last])), first+int(np.argmax(y[first:last]))])
        selected = np.unique(selected); x, y = x[selected], y[selected]
    display_y = observed/MZ_STEP
    fitted_profile = {'mass': g.masses.tolist(), 'intensity': p.tolist(),
                      'range': [fit_low, fit_high], 'experimental': True}
    return {'components': components, 'time_range': [float(start), float(end)],
        'spectrum_source': 'qtof-measured-profile', 'mw_algorithm': 'profile-fit',
        'workflow': {'id': 'qtof-profile', 'method': 'profile', 'scans_analyzed': scans,
            'fit_range': [fit_low, fit_high], 'converged': result['converged'],
            'unexplained_fraction': result['unexplained_fraction'], 'overshoot_fraction': result['overshoot_fraction'],
            'description': 'Experimental main-region fit with a shared charge distribution. Coloured masses retain the charge-envelope assignments; profile maxima are not confirmed separate proteins.'},
        'spectrum': {'mz': mz.tolist(), 'intensities': np.where(excluded, 0., display_y).tolist(), 'mz_grid_step': MZ_STEP,
            'representation': 'window-mean measured profile on an integrated 0.05 m/z grid', 'fitted_profile': fitted_profile},
        'raw_spectrum': {'mz': mz.tolist(), 'intensities': (raw/MZ_STEP).tolist()},
        'background_spectrum': {'mz': mz.tolist(), 'intensities': (blank/MZ_STEP).tolist()} if blank is not None else None,
        'measured_spectrum': {'mz': x.tolist(), 'intensities': y.tolist(), 'scan_id': apex['scan_id'],
            'time': apex['time'], 'representation': 'native apex profile; min/max display selection only'},
        'fit_check': {'mz': mz.tolist(), 'observed': display_y.tolist(),
            'predicted': (result['predicted']/MZ_STEP).tolist(), 'residual': (result['residual']/MZ_STEP).tolist(),
            'usable': usable.tolist(), 'excluded_reference_bins': int(excluded.sum())},
        'effective_max_charge': 100, 'reference_filter': (sample.qtof_info or {}).get('reference_filter')}
