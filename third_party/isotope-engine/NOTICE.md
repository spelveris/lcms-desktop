# Isotope-aware intact analysis dependencies

CATrupole uses ms_deisotope 0.0.60 by Joshua Klein and contributors,
https://github.com/mobiusklein/ms_deisotope (Apache License 2.0), for
averagine-based isotope-envelope fitting. The upstream software is unmodified.
CATrupole's metadata routing, evidence filters, scan grouping and displays are
implemented separately in `backend/lcms_app/qtof_deconvolution.py`.

The engine also uses ms_peak_picker (Apache 2.0), brain-isotopic-distribution
(Apache 2.0), pyteomics, psims, dill, python-idzip, pyzstd and SQLAlchemy.
Available upstream license texts are included alongside this notice and package
metadata is bundled with the backend. These acknowledgements do not alter the
repository's commit authorship.

Algorithm reference: Senko et al., "Determination of monoisotopic masses and ion
populations for large biomolecules from resolved isotopic distributions", 1995.
The peptide averagine approximation is not an exact known-composition fit and
does not establish protein identity or uniquely resolve every isotope assignment.
