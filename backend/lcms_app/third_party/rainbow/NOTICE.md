# rainbow-api attribution

The TOF calibration and split centroid interpretation in `../../qtof_reader.py`
are adapted from rainbow-api by Evan Shi and Eugene Kwan, licensed under
LGPL-3.0-or-later. Full license texts accompany this notice.

Source revision: e63c79e5842fb9882bc2fe6459ce8f773275e34f
https://github.com/evanyeyeye/rainbow/blob/e63c79e5842fb9882bc2fe6459ce8f773275e34f/rainbow/agilent/masshunter.py

CATrupole adaptation (2026-09-21): isolated QTOF `.sirslt` reader using embedded
schema metadata, per-scan calibration offsets, fractional intensities, strict
format/bounds checks, separate MS1/MS2 channels and recorded MS/MS parent links.
No changes to the existing rainbow-api dependency or legacy readers.

The adapted Python source and these licenses are shipped in the application's
`backend/_internal/lcms_app` directory. The source is loaded from that directory
and may be replaced with a compatible modified module (a modified macOS app may
need local re-signing). The build script is `scripts/build-backend.js` in the
CATrupole source repository.
