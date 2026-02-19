"""FastAPI backend for LC-MS Desktop App.

Wraps the existing analysis/data_reader code and exposes it as REST endpoints.
The Electron frontend communicates with this server via HTTP.
"""

import os
import sys
import io
import datetime
import json
import shutil
import subprocess
from pathlib import Path
from typing import Optional

# Patch out Streamlit before any lcms-webapp imports
from data_reader_patch import patch_streamlit
patch_streamlit()

import uvicorn
from fastapi import FastAPI, HTTPException, Query, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

import numpy as np
import matplotlib
matplotlib.use("Agg", force=True)
import matplotlib.pyplot as plt

# Prefer local desktop copies of core LC-MS modules.
BACKEND_DIR = os.path.dirname(__file__)
LOCAL_LCMS_APP_DIR = os.environ.get(
    "LCMS_LOCAL_APP_DIR",
    os.path.join(BACKEND_DIR, "lcms_app"),
)
if os.path.isdir(LOCAL_LCMS_APP_DIR):
    sys.path.insert(0, os.path.abspath(LOCAL_LCMS_APP_DIR))

# Optional external fallback via LCMS_APP_DIR (for advanced overrides).
LCMS_APP_DIR = os.environ.get("LCMS_APP_DIR")
if LCMS_APP_DIR and os.path.isdir(LCMS_APP_DIR):
    abs_external = os.path.abspath(LCMS_APP_DIR)
    if abs_external not in sys.path:
        sys.path.append(abs_external)

# Import existing modules
from data_reader import SampleData, list_d_folders
import analysis
import config as lcms_config
import plotting

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(title="LC-MS Desktop API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory cache of loaded samples  {folder_path: SampleData}
_sample_cache: dict[str, SampleData] = {}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ndarray_to_list(arr):
    """Safely convert numpy array to Python list for JSON serialization."""
    if arr is None:
        return None
    if isinstance(arr, np.ndarray):
        return arr.tolist()
    return arr


def _get_sample(folder_path: str) -> SampleData:
    """Load sample with caching."""
    if folder_path not in _sample_cache:
        sample = SampleData(folder_path)
        ok = sample.load()
        if not ok:
            raise HTTPException(status_code=400, detail=sample.error or "Failed to load sample")
        _sample_cache[folder_path] = sample
    return _sample_cache[folder_path]


def _coerce_float(value, default: float) -> float:
    try:
        return float(value)
    except Exception:
        return float(default)


def _coerce_int(value, default: int) -> int:
    try:
        return int(value)
    except Exception:
        return int(default)


def _coerce_bool(value, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        v = value.strip().lower()
        if v in {"1", "true", "yes", "on"}:
            return True
        if v in {"0", "false", "no", "off"}:
            return False
    return default


def _sanitize_filename(name: str, fallback: str = "sample") -> str:
    safe = "".join(ch if ch.isalnum() or ch in ("_", "-", ".") else "_" for ch in str(name)).strip("_")
    return safe or fallback


def _resolve_node_command() -> Optional[str]:
    preferred = os.environ.get("LCMS_NODE")
    candidates = []
    if preferred:
        candidates.append(preferred)
    candidates.extend(["node", "nodejs"])

    for candidate in candidates:
        if not candidate:
            continue
        candidate_path = candidate if os.path.isabs(candidate) else shutil.which(candidate)
        if not candidate_path:
            continue
        try:
            _kw = {}
            if sys.platform == "win32":
                _kw["creationflags"] = subprocess.CREATE_NO_WINDOW
            check = subprocess.run(
                [candidate_path, "--version"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=5,
                **_kw,
            )
            if check.returncode == 0:
                return candidate_path
        except Exception:
            continue
    return None


def _compute_smiles_properties(smiles: str) -> dict:
    node_cmd = _resolve_node_command()
    if not node_cmd:
        raise HTTPException(status_code=500, detail="Node.js runtime not available for SMILES calculation")

    smiles = str(smiles or "").strip()
    if not smiles:
        raise HTTPException(status_code=400, detail="smiles is required")

    env = dict(os.environ)
    node_modules_dir = env.get("LCMS_NODE_MODULES", "").strip()
    if node_modules_dir and os.path.isdir(node_modules_dir):
        existing_node_path = env.get("NODE_PATH", "")
        env["NODE_PATH"] = f"{node_modules_dir}{os.pathsep}{existing_node_path}" if existing_node_path else node_modules_dir

    if env.get("LCMS_NODE") and os.path.abspath(node_cmd) == os.path.abspath(env["LCMS_NODE"]):
        env["ELECTRON_RUN_AS_NODE"] = "1"

    if node_modules_dir and os.path.isdir(node_modules_dir):
        run_cwd = os.path.dirname(node_modules_dir)
    else:
        project_root = os.path.abspath(os.path.join(BACKEND_DIR, ".."))
        run_cwd = project_root if os.path.isdir(os.path.join(project_root, "node_modules")) else BACKEND_DIR

    node_script = r"""
const chunks = [];
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', async () => {
  try {
    const payload = JSON.parse(chunks.join('') || '{}');
    const smiles = String(payload.smiles || '').trim();
    if (!smiles) throw new Error('smiles is required');

    const mod = await import('openchemlib');
    const OCL = mod.default || mod;
    let mol;
    try {
      mol = OCL.Molecule.fromSmiles(smiles);
    } catch (e) {
      throw new Error('Invalid SMILES syntax');
    }
    if (!mol) throw new Error('Could not parse SMILES');

    const mf = mol.getMolecularFormula();
    const exactMass = Number(mf.absoluteWeight);
    if (!Number.isFinite(exactMass) || exactMass <= 0) {
      throw new Error('Unable to calculate molecular mass');
    }

    let netCharge = 0;
    const atomCount = Number(mol.getAllAtoms?.()) || 0;
    for (let i = 0; i < atomCount; i++) {
      netCharge += Number(mol.getAtomCharge?.(i)) || 0;
    }

    process.stdout.write(JSON.stringify({
      formula: String(mf.formula || ''),
      exact_mass: exactMass,
      net_charge: netCharge
    }));
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    process.stderr.write(msg);
    process.exit(1);
  }
});
"""

    try:
        # On Windows, hide the subprocess console window to avoid a white flash
        kwargs = {}
        if sys.platform == "win32":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        result = subprocess.run(
            [node_cmd, "-e", node_script],
            input=json.dumps({"smiles": smiles}),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=run_cwd,
            env=env,
            timeout=20,
            **kwargs,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="SMILES calculation timed out")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"SMILES calculation failed: {exc}")

    if result.returncode != 0:
        err = (result.stderr or "").strip() or (result.stdout or "").strip() or "Unknown SMILES calculation error"
        raise HTTPException(status_code=400, detail=err)

    try:
        parsed = json.loads(result.stdout or "{}")
    except Exception:
        raise HTTPException(status_code=500, detail="Invalid SMILES calculator response")

    formula = str(parsed.get("formula", ""))
    exact_mass = float(parsed.get("exact_mass", 0.0))
    net_charge = int(parsed.get("net_charge", 0))
    if not np.isfinite(exact_mass) or exact_mass <= 0:
        raise HTTPException(status_code=400, detail="Unable to calculate molecular mass from this SMILES")

    return {
        "formula": formula,
        "exact_mass": exact_mass,
        "net_charge": net_charge,
    }


def _detect_deconvolution_window_for_sample(sample: SampleData) -> tuple[float, float]:
    """Auto-detect default deconvolution time window (webapp parity)."""
    if sample.ms_times is None or len(sample.ms_times) == 0:
        return 0.0, 0.0

    min_time = float(sample.ms_times[0])
    max_time = float(sample.ms_times[-1])

    if sample.tic is None:
        return min_time, min(min_time + 1.0, max_time)

    tic_smoothed = analysis.smooth_data(sample.tic, 5)
    peaks = analysis.find_peaks(sample.ms_times, tic_smoothed, height_threshold=0.3, prominence=0.1)
    if not peaks:
        return min_time, min(min_time + 1.0, max_time)

    is_c4 = getattr(sample, "is_c4_method", False)
    if is_c4:
        protein_peaks = [p for p in peaks if p["time"] >= 1.8]
        if protein_peaks:
            peaks = protein_peaks

    dominant = max(peaks, key=lambda p: p["intensity"])
    threshold = float(dominant["intensity"]) * 0.48

    left_idx = int(dominant["index"])
    while left_idx > 0 and tic_smoothed[left_idx] > threshold:
        left_idx -= 1

    right_idx = int(dominant["index"])
    while right_idx < len(tic_smoothed) - 1 and tic_smoothed[right_idx] > threshold:
        right_idx += 1

    auto_start = float(sample.ms_times[left_idx])
    auto_end = float(sample.ms_times[right_idx])

    max_window_width = 0.30
    if auto_end > auto_start and (auto_end - auto_start) > max_window_width:
        peak_time = float(sample.ms_times[int(dominant["index"])])
        half_width = max_window_width / 2.0
        auto_start = max(min_time, peak_time - half_width)
        auto_end = min(max_time, peak_time + half_width)

    return auto_start, auto_end


def _run_default_report_deconvolution(mz_arr: np.ndarray, intensity_arr: np.ndarray) -> list[dict]:
    """Run default deconvolution matching the Deconvolution tab defaults exactly."""
    if mz_arr is None or intensity_arr is None or len(mz_arr) == 0:
        return []

    noise_cutoff = 1000.0
    low_mw = 500.0
    high_mw = 50000.0
    pwhh = 0.6

    # Multi-charge deconvolution (min_charge=2 internally, same as tab endpoint)
    components = analysis.deconvolute_protein_local_lcms_machine_like(
        mz_arr,
        intensity_arr,
        min_charge=2,
        max_charge=50,
        min_peaks=3,
        noise_cutoff=noise_cutoff,
        abundance_cutoff=0.05,
        mw_agreement=0.0002,
        mw_assign_cutoff=0.40,
        envelope_cutoff=0.50,
        max_overlap=0.0,
        pwhh=pwhh,
        low_mw=low_mw,
        high_mw=high_mw,
        contig_min=3,
        use_mz_agreement=False,
        use_monoisotopic_proton=False,
    )

    # Singly-charged detection (matches tab default: include_singly_charged=True, min_charge=1)
    exclude_ranges = []
    for comp in components:
        mzs = comp.get("ion_mzs", [])
        if mzs:
            exclude_ranges.append((min(mzs) - 2.0, max(mzs) + 2.0))

    singly = analysis.detect_singly_charged(
        mz_arr,
        intensity_arr,
        noise_cutoff=noise_cutoff,
        low_mw=low_mw,
        high_mw=min(high_mw, 2000.0),
        pwhh=pwhh,
        exclude_mz_ranges=exclude_ranges,
        use_monoisotopic_proton=False,
    )
    components.extend(singly)

    # Serialize to match the /api/deconvolute response format
    results = []
    for comp in components:
        results.append({
            "mass": float(comp.get("mass", 0)),
            "mass_std": float(comp.get("mass_std", 0)),
            "intensity": float(comp.get("intensity", 0)),
            "num_charges": int(comp.get("num_charges", 0)),
            "charge_states": comp.get("charge_states", []),
            "peaks_found": int(comp.get("peaks_found", 0)),
            "r2": float(comp.get("r2", 0)),
            "ion_mzs": comp.get("ion_mzs", []),
            "ion_charges": comp.get("ion_charges", []),
            "ion_intensities": comp.get("ion_intensities", []),
        })

    # Filter and sort by abundance
    filtered = [r for r in results if low_mw <= r["mass"] <= high_mw]
    filtered.sort(key=lambda c: c["intensity"], reverse=True)
    return filtered


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/api/health")
def health():
    return {"status": "ok", "version": lcms_config.APP_VERSION}


@app.get("/api/config")
def get_config():
    """Return app defaults so the frontend knows initial settings."""
    return {
        "version": lcms_config.APP_VERSION,
        "default_path": lcms_config.BASE_PATH,
        "uv_wavelength": lcms_config.UV_WAVELENGTH,
        "uv_smoothing": lcms_config.UV_SMOOTHING_WINDOW,
        "eic_smoothing": lcms_config.EIC_SMOOTHING_WINDOW,
        "mz_window": lcms_config.DEFAULT_MZ_WINDOW,
        "export_dpi": lcms_config.EXPORT_DPI,
    }


@app.get("/api/browse")
def browse_folder(path: str = Query(..., description="Directory to list")):
    """List contents of a directory (folders and .D folders)."""
    p = Path(path)
    if not p.exists():
        raise HTTPException(status_code=404, detail="Path not found")
    if not p.is_dir():
        raise HTTPException(status_code=400, detail="Not a directory")

    items = []
    try:
        for entry in sorted(p.iterdir()):
            if entry.name.startswith("."):
                continue
            is_d = entry.is_dir() and (entry.name.endswith(".D") or entry.name.endswith(".d"))
            items.append({
                "name": entry.name,
                "path": str(entry),
                "is_dir": entry.is_dir(),
                "is_d_folder": is_d,
            })
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied")

    return {"path": str(p), "items": items}


@app.get("/api/find-d-folders")
def find_d_folders(
    path: str = Query(...),
    search: str = Query("", description="Optional name filter"),
):
    """Recursively find .D folders under a path."""
    folders = list_d_folders(path, search)
    for f in folders:
        f["date"] = f["date"].isoformat()
    return {"folders": folders}


@app.get("/api/load-sample")
def load_sample(path: str = Query(..., description="Path to .D folder")):
    """Load a sample and return its metadata."""
    sample = _get_sample(path)
    return {
        "name": sample.name,
        "folder_path": sample.folder_path,
        "is_c4_method": sample.is_c4_method,
        "acq_method": sample.acq_method,
        "acq_info": sample.acq_info,
        "has_uv": sample.uv_data is not None,
        "has_ms": sample.ms_scans is not None,
        "uv_wavelengths": _ndarray_to_list(sample.uv_wavelengths),
        "ms_time_range": [float(sample.ms_times[0]), float(sample.ms_times[-1])] if sample.ms_times is not None else None,
        "uv_time_range": [float(sample.uv_times[0]), float(sample.uv_times[-1])] if sample.uv_times is not None else None,
    }


@app.get("/api/uv-chromatogram")
def uv_chromatogram(
    path: str = Query(...),
    wavelength: float = Query(280.0),
    smooth: int = Query(0, description="Smoothing window (0=off)"),
):
    """Return UV chromatogram data at a specific wavelength."""
    sample = _get_sample(path)
    uv = sample.get_uv_at_wavelength(wavelength)
    if uv is None:
        raise HTTPException(status_code=404, detail=f"No UV data at {wavelength} nm")

    times = _ndarray_to_list(sample.uv_times)
    intensities = _ndarray_to_list(analysis.smooth_data(uv, smooth) if smooth > 2 else uv)
    return {"times": times, "intensities": intensities, "wavelength": wavelength}


@app.get("/api/tic")
def tic(path: str = Query(...)):
    """Return total ion chromatogram."""
    sample = _get_sample(path)
    if sample.tic is None:
        raise HTTPException(status_code=404, detail="No MS data")
    return {
        "times": _ndarray_to_list(sample.ms_times),
        "intensities": _ndarray_to_list(sample.tic),
    }


@app.get("/api/eic")
def eic(
    path: str = Query(...),
    mz: float = Query(..., description="Target m/z"),
    window: float = Query(0.5),
    smooth: int = Query(0),
):
    """Return extracted ion chromatogram."""
    sample = _get_sample(path)
    eic_data = analysis.extract_eic(sample, mz, window)
    if eic_data is None:
        raise HTTPException(status_code=404, detail="No MS data for EIC")

    if smooth > 2:
        eic_data = analysis.smooth_data(eic_data, smooth)

    return {
        "times": _ndarray_to_list(sample.ms_times),
        "intensities": _ndarray_to_list(eic_data),
        "target_mz": mz,
        "window": window,
    }


@app.get("/api/ms-spectrum")
def ms_spectrum(
    path: str = Query(...),
    time: float = Query(..., description="Retention time (min)"),
):
    """Return mass spectrum at a specific retention time."""
    sample = _get_sample(path)
    result = sample.get_ms_scan(time)
    if result is None:
        raise HTTPException(status_code=404, detail="No MS scan at this time")
    mz_arr, intensity_arr = result
    return {
        "mz": _ndarray_to_list(mz_arr),
        "intensities": _ndarray_to_list(intensity_arr),
        "time": time,
    }


@app.get("/api/summed-spectrum")
def summed_spectrum(
    path: str = Query(...),
    start: float = Query(...),
    end: float = Query(...),
):
    """Return summed mass spectrum over a time range."""
    sample = _get_sample(path)
    if sample.ms_scans is None:
        raise HTTPException(status_code=404, detail="No MS data")

    mz_arr, intensity_arr = analysis.sum_spectra_in_range(sample, start, end)
    if mz_arr is None or len(mz_arr) == 0:
        raise HTTPException(status_code=404, detail="Could not sum spectra")

    return {
        "mz": _ndarray_to_list(mz_arr),
        "intensities": _ndarray_to_list(intensity_arr),
        "time_range": [start, end],
    }


@app.get("/api/peaks")
def find_chromatogram_peaks(
    path: str = Query(...),
    data_type: str = Query("tic", description="tic, uv, or eic"),
    wavelength: float = Query(280.0),
    mz: float = Query(0.0),
    mz_window: float = Query(0.5),
    smooth: int = Query(0),
    height_threshold: float = Query(0.1),
    prominence: float = Query(0.05),
):
    """Find peaks in a chromatogram (TIC, UV, or EIC)."""
    sample = _get_sample(path)

    if data_type == "tic":
        if sample.tic is None or sample.ms_times is None:
            raise HTTPException(status_code=404, detail="No TIC data")
        times = sample.ms_times
        intensities = sample.tic
    elif data_type == "uv":
        uv = sample.get_uv_at_wavelength(wavelength)
        if uv is None or sample.uv_times is None:
            raise HTTPException(status_code=404, detail=f"No UV data at {wavelength} nm")
        times = sample.uv_times
        intensities = uv
    elif data_type == "eic":
        eic_data = analysis.extract_eic(sample, mz, mz_window)
        if eic_data is None or sample.ms_times is None:
            raise HTTPException(status_code=404, detail="No EIC data")
        times = sample.ms_times
        intensities = eic_data
    else:
        raise HTTPException(status_code=400, detail=f"Unknown data_type: {data_type}")

    if smooth > 2:
        intensities = analysis.smooth_data(intensities, smooth)

    peaks = analysis.find_peaks(times, intensities, height_threshold, prominence)

    # Convert numpy types
    for p in peaks:
        for k, v in p.items():
            if isinstance(v, (np.floating, np.integer)):
                p[k] = float(v)

    return {"peaks": peaks}


@app.get("/api/peak-area")
def peak_area(
    path: str = Query(...),
    data_type: str = Query("eic"),
    mz: float = Query(0.0),
    mz_window: float = Query(0.5),
    wavelength: float = Query(280.0),
    smooth: int = Query(0),
    start: float = Query(...),
    end: float = Query(...),
):
    """Calculate peak area for a given time window."""
    sample = _get_sample(path)

    if data_type == "tic":
        times, intensities = sample.ms_times, sample.tic
    elif data_type == "uv":
        times = sample.uv_times
        intensities = sample.get_uv_at_wavelength(wavelength)
    elif data_type == "eic":
        times = sample.ms_times
        intensities = analysis.extract_eic(sample, mz, mz_window)
    else:
        raise HTTPException(status_code=400, detail=f"Unknown data_type: {data_type}")

    if times is None or intensities is None:
        raise HTTPException(status_code=404, detail="No data")

    if smooth > 2:
        intensities = analysis.smooth_data(intensities, smooth)

    area = analysis.calculate_peak_area(times, intensities, start, end)
    return {"area": float(area), "start": start, "end": end}


@app.get("/api/detect-deconv-window")
def detect_deconv_window(path: str = Query(...)):
    """Auto-detect the optimal deconvolution time window."""
    sample = _get_sample(path)
    auto_start, auto_end = _detect_deconvolution_window_for_sample(sample)
    if auto_end <= auto_start:
        raise HTTPException(status_code=404, detail="No MS time data")
    return {"start": auto_start, "end": auto_end}


@app.post("/api/smiles-mz")
def smiles_mz(payload: dict = Body(...)):
    """Calculate exact mass/formula/charge from SMILES using OpenChemLib in Node."""
    smiles = str((payload or {}).get("smiles", "")).strip()
    return _compute_smiles_properties(smiles)


@app.post("/api/deconvolute")
def deconvolute(
    path: str = Query(...),
    start: float = Query(...),
    end: float = Query(...),
    min_charge: int = Query(1),
    max_charge: int = Query(50),
    mw_agreement: float = Query(0.0002),
    contig_min: int = Query(3),
    abundance_cutoff: float = Query(0.05),
    envelope_cutoff: float = Query(0.50),
    max_overlap: float = Query(0.0),
    pwhh: float = Query(0.6),
    noise_cutoff: float = Query(1000.0),
    low_mw: float = Query(500.0),
    high_mw: float = Query(50000.0),
    mw_assign_cutoff: float = Query(0.40),
    use_mz_agreement: bool = Query(False),
    use_monoisotopic: bool = Query(False),
    include_singly_charged: bool = Query(True),
):
    """Run deconvolution on summed spectrum and return detected components."""
    sample = _get_sample(path)
    if sample.ms_scans is None:
        raise HTTPException(status_code=404, detail="No MS data")

    mz_arr, intensity_arr = analysis.sum_spectra_in_range(sample, start, end)
    if mz_arr is None or len(mz_arr) == 0:
        raise HTTPException(status_code=404, detail="Could not sum spectra")

    # Run multi-charge deconvolution
    components = analysis.deconvolute_protein_local_lcms_machine_like(
        mz_arr,
        intensity_arr,
        min_charge=max(min_charge, 2),  # Multi-charge needs z>=2
        max_charge=max_charge,
        mw_agreement=mw_agreement,
        contig_min=contig_min,
        abundance_cutoff=abundance_cutoff,
        envelope_cutoff=envelope_cutoff,
        max_overlap=max_overlap,
        pwhh=pwhh,
        noise_cutoff=noise_cutoff,
        low_mw=low_mw,
        high_mw=high_mw,
        mw_assign_cutoff=mw_assign_cutoff,
        use_mz_agreement=use_mz_agreement,
        use_monoisotopic_proton=use_monoisotopic,
    )

    # Optionally detect singly charged species
    if include_singly_charged and min_charge <= 1:
        # Exclude m/z ranges already claimed by multi-charge envelopes
        exclude_ranges = []
        for comp in components:
            mzs = comp.get("ion_mzs", [])
            if mzs:
                exclude_ranges.append((min(mzs) - 2.0, max(mzs) + 2.0))

        singly = analysis.detect_singly_charged(
            mz_arr,
            intensity_arr,
            noise_cutoff=noise_cutoff,
            low_mw=low_mw,
            high_mw=min(high_mw, 2000.0),
            pwhh=pwhh,
            exclude_mz_ranges=exclude_ranges,
            use_monoisotopic_proton=use_monoisotopic,
        )
        components.extend(singly)

    # Serialize components
    results = []
    for comp in components:
        results.append({
            "mass": float(comp.get("mass", 0)),
            "mass_std": float(comp.get("mass_std", 0)),
            "intensity": float(comp.get("intensity", 0)),
            "num_charges": int(comp.get("num_charges", 0)),
            "charge_states": comp.get("charge_states", []),
            "peaks_found": int(comp.get("peaks_found", 0)),
            "r2": float(comp.get("r2", 0)),
            "ion_mzs": comp.get("ion_mzs", []),
            "ion_charges": comp.get("ion_charges", []),
            "ion_intensities": comp.get("ion_intensities", []),
        })

    return {
        "components": results,
        "spectrum": {
            "mz": _ndarray_to_list(mz_arr),
            "intensities": _ndarray_to_list(intensity_arr),
        },
        "time_range": [start, end],
    }


@app.get("/api/theoretical-mz")
def theoretical_mz(
    mass: float = Query(..., description="Neutral mass in Da"),
    min_charge: int = Query(1),
    max_charge: int = Query(50),
    use_monoisotopic: bool = Query(False),
):
    """Calculate theoretical m/z values for given mass and charge range."""
    charge_states = list(range(min_charge, max_charge + 1))
    results = analysis.get_theoretical_mz(mass, charge_states, use_monoisotopic)
    return {"mass": mass, "ions": results}


@app.get("/api/volumes")
def list_volumes():
    """List mounted volumes / drives for quick navigation."""
    import platform
    volumes = []

    system = platform.system()
    if system == "Darwin":
        # macOS: list /Volumes
        vol_path = Path("/Volumes")
        if vol_path.exists():
            for entry in sorted(vol_path.iterdir()):
                if entry.name.startswith("."):
                    continue
                volumes.append({"name": entry.name, "path": str(entry)})
    elif system == "Windows":
        # Windows: list drive letters
        for letter in "CDEFGHIJKLMNOPQRSTUVWXYZ":
            drive = f"{letter}:\\"
            if os.path.exists(drive):
                volumes.append({"name": f"{letter}:", "path": drive})
    else:
        # Linux: list /mnt and /media
        for base in ["/mnt", "/media"]:
            bp = Path(base)
            if bp.exists():
                for entry in sorted(bp.iterdir()):
                    if entry.name.startswith("."):
                        continue
                    volumes.append({"name": entry.name, "path": str(entry)})
        # Also add home
        home = Path.home()
        volumes.append({"name": f"Home ({home.name})", "path": str(home)})

    return {"volumes": volumes, "platform": system.lower()}


@app.delete("/api/cache")
def clear_cache():
    """Clear the sample cache."""
    _sample_cache.clear()
    return {"status": "cleared"}


@app.post("/api/export-deconvoluted-masses")
def export_deconvoluted_masses(payload: dict = Body(...)):
    """Export deconvoluted masses figure using webapp's Matplotlib plotting rules."""
    sample_name = str(payload.get("sample_name", "sample"))
    components = payload.get("components", [])
    if not isinstance(components, list):
        raise HTTPException(status_code=400, detail="components must be a list")

    export_format = str(payload.get("format", "png")).lower()
    if export_format not in {"png", "svg", "pdf"}:
        raise HTTPException(status_code=400, detail="format must be one of: png, svg, pdf")

    try:
        dpi = int(payload.get("dpi", lcms_config.EXPORT_DPI))
    except Exception:
        dpi = lcms_config.EXPORT_DPI
    dpi = max(72, min(600, dpi))

    style = payload.get("style", {})
    if not isinstance(style, dict):
        style = {}

    fig = plotting.create_deconvoluted_masses_figure(sample_name, components, style)
    try:
        if export_format == "svg":
            content = plotting.export_figure_svg(fig)
            media_type = "image/svg+xml"
        elif export_format == "pdf":
            content = plotting.export_figure_pdf(fig, dpi=dpi)
            media_type = "application/pdf"
        else:
            content = plotting.export_figure(fig, dpi=dpi, format="png")
            media_type = "image/png"
    finally:
        plt.close(fig)

    base_name = sample_name[:-2] if sample_name.lower().endswith(".d") else sample_name
    safe_name = "".join(ch if ch.isalnum() or ch in ("_", "-", ".") else "_" for ch in base_name).strip("_")
    safe_name = safe_name or "sample"
    filename = f"{safe_name}_batch_deconvoluted_masses.{export_format}"

    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/export-ion-selection")
def export_ion_selection(payload: dict = Body(...)):
    """Export webapp-style ion selection figure for deconvolution results."""
    sample_path = payload.get("path")
    if not sample_path:
        raise HTTPException(status_code=400, detail="path is required")

    sample = _get_sample(str(sample_path))
    if sample.ms_scans is None or sample.ms_times is None:
        raise HTTPException(status_code=404, detail="No MS data")

    start = _coerce_float(payload.get("start"), np.nan)
    end = _coerce_float(payload.get("end"), np.nan)
    if not np.isfinite(start) or not np.isfinite(end) or end <= start:
        auto_start, auto_end = _detect_deconvolution_window_for_sample(sample)
        start, end = auto_start, auto_end
    if end <= start:
        raise HTTPException(status_code=400, detail="Invalid start/end time range")

    components = payload.get("components", [])
    if not isinstance(components, list) or len(components) == 0:
        raise HTTPException(status_code=400, detail="components must be a non-empty list")

    export_format = str(payload.get("format", "png")).lower()
    if export_format not in {"png", "svg", "pdf"}:
        raise HTTPException(status_code=400, detail="format must be one of: png, svg, pdf")

    dpi = max(72, min(600, _coerce_int(payload.get("dpi"), lcms_config.EXPORT_DPI)))
    style = payload.get("style", {})
    if not isinstance(style, dict):
        style = {}

    mz_arr, intensity_arr = analysis.sum_spectra_in_range(sample, start, end)
    if mz_arr is None or len(mz_arr) == 0:
        raise HTTPException(status_code=404, detail="Could not sum spectra for selected range")

    fig = plotting.create_ion_selection_figure(mz_arr, intensity_arr, components, style)
    try:
        if export_format == "svg":
            content = plotting.export_figure_svg(fig)
            media_type = "image/svg+xml"
        elif export_format == "pdf":
            content = plotting.export_figure_pdf(fig, dpi=dpi)
            media_type = "application/pdf"
        else:
            content = plotting.export_figure(fig, dpi=dpi, format="png")
            media_type = "image/png"
    finally:
        plt.close(fig)

    base_name = sample.name[:-2] if sample.name.lower().endswith(".d") else sample.name
    safe_name = _sanitize_filename(base_name, fallback="sample")
    filename = f"{safe_name}_ion_selection.{export_format}"

    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/export-report-pdf")
def export_report_pdf(payload: dict = Body(...)):
    """Generate a multi-page report PDF using webapp plotting/export rules."""
    sample_path = payload.get("path")
    if not sample_path:
        raise HTTPException(status_code=400, detail="path is required")

    sample = _get_sample(str(sample_path))
    settings = payload.get("settings", {})
    if not isinstance(settings, dict):
        settings = {}

    include_uv = _coerce_bool(payload.get("include_uv"), sample.uv_data is not None)
    include_deconv = _coerce_bool(payload.get("include_deconv"), True)

    line_width = _coerce_float(settings.get("line_width"), 0.8)
    show_grid = _coerce_bool(settings.get("show_grid"), False)
    deconv_x_min_da = _coerce_float(settings.get("deconv_x_min_da"), 1000.0)
    deconv_x_max_da = _coerce_float(settings.get("deconv_x_max_da"), 50000.0)
    uv_smoothing = _coerce_int(settings.get("uv_smoothing"), lcms_config.UV_SMOOTHING_WINDOW)
    eic_smoothing = _coerce_int(settings.get("eic_smoothing"), lcms_config.EIC_SMOOTHING_WINDOW)

    colors = settings.get("colors", {})
    if not isinstance(colors, dict):
        colors = {}
    labels = settings.get("labels", {})
    if not isinstance(labels, dict):
        labels = {}

    uv_wavelengths = []
    uv_wavelengths_raw = settings.get("uv_wavelengths", [])
    if isinstance(uv_wavelengths_raw, list):
        for wl in uv_wavelengths_raw:
            try:
                uv_wavelengths.append(float(wl))
            except Exception:
                continue

    if include_uv and not uv_wavelengths and sample.uv_wavelengths is not None and len(sample.uv_wavelengths) > 0:
        try:
            uv_wavelengths = [float(sample.uv_wavelengths[0])]
        except Exception:
            uv_wavelengths = []
    if not include_uv or sample.uv_data is None:
        uv_wavelengths = []

    deconv_results = payload.get("deconv_results")
    if not isinstance(deconv_results, list):
        deconv_results = []

    deconv_time_range = payload.get("deconv_time_range")
    if isinstance(deconv_time_range, (list, tuple)) and len(deconv_time_range) == 2:
        start = _coerce_float(deconv_time_range[0], np.nan)
        end = _coerce_float(deconv_time_range[1], np.nan)
        if np.isfinite(start) and np.isfinite(end) and end > start:
            deconv_time_range = (float(start), float(end))
        else:
            deconv_time_range = None
    else:
        deconv_time_range = None

    if include_deconv:
        if deconv_time_range is None:
            start, end = _detect_deconvolution_window_for_sample(sample)
            if end > start:
                deconv_time_range = (start, end)
        if not deconv_results and deconv_time_range is not None:
            report_mz, report_intensity = analysis.sum_spectra_in_range(sample, deconv_time_range[0], deconv_time_range[1])
            if report_mz is not None and len(report_mz) > 0:
                deconv_results = _run_default_report_deconvolution(report_mz, report_intensity)
    else:
        deconv_results = []
        deconv_time_range = None

    A4_W, A4_H = 8.27, 11.69
    from matplotlib.backends.backend_pdf import PdfPages

    pdf_buffer = io.BytesIO()
    with PdfPages(pdf_buffer) as pdf:
        # Page 1: sample info + deconvolution table
        params = {
            "Mass range": "500 - 50,000 Da",
            "Charge range": "1 - 50",
            "Noise cutoff": "1,000 counts",
        }
        fig_info = plotting.create_report_info_page(
            sample_name=sample.name,
            acq_method=sample.acq_method,
            app_version=lcms_config.APP_VERSION,
            time_range=deconv_time_range,
            parameters=params if deconv_results else {},
            results=deconv_results if deconv_results else None,
            acq_info=getattr(sample, "acq_info", None),
        )
        pdf.savefig(fig_info)
        plt.close(fig_info)

        # Page 2: UV/TIC chromatograms
        if sample.tic is not None or (include_uv and sample.uv_data is not None):
            chrom_style = {
                "fig_width": A4_W - 0.8,
                "fig_height_per_panel": 3.0,
                "line_width": line_width,
                "show_grid": show_grid,
                "y_scale": "linear",
                "colors": colors,
                "labels": labels,
            }
            fig_chrom = plotting.create_single_sample_figure(
                sample,
                uv_wavelengths=uv_wavelengths,
                eic_targets=[],
                style=chrom_style,
                uv_smoothing=uv_smoothing,
                eic_smoothing=eic_smoothing,
            )
            fig_chrom.set_size_inches(A4_W, A4_H)
            if fig_chrom._suptitle:
                fig_chrom._suptitle.set_y(0.98)
            fig_chrom.subplots_adjust(top=0.93)
            pdf.savefig(fig_chrom)
            plt.close(fig_chrom)

        # Page 3/4: deconvolution views
        if deconv_results and deconv_time_range is not None:
            display_results = deconv_results[:10]
            deconv_style = {
                "fig_width": A4_W - 0.8,
                "line_width": line_width,
                "show_grid": True,
                "deconv_x_min_da": deconv_x_min_da,
                "deconv_x_max_da": deconv_x_max_da,
                "deconv_show_obs_calc": False,
                "deconv_calc_mass_da": None,
            }
            fig_deconv = plotting.create_deconvolution_figure(
                sample,
                deconv_time_range[0],
                deconv_time_range[1],
                display_results,
                deconv_style,
            )
            fig_deconv.set_size_inches(A4_W, A4_H)
            if fig_deconv._suptitle:
                fig_deconv._suptitle.set_y(0.98)
            fig_deconv.subplots_adjust(top=0.93)
            pdf.savefig(fig_deconv)
            plt.close(fig_deconv)

            report_mz, report_intensity = analysis.sum_spectra_in_range(sample, deconv_time_range[0], deconv_time_range[1])
            if report_mz is not None and len(report_mz) > 0:
                ion_style = {
                    "fig_width": A4_W - 0.8,
                    "line_width": line_width,
                    "show_grid": True,
                }
                fig_ions = plotting.create_ion_selection_figure(
                    report_mz,
                    report_intensity,
                    display_results,
                    ion_style,
                )
                fig_ions.set_size_inches(A4_W, A4_H)
                if fig_ions._suptitle:
                    fig_ions._suptitle.set_y(0.98)
                fig_ions.subplots_adjust(top=0.93)
                pdf.savefig(fig_ions)
                plt.close(fig_ions)

    pdf_buffer.seek(0)
    base_name = sample.name[:-2] if sample.name.lower().endswith(".d") else sample.name
    safe_name = _sanitize_filename(base_name, fallback="sample")
    date_str = datetime.date.today().strftime("%Y%m%d")
    filename = f"{safe_name}_report_{date_str}.pdf"

    return Response(
        content=pdf_buffer.getvalue(),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    port = int(os.environ.get("LCMS_PORT", 8741))
    print(f"LC-MS Backend starting on http://localhost:{port}")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
