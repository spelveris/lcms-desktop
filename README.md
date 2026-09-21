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
Existing summed-spectrum analysis retains its existing 0.01 Da binning; this
update does not change deconvolution algorithms or infer peptide identities.
Profile-only QTOF runs and other QTOF container layouts are not covered by this
reader. The third-party source attribution is included with the backend.

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
