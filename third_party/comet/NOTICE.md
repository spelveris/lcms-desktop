# Comet MS/MS search engine

Copyright 2012–2026 Jimmy Eng. Comet v2026.02.2, Apache-2.0, with the
third-party notices reproduced in LICENSE. Official source and binaries:
https://github.com/UWPR/Comet/releases/tag/v2026.02.2

CATrupole invokes the unchanged executable locally on temporary MGF spectra.
The Thermo RawFileReader DLLs and CometWrapper DLL are not distributed or used.
Native executables are fetched at build time and checked against pinned SHA-256
digests from the official release. CATrupole supplies search parameters and
independently computes target-decoy spectrum and peptide q-value estimates.
