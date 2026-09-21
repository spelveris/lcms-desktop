"""Isotope-envelope fitting for metadata-identified G6545XT intact acquisitions.

The engine estimates monoisotopic masses with peptide averagine; these are not
raw measured neutral masses or sequence identifications. Never smooth/rebin the
calibrated MS1 centroids. Other instruments retain the legacy workflow.
"""
import re
from bisect import bisect_left, bisect_right
import numpy as np

PROTON = 1.007276466621
ISOTOPE = 1.00335483507
PPM = 10.


def is_intact_qtof(sample):
    info = getattr(sample, 'qtof_info', None) or {}
    method = str(info.get('acquisition_method', '')).replace('\\', '/').split('/')[-1].lower()
    return (info.get('instrument') == 'G6545XT' and info.get('is_protein_digest') is False
            and bool(re.search(r'(^|[^a-z0-9])intact([^a-z0-9]|$)', method)))


def _scan(scan, minimum_mz):
    a = np.asarray(scan, dtype=float)
    if a.ndim != 2 or a.shape[1] != 2 or not np.isfinite(a).all() or np.any(a[:,1] < 0):
        raise ValueError('Invalid calibrated QTOF centroid spectrum')
    a = a[(a[:,0] >= minimum_mz) & (a[:,1] > 0)]
    return a[np.argsort(a[:,0], kind='stable')].copy()


def subtract_centroids(scan, background, ppm=PPM):
    """Subtract the nearest blank centroid within ppm, without moving m/z."""
    out = scan.copy()
    if not len(scan) or not len(background):
        return out
    j = np.searchsorted(background[:,0], scan[:,0])
    left, right = np.maximum(j-1,0), np.minimum(j,len(background)-1)
    nearest = np.where(abs(background[left,0]-scan[:,0]) <= abs(background[right,0]-scan[:,0]), left, right)
    matched = abs(background[nearest,0]-scan[:,0]) <= scan[:,0]*ppm*1e-6
    out[matched,1] = np.maximum(0, scan[matched,1]-background[nearest[matched],1])
    return out


def _fit_scan(scan, low, high, charges=(2,50)):
    # Lazy: importing the scientific engine must not slow application startup.
    import ms_deisotope as engine
    if not len(scan):
        return []
    peaks, _ = engine.deconvolute_peaks(scan.tolist(), averagine=engine.peptide,
        scorer=engine.PenalizedMSDeconVFitter(20., 1.), charge_range=charges,
        error_tolerance=PPM*1e-6, charge_carrier=PROTON, truncate_after=.95,
        use_quick_charge=True, iterations=2)
    fits = []
    for peak in peaks:
        if not low <= peak.neutral_mass <= high or not np.isfinite([peak.neutral_mass,peak.score,peak.intensity]).all():
            continue
        # Retain only acquired centroids, not zero-intensity theoretical placeholders.
        envelope = []
        for p in peak.envelope:
            j = int(np.searchsorted(scan[:,0], p.mz))
            if j < len(scan) and scan[j,0] == p.mz and p.intensity > 1 and scan[j,1] > 0:
                envelope.append([float(scan[j,0]), float(min(p.intensity,scan[j,1]))])
        if len(envelope) < 4:
            continue
        a = np.array(envelope)
        spacing = ISOTOPE/peak.charge
        adjacent = abs(np.diff(a[:,0])-spacing) <= 2*a[:-1,0]*PPM*1e-6
        consecutive = best = 1
        for valid in adjacent:
            consecutive = consecutive+1 if valid else 1
            best = max(best, consecutive)
        if best < 4:
            continue
        # A lower-charge harmonic can fit alternate peaks of a higher-charge ion.
        # Reject it when substantial measured peaks repeatedly interleave the fit.
        midpoints = (a[1:,0]+a[:-1,0])/2
        interleaved = 0
        for k, mz in enumerate(midpoints):
            if not adjacent[k]:
                continue
            lo, hi = np.searchsorted(scan[:,0], [mz*(1-PPM*1e-6),mz*(1+PPM*1e-6)])
            if hi > lo and np.max(scan[lo:hi,1]) >= .25*min(a[k,1],a[k+1,1]):
                interleaved += 1
        if interleaved >= max(2,int(np.sum(adjacent))*.3):
            continue
        fits.append({'mass':float(peak.neutral_mass), 'charge':int(peak.charge),
                     'intensity':float(a[:,1].sum()), 'score':float(peak.score), 'envelope':envelope})
    return fits


def _spectrum(a):
    return {'mz':a[:,0].tolist(), 'intensities':a[:,1].tolist(),
            'mz_grid_step':None, 'representation':'calibrated centroid sticks'}


def representative_scan(sample, start, end):
    channel=sample.qtof_channels.get((0,1))
    scans=[_scan(s,300.) for m,s in zip(channel.metadata,channel.scans) if start<=m['time']<=end] if channel else []
    if not scans: return np.empty((0,2))
    return max(scans,key=lambda s:float(s[:,1].sum()))


def smoke_test():
    """Packaged-engine check with a public synthetic elemental composition."""
    from brainpy import isotopic_variants
    composition={'C':500,'H':800,'N':140,'O':150,'S':4}
    mass=list(isotopic_variants(composition,charge=0,npeaks=20))[0].mz
    points=np.array(sorted((p.mz,p.intensity*1e6) for z in [8,9,10]
        for p in isotopic_variants(composition,charge=z,npeaks=20) if p.intensity>1e-5))
    fits=_fit_scan(points,1000,50000)
    charges={f['charge'] for f in fits if abs(f['mass']-mass)/mass*1e6<3}
    if not {8,9,10} <= charges:
        raise RuntimeError('Packaged isotope fitting failed the known-composition check')
    return {'status':'ok','matched_charges':sorted(charges),'engine':'ms_deisotope 0.0.60'}


def run(sample, start, end, background=None, low=1000., high=50000., minimum_mz=300.):
    if not is_intact_qtof(sample):
        raise ValueError('Isotope-aware workflow requires G6545XT intact acquisition metadata')
    if not np.isfinite([start,end,low,high,minimum_mz]).all() or start >= end or low >= high:
        raise ValueError('Use finite, increasing time and mass ranges')
    channel = sample.qtof_channels.get((0,1))
    if channel is None:
        raise ValueError('Isotope-aware intact analysis requires positive-ion MS1 centroids')
    selected = [(m,s) for m,s in zip(channel.metadata,channel.scans) if start <= m['time'] <= end]
    if not selected:
        raise ValueError('No acquired MS1 scans in the selected time range')
    if sum(len(s) for _,s in selected) > 2000000:
        raise ValueError('Select a narrower intact peak window (at most 2 million centroids)')
    bg_channel = None
    if background is not None:
        bg_channel = getattr(background,'qtof_channels',{}).get((0,1))
        if bg_channel is None:
            raise ValueError('Choose a QTOF positive-ion centroid blank for isotope-aware subtraction')
        bg_times = np.array([m['time'] for m in bg_channel.metadata])
        if not len(bg_times) or selected[0][0]['time'] < bg_times[0] or selected[-1][0]['time'] > bg_times[-1]:
            raise ValueError('The background must cover the selected time range')
    fits, raw_scans, corrected_scans, bg_scans = [], [], [], []
    for meta, points in selected:
        raw = _scan(points, minimum_mz)
        corrected = raw
        if bg_channel is not None:
            j = int(np.argmin(abs(bg_times-meta['time'])))
            bg = _scan(bg_channel.scans[j], minimum_mz)
            corrected = subtract_centroids(raw,bg)
            bg_scans.append(bg)
        raw_scans.append(raw); corrected_scans.append(corrected)
        for fit in _fit_scan(corrected[corrected[:,1]>0],low,high):
            fits.append({**fit,'scan_id':int(meta['scan_id']),'time':float(meta['time'])})
    # Intensity-anchored ppm clustering avoids chaining masses across a wide window.
    groups, anchors = [], []
    for fit in sorted(fits,key=lambda f:f['intensity'],reverse=True):
        lo=bisect_left(anchors,fit['mass']/(1+PPM*1e-6));hi=bisect_right(anchors,fit['mass']/(1-PPM*1e-6))
        if lo==hi:
            index=bisect_left(anchors,fit['mass']);anchors.insert(index,fit['mass']);groups.insert(index,[fit])
        else:
            group=max(groups[lo:hi],key=lambda g:g[0]['intensity']);group.append(fit)
    components = []
    for group in groups:
        charge_states = sorted({f['charge'] for f in group})
        # Intact mass calls need independent support from more than one charge.
        if len(charge_states) < 2:
            continue
        weights = np.array([f['intensity'] for f in group]); masses = np.array([f['mass'] for f in group])
        mass = float(np.average(masses,weights=weights))
        representatives = [max((f for f in group if f['charge']==z),key=lambda f:f['intensity']) for z in charge_states]
        ions = [max(f['envelope'],key=lambda e:e[1]) for f in representatives]
        components.append({'mass':mass,'mass_std':float(np.sqrt(np.average((masses-mass)**2,weights=weights))),
            'intensity':float(weights.sum()),'num_charges':len(charge_states),'charge_states':charge_states,
            'peaks_found':sum(len(f['envelope']) for f in representatives),'r2':None,
            'isotope_aware':True,'fit_score':float(np.average([f['score'] for f in group],weights=weights)),
            'scan_count':len({f['scan_id'] for f in group}), 'ion_mzs':[p[0] for p in ions],
            'ion_charges':charge_states, 'ion_intensities':[f['intensity'] for f in representatives],
            'ion_mono_mzs':[(f['mass']+f['charge']*PROTON)/f['charge'] for f in representatives],
            'envelopes':representatives})
    components.sort(key=lambda c:c['intensity'],reverse=True)
    if components:
        components = [c for c in components if c['intensity'] >= components[0]['intensity']*.01][:50]
    for c in components:
        c['isotope_ambiguous'] = any(other is not c and abs(abs(other['mass']-c['mass'])-ISOTOPE) <= c['mass']*PPM*1e-6 for other in components)
    # A clearly labelled representative raw scan avoids merging different-time
    # centroids into invented single peaks. All selected scans contribute fits.
    representative = max(range(len(selected)),key=lambda i:float(corrected_scans[i][:,1].sum()))
    spectrum = _spectrum(corrected_scans[representative])
    isotope_peaks = []
    for idx,c in enumerate(components):
        # Strongest charge envelope per component; no binning, smoothing or model peaks.
        env = max(c['envelopes'],key=lambda f:f['intensity'])
        isotope_peaks.extend({'mass':(mz-PROTON)*env['charge'],'mz':mz,'intensity':intensity,
                              'charge':env['charge'],'component':idx,'scan_id':env['scan_id']} for mz,intensity in env['envelope'])
    spectrum['isotope_profile'] = isotope_peaks
    return {'components':components, 'spectrum':spectrum,
        'raw_spectrum':_spectrum(raw_scans[representative]),
        'background_spectrum':_spectrum(bg_scans[representative]) if bg_scans else None,
        'time_range':[float(start),float(end)],'spectrum_source':'qtof_isotope_aware', 'mw_algorithm':'isotope-aware',
        'workflow':{'id':'qtof-isotope-aware','scans_analyzed':len(selected),
                    'display_scan_id':int(selected[representative][0]['scan_id']),
                    'display_time':float(selected[representative][0]['time']),
                    'mass_kind':'averagine-estimated monoisotopic mass','ppm':PPM,
                    'min_charge':2,'max_charge':50,'min_isotopes':4,'min_charge_states':2,
                    'description':'Isotope-envelope candidates; monoisotopic/isobaric ambiguity can remain. The m/z panel shows the strongest corrected MS1 scan; all selected scans were fitted. The isotope profile uses each component’s strongest measured envelope, without smoothing or bins.'}}
