"""Bounded, precursor-prefiltered common variable chemistry.

MS1 can support a composition but cannot localize these variable sites. Keep
all compatible site permutations for MS/MS review; never pick the first site.
"""
from itertools import combinations, product
import numpy as np
from modification_formula import formula_mass

COMMON = {'oxidation': ('M', 'O'), 'deamidation': ('NQ', 'H-1N-1O'),
          'iam': ('C', 'C2H3NO')}
MAX_CANDIDATES = 20000
MAX_SITE_VARIANTS = 100000


def variable_settings(raw=None):
    raw = {} if raw is None else raw
    if not isinstance(raw, dict) or set(raw) - {*COMMON, 'max_per_peptide'}:
        raise ValueError('Unknown variable modification setting')
    settings = {**dict.fromkeys(COMMON, False), 'max_per_peptide': 4, **raw}
    if any(not isinstance(settings[k], bool) for k in COMMON):
        raise ValueError('Variable modification options must be true or false')
    maximum = settings['max_per_peptide']
    if isinstance(maximum, bool) or not isinstance(maximum, int) or not 1 <= maximum <= 4:
        raise ValueError('Use 1–4 variable modifications per peptide')
    return settings


def signature(peptide):
    return peptide['sequence'], tuple((m['residue'], m['delta']) for m in peptide['modifications'])


def expand_common(peptides, settings, channel, method, ppm):
    """Enumerate net compositions before site permutations; prefilter on MS/MS.

    No spectrum intensity or fragment-score gate is relaxed. An out-of-scope
    precursor must not inflate the search. Caps fail explicitly, never truncate
    competing sites silently or return an arbitrary localization.
    """
    active = [k for k in COMMON if settings[k]]
    if not active or channel is None:
        return peptides, 0
    windows = []
    tol = ppm * 1e-6
    for meta, scan in zip(channel.metadata, channel.scans):
        mz = meta.get('precursor_mz')
        if not mz or not np.isfinite(mz) or not len(scan) or not method['ms1_mz_min'] <= mz <= method['ms1_mz_max']:
            continue
        for z in range(method['charge_min'], method['charge_max']+1):
            for isotope in range(3):
                windows.append(((mz/(1+tol)-1.007276466621)*z-isotope*1.00335483507,
                                (mz/(1-tol)-1.007276466621)*z-isotope*1.00335483507))
    if not windows:
        return peptides, 0
    bounds = np.array(sorted(windows)); lows = bounds[:, 0]; highs = np.maximum.accumulate(bounds[:, 1])
    def compatible(mass):
        index = np.searchsorted(lows, mass, side='right')-1
        return index >= 0 and highs[index] >= mass
    chemistry = {k: formula_mass(COMMON[k][1]) for k in active}
    combined = {signature(p): p for p in peptides}
    visited = 0
    for peptide in peptides:
        occupied = {m['residue'] for m in peptide['modifications']}
        remaining = settings['max_per_peptide']-sum(bool(m.get('variable')) for m in peptide['modifications'])
        if remaining <= 0:
            continue
        sites = {k: [i for i, aa in enumerate(peptide['sequence'], 1)
                     if aa in COMMON[k][0] and i not in occupied] for k in active}
        for counts in product(*(range(min(len(sites[k]), remaining)+1) for k in active)):
            if not 1 <= sum(counts) <= remaining:
                continue
            mass = peptide['mass']+sum(n*chemistry[k]['delta'] for k,n in zip(active, counts))
            if not compatible(mass):
                continue
            for choices in product(*(combinations(sites[k], n) for k,n in zip(active, counts))):
                visited += 1
                if visited > MAX_SITE_VARIANTS:
                    raise ValueError('Modification search exceeds 100,000 site variants; reduce the modification limit or narrow the reference')
                mods = [dict(m) for m in peptide['modifications']]
                masses = peptide['residue_masses'].copy()
                for kind, positions in zip(active, choices):
                    for position in positions:
                        masses[position-1] += chemistry[kind]['delta']
                        mods.append({'residue':position, 'delta':chemistry[kind]['delta'],
                                     'formula':chemistry[kind]['formula'], 'kind':kind, 'variable':True})
                mods.sort(key=lambda m:m['residue'])
                candidate = {**peptide, 'mass':float(masses.sum()+18.010564684),
                             'residue_masses':masses, 'modifications':mods}
                key = signature(candidate)
                if key not in combined:
                    combined[key] = candidate
                else:
                    for location in candidate['locations']:
                        if location not in combined[key]['locations']:
                            combined[key]['locations'] = [*combined[key]['locations'], location]
                if len(combined) > MAX_CANDIDATES:
                    raise ValueError('Modification search exceeds 20,000 peptide candidates; reduce the modification limit or narrow the reference')
    return list(combined.values()), len(combined)-len(peptides)


def localize_sites(hit, peptide, alternatives, fragment_ppm):
    """Require discriminating measured backbone cuts, even for rejected rivals.

    Two independent bonds must carry a variable remnant. Each other placement
    of that remnant must be distinguished by at least one measured cut; passing
    the overall match threshold alone never localizes a site.
    """
    def fragment_mz(candidate, ion):
        bond = ion['bond']
        label = ion['ion']
        z = int(label.split('^')[1][:-1]) if '^' in label else 1
        mass = (candidate['residue_masses'][:bond].sum() if label.startswith('b')
                else candidate['residue_masses'][bond:].sum()+18.010564684)
        return float(mass/z+1.007276466621)
    for mod in hit['modifications']:
        if not mod.get('variable'):
            continue
        position = mod['residue']
        carrying = [ion for ion in hit['fragments'] if
                    (ion['ion'].startswith('b') and ion['bond'] >= position) or
                    (ion['ion'].startswith('y') and ion['bond'] < position)]
        rivals = [p for p in alternatives if p['sequence']==peptide['sequence'] and
                  abs(p['mass']-peptide['mass']) < 1e-6 and not any(
                      m['residue']==position and abs(m['delta']-mod['delta']) < 1e-6 for m in p['modifications'])]
        mod['localized'] = len({i['bond'] for i in carrying}) >= 2 and all(any(
            abs(fragment_mz(other, ion)-ion['observed_mz']) > ion['theoretical_mz']*fragment_ppm*1e-6
            for ion in hit['fragments']) for other in rivals)
