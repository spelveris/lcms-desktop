"""Optional reconstruction from supported charge assignments.

This is CATrupole's implementation, not an OpenLab compatibility engine.
Measured ion windows are transformed to neutral mass with their assigned
charges only. No all-charge projection or post-reconstruction smoothing is
used. The input, assigned signal and unassigned residual are kept separately.
"""
import copy
import numpy as np
from scipy.integrate import trapezoid


def _supported_profile_ions(ions, min_peaks, contig_min, noise, relative):
    """Recheck distributed signal after individual ion-shape pruning.

    The seed detector already checked the full original charge ladder. Shape
    pruning can leave gaps from unresolved/overlapping ions; do not reinterpret
    these missing windows as measured negative evidence. Still require a
    consecutive significant series and at least two effective charge states.
    """
    def supported(rows):
        maximum = max((v['height'] for v in rows), default=0.)
        significant = [v for v in rows if v['height'] >= max(noise, maximum*relative) and v['height'] > 0]
        if len(significant) < min_peaks:
            return False
        w = np.array([v['height']/maximum for v in significant])
        if w.sum()**2/np.square(w).sum() < (1.5 if len(significant) == 2 else 2.):
            return False
        longest = run = 1
        for a,b in zip(significant, significant[1:]):
            run = run+1 if b['charge'] == a['charge']+1 else 1
            longest = max(longest, run)
        return longest >= contig_min
    if supported(ions):
        return ions
    if len(ions) < min_peaks+1:
        return []
    spike = max(ions, key=lambda v:v['height'])
    adjacent = max((v['height'] for v in ions if abs(v['charge']-spike['charge']) == 1), default=0.)
    if spike['height'] >= .75*sum(v['height'] for v in ions) and spike['height'] > 8*adjacent:
        remaining = [v for v in ions if v['charge'] != spike['charge']]
        if supported(remaining):
            return remaining
    return []


def _centroid(x, y, cutoff):
    """Centroid the connected peak above a fraction of its own maximum."""
    apex = int(np.argmax(y))
    threshold = float(y[apex]) * cutoff
    left = right = apex
    while left > 0 and y[left - 1] >= threshold:
        left -= 1
    while right + 1 < len(y) and y[right + 1] >= threshold:
        right += 1
    # Include interpolated threshold crossings to avoid sample-grid bias.
    xx, yy = list(x[left:right + 1]), list(y[left:right + 1])
    if left > 0 and y[left] > y[left - 1]:
        xx.insert(0, float(np.interp(threshold, y[left-1:left+1], x[left-1:left+1])))
        yy.insert(0, threshold)
    if right + 1 < len(y) and y[right] > y[right + 1]:
        xx.append(float(np.interp(threshold, y[right:right+2][::-1], x[right:right+2][::-1])))
        yy.append(threshold)
    area = trapezoid(yy, xx) if len(xx) > 1 else 0.
    return float(trapezoid(np.asarray(xx)*yy, xx)/area) if area > 0 else float(x[apex])


def reconstruct(mz, intensity, candidates, *, pwhh=.6, min_peaks=3, contig_min=3,
                mw_agreement=.0005, centroid_cutoff=.4, profile_agreement=.5,
                noise_cutoff=1000., abundance_cutoff=.05, use_monoisotopic=False):
    """Refine seeded components and retain charge-consistent measured profiles.

    Candidates come from the existing charge-series detector. This mode cannot
    establish a component missed by that detector. Profile agreement is cosine
    similarity across charge-transformed ion windows, not isotope evidence.
    """
    x, observed = np.asarray(mz, dtype=float), np.asarray(intensity, dtype=float)
    if (x.ndim != 1 or observed.shape != x.shape or len(x) < 3
            or not np.isfinite(x).all() or not np.isfinite(observed).all()
            or np.any(np.diff(x) <= 0) or np.any(observed < 0)):
        raise ValueError('Charge-profile reconstruction needs increasing m/z and nonnegative finite intensities')
    if (not np.isfinite([pwhh, mw_agreement, centroid_cutoff, profile_agreement, noise_cutoff, abundance_cutoff]).all()
            or pwhh <= 0 or mw_agreement <= 0 or not 0 < centroid_cutoff < 1
            or not 0 <= profile_agreement <= 1 or noise_cutoff < 0 or not 0 <= abundance_cutoff <= 1):
        raise ValueError('Invalid charge-profile settings')
    proton = 1.007276 if use_monoisotopic else 1.00784
    step = float(np.median(np.diff(x)))
    centres = sorted({float(v) for c in candidates for v in c.get('ion_mzs', [])})
    assigned = np.zeros_like(observed)
    refined, profiles = [], []
    for candidate in candidates:
        ions = []
        # Multiple isotope maxima carrying the same charge are not independent votes.
        by_charge = {}
        for centre, z, height in zip(candidate.get('ion_mzs', []), candidate.get('ion_charges', []),
                                     candidate.get('ion_intensities', [])):
            if z >= 2 and (z not in by_charge or height > by_charge[z][1]):
                by_charge[z] = (float(centre), float(height))
        for charge, (centre, _) in sorted(by_charge.items()):
            width = max(pwhh, step * 4)
            left, right = centre - width, centre + width
            # Adjacent component assignments divide a window at their midpoint.
            near = np.searchsorted(centres, centre)
            if near > 0:
                left = max(left, (centre + centres[near - 1])/2)
            if near + 1 < len(centres):
                right = min(right, (centre + centres[near + 1])/2)
            lo, hi = np.searchsorted(x, [left, right])
            if hi - lo < 5:
                continue
            xx, raw = x[lo:hi], observed[lo:hi]
            # Local background is retained in the residual, never overwritten.
            edge = max(1, len(raw)//8)
            baseline = np.interp(xx, [xx[0], xx[-1]],
                                 [np.median(raw[:edge]), np.median(raw[-edge:])])
            yy = np.maximum(raw - baseline, 0.)
            height = float(yy.max())
            if height < noise_cutoff or height <= 0:
                continue
            measured = _centroid(xx, yy, centroid_cutoff)
            mass = (measured - proton)*charge
            if abs(mass - candidate['mass']) > candidate['mass']*mw_agreement:
                continue
            ions.append(dict(mz=measured, charge=int(charge), height=height, intensity=height, mass=mass,
                             x=xx, y=yy, lo=int(lo), hi=int(hi)))
        if len(ions) < min_peaks:
            continue
        low = min((ion['x'][0]-proton)*ion['charge'] for ion in ions)
        high = max((ion['x'][-1]-proton)*ion['charge'] for ion in ions)
        # Oversampling supports centroid integration, not a resolution claim.
        grid_step = max(.01, min(step*min(ion['charge'] for ion in ions)/4, .25), (high-low)/800)
        grid = np.arange(low, high + grid_step/2, grid_step)
        rows = np.array([np.interp(grid, (ion['x']-proton)*ion['charge'], ion['y'], left=0., right=0.)
                         for ion in ions])
        normalized = rows/np.maximum(rows.max(axis=1, keepdims=True), 1e-30)
        consensus = np.median(normalized, axis=0)
        scores = normalized@consensus / np.maximum(np.linalg.norm(normalized, axis=1)*np.linalg.norm(consensus), 1e-30)
        passing = np.flatnonzero(scores >= profile_agreement)
        original_ions = ions
        ions = _supported_profile_ions([ions[k] for k in passing], min_peaks, contig_min,
                                        noise_cutoff, abundance_cutoff)
        if not ions:
            continue
        supported = {ion['charge'] for ion in ions}
        passing = np.array([k for k in passing if original_ions[k]['charge'] in supported], dtype=int)
        charges = [ion['charge'] for ion in ions]
        longest = length = 1
        for a, b in zip(charges, charges[1:]):
            length = length + 1 if b == a + 1 else 1
            longest = max(longest, length)
        if longest < contig_min:
            continue
        # Transform intensity density with its Jacobian; preserve integrated area.
        curve = np.zeros(len(grid))
        for k, ion in zip(passing, ions):
            curve += rows[k]/ion['charge']
        mass = _centroid(grid, curve, centroid_cutoff)
        result = copy.deepcopy(candidate)
        result.update(mass=mass, mass_std=float(np.std([ion['mass'] for ion in ions])),
                      intensity=float(sum(ion['height'] for ion in ions)),
                      charge_states=charges, num_charges=len(ions), peaks_found=len(ions),
                      ion_mzs=[ion['mz'] for ion in ions], ion_charges=charges,
                      ion_intensities=[ion['height'] for ion in ions],
                      charge_profile=True, profile_agreement=float(np.median(scores[passing])),
                      mass_display_decimals=2)
        result.pop('ion_display_peaks', None)
        refined.append(result)
        curve[[0, -1]] = 0.
        profiles.append((grid, curve))
        for ion in ions:
            # Shared windows are not counted twice. The residual remains observable.
            assigned[ion['lo']:ion['hi']] = np.maximum(assigned[ion['lo']:ion['hi']], ion['y'])
    refined.sort(key=lambda c:c['intensity'], reverse=True)
    mass_axis = np.unique(np.concatenate([g for g, _ in profiles])) if profiles else np.array([])
    combined = sum((np.interp(mass_axis, g, y, left=0., right=0.) for g, y in profiles), np.zeros(len(mass_axis)))
    if len(mass_axis) > 40000:
        raise ValueError('Too many supported profile points; narrow the selected mass range')
    assigned = np.minimum(assigned, observed)
    residual = observed - assigned
    total_area = float(trapezoid(observed, x))
    return dict(components=refined, fitted_profile=dict(mass=mass_axis.tolist(), intensity=combined.tolist(),
                    range=[float(mass_axis[0]), float(mass_axis[-1])] if len(mass_axis) else [0., 0.],
                    component_masses=[c['mass'] for c in refined],
                    method='charge-profile', experimental=True),
                fit_check=dict(mz=x.tolist(), observed=observed.tolist(), predicted=assigned.tolist(),
                               residual=residual.tolist(), usable=[True]*len(x), assigned=True),
                unexplained_fraction=float(trapezoid(residual, x)/total_area) if total_area > 0 else 0.)


def sum_centroids(sample, start, end, limit=500000):
    """Sum exact acquired coordinates; do not synthesize a profile from sticks."""
    times=np.asarray(sample.ms_times,dtype=float)
    selected=np.flatnonzero((times >= start) & (times <= end))
    axis=getattr(sample,'ms_mz_axis',None)
    if axis is not None:
        y=np.sum([sample.ms_scans[i] for i in selected],axis=0) if len(selected) else np.zeros(len(axis))
        return np.asarray(axis,dtype=float), np.asarray(y,dtype=float)
    scans=[np.asarray(sample.ms_scans[i],dtype=float) for i in selected if len(sample.ms_scans[i])]
    if sum(len(scan) for scan in scans)>limit:
        raise ValueError('Narrow the time window to reconstruct up to 500,000 exact centroid points')
    if not scans:
        return np.array([]),np.array([])
    points=np.concatenate(scans)
    x,inverse=np.unique(points[:,0],return_inverse=True)
    return x,np.bincount(inverse,weights=points[:,1],minlength=len(x))


def reconstruct_centroids(mz, intensity, candidates, *, min_peaks=3, contig_min=3,
                          mw_agreement=.0005, centroid_cutoff=.4, noise_cutoff=1000.,
                          abundance_cutoff=.05, use_monoisotopic=False, **unused):
    """Use charge-assigned centroid masses without inventing measured line shapes.

    M = z * (m/z - proton). Each accepted ion retains its exact acquired
    coordinate. The component mass is an intensity-weighted centroid of the
    supporting per-charge masses above the chosen height cutoff. Profile-shape
    agreement is deliberately inapplicable to centroid-only acquisitions.
    """
    x,y=np.asarray(mz,dtype=float),np.asarray(intensity,dtype=float)
    if (x.ndim!=1 or y.shape!=x.shape or not np.isfinite(x).all() or not np.isfinite(y).all()
            or np.any(np.diff(x)<=0) or np.any(y<0)):
        raise ValueError('Centroid reconstruction needs sorted finite acquired coordinates and nonnegative intensities')
    if (not np.isfinite([centroid_cutoff,mw_agreement,noise_cutoff,abundance_cutoff]).all()
            or not 0<centroid_cutoff<1 or mw_agreement<=0 or noise_cutoff<0 or not 0<=abundance_cutoff<=1):
        raise ValueError('Invalid centroid reconstruction settings')
    proton=1.007276 if use_monoisotopic else 1.00784
    assigned=np.zeros_like(y);components=[];mass_points={};seen_assignments=set()
    positive=np.flatnonzero(y>0)
    px=x[positive]
    differences=np.diff(x)
    quantization=float(np.median(differences)) if len(differences) and np.allclose(differences,np.median(differences),rtol=.001,atol=1e-8) else 0.
    for candidate in candidates:
        ions=[]
        for charge in sorted(set(int(z) for z in candidate.get('ion_charges',[]) if z>=2)):
            center=candidate['mass']/charge+proton
            tolerance=candidate['mass']*mw_agreement/charge + quantization/2
            lo,hi=np.searchsorted(px,[center-tolerance,center+tolerance])
            if hi<=lo:
                continue
            indices=positive[lo:hi]
            height=float(y[indices].sum())
            if height<noise_cutoff:
                continue
            measured=float(np.average(x[indices],weights=y[indices]))
            ions.append(dict(charge=charge,mz=measured,height=height,
                             mass=float((measured-proton)*charge),indices=indices))
        ions=_supported_profile_ions(ions,min_peaks,contig_min,noise_cutoff,abundance_cutoff)
        if not ions:
            continue
        maximum=max(ion['height'] for ion in ions)
        strong=[ion for ion in ions if ion['height']>=maximum*centroid_cutoff]
        mass=float(np.average([ion['mass'] for ion in strong],weights=[ion['height'] for ion in strong]))
        component=copy.deepcopy(candidate)
        component.update(mass=mass,mass_std=float(np.std([ion['mass'] for ion in ions])),
            intensity=float(sum(ion['height'] for ion in ions)),num_charges=len(ions),peaks_found=len(ions),
            charge_states=[ion['charge'] for ion in ions],ion_charges=[ion['charge'] for ion in ions],
            ion_mzs=[ion['mz'] for ion in ions],ion_intensities=[ion['height'] for ion in ions],
            charge_profile=True,reconstruction_kind='centroid',profile_agreement=None,mass_display_decimals=2)
        component.pop('ion_display_peaks',None)
        components.append(component)
        for ion in ions:
            # Repeated/shared assignments do not multiply measured signal.
            assigned[ion['indices']]=y[ion['indices']]
            for index in ion['indices']:
                mass=float((x[index]-proton)*ion['charge'])
                key=(int(index),ion['charge'])
                if key not in seen_assignments:
                    mass_points[mass]=mass_points.get(mass,0.)+float(y[index])
                    seen_assignments.add(key)
    components.sort(key=lambda c:c['intensity'],reverse=True)
    masses=sorted(mass_points)
    if len(masses)>40000:
        raise ValueError('Narrow the time window to retain up to 40,000 exact transformed centroid masses')
    return dict(components=components,fitted_profile=dict(mass=masses,intensity=[mass_points[m] for m in masses],
        range=[float(masses[0]),float(masses[-1])] if len(masses)>1 else [float(masses[0]-.5),float(masses[0]+.5)] if masses else [0.,1.],
        component_masses=[c['mass'] for c in components],method='charge-profile',sticks=True,experimental=True),
        fit_check=dict(mz=x.tolist(),observed=y.tolist(),predicted=assigned.tolist(),residual=(y-assigned).tolist(),
                       usable=[True]*len(x),assigned=True,centroid_sticks=True),
        unexplained_fraction=float((y-assigned).sum()/y.sum()) if y.sum()>0 else 0.)
