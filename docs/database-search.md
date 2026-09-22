# Optional local protein database search

## Workflow

1. Load an acquired positive-ion QTOF **protein digest** in Peptide Mapping.
2. Choose **Analysis → Search downloaded database**.
3. Select the organism/cell-line preset. Download once if needed; later searches
   use the verified saved FASTA offline. Cell-line choices share species references.
4. In **Variable modifications**, set the sample preparation: reduced/free
   thiols, fixed IAM if actually used, and optional oxidation, deamidation or
   variable IAM. Fixed and variable IAM are mutually exclusive.
5. Open **Database search settings · Comet** to adjust the separate search settings.
6. Click **Search database**. Preparation, search and scoring show progress;
   **Cancel** stops this search, not the app. Search results appear on completion.
7. Click a protein candidate to filter its peptide-spectrum matches. Click a
   peptide to see that individual measured MS/MS and matched b/y cuts. Spectrum
   PDF export uses the existing measured-spectrum exporter.
8. **Use as reference** copies a candidate's complete database sequence into the
   ordinary reference mapper. It does not rerun mapping automatically or transfer
   confidence estimates to reference-mapping results.

No expected sequence or saved BioConfirm assignment enters the database search.
The search is not de novo sequencing: it finds candidates present in the selected
species database. Custom constructs, strain variants and noncanonical chemistry
may not be represented. The E. coli catalog is K-12, not every E. coli strain.

## Defaults and supported scope

- Pinned Comet 2026.02.2, native CLI bundled separately for each platform.
- Fully tryptic, two missed cleavages; optional semi-tryptic search is slower.
- Precursor tolerance ±10 ppm; isotope offsets 0–2; charge hypotheses +1 to +6.
- High-resolution fragment bin width 0.02 Da, b/y ions up to +2.
- Peptide length 5–50 and neutral mass 400–6500 Da.
- Fixed IAM off unless selected; variable chemistry follows the selected sample.
- One best target/decoy hypothesis per measured MS/MS scan, across charge hypotheses.
- Default spectrum q threshold 1%; optional 5% exploratory view. Unfiltered
  candidates require an explicit checkbox and retain their displayed q values.
- Measured scans with fewer than ten positive finite peaks are skipped. Reference
  ions follow the same per-run exclusion policy as the rest of the app.
- Display-only b/y annotation uses ±20 ppm, separately from Comet's scoring bins.

Only linear, reduced/free-thiol peptides are supported. Unreduced disulfide-linked
peptide searching is refused. Reference-position remnants are for the supplied-
sequence mapper and are not included in an unknown-protein search. Modification
positions are search assignments, not validated localization. No MS1-only peak
is promoted to a database identification; this option searches acquired MS/MS.

## Confidence

Comet uses concatenated target/decoy competition. The app retains one winning
hypothesis per acquired scan, preferring decoys on tied scores. Equal E-values
are counted together. Spectrum q is the monotone minimum of `(D + 1) / T`.
The +1 correction prevents a small target-only result from claiming zero error.

Peptide q is estimated separately after taking the best hypothesis per unmodified
sequence, treating I/L as indistinguishable. Modification forms are collapsed for
this counting unit. Decoy-winning sequences do not give targets peptide confidence.
Small purified-protein datasets can have spectrum matches passing 1% while no
distinct peptides pass the separate conservative peptide-q threshold.

Protein rows are **candidates**, not a protein-level FDR result. Their supported
peptide counts and coverage use spectrum-q-passing matches; this does not imply
the separate peptide-q threshold passed. Shared peptides can appear under several
accessions. Exclusive-peptide counts distinguish unshared database associations,
but do not constitute full protein-group inference or validated identification.

## Storage, privacy and resource use

Raw files and spectra are not uploaded. After the reference FASTA is downloaded,
the whole search runs locally. The database and raw acquisition files are read-only.
The full saved FASTA checksum is verified when copied into a job-owned temporary
folder. Comet uses at most four CPU threads and batches 500 spectra. The temporary
MGF, FASTA copy and logs are removed when the job ends. Completed results are
atomically saved as `userData/protein-searches/latest.json`; the current session
displays the completed job. Searches are not automatically resumed after restart.

Cancellation terminates only that job's native child process. A failed/interrupted
search never exposes partial results or overwrites downloaded databases. Old
results cannot be inspected after changing the run's reference-ion policy without
rerunning the search.

The build downloads an exact official engine release and verifies a pinned SHA-256.
Only the CLI is bundled; no vendor raw-reader DLLs or wrapper are distributed.
License and third-party notices are in `third_party/comet`. The frozen backend
self-test performs a synthetic target/decoy search on both release platforms;
it is a packaging smoke test, not a validation of proteomics identification accuracy.

Sources: [Comet](https://github.com/UWPR/Comet),
[parameters](https://uwpr.github.io/Comet/parameters/parameters_202602/),
[database catalog and attribution](protein-databases.md).
