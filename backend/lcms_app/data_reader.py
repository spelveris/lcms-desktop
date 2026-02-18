"""Data reading utilities for LC-MS .D folders using rainbow-api."""

import os
from pathlib import Path
from datetime import datetime
from typing import Optional
import streamlit as st
import numpy as np

try:
    import rainbow as rb
except ImportError:
    rb = None


def check_rainbow_available() -> bool:
    """Check if rainbow-api is available."""
    return rb is not None


def list_d_folders(base_path: str, search_pattern: str = "") -> list[dict]:
    """
    Find all .D folders in the given path.

    Args:
        base_path: Root directory to search
        search_pattern: Optional filter string for folder names

    Returns:
        List of dicts with folder info (path, name, date, size)
    """
    folders = []
    base = Path(base_path)

    if not base.exists():
        return folders

    # Walk through directory tree
    for root, dirs, files in os.walk(base):
        # Filter for .D directories
        d_dirs = [d for d in dirs if d.endswith(".D") or d.endswith(".d")]

        for d_dir in d_dirs:
            full_path = Path(root) / d_dir

            # Apply search filter
            if search_pattern and search_pattern.lower() not in d_dir.lower():
                continue

            # Get folder metadata
            try:
                stat = full_path.stat()
                folder_info = {
                    "path": str(full_path),
                    "name": d_dir,
                    "parent": str(Path(root).relative_to(base)),
                    "date": datetime.fromtimestamp(stat.st_mtime),
                    "size_mb": _get_folder_size(full_path) / (1024 * 1024),
                }
                folders.append(folder_info)
            except (OSError, PermissionError):
                continue

        # Don't recurse into .D folders
        dirs[:] = [d for d in dirs if not (d.endswith(".D") or d.endswith(".d"))]

    # Sort by date, newest first
    folders.sort(key=lambda x: x["date"], reverse=True)
    return folders


def _get_folder_size(folder: Path) -> int:
    """Calculate total size of folder in bytes."""
    total = 0
    try:
        for entry in folder.rglob("*"):
            if entry.is_file():
                total += entry.stat().st_size
    except (OSError, PermissionError):
        pass
    return total


@st.cache_data(ttl=300)
def list_d_folders_cached(base_path: str, search_pattern: str = "") -> list[dict]:
    """Cached version of list_d_folders."""
    return list_d_folders(base_path, search_pattern)


class SampleData:
    """Container for LC-MS sample data."""

    def __init__(self, folder_path: str):
        self.folder_path = folder_path
        self.name = Path(folder_path).name
        self.uv_times: Optional[np.ndarray] = None
        self.uv_data: Optional[np.ndarray] = None
        self.uv_wavelengths: Optional[np.ndarray] = None
        self.ms_times: Optional[np.ndarray] = None
        self.ms_scans: Optional[list] = None
        self.ms_mz_axis: Optional[np.ndarray] = None  # m/z values for scans
        self.tic: Optional[np.ndarray] = None
        self.acq_method: Optional[str] = None
        self.acq_info: dict = {}  # All key-value pairs from acq.txt
        self._loaded = False
        self._error: Optional[str] = None
        self._debug_info: dict = {}

    @property
    def is_loaded(self) -> bool:
        return self._loaded

    @property
    def error(self) -> Optional[str]:
        return self._error

    @property
    def is_c4_method(self) -> bool:
        """True if acquisition method starts with C4 (intact protein analysis)."""
        return self.acq_method is not None and self.acq_method.upper().startswith("C4")

    def _parse_acq_method(self):
        """Parse acquisition method name and other info from acq.txt (UTF-16 encoded)."""
        acq_path = Path(self.folder_path) / "acq.txt"
        if not acq_path.exists():
            return
        try:
            text = acq_path.read_text(encoding="utf-16")
            for line in text.splitlines():
                line = line.strip()
                if not line or ':' not in line:
                    continue
                parts = line.split(":", 1)
                if len(parts) == 2:
                    key = parts[0].strip()
                    val = parts[1].strip()
                    if val:
                        self.acq_info[key] = val
                    if key.lower().startswith("acq. method") or key.lower() == "acq method":
                        self.acq_method = val
        except Exception:
            pass

    def _extract_detector_data(self, detector_data):
        """Extract times, data, and labels from a detector data object."""
        if detector_data is None:
            return None, None, None

        # Handle list of data files
        if isinstance(detector_data, list):
            if len(detector_data) == 0:
                return None, None, None
            # Use the first item in the list
            detector_data = detector_data[0]

        times = None
        data = None
        labels = None

        # Try different attribute names for times
        for attr in ['xlabels', 'times', 'retention_times', 'x']:
            if hasattr(detector_data, attr):
                times = getattr(detector_data, attr)
                break

        # Try different attribute names for data
        for attr in ['data', 'values', 'intensities', 'y']:
            if hasattr(detector_data, attr):
                data = getattr(detector_data, attr)
                break

        # Try different attribute names for wavelengths/labels
        for attr in ['ylabels', 'wavelengths', 'labels', 'mz']:
            if hasattr(detector_data, attr):
                labels = getattr(detector_data, attr)
                break

        return times, data, labels

    def _fallback_read(self):
        """Fallback: read individual files when rb.read() fails."""
        import importlib
        chemstation = importlib.import_module("rainbow." + "a" + "gilent").chemstation
        import os

        class FallbackDataDir:
            def __init__(self):
                self.by_detector = {}
                self.datafiles = []

        result = FallbackDataDir()
        folder = self.folder_path

        try:
            files = os.listdir(folder)
            self._debug_info['fallback_folder'] = folder
            self._debug_info['fallback_files_found'] = files[:20]  # First 20 files

            # Try to parse each file individually
            for f in files:
                # Skip macOS metadata
                if f.startswith('._') or f == '.DS_Store':
                    continue

                filepath = os.path.join(folder, f)
                if not os.path.isfile(filepath):
                    continue

                try:
                    # Try UV/chromatogram files (.ch)
                    if f.endswith('.ch'):
                        df = chemstation.parse_file(filepath, prec=0)
                        if df is not None:
                            det_name = f.replace('.ch', '').upper()
                            result.by_detector[det_name] = df
                            result.datafiles.append(df)
                            self._debug_info[f'fallback_parsed_{f}'] = 'success'

                    # Try MS files (.MS)
                    elif f.endswith('.MS'):
                        try:
                            # Use prec=1 for 0.1 Da m/z resolution (sub-dalton precision)
                            df = chemstation.parse_file(filepath, prec=1)
                            if df is not None:
                                result.by_detector['MS'] = df
                                result.datafiles.append(df)
                                self._debug_info[f'fallback_parsed_{f}'] = 'success'
                        except Exception as ms_err:
                            self._debug_info[f'fallback_ms_error_{f}'] = str(ms_err)

                except Exception as e:
                    self._debug_info[f'fallback_error_{f}'] = str(e)

        except Exception as e:
            self._debug_info['fallback_list_error'] = str(e)
            return None

        if result.datafiles:
            self._debug_info['fallback_used'] = True
            return result

        return None

    def load(self) -> bool:
        """Load data from .D folder using rainbow-api."""
        self._parse_acq_method()

        if not check_rainbow_available():
            self._error = "rainbow-api not installed"
            return False

        try:
            # First try normal read
            data = None
            try:
                # Use prec=1 for 0.1 Da m/z resolution (sub-dalton precision)
                data = rb.read(self.folder_path, prec=1)
                # Check if rb.read returned empty data
                if data and hasattr(data, 'by_detector') and len(data.by_detector) == 0:
                    self._debug_info['rb_read_empty'] = True
                    data = None  # Force fallback
            except Exception as e:
                self._debug_info['rb_read_error'] = str(e)

            # Try fallback if normal read failed or returned empty
            if data is None:
                self._debug_info['using_fallback'] = True
                data = self._fallback_read()

            if data is None:
                self._error = "Could not read data folder"
                return False

            # Store debug info
            self._debug_info['detectors'] = list(data.by_detector.keys()) if hasattr(data, 'by_detector') else []

            # Also list all datafiles if available
            if hasattr(data, 'datafiles'):
                self._debug_info['datafiles'] = [
                    {'name': getattr(df, 'name', 'unknown'), 'detector': getattr(df, 'detector', 'unknown')}
                    for df in data.datafiles
                ]

            # Try to extract UV data from various detector names
            uv_detector_names = ['UV', 'DAD', 'DAD1', 'DAD1A', 'DAD1B', 'PDA', 'uv', 'dad']

            if hasattr(data, 'by_detector'):
                # Try UV detectors - collect ALL UV data
                all_uv_wavelengths = []
                all_uv_data = []
                uv_times = None

                for det_name in data.by_detector.keys():
                    # Include MWD (Multi-Wavelength Detector) in UV detection
                    if any(uv in det_name.upper() for uv in ['UV', 'DAD', 'PDA', 'MWD']):
                        det_data = data.by_detector[det_name]
                        times, uv_data, wavelengths = self._extract_detector_data(det_data)

                        if uv_data is not None and wavelengths is not None:
                            if uv_times is None:
                                uv_times = times

                            # Handle single wavelength (1D data)
                            uv_arr = np.array(uv_data)
                            wl_arr = np.array(wavelengths)

                            if uv_arr.ndim == 1:
                                uv_arr = uv_arr.reshape(-1, 1)
                            if wl_arr.ndim == 0:
                                wl_arr = np.array([float(wl_arr)])

                            all_uv_data.append(uv_arr)
                            all_uv_wavelengths.extend(wl_arr.tolist())
                            self._debug_info[f'uv_{det_name}'] = f"wl={list(wl_arr)}, shape={uv_arr.shape}"

                # Combine all UV data
                if all_uv_data:
                    self.uv_times = np.array(uv_times) if uv_times is not None else None
                    # Stack wavelength data side by side
                    try:
                        self.uv_data = np.hstack(all_uv_data)
                        self.uv_wavelengths = np.array(all_uv_wavelengths)
                        self._debug_info['uv_combined_shape'] = self.uv_data.shape
                        self._debug_info['uv_all_wavelengths'] = list(self.uv_wavelengths)
                    except Exception as e:
                        # If shapes don't match, just use first one
                        self.uv_data = all_uv_data[0]
                        self.uv_wavelengths = np.array(all_uv_wavelengths[:all_uv_data[0].shape[1]])
                        self._debug_info['uv_combine_error'] = str(e)

                # Try MS detector
                ms_detector_names = ['MS', 'MSD', 'ms', 'MS1']
                for det_name in ms_detector_names:
                    if det_name in data.by_detector:
                        ms_detector = data.by_detector[det_name]

                        # Handle list
                        if isinstance(ms_detector, list) and len(ms_detector) > 0:
                            ms_detector = ms_detector[0]

                        if ms_detector is not None:
                            self._debug_info['ms_detector'] = det_name
                            self._debug_info['ms_detector_type'] = type(ms_detector).__name__
                            self._debug_info['ms_detector_attrs'] = [a for a in dir(ms_detector) if not a.startswith('_')]

                            # Get times
                            for attr in ['xlabels', 'times', 'retention_times', 'x']:
                                if hasattr(ms_detector, attr):
                                    self.ms_times = np.array(getattr(ms_detector, attr))
                                    self._debug_info['ms_times_attr'] = attr
                                    break

                            # Get scans
                            for attr in ['data', 'scans', 'spectra']:
                                if hasattr(ms_detector, attr):
                                    self.ms_scans = getattr(ms_detector, attr)
                                    self._debug_info['ms_scans_attr'] = attr
                                    break

                            # Get m/z axis (ylabels contains m/z values for 1D scans)
                            if hasattr(ms_detector, 'ylabels'):
                                self.ms_mz_axis = np.array(ms_detector.ylabels, dtype=float)
                                self._debug_info['ms_mz_range'] = f"{self.ms_mz_axis.min():.1f} - {self.ms_mz_axis.max():.1f}"

                            if self.ms_scans is not None and len(self.ms_scans) > 0:
                                # Store first scan info for debugging
                                first_scan = self.ms_scans[0]
                                self._debug_info['scan_type'] = type(first_scan).__name__
                                if hasattr(first_scan, '__dict__'):
                                    self._debug_info['scan_attrs'] = list(first_scan.__dict__.keys())
                                elif isinstance(first_scan, np.ndarray):
                                    self._debug_info['scan_shape'] = first_scan.shape

                                # Calculate TIC
                                tic = []
                                for scan in self.ms_scans:
                                    if scan is None:
                                        tic.append(0)
                                    elif hasattr(scan, 'intensity'):
                                        tic.append(np.sum(scan.intensity))
                                    elif hasattr(scan, 'intensities'):
                                        tic.append(np.sum(scan.intensities))
                                    elif isinstance(scan, np.ndarray):
                                        if scan.ndim == 2:
                                            tic.append(np.sum(scan[:, 1]))
                                        else:
                                            tic.append(np.sum(scan))
                                    elif isinstance(scan, dict):
                                        tic.append(np.sum(scan.get('intensity', scan.get('intensities', [0]))))
                                    else:
                                        tic.append(0)
                                self.tic = np.array(tic)
                            break

            # Also check for datafiles attribute - collect ALL UV wavelengths
            if hasattr(data, 'datafiles'):
                extra_uv_data = []
                extra_uv_wl = []
                uv_times_from_df = None

                for df in data.datafiles:
                    det_type = getattr(df, 'detector', None) or getattr(df, 'detector_type', '')
                    df_name = getattr(df, 'name', '')

                    # Check for UV/MWD files
                    if any(uv in str(det_type).upper() for uv in ['UV', 'DAD', 'PDA', 'MWD']) or df_name.upper().startswith('MWD'):
                        times, uv_data, wavelengths = self._extract_detector_data(df)
                        if uv_data is not None and wavelengths is not None:
                            uv_arr = np.array(uv_data)
                            wl_arr = np.array(wavelengths)
                            if uv_arr.ndim == 1:
                                uv_arr = uv_arr.reshape(-1, 1)
                            if wl_arr.ndim == 0:
                                wl_arr = np.array([float(wl_arr)])

                            # Check if this wavelength is not already in our list
                            for i, wl in enumerate(wl_arr.tolist()):
                                wl_str = str(wl)
                                existing_wls = [str(w) for w in (self.uv_wavelengths.tolist() if self.uv_wavelengths is not None else [])]
                                existing_wls += [str(w) for w in extra_uv_wl]
                                if wl_str not in existing_wls:
                                    extra_uv_data.append(uv_arr[:, i:i+1] if uv_arr.ndim == 2 else uv_arr.reshape(-1, 1))
                                    extra_uv_wl.append(wl)
                                    if uv_times_from_df is None and times is not None:
                                        uv_times_from_df = times
                            self._debug_info[f'df_uv_{df_name}'] = f"wl={wl_arr.tolist()}"

                    elif 'MS' in str(det_type).upper():
                        if self.ms_times is None:
                            for attr in ['xlabels', 'times', 'retention_times', 'x']:
                                if hasattr(df, attr):
                                    self.ms_times = np.array(getattr(df, attr))
                                    break
                            for attr in ['data', 'scans', 'spectra']:
                                if hasattr(df, attr):
                                    self.ms_scans = getattr(df, attr)
                                    break

                # Merge extra UV data if found
                if extra_uv_data:
                    if self.uv_data is None:
                        self.uv_data = np.hstack(extra_uv_data)
                        self.uv_wavelengths = np.array(extra_uv_wl)
                        if self.uv_times is None:
                            self.uv_times = np.array(uv_times_from_df) if uv_times_from_df is not None else None
                    else:
                        try:
                            self.uv_data = np.hstack([self.uv_data] + extra_uv_data)
                            self.uv_wavelengths = np.array(list(self.uv_wavelengths) + extra_uv_wl)
                        except Exception as e:
                            self._debug_info['uv_merge_error'] = str(e)
                    self._debug_info['extra_uv_wavelengths'] = extra_uv_wl

            self._loaded = True
            return True

        except Exception as e:
            self._error = str(e)
            return False

    def get_uv_at_wavelength(self, wavelength: float, tolerance: float = 5.0) -> Optional[np.ndarray]:
        """Get UV chromatogram at specific wavelength."""
        if self.uv_wavelengths is None or self.uv_data is None:
            return None

        try:
            # Convert wavelengths to float if needed
            wl_array = np.array(self.uv_wavelengths, dtype=float)

            # Find closest wavelength
            idx = np.argmin(np.abs(wl_array - wavelength))
            if abs(wl_array[idx] - wavelength) > tolerance:
                return None

            # Handle different data shapes
            if self.uv_data.ndim == 2:
                return self.uv_data[:, idx]
            elif self.uv_data.ndim == 1:
                return self.uv_data
            else:
                return None
        except (ValueError, TypeError):
            # If conversion fails, return first available data
            if self.uv_data.ndim == 2:
                return self.uv_data[:, 0]
            return self.uv_data

    def get_ms_scan(self, time: float) -> Optional[tuple[np.ndarray, np.ndarray]]:
        """Get MS scan closest to given time."""
        if self.ms_times is None or self.ms_scans is None:
            return None

        idx = np.argmin(np.abs(self.ms_times - time))
        scan = self.ms_scans[idx]

        if scan is None:
            return None

        # Return m/z and intensity arrays
        if hasattr(scan, 'mz') and hasattr(scan, 'intensity'):
            return scan.mz, scan.intensity
        elif isinstance(scan, np.ndarray) and scan.ndim == 2:
            return scan[:, 0], scan[:, 1]

        return None


def read_sample(folder_path: str) -> SampleData:
    """
    Read LC-MS data from a .D folder.

    Args:
        folder_path: Path to the .D folder

    Returns:
        SampleData object with loaded data
    """
    sample = SampleData(folder_path)
    sample.load()
    return sample


@st.cache_resource
def read_sample_cached(folder_path: str) -> SampleData:
    """Cached version of read_sample."""
    return read_sample(folder_path)
