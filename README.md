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
QTOF summed spectra use a fixed 0.001 m/z grid (v0.2.55), including the intact
deconvolution m/z panel. This is a rebinned centroid sum, not measured profile
data or additional instrument resolution. Original individual scan values are
unchanged. Other readers retain their existing summation behavior. The full
regular grid is used for calculations; only redundant interior zero points are
removed for display, keeping every occupied bin and the same line shape.
When smoothing is applied, QTOF peak intensities are expressed on the previous
0.01 m/z reference-bin scale, so a ten-times-finer grid does not silently lower
the existing noise threshold by tenfold. Raw summed counts are not rescaled.
This update does not infer peptide identities from intact spectra.
Profile-only QTOF runs and other QTOF container layouts are not covered by this
reader. The third-party source attribution is included with the backend.

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

The initial mapping implementation is **exploratory**: tryptic peptides of 5–70
residues, 0–3 missed cleavages, precursor charges 1–6 (inferred), isotope offsets
0–2, and b/y fragments of charges 1–2. Default tolerances are 10 ppm precursor
and 20 ppm fragments (both remain adjustable). It requires four distinct matched ions, three cleavage
bonds and 10% of filtered fragment intensity (top 200 peaks above 1%). These
are review thresholds, not a validated identification score or FDR estimate.
Ambiguous sequence candidates are excluded from coverage; repeated/shared
peptides map to all compatible locations and do not establish chain identity.
I/L are indistinguishable; neutral losses are not searched. Click a candidate to
inspect its measured, annotated fragment spectrum.

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
Protein coverage underlines show matched peptide spans, separate overlapping
peptides into rows, and combine repeated observations: **blue solid** means
MS/MS-supported; **green dashed** means tentative MS-only mass compatibility.
Click an underline to open a matching spectrum. Competing sequence candidates
remain excluded, while shared peptides are shown at every compatible location.
Two coverage percentages count unique residue positions, never overlapping spans
twice: **MS** combines MS-only precursor-mass hypotheses and MS/MS-supported
candidates; **MS/MS** is the fragment-supported subset. Thus MS coverage is not
sequence confirmation, and the two percentages must not be added. Alternative
modification positions on the same peptide can contribute sequence coverage
without claiming site localization; competing peptide sequences remain excluded.

The MS-only search compares the top 500 positive survey peaks above 1% relative
intensity per scan to reference peptide masses, with charges +1 to +6 and isotope
offsets 0–2. It is not isotope-envelope validation or sequence confirmation.
Repeated observations across the run are aggregated per peptide/charge/isotope
hypothesis; the strongest measured observation and retention-time span are shown.
Any peptide with MS/MS support in the run is omitted from MS-only results.
This aggregation does not identify separate chromatographic features.

The results table supports sequence/location/modification text filtering,
evidence, charge and competing-assignment filters, and sortable columns including
precursor m/z (five decimal places) and the separate signed precursor ppm error.
Precursor m/z is the recorded MS/MS precursor, or the exact measured survey peak
for an MS-only hypothesis. Charge is inferred from mass, including +1; its
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
