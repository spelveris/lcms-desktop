# Optional protein databases

Peptide Mapping has an organism / cell-line dropdown and **Download** button.
Nothing is downloaded until requested. Downloaded databases are available offline.
Choose **Analysis → Search downloaded database** to identify protein candidates
from acquired positive-ion QTOF digest MS/MS without providing a sequence.
This optional, local Comet search is separate from **Map supplied sequence**;
it does not load a whole organism into the single-reference mapper. See
[Database search](database-search.md) for workflow, defaults and confidence.

## Catalog

| Choices | Shared UniProt reference proteome | Scope |
| --- | --- | --- |
| Human, HEK293, HEK293T, HeLa, A549, U2OS, MCF-7, Jurkat | UP000005640 / 9606 | Human main representative sequences |
| E. coli | UP000000625 / 83333 | K-12 strain reference, not all E. coli strains |
| Yeast, Saccharomyces cerevisiae | UP000002311 / 559292 | S288c strain reference |
| CHO | UP001108280 / 10029 | Chinese hamster main representative sequences |

Human cell-line presets resolve to the same `human` database ID and do not
download duplicate copies or restrict the reference to proteins expressed in a
particular line. The species reference does not automatically include cell-line
mutations, engineered constructs, extra isoforms, or noncanonical residues.

## Persistent storage

The desktop application stores everything under Electron's existing
`app.getPath("userData")/databases`, also passed to Python as `LCMS_USER_DATA_DIR`.
Use **Open databases folder** to see the exact location on this computer.
It is outside the application bundle, installer location and updater cache.
Paths and database IDs do not contain the CATrupole version. App updates neither
replace nor automatically refresh these databases. The last chosen preset is
stored in `databases/settings.json`.

Each installed organism folder contains exactly `proteins.fasta` and
`metadata.json` (release, source URL, sequence count, sizes, checksum, download
date and attribution). Human presets all reuse `databases/human`.
For standalone Python use, the existing platform-specific CATrupole user-data
fallback is used. Normal desktop updates preserve this directory; deliberate
removal of application user data will also remove its databases.

## Download integrity and recovery

- Only hard-coded UniProt HTTPS sources and organism IDs are accepted.
- Connection timeouts, interrupted reads, and temporary server errors try three
  official sources in order: UniProt USA, EMBL-EBI UK, then ExPASy Switzerland.
  Progress names the source and attempt. Each retry starts a fresh download
  with that source's own release manifest; chunks/releases are never mixed.
  TLS certificate validation is never disabled, and certificate or checksum
  failures stop the download rather than accepting an unverified database.
- Fetch the official `RELEASE.metalink`; verify the gzip size and published MD5.
  HTTPS authenticates the source; MD5 is the publisher's transport checksum.
- Validate protein FASTA syntax, taxonomy, nonempty sequences, and reasonable
  bounds. Record SHA-256 of the unchanged decompressed FASTA.
- Show progress, support cancellation, and keep a download out of the installed
  catalog until the FASTA and metadata are atomically committed together.
- Discard the compressed download after verification. Partial files left by an
  interrupted process are removed on that organism's next explicit retry, not
  used as a database. Unrecognized files are never recursively deleted.
- Verify saved checksums on first access and after file changes. An existing
  damaged database is left untouched; the UI asks the user to move it aside
  before downloading another copy. No automatic database upgrades or removals.

Catalog and offline checks make no internet calls. Raw acquisition files and
spectra are not uploaded. The downloaded UniProt reference FASTAs are unchanged.

## Attribution and sources

UniProt Consortium, Creative Commons Attribution 4.0 International (CC BY 4.0).
The download's exact source and release are retained in its metadata.

- https://www.uniprot.org/help/license
- https://www.uniprot.org/help/downloads
- https://ftp.uniprot.org/pub/databases/uniprot/current_release/knowledgebase/reference_proteomes/
- https://www.cellosaurus.org/CVCL_0045 (HEK293)
- https://www.cellosaurus.org/CVCL_0063 (HEK293T)
- https://www.cellosaurus.org/CVCL_0030 (HeLa)
- https://www.cellosaurus.org/CVCL_0023 (A549)
- https://www.cellosaurus.org/CVCL_0042 (U2OS)
- https://www.cellosaurus.org/CVCL_0031 (MCF-7)
- https://www.cellosaurus.org/CVCL_0065 (Jurkat)
- https://www.cellosaurus.org/CVCL_0214 (CHO-K1)

## Verification

`python -m unittest discover -s backend/tests -p test_protein_databases.py -v`

`node --test frontend/tests/protein-databases.test.js`

Both release platforms also run `lcms-backend --database-self-test` against the
frozen executable. This uses synthetic sequences and checks the packaged HTTPS
CA bundle, verified installation and offline restart without external downloads.
