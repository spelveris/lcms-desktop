"""Local, version-pinned Comet target/decoy MS/MS search of saved proteomes.

No expected sequence or BioConfirm assignments enter this search. Report
spectrum and peptide q estimates separately; never call them protein FDR.
"""
from collections import defaultdict
from datetime import datetime, timezone
import csv
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile
from threading import Event, RLock, Thread
import time
import uuid

import numpy as np
from peptide_modifications import variable_settings
from protein_databases import _atomic_json

ENGINE_VERSION = '2026.02.2'
PROTON = 1.007276466621
ISOTOPE = 1.00335483507
ACTIVE = {'preparing', 'searching', 'scoring', 'cancelling'}
DEFAULTS = dict(precursor_ppm=10., fragment_bin_da=.02, missed_cleavages=2,
                semi_tryptic=False, charge_min=1, charge_max=6,
                min_length=5, max_length=50, q_threshold=.01)


class SearchCancelled(Exception):
    pass


def engine_path():
    name = 'comet.exe' if os.name == 'nt' else 'comet'
    if getattr(sys, 'frozen', False):
        return Path(sys._MEIPASS) / 'comet' / name
    system = {'Darwin': 'darwin', 'Windows': 'win32', 'Linux': 'linux'}.get(platform.system(), '')
    arch = 'arm64' if platform.machine().lower() in ('aarch64', 'arm64') else 'x64'
    return Path(__file__).resolve().parents[2] / 'build' / 'comet' / f'{system}-{arch}' / name


def normalize_settings(payload):
    raw = payload.get('settings', {})
    if not isinstance(raw, dict) or set(raw) - DEFAULTS.keys():
        raise ValueError('Unknown database-search setting')
    settings = {**DEFAULTS, **raw}
    bounds = dict(precursor_ppm=(1,50), fragment_bin_da=(.005,.1), missed_cleavages=(0,3),
                  charge_min=(1,6), charge_max=(1,6), min_length=(5,50), max_length=(5,50), q_threshold=(.001,.1))
    integers = {'missed_cleavages','charge_min','charge_max','min_length','max_length'}
    for key, (low, high) in bounds.items():
        value = settings[key]
        if isinstance(value, bool) or not isinstance(value, (int,float)) or not math.isfinite(value) or not low <= value <= high:
            raise ValueError(f'{key}: choose a finite number from {low:g} to {high:g}')
        if key in integers and int(value) != value:
            raise ValueError(f'{key} must be a whole number')
    if settings['charge_min'] > settings['charge_max'] or settings['min_length'] > settings['max_length']:
        raise ValueError('The lower range limit must not exceed the upper limit')
    if not isinstance(settings['semi_tryptic'], bool):
        raise ValueError('Semi-tryptic search must be true or false')
    prep = payload.get('preparation', {})
    if not isinstance(prep, dict) or not isinstance(prep.get('reduced', True), bool) or not isinstance(prep.get('iam', False), bool):
        raise ValueError('Invalid preparation settings')
    if not prep.get('reduced', True):
        raise ValueError('Database search currently supports reduced/free-thiol linear peptides, not unreduced disulfide-linked peptides.')
    variable = variable_settings(payload.get('variable_modifications'))
    if prep.get('iam', False) and variable['iam']:
        raise ValueError('Choose fixed IAM or variable IAM, not both')
    if payload.get('modifications'):
        raise ValueError('Reference-specific remnant sites do not apply to an unknown-protein search')
    return dict(settings, fixed_iam=prep.get('iam',False), variable_modifications=variable)


def parameters(template, settings):
    mods = settings['variable_modifications']
    maximum = mods['max_per_peptide']
    values = dict(database_name='database.fasta', decoy_search='1', num_threads=str(min(4, max(1,(os.cpu_count() or 2)-1))),
                  peptide_mass_tolerance_upper=str(settings['precursor_ppm']), peptide_mass_tolerance_lower=str(-settings['precursor_ppm']),
                  peptide_mass_units='2', isotope_error='2', num_enzyme_termini='1' if settings['semi_tryptic'] else '2',
                  allowed_missed_cleavage=str(settings['missed_cleavages']), fragment_bin_tol=str(settings['fragment_bin_da']),
                  fragment_bin_offset='0.0', theoretical_fragment_ions='0',
                  variable_mod01=f"{15.99491462 if mods['oxidation'] else 0} M 0 {maximum} -1 0 0 0.0",
                  variable_mod02=f"{.984015585 if mods['deamidation'] else 0} NQ 0 {maximum} -1 0 0 0.0",
                  variable_mod03=f"{57.021463735 if mods['iam'] else 0} C 0 {maximum} -1 0 0 0.0",
                  max_variable_mods_in_peptide=str(maximum), add_C_cysteine='57.021463735' if settings['fixed_iam'] else '0',
                  output_txtfile='1', output_pepxmlfile='0', output_percolatorfile='0', num_output_lines='1',
                  precursor_charge=f"{settings['charge_min']} {settings['charge_max']}", override_charge='1',
                  max_duplicate_proteins='-1', max_fragment_charge='2', min_precursor_charge=str(settings['charge_min']),
                  max_precursor_charge=str(settings['charge_max']), digest_mass_range='400.0 6500.0',
                  peptide_length_range=f"{settings['min_length']} {settings['max_length']}", clip_nterm_methionine='1',
                  spectrum_batch_size='500', remove_precursor_peak='1', remove_precursor_tolerance='0.05',
                  decoy_prefix='DECOY_', equal_I_and_L='1', use_B_ions='1', use_Y_ions='1', use_NL_ions='0')
    seen, lines = set(), []
    for line in template.splitlines():
        key = line.split('=')[0].strip()
        if key in values:
            line = f'{key} = {values[key]}'; seen.add(key)
        lines.append(line)
    if seen != set(values):
        raise ValueError('The packaged Comet parameter template does not match this app version')
    return '\n'.join(lines)+'\n'


def export_measured(sample, path, cancel):
    if not getattr(sample, 'qtof_info', None) or not sample.qtof_info.get('is_protein_digest'):
        raise ValueError('Choose a QTOF protein digest with measured positive-ion MS/MS spectra')
    channel = sample.qtof_channels.get((0,2))
    if channel is None:
        raise ValueError('This sample has no acquired positive-ion MS/MS spectra')
    scans, skipped = {}, 0
    with path.open('w', encoding='ascii', newline='\n') as stream:
        for meta, scan in zip(channel.metadata, channel.scans):
            if cancel.is_set(): raise SearchCancelled()
            mz, rt, scan_id = meta.get('precursor_mz'), meta.get('time'), meta.get('scan_id')
            if not mz or not np.isfinite([mz,rt]).all() or mz <= 0:
                skipped += 1; continue
            peaks = scan[np.isfinite(scan).all(axis=1) & (scan[:,0]>0) & (scan[:,1]>0)]
            if len(peaks) < 10:
                skipped += 1; continue
            if scan_id in scans: raise ValueError('Duplicate acquired MS/MS scan identifiers')
            scans[scan_id] = dict(scan_id=int(scan_id), time=float(rt), precursor_mz=float(mz))
            stream.write(f'BEGIN IONS\nTITLE=scan_{scan_id}\nSCANS={scan_id}\nRTINSECONDS={rt*60:.12g}\nPEPMASS={mz:.12g}\n')
            # QTOF files may not contain a reliable charge: do not invent one in MGF.
            for x,y in peaks: stream.write(f'{x:.12g} {y:.12g}\n')
            stream.write('END IONS\n\n')
    if not scans: raise ValueError('No usable measured MS/MS scans (at least 10 positive peaks required)')
    if len(scans) > 100000: raise ValueError('Database search supports up to 100,000 MS/MS scans per run')
    return scans, skipped


def qvalues(items, field):
    """Tie-grouped TDC (D+1)/T; one winning hypothesis per counting unit."""
    groups = []
    for row in sorted(items, key=lambda row: row['evalue']):
        if not groups or groups[-1][0]['evalue'] != row['evalue']: groups.append([])
        groups[-1].append(row)
    t = d = 0; estimates = []
    for group in groups:
        t += sum(not row['decoy'] for row in group); d += sum(row['decoy'] for row in group)
        estimates.append(min(1., (d+1)/max(t,1)))
    running = 1.
    for group, estimate in reversed(list(zip(groups, estimates))):
        running = min(running, estimate)
        for row in group: row[field] = running


def read_fasta(path):
    records, name, pieces = {}, None, []
    with path.open(encoding='utf-8') as stream:
        for line in stream:
            if line.startswith('>'):
                if name: records[name.split()[0]] = dict(header=name, sequence=''.join(pieces))
                name = line[1:].strip(); pieces = []
            else: pieces.append(line.strip())
    if name: records[name.split()[0]] = dict(header=name, sequence=''.join(pieces))
    return records


def parse_results(path, scans, fasta, settings):
    best = {}
    with path.open(encoding='utf-8') as stream:
        if '2026.02' not in stream.readline(): raise ValueError('Unexpected Comet result version')
        for row in csv.DictReader(stream, delimiter='\t'):
            if row.get('num') != '1': continue
            scan_id = int(row['scan'])
            if scan_id not in scans: raise ValueError('Search returned an unknown acquired scan')
            score, xcorr = float(row['e-value']), float(row['xcorr'])
            if not math.isfinite(score) or score < 0 or not math.isfinite(xcorr): raise ValueError('Invalid search score')
            proteins = row['protein'].split(',')
            # Any target/decoy collision is conservatively a decoy winner.
            decoy = any(p.startswith('DECOY_') for p in proteins)
            result = dict(scans[scan_id], sequence=row['plain_peptide'], modified_sequence=row['modified_peptide'],
                          modifications_text=row['modifications'], charge=int(row['charge']), evalue=score,
                          xcorr=xcorr, decoy=decoy, proteins=proteins, matched_ions=int(row['ions_matched']),
                          theoretical_mass=float(row['calc_neutral_mass']), experimental_mass=float(row['exp_neutral_mass']))
            # Equal best scores across charges favour the decoy, never the target.
            key = (score, not decoy, -xcorr)
            if scan_id not in best or key < best[scan_id][0]: best[scan_id] = key, result
    winners = [entry[1] for entry in best.values()]
    qvalues(winners, 'psm_q')
    peptide_best = {}
    for row in sorted(winners, key=lambda row:(row['evalue'],not row['decoy'],-row['xcorr'])):
        # Target/decoy compete for the same normalized unmodified peptide unit.
        peptide_best.setdefault(row['sequence'].replace('I','L'), dict(row))
    qvalues(list(peptide_best.values()), 'peptide_q')
    for row in winners:
        peptide = peptide_best[row['sequence'].replace('I','L')]
        # A losing target must not inherit a decoy winner's peptide confidence.
        row['peptide_q'] = 1. if peptide['decoy'] else peptide['peptide_q']
        row['passes_psm_q'] = not row['decoy'] and row['psm_q'] <= settings['q_threshold']
    targets = sorted((r for r in winners if not r['decoy']), key=lambda r:(r['evalue'],r['scan_id']))
    references = read_fasta(fasta)
    supported = defaultdict(list)
    for row in targets:
        for accession in row['proteins']:
            if accession in references: supported[accession].append(row)
    proteins = []
    for accession, rows in supported.items():
        reference = references[accession]
        accepted = [r for r in rows if r['passes_psm_q']]
        peptides = {r['sequence'].replace('I','L') for r in accepted}
        exclusive = {r['sequence'].replace('I','L') for r in accepted if len(r['proteins'])==1}
        covered = set(); normalized = reference['sequence'].replace('I','L')
        for peptide in peptides:
            start = normalized.find(peptide)
            while start >= 0:
                covered.update(range(start,start+len(peptide))); start = normalized.find(peptide,start+1)
        proteins.append(dict(accession=accession, **reference, accepted_psms=len(accepted),
                             peptides=len(peptides), exclusive_peptides=len(exclusive),
                             coverage_percent=100*len(covered)/max(1,len(normalized)), best_evalue=min(r['evalue'] for r in rows),
                             total_psms=len(rows)))
    proteins.sort(key=lambda p:(-p['peptides'],-p['accepted_psms'],p['best_evalue'],p['accession']))
    return dict(psms=targets, proteins=proteins, searched_scans=len(scans), reported_scans=len(winners),
                target_winners=len(targets), decoy_winners=sum(r['decoy'] for r in winners),
                accepted_psms=sum(r['passes_psm_q'] for r in targets),
                accepted_peptides=sum(not r['decoy'] and r['peptide_q']<=settings['q_threshold'] for r in peptide_best.values()),
                confidence='Target-decoy estimates: spectrum q and peptide q are separate; no protein-level FDR. Shared peptides do not establish one protein. Modification sites are search assignments, not validated localization.')


class DatabaseSearchStore:
    def __init__(self, root, databases, loader):
        self.root = Path(root) / 'protein-searches'
        self.databases, self.loader = databases, loader
        self.lock, self.cancel_event = RLock(), Event()
        self.job = self.result = self.thread = None

    def status(self):
        with self.lock:
            return dict(job=dict(self.job) if self.job else None, engine_available=engine_path().is_file(), engine_version=ENGINE_VERSION)

    def start(self, payload):
        settings = normalize_settings(payload)
        database_id, sample_path = payload.get('database_id'), payload.get('path')
        if not isinstance(sample_path, str) or not sample_path: raise ValueError('Choose a digest sample')
        fasta, metadata = self.databases.search_database(database_id)
        if not engine_path().is_file(): raise ValueError('The local Comet engine is missing from this installation')
        with self.lock:
            if self.thread and self.thread.is_alive(): raise ValueError('Finish or cancel the current database search')
            self.cancel_event = Event(); self.result = None
            self.job = dict(id=uuid.uuid4().hex, state='preparing', path=sample_path, database_id=database_id, message='Preparing measured MS/MS spectra…', error=None)
            self.thread = Thread(target=self._worker, args=(sample_path,fasta,metadata,settings), daemon=True)
            self.thread.start()
            return self.status()

    def cancel(self, job_id):
        with self.lock:
            if not self.job or self.job['id'] != job_id: raise ValueError('This database search is no longer active')
            if self.job['state'] in ACTIVE:
                self.cancel_event.set(); self.job.update(state='cancelling',message='Cancelling database search…')
            return self.status()

    def close(self):
        self.cancel_event.set()
        # Give the worker time to terminate its native child before Python exits.
        if self.thread: self.thread.join(12)

    def _update(self, **changes):
        if self.cancel_event.is_set(): raise SearchCancelled()
        with self.lock: self.job.update(changes)

    def _process(self, args, directory, log):
        if self.cancel_event.is_set(): raise SearchCancelled()
        with log.open('wb') as stream:
            proc = subprocess.Popen([str(engine_path()),*args], cwd=directory, stdout=stream, stderr=subprocess.STDOUT,
                                    creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
            start = time.monotonic()
            try:
                while proc.poll() is None:
                    if self.cancel_event.wait(.25): raise SearchCancelled()
                    if time.monotonic()-start > 7200: raise ValueError('Database search exceeded two hours; use fewer variable modifications or fully tryptic digestion')
                    if log.stat().st_size > 50_000_000: raise ValueError('Search log exceeded its safety limit')
                if proc.returncode:
                    raise ValueError(f'Comet search failed (exit {proc.returncode}). '+log.read_text(errors='replace')[-600:])
            finally:
                if proc.poll() is None:
                    proc.terminate()
                    try: proc.wait(timeout=5)
                    except subprocess.TimeoutExpired: proc.kill(); proc.wait(timeout=5)

    def _worker(self, sample_path, fasta, metadata, settings):
        try:
            # Job-owned temporary directory only; raw samples and saved DB never modified.
            with tempfile.TemporaryDirectory(prefix='catrupole-search-') as tmp:
                directory = Path(tmp)
                sample = self.loader(sample_path)
                scans, skipped = export_measured(sample,directory/'measured.mgf',self.cancel_event)
                shutil.copyfile(fasta, directory/'database.fasta')
                digest = hashlib.sha256((directory/'database.fasta').read_bytes()).hexdigest()
                if digest != metadata['sha256']: raise ValueError('Database changed during preparation; retry with a verified database')
                self._process(['-p'], directory, directory/'template.log')
                template = (directory/'comet.params.new').read_text()
                (directory/'search.params').write_text(parameters(template,settings))
                self._update(state='searching', message=f'Searching {len(scans):,} MS/MS spectra with Comet…', spectra=len(scans))
                self._process(['-Psearch.params','measured.mgf'],directory,directory/'search.log')
                self._update(state='scoring',message='Estimating false matches and collecting protein candidates…')
                result = parse_results(directory/'measured.txt',scans,directory/'database.fasta',settings)
                result.update(id=self.job['id'], path=sample_path, database=metadata, settings=settings, engine_version=ENGINE_VERSION,
                              skipped_spectra=skipped, reference_filter=sample.qtof_info.get('reference_filter'),
                              completed_at=datetime.now(timezone.utc).isoformat())
                self._update(message='Saving results…')
                self.root.mkdir(parents=True, exist_ok=True)
                _atomic_json(self.root/'latest.json', result)
            with self.lock:
                self.result = result
                self.job.update(state='complete',message=f"{result['accepted_psms']} spectrum matches pass the selected q threshold")
        except SearchCancelled:
            with self.lock: self.job.update(state='cancelled',message='Search cancelled; saved databases and raw files unchanged')
        except Exception as error:
            with self.lock: self.job.update(state='failed',error=str(error),message='Database search failed')

    def results(self, job_id):
        with self.lock:
            if not self.result or self.result['id'] != job_id: raise ValueError('No completed results for this search')
            result = self.result
        if self.loader(result['path']).qtof_info.get('reference_filter') != result['reference_filter']:
            raise ValueError('Reference-ion settings changed; rerun the database search')
        return result

    def spectrum_match(self, job_id, scan_id):
        from peptide_mapping import AA, fragments, match_fragments
        result = self.results(job_id)
        row = next((r for r in result['psms'] if r['scan_id']==scan_id),None)
        if row is None: raise ValueError('This measured scan has no target match in the search')
        sample = self.loader(result['path']); channel = sample.qtof_channels[(0,2)]
        scan = next((scan for meta,scan in zip(channel.metadata,channel.scans) if meta['scan_id']==scan_id),None)
        if scan is None: raise ValueError('The acquired spectrum is no longer available')
        # Refuse changed exclusion policy; do not mix evidence from different searches.
        if sample.qtof_info.get('reference_filter') != result['reference_filter']:
            raise ValueError('Reference-ion settings changed; rerun the database search')
        sequence = row['sequence']; masses = np.array([AA[a] for a in sequence]); mods=[]
        if row['modifications_text'] != '-':
            for token in row['modifications_text'].split(','):
                match=re.fullmatch(r'(\d+)_[SV]_(-?\d+(?:\.\d+)?)',token)
                if not match: raise ValueError('Unsupported terminal modification in search result')
                pos, delta=int(match[1]),float(match[2]); masses[pos-1]+=delta
                mods.append(dict(residue=pos,delta=delta,kind='database',variable=True))
        # Display-only exact b/y matches at 20 ppm; Comet scoring uses its visible Da bin setting.
        matches, explained = match_fragments(scan,fragments(masses,min(2,row['charge'])),20.,
              dict(fragment_min_relative_percent=0.,fragment_min_intensity=0.,fragment_peak_limit=0))
        isotope = min(range(3),key=lambda i:abs(row['experimental_mass']-row['theoretical_mass']-i*ISOTOPE))
        return dict(row,fragments=matches,modifications=mods,evidence='msms',locations=[],
                    isotope_offset=isotope,ms1_supported=False,explained_intensity=explained,
                    spectrum=dict(mz=scan[:,0].tolist(),intensities=scan[:,1].tolist(),ms_level=2),
                    annotation_ppm=20., database_search=True)
