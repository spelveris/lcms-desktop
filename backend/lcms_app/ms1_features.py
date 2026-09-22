"""Conservative, reference-guided MS1 features, not peptide identifications.

Require a composition-compatible isotope envelope AND a bracketed elution peak.
No single centroid, however intense, is evidence of a supported peptide feature.
The heuristic thresholds below are not a calibrated FDR or a vendor algorithm.
"""
from collections import defaultdict
import numpy as np
from scipy.signal import find_peaks, peak_widths
from modification_formula import formula_mass

PROTON = 1.007276466621
ISOTOPE = 1.00335483507
MIN_SURVEYS = 3
MIN_FIT = .9


def expected_envelope(peptide):
    """Nominal isotope centroids from the actual peptide + known net formulas.

    Do not substitute averagine for an unknown custom modification composition.
    Such candidates can still be reviewed with MS/MS, but not claimed as an
    elemental-envelope-supported MS1 feature. Heavy-isotope labels are unsupported.
    """
    from brainpy import isotopic_variants
    from pyteomics.mass import Composition
    composition = dict(Composition(sequence=peptide['sequence']))
    for mod in peptide['modifications']:
        formula = mod.get('formula') or {'gg':'C4H6N2O2', 'iam':'C2H3NO'}.get(mod.get('kind'))
        if not formula:
            return None
        parsed = formula_mass(formula)
        if abs(parsed['delta'] - mod['delta']) > 1e-5:
            return None
        for element, count in parsed['composition'].items():
            composition[element] = composition.get(element, 0) + count
    if any(n < 0 for n in composition.values()):
        return None
    # The formula editor permits these elements, but their most-abundant isotope
    # is not the lightest. Do not align their envelope to a false M origin.
    if composition.get('Se', 0):
        return None
    peaks = list(isotopic_variants(composition, npeaks=8, charge=0))
    if len(peaks) < 2:
        return None
    offsets = np.array([p.mz - peaks[0].mz for p in peaks])
    abundance = np.array([p.intensity for p in peaks])
    abundance /= abundance.max()
    required = np.flatnonzero(abundance >= .1)
    # Short +1 peptides may have only two observable isotope peaks, not three.
    if len(required) < 2:
        required = np.argsort(abundance)[-2:]
    return offsets, abundance, np.sort(required)


def _pick(scan, targets, tolerance, spacing):
    """Nearest measured centroid within ppm; no resampling or coordinate edits."""
    if not len(scan):
        return np.zeros(len(targets)), np.full(len(targets), np.nan)
    index = np.searchsorted(scan[:, 0], targets)
    left, right = np.clip(index-1, 0, len(scan)-1), np.clip(index, 0, len(scan)-1)
    index = np.where(abs(scan[left, 0]-targets) <= abs(scan[right, 0]-targets), left, right)
    valid = abs(scan[index, 0]-targets) <= np.minimum(targets*tolerance, spacing*.2)
    return np.where(valid, scan[index, 1], 0.), np.where(valid, scan[index, 0], np.nan)


def _pattern(scan, peptide, charge, model, tolerance):
    offsets, expected, required = model
    targets = (peptide['mass'] + offsets)/charge + PROTON
    observed, mz = _pick(scan, targets, tolerance, ISOTOPE/charge)
    # Seed on an isotope whose absolute mass passes the precursor tolerance,
    # then test relative isotope spacing around that measured anchor. Small
    # centroid shifts must not fabricate a missing mono peak halfway through an
    # otherwise coherent envelope. The reported precursor must still pass the
    # original absolute ppm gate (see _eligible_precursors).
    anchor = int(np.argmax(observed[:min(3,len(observed))]))
    if observed[anchor] > 0:
        shifted = targets + mz[anchor] - targets[anchor]
        observed, mz = _pick(scan, shifted, tolerance, ISOTOPE/charge)
    norm = np.linalg.norm(observed)
    score = float(observed @ expected / (norm*np.linalg.norm(expected))) if norm else 0.
    good = score >= MIN_FIT and np.all(observed[required] >= max(observed.max()*.02, 1e-12))
    # Cosine alone is permissive for short peptides with a dominant mono peak.
    scale = float(observed @ expected / (expected @ expected))
    ratios = observed[required] / np.maximum(scale*expected[required], 1e-30)
    good = good and np.all((ratios >= .4) & (ratios <= 2.5))
    if good:
        # Reject a sparse sub-pattern embedded in a stronger, finer charge grid.
        # Include preceding half/third steps so a +2 M+2 peak is not called +1 M.
        for multiple in range(2, 7//charge+1):
            steps = np.arange(-multiple+1, min(4, len(expected))*multiple)
            steps = steps[steps % multiple != 0] / multiple
            strongest = int(np.argmax(observed))
            measured_origin = targets[0] + mz[strongest] - targets[strongest]
            extra, _ = _pick(scan, measured_origin + steps*ISOTOPE/charge, tolerance, ISOTOPE/(charge*multiple))
            if np.count_nonzero(extra >= observed.max()*.1) >= 2 and extra.sum() >= observed.sum()*.25:
                good = False
                break
    return observed, mz, score, bool(good)


def _eligible_precursors(peptide, charge, model, mzs, tolerance):
    targets = (peptide['mass'] + model[0][:3])/charge + PROTON
    return np.flatnonzero(np.isfinite(mzs[:3]) & (abs(mzs[:3]-targets) <= targets*tolerance))


def find_features(channel, peptides, ppm, min_relative_intensity=.05, min_intensity=0., method=None):
    if channel is None or not peptides or len(channel.scans) < MIN_SURVEYS:
        return []
    method = method or {'ms1_mz_min':0., 'ms1_mz_max':10000., 'ms1_peak_min':0., 'charge_min':1, 'charge_max':6}
    # Preselect possible mass/charge candidates before expensive composition
    # models, especially when one non-tryptic terminus is allowed.
    models = [expected_envelope(p) if any(method['ms1_mz_min'] <= p['mass']/z+PROTON <= method['ms1_mz_max']
              for z in range(method['charge_min'],method['charge_max']+1)) else None for p in peptides]
    scans, maxima = [], []
    for scan in channel.scans:
        valid = np.asarray(scan)[np.isfinite(scan).all(axis=1) & (scan[:,0] > 0) & (scan[:,1] > 0)]
        valid = valid[(valid[:,0] >= method['ms1_mz_min']) & (valid[:,0] <= method['ms1_mz_max'])]
        valid = valid[np.argsort(valid[:,0], kind='stable')]
        scans.append(valid)
        maxima.append(float(valid[:,1].max()) if len(valid) else 0.)
    times = np.array([m['time'] for m in channel.metadata], dtype=float)
    if len(times) != len(scans) or not np.isfinite(times).all() or np.any(np.diff(times) <= 0):
        raise ValueError('MS1 feature detection requires ordered, distinct survey retention times')
    tolerance = ppm*1e-6
    # Bounded seed search. The user intensity gates apply to a feature's apex;
    # weaker neighbouring scans remain available for its shape/isotope checks.
    hypotheses = [(i,z,k) for i,model in enumerate(models) if model is not None
                  for z in range(method['charge_min'],method['charge_max']+1) for k in range(min(3,len(model[0])))]
    if not hypotheses:
        return []
    predicted = np.array([(peptides[i]['mass']+models[i][0][k])/z+PROTON for i,z,k in hypotheses])
    order = np.argsort(predicted, kind='stable'); predicted = predicted[order]
    seeds = defaultdict(set)
    for si, scan in enumerate(scans):
        passing = np.flatnonzero(scan[:,1] >= max(maxima[si]*min_relative_intensity, min_intensity, method['ms1_peak_min']))
        passing = passing[np.argsort(scan[passing,1], kind='stable')[-500:]]
        mzs = scan[passing,0]
        starts = np.searchsorted(predicted, mzs/(1+tolerance), side='left')
        ends = np.searchsorted(predicted, mzs/(1-tolerance), side='right')
        keys = {(hypotheses[order[j]][0], hypotheses[order[j]][1]) for a,b in zip(starts,ends) for j in range(a,b)}
        for i,z in keys:
            observed, measured, _, good = _pattern(scan, peptides[i], z, models[i], tolerance)
            eligible = _eligible_precursors(peptides[i],z,models[i],measured,tolerance)
            if good and len(eligible) and observed[eligible].max() >= max(maxima[si]*min_relative_intensity,min_intensity,method['ms1_peak_min']):
                seeds[i,z].add(si)
        if len(seeds) > 20000:
            raise ValueError('Too many MS1 feature candidates; narrow the reference or precursor tolerance')
    features = []
    for (i,z), seed_scans in sorted(seeds.items()):
        peptide, model = peptides[i], models[i]
        # Extract the complete trace, including low intensity and off-peak scans:
        # thresholding the trace first would manufacture peaks in flat background.
        patterns = [_pattern(scan, peptide, z, model, tolerance) for scan in scans]
        values = np.array([p[0] for p in patterns]); trace = values[:,model[2]].sum(axis=1)
        peaks, initial = find_peaks(trace, prominence=0)
        if not len(peaks):
            continue
        # DDA changes survey cadence during elution. Use an actual +/-0.5 min
        # neighbourhood, not a global scan-count window dominated by fast blanks.
        left_limits = [max(initial['left_bases'][pi],np.searchsorted(times,times[a]-.5)) for pi,a in enumerate(peaks)]
        right_limits = [min(initial['right_bases'][pi]+1,np.searchsorted(times,times[a]+.5,side='right')) for pi,a in enumerate(peaks)]
        left_bases = np.array([lo + np.argmin(trace[lo:a+1]) for a,lo in zip(peaks,left_limits)])
        right_bases = np.array([a + np.argmin(trace[a:hi]) for a,hi in zip(peaks,right_limits)])
        prominences = trace[peaks]-np.maximum(trace[left_bases],trace[right_bases])
        properties = {'prominences':prominences, 'left_bases':left_bases, 'right_bases':right_bases}
        positive = prominences > 0
        peaks = peaks[positive]; properties = {key:value[positive] for key,value in properties.items()}
        if not len(peaks):
            continue
        widths = peak_widths(trace, peaks, rel_height=.5,
                            prominence_data=(properties['prominences'],properties['left_bases'],properties['right_bases']))
        for pi, apex in enumerate(peaks):
            if apex not in seed_scans or properties['prominences'][pi] < trace[apex]*.5:
                continue
            lo, hi = max(0,int(np.floor(widths[2][pi]))), min(len(scans)-1,int(np.ceil(widths[3][pi])))
            # A narrow DDA peak may have only two surveys above half-height.
            # Require a two-survey core AND three contiguous supported surveys
            # after shoulder expansion; never accept a one-scan spike.
            members = [j for j in range(lo,hi+1) if patterns[j][3] and trace[j] >= trace[apex]*.5]
            runs = np.split(np.array(members,dtype=int), np.flatnonzero(np.diff(members)>1)+1)
            run = next((r for r in runs if apex in r), [])
            if len(run) < 2 or np.any(np.diff(times[run]) > .15):
                continue
            # The isotope traces must rise/fall together, not just occur nearby.
            local = values[lo:hi+1,model[2]]
            anchor = local[:,np.argmax(model[1][model[2]])]
            coelution = min(float(anchor @ local[:,k] / max(np.linalg.norm(anchor)*np.linalg.norm(local[:,k]),1e-30)) for k in range(local.shape[1]))
            if coelution < .95:
                continue
            # MS/MS can be acquired on a feature's shoulders. Link those recorded
            # parent surveys too, provided the same envelope continues to 10% apex.
            first,last=int(run[0]),int(run[-1])
            while first>properties['left_bases'][pi] and patterns[first-1][3] and trace[first-1]>=trace[apex]*.1 and times[first]-times[first-1]<=.15:
                first-=1
            while last<properties['right_bases'][pi] and patterns[last+1][3] and trace[last+1]>=trace[apex]*.1 and times[last+1]-times[last]<=.15:
                last+=1
            support = np.arange(first,last+1)
            if len(support) < MIN_SURVEYS:
                continue
            observed, mzs, score, _ = patterns[apex]
            eligible = _eligible_precursors(peptide,z,model,mzs,tolerance)
            isotope = int(eligible[np.argmax(observed[eligible])])
            precursor = float(mzs[isotope]); predicted_mz = (peptide['mass']+model[0][isotope])/z+PROTON
            meta = channel.metadata[apex]
            features.append({k:v for k,v in peptide.items() if k != 'residue_masses'} | {
                'evidence':'ms1', 'ms1_supported':True, 'feature_id':f'ms1-{i}-{z}-{meta["scan_id"]}',
                'scan_id':meta['scan_id'], 'time':meta['time'], 'precursor_mz':precursor, 'charge':z,
                'theoretical_precursor_mz':float(predicted_mz),
                'isotope_offset':isotope, 'precursor_error_ppm':float((precursor-predicted_mz)/predicted_mz*1e6),
                'precursor_intensity':float(observed[isotope]), 'precursor_relative_intensity_pct':float(observed[isotope]/maxima[apex]*100),
                'matched_ions':0, 'matched_bonds':0, 'explained_intensity_pct':None, 'fragments':[],
                'ambiguous_scan':False, 'sequence_ambiguous':False, 'site_ambiguous':False,
                'site_search':any(m.get('variable') for m in peptide['modifications']),
                'observation_count':len(support), 'core_observation_count':len(run), 'time_start':float(times[first]), 'time_end':float(times[last]),
                'isotope_count':len(model[2]), 'isotope_fit':score, 'isotope_coelution':coelution,
                'peak_prominence_fraction':float(properties['prominences'][pi]/trace[apex]),
                'isotope_peaks':[{'mz':float(mzs[k]),'intensity':float(observed[k]),'offset':int(k)} for k in range(len(observed)) if observed[k]>0],
                '_survey_ids':{channel.metadata[j]['scan_id'] for j in support}, '_cadence':float(np.median(np.diff(times[support]))),
                '_targets':((peptide['mass']+model[0])/z+PROTON).tolist(),
                '_trace':trace, '_times':times,
                '_group_targets':((peptide['mass']+model[0][model[2]])/z+PROTON).tolist(),
            })
            if len(features) > 20000:
                raise ValueError('Too many MS1 features; narrow the reference')
    # Competing sequences for the same local envelope are retained, not covered.
    by_apex = defaultdict(list)
    for feature in features:
        by_apex[feature['scan_id'],feature['charge']].append(feature)
    for group in by_apex.values():
        for feature in group:
            alternatives = [f for f in group if abs(f['mass']-feature['mass']) <= feature['mass']*tolerance]
            feature['sequence_ambiguous'] = len({f['sequence'] for f in alternatives}) > 1
            feature['site_ambiguous'] = len({tuple((m['residue'],m['delta']) for m in f['modifications']) for f in alternatives if f['sequence']==feature['sequence']}) > 1
            feature['ambiguous_scan'] = feature['sequence_ambiguous'] or feature['site_ambiguous']
    return features


def group_biomolecules(features, signature):
    """Conservative complete-link grouping of coeluting charge envelopes.

    Sequence identity alone never joins peaks. Different charges must have
    overlapping support, nearby apices and >=0.95 raw trace cosine similarity.
    Complete-link membership prevents a chain of overlaps joining distinct peaks.
    """
    groups = []
    by_signature = defaultdict(list)
    def compatible(a, b):
        if a['charge'] == b['charge']:
            return False
        overlap = min(a['time_end'], b['time_end'])-max(a['time_start'], b['time_start'])
        shorter = min(a['time_end']-a['time_start'], b['time_end']-b['time_start'])
        if overlap <= 0 or overlap < shorter*.5 or abs(a['time']-b['time']) > min(.1,2*max(a['_cadence'], b['_cadence'])):
            return False
        times = a['_times']
        mask = (times >= min(a['time_start'],b['time_start'])) & (times <= max(a['time_end'],b['time_end']))
        x, y = a['_trace'][mask], b['_trace'][mask]
        return float(x@y/max(np.linalg.norm(x)*np.linalg.norm(y),1e-30)) >= .95
    for feature in sorted(features, key=lambda f:(f['time'], f['charge'], f['feature_id'])):
        options = by_signature[signature(feature)]
        group = next((g for g in options if all(compatible(feature, other) for other in g)), None)
        if group is None:
            group = []; options.append(group); groups.append(group)
        group.append(feature)
    for index, group in enumerate(groups, 1):
        start, end = min(f['time_start'] for f in group), max(f['time_end'] for f in group)
        trace = sum(f['_trace'] for f in group)
        times = group[0]['_times']; mask = (times >= start) & (times <= end)
        apex = float(times[mask][np.argmax(trace[mask])])
        info = {'id':f'biomolecule-{index}', 'confirmed':True, 'time_start':start, 'time_end':end, 'apex_time':apex,
                'charges':sorted(f['charge'] for f in group), 'feature_ids':[f['feature_id'] for f in group],
                'target_mzs':sorted({mz for f in group for mz in f['_group_targets']})}
        for feature in group:
            feature['biomolecule'] = info


def link_msms(features, rows, ppm, signature):
    """No run-wide sequence suppression: link only a compatible local precursor."""
    linked = set()
    by_peptide = defaultdict(list)
    for feature in features:
        by_peptide[signature(feature)].append(feature)
    for row in rows:
        parent = row.get('parent_scan_id')
        candidates = []
        for feature in by_peptide[signature(row)]:
            if row['charge'] != feature['charge']:
                continue
            if not any(abs(row['precursor_mz']-mz) <= mz*ppm*1e-6 for mz in feature['_targets'][:3]):
                continue
            margin = min(.1,feature['_cadence']*1.5)
            in_time = feature['time_start']-margin <= row['time'] <= feature['time_end']+margin
            if in_time and (parent in feature['_survey_ids'] if parent is not None else True):
                candidates.append(feature)
        row['ms1_supported'] = len(candidates)==1
        row['precursor_link'] = ('recorded parent' if parent is not None else 'mass/charge/RT inferred') if len(candidates)==1 else 'unconfirmed'
        if len(candidates)==1:
            feature = candidates[0]; linked.add(feature['feature_id'])
            if 'biomolecule' in feature:
                row['biomolecule'] = feature['biomolecule']
            row['precursor_feature'] = {k:feature[k] for k in ['feature_id','scan_id','time_start','time_end','observation_count','isotope_count','isotope_fit']}
    for feature in features:
        for key in list(feature):
            if key.startswith('_'): feature.pop(key)
    return [f for f in features if f['feature_id'] not in linked and not f['site_search']]


def smoke_test():
    """Exercise the packaged composition model and peak finder with public data."""
    from types import SimpleNamespace
    from peptide_mapping import parse_fasta, digest
    peptide = digest(parse_fasta('PEPTIDER'), 0, [])[0][0]
    offsets, intensity, _ = expected_envelope(peptide)
    scans = [np.column_stack((peptide['mass']+offsets+PROTON, intensity*height)) for height in [0,20,70,100,70,20,0]]
    channel = SimpleNamespace(scans=scans, metadata=[{'scan_id':i+1,'time':i*.01} for i in range(len(scans))])
    features = find_features(channel, [peptide], 10.)
    assert len(features)==1 and features[0]['charge']==1 and features[0]['core_observation_count']==3
    channel.scans = [scan[:1] for scan in scans]
    assert not find_features(channel, [peptide], 10.)
    return {'status':'ok','features':len(features),'isolated_centroids_rejected':True}
