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

PROTON = 1.007276466621
WATER = 18.010564684
ISOTOPE = 1.00335483507
# Unimod 121: epsilon-linked diglycyl remnant after tryptic digestion.
# https://www.unimod.org/modifications_view.php?editid1=121
GGISOK_DELTA = 114.04292747
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
                                     'modifications': [{'residue': pos+1, 'delta': delta} for pos, delta in shifts]}
                peptides[key]['locations'].append({'chain': chain['id'], 'start': start+1, 'end': end})
    return list(peptides.values()), excluded


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


def match_ms1(channel, peptides, supported, ppm):
    """Tentative mass compatibility only; not sequence or isotope validation.

    Aggregate repeated observations across the run, retaining the strongest
    measured survey peak per peptide/charge/isotope hypothesis. Never promote
    these matches to MS/MS sequence coverage. Search positive charges 1–6.
    """
    if channel is None or not peptides:
        return []
    masses = np.array([p['mass'] for p in peptides])
    hypotheses = [(pidx, charge, isotope)
                  for charge in range(1, 7) for isotope in range(3)
                  for pidx in range(len(peptides))]
    predicted = np.concatenate([(masses + charge*PROTON + isotope*ISOTOPE)/charge
                                for charge in range(1, 7) for isotope in range(3)])
    order = np.argsort(predicted, kind='stable')
    predicted = predicted[order]
    best = {}
    tolerance = ppm * 1e-6
    for meta, scan in zip(channel.metadata, channel.scans):
        if not len(scan): continue
        valid = np.flatnonzero(np.isfinite(scan).all(axis=1) & (scan[:, 0] > 0) & (scan[:, 1] > 0))
        if not len(valid): continue
        # Bounded noise filter; disclosed with the result settings.
        valid = valid[scan[valid, 1] >= scan[valid, 1].max() * .01]
        valid = valid[np.argsort(scan[valid, 1], kind='stable')[-500:]]
        observed = scan[valid, 0]
        starts = np.searchsorted(predicted, observed/(1+tolerance), side='left')
        ends = np.searchsorted(predicted, observed/(1-tolerance), side='right')
        for index, start, end in zip(valid, starts, ends):
            alternatives = {peptide_signature(peptides[hypotheses[order[j]][0]]) for j in range(start, end)}
            for j in range(start, end):
                pidx, charge, isotope = key = hypotheses[order[j]]
                peptide = peptides[pidx]
                if peptide_signature(peptide) in supported: continue
                hit = {k: v for k, v in peptide.items() if k != 'residue_masses'} | {
                    'evidence': 'ms1', 'scan_id': meta['scan_id'], 'time': meta['time'],
                    'precursor_mz': float(scan[index, 0]), 'charge': charge, 'isotope_offset': isotope,
                    'precursor_error_ppm': float((scan[index, 0]-predicted[j])/predicted[j]*1e6),
                    'precursor_intensity': float(scan[index, 1]), 'matched_ions': 0, 'matched_bonds': 0,
                    'explained_intensity_pct': None, 'fragments': [], 'ambiguous_scan': len(alternatives) > 1,
                    'observation_count': 1, 'time_start': meta['time'], 'time_end': meta['time'],
                }
                previous = best.get(key)
                if previous is not None:
                    # Count scans, not multiple compatible peaks within a scan.
                    count = previous['observation_count'] + (previous['_last_scan'] != meta['scan_id'])
                    first_time, last_time = min(previous['time_start'], meta['time']), max(previous['time_end'], meta['time'])
                    ambiguous = previous['ambiguous_scan'] or hit['ambiguous_scan']
                    if previous['precursor_intensity'] > hit['precursor_intensity']:
                        hit = previous
                    hit.update(observation_count=count, time_start=first_time, time_end=last_time, ambiguous_scan=ambiguous)
                hit['_last_scan'] = meta['scan_id']
                best[key] = hit
                if len(best) > 20000:
                    raise ValueError('Too many MS-only mass hypotheses; reduce the reference, missed cleavages or precursor tolerance')
    for hit in best.values(): hit.pop('_last_scan', None)
    return list(best.values())


def analyze(sample, payload):
    if not sample.qtof_info or not sample.qtof_info.get('is_protein_digest'):
        raise ValueError('Peptide Mapping requires a QTOF protein digest/peptide mapping acquisition')
    channel = sample.qtof_channels.get((0, 2))
    survey = sample.qtof_channels.get((0, 1))
    if channel is None and survey is None: raise ValueError('No acquired positive-ion MS or MS/MS scans in this run')
    chains = parse_fasta(payload.get('fasta', ''))
    missed = int(payload.get('missed_cleavages', 2))
    precursor_ppm, fragment_ppm = float(payload.get('precursor_ppm', 10)), float(payload.get('fragment_ppm', 50))
    if not 0 <= missed <= 3 or not 1 <= precursor_ppm <= 50 or not 1 <= fragment_ppm <= 100:
        raise ValueError('Use 0–3 missed cleavages, 1–50 precursor ppm and 1–100 fragment ppm')
    modifications = payload.get('modifications', [])
    if not isinstance(modifications, list) or len(modifications) > 100: raise ValueError('Too many modifications')
    if any(not isinstance(mod, dict) for mod in modifications): raise ValueError('Invalid modification definition')
    modifications = [dict(mod) for mod in modifications]
    seen = set()
    for mod in modifications:
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
            mod['block_cleavage'] = True
        if delta is not None:
            mod['delta'] = float(delta)
            if not np.isfinite(mod['delta']) or abs(mod['delta']) > 2000: raise ValueError('Invalid modification mass shift')
    peptides, excluded = digest(chains, missed, modifications)
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
                    bonds = len({m['bond'] for m in matches})
                    if len(matches) < 4 or bonds < 3 or explained < 10: continue
                    hits.append({k:v for k,v in peptide.items() if k != 'residue_masses'} | {
                        'evidence': 'msms', 'scan_id': meta['scan_id'], 'time': meta['time'], 'precursor_mz': precursor,
                        'charge': charge, 'isotope_offset': isotope, 'precursor_error_ppm': float(errors[pidx]),
                        'matched_ions': len(matches), 'matched_bonds': bonds, 'explained_intensity_pct': explained, 'fragments': matches})
        hits.sort(key=lambda h:(h['matched_bonds'],h['explained_intensity_pct'],-abs(h['precursor_error_ppm'])),reverse=True)
        # Keep alternative peptide sequences visible; no false certainty from a tie.
        signatures = set()
        for hit in hits:
            signature = (hit['sequence'], tuple((m['residue'],m['delta']) for m in hit['modifications']))
            if signature in signatures: continue
            signatures.add(signature)
            hit['ambiguous_scan'] = len({(h['sequence'], tuple((m['residue'],m['delta']) for m in h['modifications'])) for h in hits}) > 1
            rows.append(hit)
    # "MS-only" means there is no fragment-supported assignment for this
    # sequence/modification anywhere in this run, including competing MS/MS hits.
    supported = {peptide_signature(row) for row in rows}
    rows.extend(match_ms1(survey, peptides, supported, precursor_ppm))
    rows.sort(key=lambda r:(r['time'],r['scan_id']))
    coverage = []
    for chain in chains:
        positions = set()
        for row in rows:
            if row['ambiguous_scan'] or row['evidence'] != 'msms': continue
            for loc in row['locations']:
                if loc['chain'] == chain['id']: positions.update(range(loc['start'],loc['end']+1))
        coverage.append({**chain,'positions':sorted(positions),'percent':len(positions)/len(chain['sequence'])*100})
    return {'coverage': coverage, 'matches': rows, 'candidate_peptides':len(peptides), 'excluded_modified_peptides':excluded,
            'settings':{'enzyme':'Trypsin (not before P)', 'missed_cleavages':missed, 'precursor_ppm':precursor_ppm, 'fragment_ppm':fragment_ppm,
                        'ms1_peak_limit':500, 'ms1_min_relative_intensity':.01, 'charges':[1,2,3,4,5,6]},
            'warning':'Exploratory candidates, not validated identifications; no FDR estimate. MS-only matches are tentative mass compatibility, not sequence or isotope-envelope confirmation: top 500 survey peaks above 1% per scan, aggregated across the run with the strongest observation shown. Charge and isotope offset are hypotheses, not independently measured assignments. Shared/repeated peptides map to every compatible location and do not identify an individual chain. I/L cannot be distinguished. MS/MS coverage excludes competing sequence assignments and all MS-only matches. Unknown modifications, cross-links, neutral losses and variable modifications are not searched.'}
