"""Reference-guided peptide candidate review, not a validated search/FDR engine.

Monoisotopic residue masses, tryptic cleavage (except before P), and b/y
fragment formulas follow standard peptide mass conventions, independently
tested against the examples in https://pyteomics.readthedocs.io/en/latest/mass.html.
No proprietary BioConfirm result objects are deserialized or executed.
"""
from pathlib import Path
import re
from zipfile import ZipFile
import xml.etree.ElementTree as ET
import numpy as np
from modification_formula import formula_mass
from ms1_features import find_features, link_msms

PROTON = 1.007276466621
WATER = 18.010564684
ISOTOPE = 1.00335483507
# Unimod 121: epsilon-linked diglycyl remnant after tryptic digestion.
# https://www.unimod.org/modifications_view.php?editid1=121
GGISOK_DELTA = 114.04292747
# Unimod 4: iodoacetamide adds C2H3NO to a free cysteine thiol.
IAM_DELTA = 57.021463735
AA = dict(zip('ACDEFGHIKLMNPQRSTVWY', [71.037113805,103.009184505,115.026943065,129.042593135,147.068413945,57.021463735,137.058911875,113.084063975,128.094963015,113.084063975,131.040484645,114.04292747,97.052763875,128.05857754,156.10111105,87.032028435,101.047678505,99.068413945,186.07931298,163.063328575]))


def parse_fasta(text):
    if not isinstance(text, str) or len(text) > 30000:
        raise ValueError('Provide a reference sequence or FASTA, up to 10,000 residues')
    records, name, parts = [], 'A', []
    for line in text.splitlines():
        line = line.strip()
        if not line: continue
        if line.startswith('>'):
            if parts: records.append((name, ''.join(parts))); parts = []
            name = line[1:].strip() or f'Chain {len(records)+1}'
        else:
            parts.append(re.sub(r'\s+', '', line).upper())
    if parts: records.append((name, ''.join(parts)))
    if not records or sum(len(s) for _, s in records) > 10000 or len(records) > 26:
        raise ValueError('Provide 1–26 nonempty chains, at most 10,000 residues total')
    for _, seq in records:
        if set(seq) - AA.keys():
            raise ValueError('Use standard one-letter amino acids only; add modifications separately')
    return [{'id': chr(65+i), 'name': name, 'sequence': seq} for i, (name, seq) in enumerate(records)]


def preparation_modifications(chains, fixed, preparation=None):
    """Do not add reduction hydrogens twice: residue masses are free thiols.

    Intact disulfide-linked peptides are outside this linear-peptide search.
    Explicit unreduced cysteine pairs therefore exclude affected candidates.
    """
    prep = {} if preparation is None else preparation
    if not isinstance(prep, dict):
        raise ValueError('Invalid sample preparation settings')
    reduced, iam = prep.get('reduced', True), prep.get('iam', False)
    if not isinstance(reduced, bool) or not isinstance(iam, bool):
        raise ValueError('Reduction and IAM must be true or false')
    pairs_text = prep.get('disulfides', '')
    if not isinstance(pairs_text, str) or len(pairs_text) > 10000:
        raise ValueError('Enter disulfide pairs as A:3-A:18, A:8-A:25')
    cysteines = {(c['id'], i) for c in chains for i, aa in enumerate(c['sequence'], 1) if aa == 'C'}
    paired, pairs = set(), []
    if not reduced:
        for token in filter(None, (t.strip() for t in pairs_text.split(','))):
            match = re.fullmatch(r'([A-Z]):(\d+)\s*-\s*([A-Z]):(\d+)', token)
            if not match:
                raise ValueError('Enter disulfide pairs as A:3-A:18, A:8-A:25')
            a, b = (match[1], int(match[2])), (match[3], int(match[4]))
            if a == b or a not in cysteines or b not in cysteines or a in paired or b in paired:
                raise ValueError('Disulfide pairs need two distinct, unused cysteine positions')
            paired.update((a, b)); pairs.append([list(a), list(b)])
        if cysteines and not pairs:
            raise ValueError('Specify the unreduced disulfide pairs, or choose Reduced / free thiols')
    mods = [dict(m) for m in fixed]
    existing = {(m['chain'], m['position']): m for m in mods}
    for chain, position in sorted(cysteines):
        site = (chain, position)
        if site not in paired and not iam:
            continue
        if site in existing:
            old = existing[site]
            if site not in paired and old.get('delta') is not None and abs(float(old['delta'])-IAM_DELTA) < 1e-6 and not old.get('block_cleavage'):
                continue  # An explicitly entered carbamidomethyl is counted once.
            raise ValueError(f'Preparation conflicts with the modification at {chain}:C{position}')
        mods.append({'chain':chain, 'position':position, 'kind':'disulfide' if site in paired else 'iam',
                     'delta':None if site in paired else IAM_DELTA,
                     'formula':None if site in paired else 'C2H3NO', 'block_cleavage':False})
    description = ('Reduced/free cysteines; no extra hydrogen shift.' if reduced else
                   f'{len(pairs)} unreduced disulfide pairs; peptides containing bonded cysteines are excluded (linked peptides are not searched).')
    if iam:
        description += ' IAM: +57.021464 Da per free cysteine (C2H3NO).'
    return mods, {'reduced':reduced, 'iam':iam, 'disulfides':pairs, 'description':description}


def bioconfirm_references(bundle):
    """Read bounded XML method metadata only; never .NET binary results."""
    methods = sorted(Path(bundle).glob('*_BioConfirm_Results/Version*/*.bcpmx'),
                     key=lambda p: p.stat().st_mtime, reverse=True)
    references = []
    for path in methods[:10]:
        with ZipFile(path) as archive:
            info = archive.getinfo('bioconfirm.xml')
            if info.file_size > 16 * 1024 * 1024: raise ValueError('BioConfirm method XML is too large')
            root = ET.fromstring(archive.read(info))
        for ps in root.iter('ParameterSet'):
            fields = {p.get('id'): p.find('Value') for p in ps.findall('Parameters/Parameter')}
            if 'ChainSequences' not in fields or fields.get('ChainSequences') is None: continue
            sequences = [s.text or '' for s in fields['ChainSequences'].findall('String')]
            names = [s.text or '' for s in fields['Chains'].findall('String')] if fields.get('Chains') is not None else []
            fasta = '\n'.join(f'>{names[i] if i < len(names) else chr(65+i)}\n{seq}' for i, seq in enumerate(sequences))
            parse_fasta(fasta)
            mods = []
            if fields.get('Modification') is not None:
                for mod in fields['Modification'].iter('ParameterSet'):
                    vals = {p.get('id'): p.findtext('Value') for p in mod.findall('Parameters/Parameter')}
                    match = re.fullmatch(r'([A-Z])(\d+)', vals.get('Position') or '')
                    if match:
                        mods.append({'chain': match[1], 'position': int(match[2]), 'name': vals.get('ModificationName') or 'Imported modification', 'delta': None, 'block_cleavage': True})
            warnings = ['Imported reference and method settings only; saved BioConfirm scores/coverage are not imported.']
            if mods: warnings.append('Imported modifications need a verified mass shift. Peptides spanning unresolved sites are excluded, not treated as unmodified.')
            if fields.get('Links') is not None and list(fields['Links']):
                warnings.append('Linked-chain chemistry is not supported; linear peptides only.')
            references.append({'name': fields['SequenceName'].text if fields.get('SequenceName') is not None else path.stem,
                'source': str(path.relative_to(bundle)), 'fasta': fasta, 'modifications': mods, 'warnings': warnings})
    return references


def digest(chains, missed, modifications):
    peptides = {}
    excluded = 0
    for chain in chains:
        sequence = chain['sequence']
        mods = {m['position']: m for m in modifications if m['chain'] == chain['id']}
        cuts = [0] + [i+1 for i, aa in enumerate(sequence[:-1]) if aa in 'KR' and sequence[i+1] != 'P'
                      and not mods.get(i+1, {}).get('block_cleavage', False)] + [len(sequence)]
        for ci, start in enumerate(cuts[:-1]):
            for end in cuts[ci+1:ci+missed+2]:
                if not 5 <= end-start <= 70: continue
                local = [m for pos, m in mods.items() if start < pos <= end]
                if any(m['delta'] is None for m in local): excluded += 1; continue
                seq = sequence[start:end]
                shifts = tuple((m['position']-start-1, m['delta']) for m in sorted(local, key=lambda m:m['position']))
                key = (seq, shifts)
                if key not in peptides:
                    masses = np.array([AA[a] for a in seq])
                    for pos, delta in shifts: masses[pos] += delta
                    peptides[key] = {'sequence': seq, 'residue_masses': masses, 'mass': float(masses.sum()+WATER), 'locations': [],
                                     'modifications': [{'residue': m['position']-start, 'delta': m['delta'], 'kind': m.get('kind', 'custom'), 'formula': m.get('formula'),
                                                        'variable': bool(m.get('variable'))} for m in sorted(local, key=lambda m:m['position'])]}
                peptides[key]['locations'].append({'chain': chain['id'], 'start': start+1, 'end': end})
    return list(peptides.values()), excluded


def digest_with_site_search(chains, missed, fixed, searches):
    """One variable remnant per peptide; enumerate sites, never assume localization."""
    peptides, excluded = digest(chains, missed, fixed)
    if not searches:
        return peptides, excluded, 0
    search = searches[0]
    sites = [(chain, position) for chain in chains if search['chain'] in {'*', chain['id']}
             for position, aa in enumerate(chain['sequence'], 1)
             if (search['residues'] == '*' or aa in search['residues'])
             and not any(m['chain'] == chain['id'] and m['position'] == position for m in fixed)]
    if not sites:
        raise ValueError('No eligible unmodified residues for the whole-reference site search')
    if len(sites) > 400:
        raise ValueError('Site search exceeds 400 positions; choose one chain or narrower residue types')
    combined = {peptide_signature(p): p for p in peptides}
    for chain, position in sites:
        variant = {**search, 'chain': chain['id'], 'position': position, 'variable': True}
        candidates, _ = digest([chain], missed, [*fixed, variant])
        for candidate in candidates:
            if not any(mod['variable'] for mod in candidate['modifications']):
                continue
            key = peptide_signature(candidate)
            if key not in combined:
                combined[key] = candidate
            else:
                for old, new in zip(combined[key]['modifications'], candidate['modifications']):
                    old['variable'] = old.get('variable', False) or new.get('variable', False)
                for location in candidate['locations']:
                    if location not in combined[key]['locations']:
                        combined[key]['locations'].append(location)
            if len(combined) > 20000:
                raise ValueError('Site search exceeds 20,000 peptide candidates; narrow the search')
    return list(combined.values()), excluded, len(sites)


def fragments(masses, max_charge):
    prefix, total = np.cumsum(masses), float(np.sum(masses))
    result = []
    for bond in range(1, len(masses)):
        for z in range(1, max_charge+1):
            result.append((f'b{bond}' + (f'^{z}+' if z > 1 else '+'), (prefix[bond-1]+z*PROTON)/z, bond))
            result.append((f'y{len(masses)-bond}' + (f'^{z}+' if z > 1 else '+'), (total-prefix[bond-1]+WATER+z*PROTON)/z, bond))
    return result


def match_fragments(scan, theory, ppm):
    if not len(scan): return [], 0.
    # Keep at most 200 peaks above 1% relative intensity, with no resampling.
    idx = np.flatnonzero(scan[:,1] >= np.max(scan[:,1]) * .01)
    idx = idx[np.argsort(scan[idx,1])[-200:]]
    candidates = []
    for label, mass, bond in theory:
        errors = np.abs(scan[idx,0]-mass) / mass * 1e6
        for j in np.flatnonzero(errors <= ppm):
            candidates.append((float(errors[j]), int(idx[j]), label, mass, bond))
    used_peaks, used_ions, matches = set(), set(), []
    for error, index, label, mass, bond in sorted(candidates):
        if index in used_peaks or label in used_ions: continue
        used_peaks.add(index); used_ions.add(label)
        matches.append({'ion': label, 'theoretical_mz': float(mass), 'observed_mz': float(scan[index,0]),
                        'error_ppm': float((scan[index,0]-mass)/mass*1e6), 'intensity': float(scan[index,1]), 'bond': bond})
    explained = float(sum(scan[i,1] for i in used_peaks)/np.sum(scan[idx,1])*100) if np.sum(scan[idx,1]) > 0 else 0.
    return matches, explained


def peptide_signature(peptide):
    return (peptide['sequence'], tuple((m['residue'], m['delta']) for m in peptide['modifications']))


def analyze(sample, payload):
    if not sample.qtof_info or not sample.qtof_info.get('is_protein_digest'):
        raise ValueError('Peptide Mapping requires a QTOF protein digest/peptide mapping acquisition')
    channel = sample.qtof_channels.get((0, 2))
    survey = sample.qtof_channels.get((0, 1))
    if channel is None and survey is None: raise ValueError('No acquired positive-ion MS or MS/MS scans in this run')
    chains = parse_fasta(payload.get('fasta', ''))
    missed = int(payload.get('missed_cleavages', 2))
    precursor_ppm, fragment_ppm = float(payload.get('precursor_ppm', 10)), float(payload.get('fragment_ppm', 20))
    if not 0 <= missed <= 3 or not 1 <= precursor_ppm <= 50 or not 1 <= fragment_ppm <= 100:
        raise ValueError('Use 0–3 missed cleavages, 1–50 precursor ppm and 1–100 fragment ppm')
    try:
        threshold_values = [payload.get('ms1_min_relative_percent', 5), payload.get('ms1_min_intensity', 0)]
        if any(isinstance(value, bool) for value in threshold_values): raise ValueError()
        ms1_percent, ms1_intensity = map(float, threshold_values)
        if not np.isfinite([ms1_percent, ms1_intensity]).all() or not 0 <= ms1_percent <= 100 or not 0 <= ms1_intensity <= 1e15:
            raise ValueError()
    except (ValueError, TypeError, OverflowError) as exc:
        raise ValueError('Use 0–100% for the MS-only relative threshold and a finite nonnegative intensity (up to 1e15 counts)') from exc
    modifications = payload.get('modifications', [])
    if not isinstance(modifications, list) or len(modifications) > 100: raise ValueError('Too many modifications')
    if any(not isinstance(mod, dict) for mod in modifications): raise ValueError('Invalid modification definition')
    modifications = [dict(mod) for mod in modifications]
    seen, fixed, searches = set(), [], []
    for mod in modifications:
        if mod.get('kind') == 'custom' and 'formula' in mod:
            mod.update(formula_mass(mod['formula']))
        if not isinstance(mod.get('search_all', False), bool):
            raise ValueError('Site search must be true or false')
        if mod.get('search_all'):
            if mod.get('chain') not in {'*', *(c['id'] for c in chains)}:
                raise ValueError('Select a reference chain for the site search')
            if mod.get('kind') == 'gg':
                mod.update(delta=GGISOK_DELTA, block_cleavage=True, residues='K', formula='C4H6N2O2')
            residues = str(mod.get('residues', 'K')).strip().upper()
            if not residues or (residues != '*' and set(residues)-AA.keys()):
                raise ValueError('Use amino-acid letters or * for eligible site-search residues')
            mod['residues'] = residues
            delta = mod.get('delta')
            if delta is None or not np.isfinite(float(delta)) or not 0 < abs(float(delta)) <= 2000:
                raise ValueError('A site search needs a known nonzero modification mass shift')
            mod['delta'] = float(delta)
            searches.append(mod)
            continue
        chain = next((c for c in chains if c['id'] == mod.get('chain')), None)
        raw_position = mod.get('position', 0)
        pos = int(raw_position); delta = mod.get('delta')
        if isinstance(raw_position, bool) or float(raw_position) != pos:
            raise ValueError('Residue positions must be whole numbers')
        if chain is None or not 1 <= pos <= len(chain['sequence']) or (mod['chain'],pos) in seen:
            raise ValueError('Modification positions must be unique and within the reference chain')
        seen.add((mod['chain'],pos)); mod['position'] = pos
        if mod.get('kind') == 'gg':
            if chain['sequence'][pos-1] != 'K':
                raise ValueError('GGisoK requires a lysine (K) at the selected reference position')
            # A named chemistry preset is authoritative, not an editable delta.
            mod['delta'] = delta = GGISOK_DELTA
            mod['formula'] = 'C4H6N2O2'
            mod['block_cleavage'] = True
        if delta is not None:
            mod['delta'] = float(delta)
            if not np.isfinite(mod['delta']) or abs(mod['delta']) > 2000: raise ValueError('Invalid modification mass shift')
        fixed.append(mod)
    if len(searches) > 1:
        raise ValueError('Use one whole-reference modification search at a time; fixed sites may be combined with it')
    fixed, preparation = preparation_modifications(chains, fixed, payload.get('preparation'))
    peptides, excluded, searched_sites = digest_with_site_search(chains, missed, fixed, searches)
    if len(peptides) > 20000: raise ValueError('Reference search is too large; use fewer chains')
    masses = np.array([p['mass'] for p in peptides])
    rows = []
    for meta, scan in (zip(channel.metadata, channel.scans) if channel is not None else []):
        precursor = meta['precursor_mz']
        if not precursor or not len(scan): continue
        hits = []
        for charge in range(1, 7):
            for isotope in range(3):
                predicted = (masses + charge*PROTON + isotope*ISOTOPE)/charge
                errors = (precursor-predicted)/predicted*1e6
                for pidx in np.flatnonzero(np.abs(errors) <= precursor_ppm):
                    peptide = peptides[pidx]
                    matches, explained = match_fragments(scan, fragments(peptide['residue_masses'], min(2, charge)), fragment_ppm)
                    # Unknown-site candidates need a measured fragment carrying
                    # the variable remnant, not just a compatible precursor mass.
                    variable_sites = [m['residue'] for m in peptide['modifications'] if m.get('variable')]
                    remnant_ions = [m for m in matches if any(
                        (m['ion'].startswith('b') and m['bond'] >= pos)
                        or (m['ion'].startswith('y') and m['bond'] < pos) for pos in variable_sites)]
                    if variable_sites and not remnant_ions: continue
                    bonds = len({m['bond'] for m in matches})
                    if len(matches) < 4 or bonds < 3 or explained < 10: continue
                    hits.append({k:v for k,v in peptide.items() if k != 'residue_masses'} | {
                        'evidence': 'msms', 'scan_id': meta['scan_id'], 'time': meta['time'], 'precursor_mz': precursor,
                        'theoretical_precursor_mz': float(predicted[pidx]),
                        'parent_scan_id': meta.get('parent_scan_id'),
                        'charge': charge, 'isotope_offset': isotope, 'precursor_error_ppm': float(errors[pidx]),
                        'matched_ions': len(matches), 'matched_bonds': bonds, 'explained_intensity_pct': explained, 'fragments': matches,
                        'remnant_fragment_ions': [m['ion'] for m in remnant_ions]})
        hits.sort(key=lambda h:(h['matched_bonds'],h['explained_intensity_pct'],-abs(h['precursor_error_ppm'])),reverse=True)
        # Keep alternative peptide sequences visible; no false certainty from a tie.
        signatures = set()
        for hit in hits:
            signature = (hit['sequence'], tuple((m['residue'],m['delta']) for m in hit['modifications']))
            if signature in signatures: continue
            signatures.add(signature)
            hit['ambiguous_scan'] = len({(h['sequence'], tuple((m['residue'],m['delta']) for m in h['modifications'])) for h in hits}) > 1
            hit['sequence_ambiguous'] = len({h['sequence'] for h in hits}) > 1
            hit['site_ambiguous'] = len({peptide_signature(h) for h in hits if h['sequence'] == hit['sequence']}) > 1
            hit['site_search'] = any(m.get('variable') for m in hit['modifications'])
            rows.append(hit)
    features = find_features(survey, peptides, precursor_ppm, ms1_percent/100, ms1_intensity)
    # A variable-site feature may support a measured MS/MS precursor, but it must
    # never become an MS-only modification-site assignment or coverage line.
    rows.extend(link_msms(features, rows, precursor_ppm, peptide_signature))
    rows.sort(key=lambda r:(r['time'],r['scan_id']))
    coverage = []
    for chain in chains:
        positions, ms_positions, ms_only_positions = set(), set(), set()
        for row in rows:
            if row.get('sequence_ambiguous', row['ambiguous_scan']): continue
            for loc in row['locations']:
                if loc['chain'] != chain['id']: continue
                covered = range(loc['start'],loc['end']+1)
                if row.get('ms1_supported'): ms_positions.update(covered)
                (positions if row['evidence'] == 'msms' else ms_only_positions).update(covered)
        coverage.append({**chain,'positions':sorted(positions),'percent':len(positions)/len(chain['sequence'])*100,
                         'ms_positions':sorted(ms_positions), 'ms_only_positions':sorted(ms_only_positions),
                         'ms_percent':len(ms_positions)/len(chain['sequence'])*100,
                         'msms_percent':len(positions)/len(chain['sequence'])*100,
                         'ms_only_percent':len(ms_only_positions)/len(chain['sequence'])*100})
    return {'coverage': coverage, 'matches': rows, 'candidate_peptides':len(peptides), 'excluded_modified_peptides':excluded,
            'settings':{'enzyme':'Trypsin (not before P)', 'missed_cleavages':missed, 'precursor_ppm':precursor_ppm, 'fragment_ppm':fragment_ppm,
                        'ms1_peak_limit':500, 'ms1_min_relative_intensity':ms1_percent/100,
                        'ms1_min_relative_percent':ms1_percent, 'ms1_min_intensity':ms1_intensity, 'charges':[1,2,3,4,5,6],
                        'ms1_min_surveys':3, 'ms1_min_isotope_fit':.9, 'ms1_min_coelution':.95,
                        'ms1_min_peak_prominence_fraction':.5, 'ms1_threshold_scope':'feature apex',
                        'searched_modification_sites':searched_sites, 'site_search_evidence':'MS/MS only',
                        'variable_modifications_per_peptide':1 if searches else 0, 'preparation':preparation},
            'reference_filter':sample.qtof_info.get('reference_filter'),
            'warning':f'Exploratory candidates, not validated identifications; no FDR estimate. MS coverage requires a formula-compatible isotope envelope across at least three consecutive surveys within one bracketed chromatographic peak (isotope cosine >=0.90, coelution >=0.95, prominence >=50% of apex). Apex gates: {ms1_percent:g}% of the reference-filtered scan maximum and {ms1_intensity:g} counts; top 500 seed peaks per scan. Short peptides may use two isotope peaks. These conservative heuristics can miss weak, narrow, overlapping or edge-of-run features, and do not prove peptide sequence or exclude all chemical background. Unknown modification formulas do not receive MS1 feature support. MS/MS coverage requires fragments; an unconfirmed precursor feature is explicitly marked and excluded from MS coverage. Parent-linked or inferred mass/charge/RT associations are distinguished. Shared/repeated peptides map to every compatible location and do not identify an individual chain. I/L cannot be distinguished. Both coverages count unique residues and exclude competing sequences. Optional site search uses MS/MS only; competing sites stay unresolved. Intact cross-links and neutral losses are not searched.'}
