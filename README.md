# LCMS Desktop

Desktop LC-MS analysis app built with Electron (frontend shell) and a packaged FastAPI backend.

## Automatic updates

Starting with version `0.2.43`, CATrupole checks GitHub when it starts and once per day. New releases download quietly in the background. The small update indicator changes to **Restart to update** when installation is ready; the update is also installed the next time CATrupole is quit normally.

Version `0.2.43` is the one-time bridge and must be installed manually. Later versions can update from inside CATrupole.

## QTOF and peptide mapping (v0.2.54)

Agilent TOF/Q-TOF OpenLab `.sirslt` runs with embedded scan/calibration metadata
and stored centroid peaks can be opened alongside the existing machine formats.
The reader uses each scan's recorded calibration and does not modify the run.
Existing analysis tabs use MS1 only; MS/MS fragments are kept separate.

The additional **MS Spectra** tab is shown only for selected QTOF runs whose
recorded acquisition method identifies a protein digest or peptide mapping
(not guessed from the sample's name). Intact runs retain the usual layout.
Use **MS Spectra → Open spectra** to inspect acquired QTOF digest scans. Choose an MS1
scan (or retention time), then click a blue acquired-precursor diamond to show
its measured MS/MS spectrum below. The MS/MS dropdown lists all acquired
fragment scans and follows the instrument's recorded parent links, not a
retention-time guess. MS1-only runs show that no MS/MS was acquired.

Individual spectra retain calibrated centroid masses and fractional intensities.
QTOF summed-spectrum views use a fixed 0.001 m/z grid (v0.2.55), except for the
explicitly selected isotope-fitting option described below. This is a rebinned centroid sum, not measured profile
data or additional instrument resolution. Original individual scan values are
unchanged. Other readers retain their existing summation behavior. The full
regular grid is used for calculations; only redundant interior zero points are
removed for display, keeping every occupied bin and the same line shape.
On-screen peak labels and hover values retain the available numeric precision;
declared QTOF grid values show three decimals rather than one. Original calibrated
centroids and inferred ion centroids are not rounded for their hover readouts.
In the default charge-envelope workflow, the dense third-row mass view is an all-charge projection with 0.1 Da bins and
2 Da Gaussian smoothing, not isotope-resolved deconvolution. The 0.001 m/z grid
does not add isotope resolution or change that algorithm.
The on-screen dense profile initially focuses on the strongest displayed component.
Click another coloured mass bar or result-table row to focus that component;
**Full range** restores the configured overview. View edges are just inside the
nearest predicted one-charge-too-low/high copies of the selected ion ladder.
A guard of 5% of the alias spacing (at least 12 Da, or four times the reported
mass spread) keeps some room before the predicted artifact shoulders. Measured
ion centres are used when available; otherwise positions follow assigned mass
and charges. Missing/multiply-charged-unavailable assignments use 2% of mass,
at least 25 Da. This is a reversible viewing
heuristic, not artifact removal or a guarantee that every visible peak is real.
Prominent local maxima receive adaptive, collision-spaced labels in **Da** with
one decimal place; the selected component's nearby apex is emphasized. Labels
are calculated from the full profile before display downsampling and are not
chemical identifications. Focus changes axis limits only: profile samples,
normalization, bins, smoothing and analysis results are unchanged. Existing PDF
downloads remain unchanged; these display labels and focus are on-screen only.
When smoothing is applied, QTOF peak intensities are expressed on the previous
0.01 m/z reference-bin scale, so a ten-times-finer grid does not silently lower
the existing noise threshold by tenfold. Raw summed counts are not rescaled.
This update does not infer peptide identities from intact spectra.
Profile-only QTOF runs and other QTOF container layouts are not covered by this
reader. The third-party source attribution is included with the backend.

### Intact analysis defaults and optional isotope fitting (v0.2.59)

The instrument metadata must identify **G6545XT**, the acquisition method must
explicitly say **Intact**, and it must not be a digest acquisition. Filenames alone
never select this workflow. This metadata only enables an **experimental option**;
**Charge envelope (default)** restores the previous intact analysis and summed
time-window spectrum. Other instrument/digest defaults are unchanged. Changing
samples resets the option to the default; isotope fitting is never auto-selected.

For supported QTOF intact samples, the m/z panel can also show **Measured centroids**:
all acquired coordinates in the selected window, merging only exact-equal m/z
values, with no rounding or bins. This optional view is reference-filtered but
**before blank subtraction** and does not replace the calculation spectrum. The
view asks for a narrower window above 500,000 points rather than downsampling.
The summed default retains the previous background subtraction. Candidate masses
sharing at least three ions at near-integer mass ratios receive a review warning;
they are not silently deleted, because oligomers can also share ions.

When **Isotope fitting (experimental)** is explicitly selected:

Each positive-ion MS1 scan in the selected time window is fitted independently
with `ms_deisotope` peptide averagine (10 ppm, charges +2–50, 95% isotope-pattern
truncation, two passes), using calibrated centroids above m/z 300. No 0.001-grid
resampling or smoothing enters this calculation. Fits need at least four consecutive
measured isotope peaks; repeated interleaving peaks reject lower-charge harmonics.
Component candidates require at least two charge states with monoisotopic estimates
within 10 ppm. These are averaged by envelope intensity; alternative isotope
assignments remain explicitly flagged, not claimed as separate confirmed proteoforms.
Unresolved isotope envelopes cannot support an isotope-resolved result.

In this optional mode, the main m/z panel shows the strongest corrected MS1 scan, labelled with scan ID
and time, retaining its stored precision. All selected scans contribute to fitting.
The third-row graph shows each component's strongest measured envelope converted
to neutral isotope masses using its fitted charge, with **no bins or smoothing**.
Those neutral masses are derived coordinates, not raw acquired neutral masses.
Fitted monoisotopic masses are averagine estimates, not sequence identifications
or guaranteed exact monoisotopic assignments. A fit score is not R² or an FDR.
Legacy expert settings are hidden for this preset; the mass-range controls apply.
To bound processing, windows containing over two million centroids must be narrowed.

Background subtraction uses the nearest-in-time positive QTOF MS1 blank scan and
subtracts nearest matching centroids within 10 ppm without changing sample m/z;
the blank must span the time window. Reference-ion exclusion is applied first.
The packaged macOS/Windows smoke checks fit a known synthetic elemental composition
to verify the engine is present, not just that the app starts.

OpenLab UV channels retain their own original time/intensity pairs, including
runs where the 214 and 278 nm channels have different lengths or time axes.
Neither channel is truncated, zero-padded or interpolated during import. The
chromatogram API, peak analysis, UV background subtraction and export figures
use each selected channel's own times. The compatibility matrix marks missing
observations with NaN; normal analysis uses the original channel arrays.
Wavelength selection defaults to an available channel (194 nm when recorded,
otherwise 214 nm when recorded, otherwise the first available wavelength), and
preserves the user's choices on refresh. Deconvolution and UV area calculation
choose a channel actually available in the selected run. UV Time Change requires
a shared recorded wavelength across its selected runs.

**Peptide Mapping**, beside Deconvolution, is also digest-only. Paste reference
FASTA, load a FASTA file, or read reference sequences from the run's saved
BioConfirm method. This imports method XML, not proprietary binary result scores.
Set fixed, site-specific modifications explicitly; imported unresolved modifications
exclude affected peptides. For a confirmed diglycyl lysine remnant, use
the **GGisoK (ε-Gly-Gly lysine)** preset, choosing chain B and position 48 for
that example. The preset adds 114.042927 Da relative to lysine and blocks
trypsin cleavage at the site. Do not substitute a linear GG
sequence for an epsilon-linked modification. Cross-linked peptides are not searched.

Below the sequence input, **Reduced / free thiols** preserves the original residue
mass convention (no extra hydrogen shift). **IAM alkylation** adds C2H3NO,
57.021463735 Da, to each free cysteine; duplicate explicit carbamidomethyl entries
are counted once and conflicting modifications are rejected. **Unreduced disulfides**
requires explicit pairs such as `A:3-A:18`: peptides containing bonded cysteines
are excluded rather than treated as independent linear peptides. The algorithm
does not infer disulfide positions from sequence. IAM does not modify those bonded
cysteines. The long analysis qualifications are available in closed **Analysis details**;
the main view displays only short match counts. Custom **Chemical formula** is
immediately left of its read-only **Calculated shift (Da)**.

The mapping implementation is **exploratory**: tryptic peptides of 5–70
residues, 0–3 missed cleavages, precursor charges 1–6 (inferred), isotope offsets
0–2, and b/y fragments of charges 1–2. Default tolerances are 10 ppm precursor
and 50 ppm fragments (both remain adjustable). One non-tryptic terminus is allowed
by default: either end of a tryptic peptide may be truncated, not both. Fully
tryptic-only searching remains available. It requires four distinct matched ions,
three cleavage bonds and 10% of retained fragment intensity. MS/MS peak-height and
peak-count filters are disabled by default; optional cutoffs are editable. These
are review thresholds, not a validated identification score or FDR estimate.
Ambiguous sequence candidates are excluded from coverage; repeated/shared
peptides map to all compatible locations and do not establish chain identity.
I/L are indistinguishable; neutral losses are not searched. Click a candidate to
inspect its measured, annotated fragment spectrum.

The expandable **Peptide mapping settings** panel saves numerical method choices
locally (not sequences or research results), with **Reset defaults**. Defaults
match the supported numerical settings in the supplied BioConfirm method:
10/50 ppm, 2 missed cleavages, 5–70 residues, 350–2000 MS1 m/z and a 100-count seed
minimum. Seeds must pass that floor; weaker measured isotope peaks and shoulder
scans are retained for coherence checks rather than censored into false peaks.
Additional feature-apex gates for **percent of the survey maximum** and **counts**
default to 0 (disabled). Both enabled gates must pass at a feature's apex; 0 disables the
corresponding gate, not the feature evidence checks. The maximum is measured
after reference-ion and m/z-window filtering. At most the 500 strongest passing peaks per scan
are tested as seeds. Weaker neighbouring scans remain available for isotope and
chromatographic checks. Counts, isotope fit and consecutive observations are shown
for the selected feature. These gates do not change MS/MS fragment matching or raw
data; they can change whether a precursor feature is confirmed.

The initial table filter shows MS/MS candidates; choose **All** to include MS-only
features. Coverage still reports both evidence types. CID b/y matching, free-thiol
mass conventions and individual measured spectra are retained. These settings do
not reproduce Agilent's proprietary quality/identification scores, Agile 2,
adduct grouping, negative-ion search or averaging/saturation rules. CATrupole keeps
its explicit +1–+6 search bound. Optional oxidation (M), deamidation (N/Q) and
variable IAM (C) can be combined, with a limit of 1–4 variable modifications per
peptide (including any selected variable remnant). These options default off;
fixed IAM and variable IAM are mutually exclusive. Preparation choices belong to
each sample in the current session, not to every subsequently loaded sample.
Precursor-compatible site permutations are retained for MS/MS comparison;
MS1 alone cannot localize them. Localization requires two modified backbone cuts
and evidence distinguishing every compatible alternative placement. Search size
limits fail explicitly rather than silently dropping competing sites.
It retains competing assignments rather than enforcing the
vendor's maximum-three-matches display or implying equivalent scores. No FDR is
calculated. Unchecked vendor filters are not silently applied as active settings.

An MS1 mass candidate now requires a **composition-compatible isotope envelope**
across at least three consecutive surveys of a bracketed elution peak, including
at least two coherent surveys in its half-height core. This admits narrow peaks
with measured shoulders without accepting a single-survey spike.
The expected pattern comes from the reference peptide and known net modification
formulas, using Pyteomics compositions and Brain isotope centroids. Required peaks
are at least 10% of the expected maximum, with a minimum of two (short +1 peptides
are supported). Cosine fit must be at least 0.90, and required isotope intensities
must be within 0.4–2.5 times their fitted expectation.
Each envelope is aligned to a measured M/M+1/M+2 anchor within the requested
absolute precursor ppm tolerance, then its relative isotope spacing is checked
at that same ppm tolerance. The reported precursor must still pass the absolute
mass gate; acquired m/z values are not shifted or rounded. Strong interleaved finer
charge patterns reject lower-charge aliases. Isotope traces must coelute with cosine
at least 0.95. Peak prominence must be at least 50% of apex within +/-0.5 minutes;
survey gaps cannot exceed 0.15 minutes. Coherent shoulders down to 10% of apex are
included for MS/MS parent linking. Isotope offsets are merged within a feature,
while separate chromatographic peaks remain separate.

These conservative heuristics are not a validated identification/FDR method, and
can miss narrow, weak, overlapping or edge-of-run peaks. They do not eliminate all
chemical interference. A matching MS1 feature supports mass/charge, not sequence.
Unknown custom modification formulas (and selenium isotope origins) are not given
MS1 envelope support; MS/MS review remains available. An isolated matching m/z or
flat persistent trace never qualifies, even with intensity cutoffs disabled.

The optional **Find site across reference** control searches every eligible
position on one chain or all supplied chains, without requiring a written residue
position. The unused written position is hidden while this is checked. Click
**Map measured MS / MS/MS to reference** to start; a loading overlay shows the
active search and the completed status reports the number of sites tested.
GGisoK is restricted to lysines; a custom elemental change can target
chosen residue letters or `*` for any residue. One variable remnant per peptide
is tested at a time, optionally alongside fixed modifications; combinations of
multiple variable sites within one peptide are not searched. Searches are bounded
to 400 eligible sites and 20,000 peptide candidates. Unmodified alternatives are
also retained. The table shows protein-wide modification positions for every
compatible peptide location and explicitly marks searched sites as candidates.
Unknown-site candidates require MS/MS evidence, including at least one matched
fragment that carries the variable remnant. MS-only does not generate unknown-site
candidates or their coverage. Unmodified and explicitly fixed-reference peptides
retain the normal MS-only search. Competing sites remain unresolved; the thresholds
are not a validated site-localization score or a false-discovery-rate estimate.

For **Custom elemental change**, enter the net atoms added or removed relative to
the original residue, not the complete modified amino acid. For example `C2H2O`
adds 42.01056468 Da, `H-2` removes 2.01565006 Da, and `C4H6N2O2` has the GG-remnant
mass. The calculated neutral monoisotopic shift is read-only and recalculated by
the backend. Supported elements: C, H, N, O, P, S, F, Cl, Br, I, Si and Se. Charges,
isotope labels and bracketed formulas are rejected rather than guessed.

The selected spectrum has a peptide-sequence cleavage map below it: matched b ions
are blue below the sequence, matched y ions red above, with angled marks between
residues at the supported cuts. Fragment charges +1/+2 are explicit. Unmatched
cuts have no evidence marker. Select a matched ion
to highlight its sequence span and inspect measured/theoretical m/z and ppm error.
Fixed modifications (including GGisoK) are marked on the appropriate residue;
the map uses the existing matched-ion values without inventing fragment evidence.

Named GGisoK candidates also show the expected GG-remnant carbonyl-to-lysine
epsilon-N connectivity and all compatible acceptor positions. In a ubiquitin
context this is consistent with donor G76 linked to that acceptor lysine. A GG
remnant alone does not establish donor-chain identity or intact chain topology;
shared peptides cannot distinguish chains. This remains a linear-remnant search,
not an intact cross-linked-peptide search.

**Download map PDF** exports all reference chains, sequence coverage percentages,
and blue solid MS/MS / green dashed MS-only spans as vector text and lines.
Long sequences and dense evidence continue onto further pages without dropping
residues or lines. On screen, sequence rows follow the available panel width and
coverage lanes use compact spacing; the results table wraps to one panel width.

**Download spectrum PDF** exports the selected measured spectrum, blue b / red y
peaks with measured m/z to five decimals, the sequence cleavage diagram and
modification details. The existing Deconvolution renderer supplies the font family,
8-point axis labels, 7-point ticks, line-width/grid settings and physical axis
height. An annotation-friendly wider canvas prevents label crowding. When more
than 12 ions match, the overview labels the strongest 12 and detail pages label
every matched ion. No peaks are resampled or smoothed for the PDF, no theoretical
peaks are substituted for measured values, and MS-only exports invent no b/y ions.
All PDFs are generated locally; previous Deconvolution/UV exports are unchanged.
The spectrum PDF's sequence ladder follows the on-screen diagram: monospaced
residues, red y ions above/blue b ions below, angled cut marks, subscript ion
numbers, superscript charges and separately raised modification stars. Long
peptides wrap without shrinking the diagram; graph-axis typography is unchanged.
Residue spacing is compact (36 rather than 52 screen pixels, with matching PDF
proportions); ion labels and click targets fit within the closer letter spacing.
The blue labels have additional clearance below their cut lines, including both
fragment charges. The spectrum PDF omits the candidate-identification footer
sentence; scientific evidence warnings remain in the application.
Every results-table header has a filter button beside its sorting control.
Text columns support case-insensitive matching; numeric columns have inclusive
minimum/maximum values. Filters combine with the toolbar filters, disclose the
visible match count, and can be cleared individually or together without altering
analysis results or coverage. Missing fragment evidence does not pass a numeric
fragment filter. Red coverage residues mark MS/MS modification candidates with
at least one matched modification-bearing fragment; dotted red underlines mark
unresolved alternative sites. MS-only hypotheses do not colour modification sites.
Shared peptides still cannot identify a particular chain. Map PDFs preserve these
residue colours and ambiguity marks.
Protein coverage underlines show matched peptide spans, separate overlapping
peptides into rows, and combine repeated observations: **blue solid** means
MS/MS linked to a compatible local MS1 feature; **green dashed** means an MS1
feature-supported peptide-mass candidate. **Blue dotted** retains fragment-supported
MS/MS candidates whose precursor feature is unconfirmed; these are also labelled
in the table. No crowded on-screen legend is added; hover titles explain each line.
Click an underline to open a matching spectrum. Competing sequence candidates
remain excluded, while shared peptides are shown at every compatible location.
Two coverage percentages count unique residue positions, never overlapping spans
twice: **MS** counts feature-supported precursor candidates; **MS/MS** counts
fragment-supported candidates, including unconfirmed precursor features. These
independent percentages are not additive, and MS coverage is not sequence
confirmation. Alternative
modification positions on the same peptide can contribute sequence coverage
without claiming site localization; competing peptide sequences remain excluded.

MS/MS is associated using the recorded parent survey plus compatible charge,
precursor mass and retention time. If the acquisition has no valid parent link,
a unique local mass/charge/RT association may be used, explicitly labelled as
inferred. A recorded but incompatible parent is never replaced by a time guess.
A sequence matched elsewhere in the run no longer suppresses an unrelated MS1
feature. Strong MS/MS remains visible when precursor feature evidence is missing.

The peptide selection view includes a full-width, whole-run **black MS1 TIC**
with a **blue selected-biomolecule XIC**. Both remain in measured counts on clearly
labelled separate axes (TIC left, XIC right); neither trace is normalized or
smoothed. Confirmed features use the required isotope targets of their grouped
charge envelopes, with the mapping precursor ppm tolerance. Overlapping windows
are unioned so a measured centroid is never counted twice. Unconfirmed precursors
use only their selected theoretical m/z (measured m/z fallback for older rows).
Extraction sums centroid counts inside those windows
at each positive MS1 survey, not MS/MS fragment intensities or scans over time.
The existing reference-ion exclusion applies to both traces. Other peaks in the
same m/z window are not automatically evidence for the peptide sequence.

The selected scan's acquisition time is marked separately from its shaded
**supported MS1 interval**. That interval comes from the existing feature matcher,
not the entire visible tail, and is absent when precursor support is unconfirmed.
No extra feature association or confidence upgrade is inferred from the XIC.
The black TIC always starts at the full recorded run range. The blue biomolecule
overlay is restricted to its supported interval and labels its measured apex.
Separate elution peaks of the same sequence remain separate selectable features.
Different charge envelopes group only with identical sequence/modification
signatures, overlapping support (at least half the shorter interval), apices
within two survey cadences (capped at 0.1 min), and raw trace cosine >=0.95.
All members must agree with one another; transitive overlap cannot bridge peaks.
Unconfirmed precursor spectra do not inherit another peak's evidence.
The **Elution feature** selector chooses among peaks; the observations picker
contains only that feature's measured spectra. Each
choice retains its own measured spectrum, support status, isotope assignment and
time interval; nothing is averaged, summed across scans or merged into a new
identification. Existing PDF downloads and coverage calculations are unchanged.

The results table supports sequence/location/modification text filtering,
evidence, charge and competing-assignment filters, and sortable columns including
measured and theoretical precursor m/z side by side (five decimal places, full
stored precision in their tooltips), plus the signed precursor ppm error. Both
m/z columns have independent numeric sorting and range filters. Measured m/z is
the recorded MS/MS precursor, or the exact measured survey peak for an MS-only
hypothesis. The theoretical value is the actual matching target, including
modifications, inferred charge and assigned isotope offset, not necessarily the
monoisotopic peak. Thus it agrees with the ppm calculation; MS1 elemental-envelope
centroids and MS/MS nominal isotope offsets retain their existing definitions.
Default widths reserve equal room for the two values and more space for evidence,
while keeping all columns within one panel width and wrapping long text.
Charge is inferred from mass, including +1; its
presence in the search is not a guarantee of a +1 result in every run.

### QTOF reference-ion exclusion

The shared **QTOF reference ions** panel applies one per-run policy to every
analysis and export: MS/MS peptide mapping (including precursor selection and
fragment matching), intact/batch deconvolution, summed spectra, TIC/EIC, area and
time analyses. The raw acquisition files and cached raw arrays are not modified.
Automatic mode uses only enabled references from the saved acquisition method
when its automatic recalibration is enabled. It does not infer calibrant identity
from an arbitrary nearby analyte. When metadata is unavailable, detected preset
signals are reported but not automatically excluded; select a preset or custom
reference explicitly.

Presets include positive HP-0921 **m/z 922.009798** and purine **m/z 121.050873**
([Agilent reference](https://www.agilent.com/cs/library/usermanuals/public/Q-TOF_Verification_MH10.0.pdf)).
Custom targets have an explicit polarity and charge. Detection uses raw MS1
centroids and reports matching scan counts, median observed m/z and ppm error;
configuration alone is never reported as a measured detection. A mass match is
not proof of chemical identity.

Masks use ±20 ppm by default (adjustable 1–50), with optional +1–+3 isotope windows
at 1.00335483507/charge spacing (enabled by default). They exclude any coincident
analyte in the same windows too; this is a deliberate, visible analysis setting,
not a claim to separate unresolved compounds. Entire MS/MS scans selected on a
reference precursor are excluded. Remaining centroid values/time axes are exact;
TIC subtracts excluded centroid intensity from the instrument TIC, clipped at zero.
Turning exclusion off restores the original analysis view. No second mass
calibration/correction is applied.

Preferences are saved locally in CATrupole's user-data directory, not on the NAS.
Applying a changed policy refreshes the renderer and clears prior calculation and
export caches; editable peptide sequence/modification inputs are retained. This
prevents results made under the previous mask from being exported as current ones.

## Downloads

Get installers from GitHub Releases.

`<version>` means the numeric release version (for example `0.2.2` for tag `v0.2.2`).

| Platform | File | Description |
| --- | --- | --- |
| Windows | `LCMS.Desktop.Setup.<version>.exe` | Installer (recommended) |
| Windows | `LCMS.Desktop-<version>-win.zip` | Portable (no install) |
| Windows | `LCMS.Desktop.<version>.exe` | Portable executable |
| macOS (Apple Silicon) | `LCMS.Desktop-<version>-arm64.dmg` | Disk image (recommended) |
| macOS (Apple Silicon) | `LCMS.Desktop-<version>-arm64-mac.zip` | Zip archive |

### macOS First-Run (if Gatekeeper blocks launch)

If macOS shows "app is damaged" or blocks launch after download, run:

```bash
xattr -dr com.apple.quarantine "/Applications/LCMS Desktop.app"
codesign --force --deep --sign - "/Applications/LCMS Desktop.app"
open "/Applications/LCMS Desktop.app"
```

## Run In Dev Mode

```bash
cd /Users/dspelveris/lcms-desktop
./start-dev.sh
```

In another terminal for full Electron UI:

```bash
cd /Users/dspelveris/lcms-desktop
npm start
```

## Build

```bash
npm run dist:mac
npm run dist:win
```
