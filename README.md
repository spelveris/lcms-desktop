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
Set fixed, site-specific mass shifts explicitly; imported unresolved modifications
exclude affected peptides. For a confirmed diglycyl lysine remnant, use
the **GGisoK (ε-Gly-Gly lysine)** preset, choosing chain B and position 48 for
that example. The preset adds 114.042927 Da relative to lysine and blocks
trypsin cleavage at the site. Do not substitute a linear GG
sequence for an epsilon-linked modification. Cross-linked peptides are not searched.

The initial mapping implementation is **exploratory**: tryptic peptides of 5–70
residues, 0–3 missed cleavages, precursor charges 1–6 (inferred), isotope offsets
0–2, and b/y fragments of charges 1–2. Default tolerances are 10 ppm precursor
and 50 ppm fragments. It requires four distinct matched ions, three cleavage
bonds and 10% of filtered fragment intensity (top 200 peaks above 1%). These
are review thresholds, not a validated identification score or FDR estimate.
Ambiguous sequence candidates are excluded from coverage; repeated/shared
peptides map to all compatible locations and do not establish chain identity.
I/L are indistinguishable, and variable modifications/neutral losses are not
searched. Click a candidate to inspect its measured, annotated fragment spectrum.

The selected spectrum has a peptide-sequence cleavage map below it: matched b ions
are blue below the sequence, matched y ions red above, with angled marks between
residues at the supported cuts. Fragment charges +1/+2 are explicit. Unmatched
cuts have no evidence marker. Select a matched ion
to highlight its sequence span and inspect measured/theoretical m/z and ppm error.
Fixed modifications (including GGisoK) are marked on the appropriate residue;
the map uses the existing matched-ion values without inventing fragment evidence.
Protein coverage underlines show matched peptide spans, separate overlapping
peptides into rows, and combine repeated observations: **blue solid** means
MS/MS-supported; **green dashed** means tentative MS-only mass compatibility.
Click an underline to open a matching spectrum. Competing sequence candidates
remain excluded, while shared peptides are shown at every compatible location.
The coverage percentage counts only noncompeting MS/MS candidates, never MS-only
mass hypotheses.

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
