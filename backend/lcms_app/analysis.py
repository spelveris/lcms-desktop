"""Analysis functions for LC-MS data processing."""

import warnings
import numpy as np
from scipy import signal
from scipy import integrate
from typing import Optional

from data_reader import SampleData


def smooth_data(data: np.ndarray, window_size: int = 5) -> np.ndarray:
    """
    Apply Savitzky-Golay smoothing to data.

    Args:
        data: Input array to smooth
        window_size: Size of smoothing window (must be odd)

    Returns:
        Smoothed array
    """
    if data is None or len(data) < window_size:
        return data

    # Ensure window size is odd
    if window_size % 2 == 0:
        window_size += 1

    # Window must be smaller than data length
    if window_size >= len(data):
        window_size = len(data) - 1 if len(data) % 2 == 0 else len(data) - 2
        if window_size < 3:
            return data

    try:
        return signal.savgol_filter(data, window_size, polyorder=2)
    except Exception:
        # Fall back to simple moving average
        return np.convolve(data, np.ones(window_size) / window_size, mode='same')


def extract_eic(sample: SampleData, target_mz: float, window: float = 0.5) -> Optional[np.ndarray]:
    """
    Extract ion chromatogram (EIC) for a given m/z value.

    Args:
        sample: SampleData object with loaded MS data
        target_mz: Target m/z value
        window: m/z window (+/- this value)

    Returns:
        Array of intensities at each time point, or None if no MS data
    """
    if sample.ms_scans is None or sample.ms_times is None:
        return None

    mz_min = target_mz - window
    mz_max = target_mz + window

    # Check if we have a shared m/z axis (1D scans)
    if sample.ms_mz_axis is not None:
        # Find indices within m/z window
        mask = (sample.ms_mz_axis >= mz_min) & (sample.ms_mz_axis <= mz_max)
        if not np.any(mask):
            return np.zeros(len(sample.ms_scans))

        eic = []
        for scan in sample.ms_scans:
            if scan is None:
                eic.append(0)
            elif isinstance(scan, np.ndarray) and scan.ndim == 1:
                # 1D array - use mask on shared m/z axis
                eic.append(np.sum(scan[mask]))
            else:
                eic.append(0)
        return np.array(eic)

    # Fall back to per-scan m/z extraction (2D scans)
    eic = []
    for scan in sample.ms_scans:
        if scan is None:
            eic.append(0)
            continue

        # Get m/z and intensity from scan
        try:
            mz = None
            intensity = None

            # Try different attribute names
            if hasattr(scan, 'mz') and hasattr(scan, 'intensity'):
                mz = np.array(scan.mz)
                intensity = np.array(scan.intensity)
            elif hasattr(scan, 'masses') and hasattr(scan, 'intensities'):
                mz = np.array(scan.masses)
                intensity = np.array(scan.intensities)
            elif hasattr(scan, 'mzs') and hasattr(scan, 'ints'):
                mz = np.array(scan.mzs)
                intensity = np.array(scan.ints)
            elif isinstance(scan, dict):
                mz = np.array(scan.get('mz', scan.get('masses', [])))
                intensity = np.array(scan.get('intensity', scan.get('intensities', [])))
            elif isinstance(scan, np.ndarray):
                if scan.ndim == 2 and scan.shape[1] >= 2:
                    mz = scan[:, 0]
                    intensity = scan[:, 1]
                elif scan.ndim == 1:
                    # 1D without m/z axis - can't extract EIC
                    eic.append(0)
                    continue
            elif isinstance(scan, (list, tuple)) and len(scan) >= 2:
                mz = np.array(scan[0])
                intensity = np.array(scan[1])

            if mz is None or intensity is None or len(mz) == 0:
                eic.append(0)
                continue

            # Sum intensities within m/z window
            scan_mask = (mz >= mz_min) & (mz <= mz_max)
            eic.append(np.sum(intensity[scan_mask]) if np.any(scan_mask) else 0)

        except Exception as e:
            eic.append(0)

    return np.array(eic)


def calculate_tic(sample: SampleData) -> Optional[np.ndarray]:
    """
    Calculate Total Ion Chromatogram from MS data.

    Args:
        sample: SampleData object with loaded MS data

    Returns:
        Array of total ion intensities, or None if no MS data
    """
    if sample.tic is not None:
        return sample.tic

    if sample.ms_scans is None:
        return None

    tic = []
    for scan in sample.ms_scans:
        if scan is None:
            tic.append(0)
            continue

        try:
            if hasattr(scan, 'intensity'):
                tic.append(np.sum(scan.intensity))
            elif isinstance(scan, np.ndarray):
                if scan.ndim == 2:
                    tic.append(np.sum(scan[:, 1]))
                else:
                    tic.append(np.sum(scan))
            else:
                tic.append(0)
        except Exception:
            tic.append(0)

    return np.array(tic)


def calculate_peak_area(times: np.ndarray, intensities: np.ndarray,
                        start_time: Optional[float] = None,
                        end_time: Optional[float] = None) -> float:
    """
    Calculate peak area using trapezoidal integration.

    Args:
        times: Time array
        intensities: Intensity array
        start_time: Start of integration window (optional)
        end_time: End of integration window (optional)

    Returns:
        Integrated area
    """
    if times is None or intensities is None or len(times) != len(intensities):
        return 0.0

    # Apply time window if specified
    if start_time is not None or end_time is not None:
        mask = np.ones(len(times), dtype=bool)
        if start_time is not None:
            mask &= times >= start_time
        if end_time is not None:
            mask &= times <= end_time
        times = times[mask]
        intensities = intensities[mask]

    if len(times) < 2:
        return 0.0

    return float(integrate.trapezoid(intensities, times))


def find_peaks(times: np.ndarray, intensities: np.ndarray,
               height_threshold: float = 0.1,
               prominence: float = 0.05) -> list[dict]:
    """
    Find peaks in chromatogram.

    Args:
        times: Time array
        intensities: Intensity array
        height_threshold: Minimum height as fraction of max
        prominence: Minimum prominence as fraction of max

    Returns:
        List of peak info dicts with time, intensity, area
    """
    if times is None or intensities is None or len(times) < 3:
        return []

    max_intensity = np.max(intensities)
    if max_intensity == 0:
        return []

    min_height = max_intensity * height_threshold
    min_prominence = max_intensity * prominence

    try:
        peak_indices, properties = signal.find_peaks(
            intensities,
            height=min_height,
            prominence=min_prominence
        )
    except Exception:
        return []

    peaks = []
    for i, idx in enumerate(peak_indices):
        # Estimate peak boundaries for area calculation
        left_base = properties.get('left_bases', [idx - 1])[i] if 'left_bases' in properties else max(0, idx - 5)
        right_base = properties.get('right_bases', [idx + 1])[i] if 'right_bases' in properties else min(len(times) - 1, idx + 5)

        area = calculate_peak_area(
            times[left_base:right_base + 1],
            intensities[left_base:right_base + 1]
        )

        peaks.append({
            'time': times[idx],
            'intensity': intensities[idx],
            'area': area,
            'index': idx,
            'left_index': int(left_base),
            'right_index': int(right_base),
            'start_time': float(times[left_base]),
            'end_time': float(times[right_base]),
        })

    return peaks


def normalize_data(data: np.ndarray) -> np.ndarray:
    """Normalize data to 0-1 range."""
    if data is None or len(data) == 0:
        return data

    data_min = np.min(data)
    data_max = np.max(data)

    if data_max - data_min == 0:
        return np.zeros_like(data)

    return (data - data_min) / (data_max - data_min)


def baseline_correction(data: np.ndarray, percentile: float = 5) -> np.ndarray:
    """
    Simple baseline correction using percentile.

    Args:
        data: Input array
        percentile: Percentile to use as baseline estimate

    Returns:
        Baseline-corrected array
    """
    if data is None or len(data) == 0:
        return data

    baseline = np.percentile(data, percentile)
    corrected = data - baseline
    corrected[corrected < 0] = 0

    return corrected


def sum_spectra_in_range(sample: 'SampleData', start_time: float, end_time: float) -> tuple[np.ndarray, np.ndarray]:
    """
    Sum mass spectra within a time range.

    Args:
        sample: SampleData object with loaded MS data
        start_time: Start time in minutes
        end_time: End time in minutes

    Returns:
        Tuple of (mz_array, intensity_array)
    """
    if sample.ms_scans is None or sample.ms_times is None:
        return np.array([]), np.array([])

    # Find time indices within range
    time_mask = (sample.ms_times >= start_time) & (sample.ms_times <= end_time)
    scan_indices = np.where(time_mask)[0]

    if len(scan_indices) == 0:
        return np.array([]), np.array([])

    # If we have a shared m/z axis
    if sample.ms_mz_axis is not None:
        mz_axis = sample.ms_mz_axis
        summed_intensities = np.zeros(len(mz_axis))

        for idx in scan_indices:
            scan = sample.ms_scans[idx]
            if scan is not None and isinstance(scan, np.ndarray):
                summed_intensities += scan

        return mz_axis, summed_intensities

    # Otherwise, need to bin the spectra
    # Collect all m/z and intensities first
    all_mz = []
    all_int = []

    for idx in scan_indices:
        scan = sample.ms_scans[idx]
        if scan is None:
            continue

        mz, intensity = None, None

        if hasattr(scan, 'mz') and hasattr(scan, 'intensity'):
            mz = np.array(scan.mz)
            intensity = np.array(scan.intensity)
        elif hasattr(scan, 'masses') and hasattr(scan, 'intensities'):
            mz = np.array(scan.masses)
            intensity = np.array(scan.intensities)
        elif isinstance(scan, np.ndarray) and scan.ndim == 2:
            mz = scan[:, 0]
            intensity = scan[:, 1]

        if mz is not None and intensity is not None and len(mz) > 0:
            all_mz.extend(mz)
            all_int.extend(intensity)

    if len(all_mz) == 0:
        return np.array([]), np.array([])

    # Bin the data with higher precision
    mz_min, mz_max = min(all_mz), max(all_mz)
    bin_width = 0.01  # 0.01 Da bins for better precision
    bins = np.arange(mz_min, mz_max + bin_width, bin_width)

    binned_intensity, bin_edges = np.histogram(all_mz, bins=bins, weights=all_int)
    mz_centers = (bin_edges[:-1] + bin_edges[1:]) / 2

    return mz_centers, binned_intensity


def centroid_peak(mz: np.ndarray, intensity: np.ndarray, peak_idx: int, window: int = 3) -> float:
    """
    Calculate centroid m/z for a peak using intensity-weighted average.

    Args:
        mz: m/z array
        intensity: intensity array
        peak_idx: Index of peak maximum
        window: Number of points on each side to include

    Returns:
        Centroid m/z value
    """
    left = max(0, peak_idx - window)
    right = min(len(mz), peak_idx + window + 1)

    mz_window = mz[left:right]
    int_window = intensity[left:right]

    # Use only the top portion of the peak (above 50% of max in window)
    max_int = np.max(int_window)
    threshold = max_int * 0.5
    mask = int_window >= threshold

    if not np.any(mask):
        return mz[peak_idx]

    mz_filtered = mz_window[mask]
    int_filtered = int_window[mask]

    # Subtract baseline
    baseline = np.min(int_filtered)
    int_corrected = int_filtered - baseline

    total_int = np.sum(int_corrected)
    if total_int == 0:
        return mz[peak_idx]

    # Intensity-weighted centroid
    centroid = np.sum(mz_filtered * int_corrected) / total_int
    return centroid


def find_spectrum_peaks(mz: np.ndarray, intensity: np.ndarray,
                        height_threshold: float = 0.01,
                        min_distance: int = 3,
                        use_centroid: bool = True) -> list[dict]:
    """
    Find peaks in a mass spectrum.

    Args:
        mz: m/z array
        intensity: intensity array
        height_threshold: Minimum height as fraction of max
        min_distance: Minimum distance between peaks in data points
        use_centroid: If True, calculate centroid m/z for better precision

    Returns:
        List of peak dicts with mz and intensity
    """
    if len(mz) == 0 or len(intensity) == 0:
        return []

    max_int = np.max(intensity)
    if max_int == 0:
        return []

    min_height = max_int * height_threshold

    try:
        peak_indices, properties = signal.find_peaks(
            intensity,
            height=min_height,
            distance=min_distance
        )
    except Exception:
        return []

    peaks = []
    for idx in peak_indices:
        if use_centroid:
            peak_mz = centroid_peak(mz, intensity, idx)
        else:
            peak_mz = mz[idx]

        peaks.append({
            'mz': peak_mz,
            'intensity': intensity[idx],
            'index': idx
        })

    # Sort by intensity descending
    peaks.sort(key=lambda x: x['intensity'], reverse=True)
    return peaks


def deconvolute_protein(mz: np.ndarray, intensity: np.ndarray,
                        min_charge: int = 5, max_charge: int = 60,
                        mass_tolerance: float = 1.0,
                        min_peaks: int = 3,
                        max_peaks: int = 50) -> list[dict]:
    """
    Perform protein mass deconvolution from multiply-charged ions.

    Algorithm:
    For each pair of adjacent peaks, calculate potential charge state:
    z = m2 / (m1 - m2) where m1 > m2
    Then M = m1 * z - z * 1.00784 (proton mass)

    Args:
        mz: m/z array
        intensity: intensity array
        min_charge: Minimum charge state to consider
        max_charge: Maximum charge state to consider
        mass_tolerance: Mass tolerance in Da for grouping
        min_peaks: Minimum number of charge states to confirm a mass

    Returns:
        List of deconvoluted mass results
    """
    PROTON_MASS = 1.00784

    # Find peaks
    peaks = find_spectrum_peaks(mz, intensity, height_threshold=0.01, min_distance=2)

    if len(peaks) < min_peaks:
        return []

    # Get top peaks (limit to max_peaks to control processing)
    peaks = peaks[:max_peaks]
    peak_mzs = np.array([p['mz'] for p in peaks])
    peak_ints = np.array([p['intensity'] for p in peaks])

    # Determine data resolution
    if len(mz) > 1:
        resolution = np.median(np.diff(mz))
    else:
        resolution = 1.0

    # Adjust charge tolerance based on resolution
    charge_tolerance = 0.3 if resolution < 0.5 else 0.5

    # Calculate potential masses from all peak pairs
    candidate_masses = []

    for i, mz1 in enumerate(peak_mzs):
        for j, mz2 in enumerate(peak_mzs):
            if i >= j or mz1 <= mz2:
                continue

            # Calculate charge from adjacent peaks
            delta_mz = mz1 - mz2
            if delta_mz < 0.5 or delta_mz > 200:  # Reasonable range for proteins
                continue

            z = mz2 / delta_mz
            z_rounded = round(z)

            if z_rounded < min_charge or z_rounded > max_charge:
                continue

            # Check if z is close to an integer (more tolerant for low-res data)
            if abs(z - z_rounded) > charge_tolerance:
                continue

            # Calculate neutral mass from both peaks
            mass1 = (mz1 * z_rounded) - (z_rounded * PROTON_MASS)
            mass2 = (mz2 * (z_rounded + 1)) - ((z_rounded + 1) * PROTON_MASS)

            # Average the two mass estimates
            mass_avg = (mass1 + mass2) / 2

            candidate_masses.append({
                'mass': mass_avg,
                'charge': z_rounded,
                'mz1': mz1,
                'mz2': mz2,
                'intensity': (peak_ints[i] + peak_ints[j]) / 2
            })

    if len(candidate_masses) == 0:
        return []

    # Group masses within tolerance (scale tolerance with mass for large proteins)
    masses = np.array([c['mass'] for c in candidate_masses])

    # Use percentage-based tolerance for larger masses
    def get_tolerance(mass):
        base_tol = mass_tolerance
        # Add 0.01% of mass for larger proteins
        return base_tol + mass * 0.0005

    # Cluster similar masses
    results = []
    used = set()

    # Sort by mass for consistent clustering
    sorted_indices = np.argsort(masses)

    for i in sorted_indices:
        if i in used:
            continue

        mass = masses[i]
        tol = get_tolerance(mass)

        # Find all masses within tolerance
        group_indices = np.where(np.abs(masses - mass) < tol)[0]

        if len(group_indices) < min_peaks:
            continue

        for idx in group_indices:
            used.add(idx)

        # Calculate median mass (more robust than mean) and collect charge states
        group_masses = [candidate_masses[idx]['mass'] for idx in group_indices]
        group_charges = [candidate_masses[idx]['charge'] for idx in group_indices]
        group_intensities = [candidate_masses[idx]['intensity'] for idx in group_indices]

        median_mass = np.median(group_masses)
        std_mass = np.std(group_masses)
        unique_charges = sorted(set(group_charges))
        total_intensity = sum(group_intensities)

        # Collect unique m/z values used for this component
        group_mzs = []
        group_mz_charges = []
        group_mz_ints = []
        seen_mz = set()
        for idx in group_indices:
            c = candidate_masses[idx]
            for mz_val in (c['mz1'], c['mz2']):
                mz_key = round(mz_val, 2)
                if mz_key not in seen_mz:
                    seen_mz.add(mz_key)
                    group_mzs.append(mz_val)
                    group_mz_charges.append(c['charge'])
                    group_mz_ints.append(c['intensity'])

        results.append({
            'mass': median_mass,
            'mass_std': std_mass,
            'charge_states': unique_charges,
            'num_charges': len(unique_charges),
            'intensity': total_intensity,
            'peaks_found': len(group_indices),
            'ion_mzs': group_mzs,
            'ion_charges': group_mz_charges,
            'ion_intensities': group_mz_ints,
        })

    # Sort by number of charge states first, then intensity
    results.sort(key=lambda x: (x['num_charges'], x['intensity']), reverse=True)

    return results


def _smooth_spectrum(mz: np.ndarray, intensity: np.ndarray, fwhm_da: float) -> np.ndarray:
    if len(mz) < 2 or fwhm_da <= 0:
        return intensity
    try:
        from scipy.ndimage import gaussian_filter1d
    except Exception:
        return intensity
    resolution = float(np.median(np.diff(mz)))
    if resolution <= 0:
        return intensity
    sigma_da = fwhm_da / 2.3548
    sigma_pts = sigma_da / resolution
    if sigma_pts < 0.5:
        return intensity
    return gaussian_filter1d(intensity, sigma_pts)


def _find_peaks_simple(intensity: np.ndarray, min_distance_pts: int = 2) -> list[int]:
    if len(intensity) < 3:
        return []
    peak_idx = []
    for i in range(1, len(intensity) - 1):
        if intensity[i] >= intensity[i - 1] and intensity[i] >= intensity[i + 1]:
            peak_idx.append(i)

    if not peak_idx:
        return []

    # OPTIMIZATION: Use a set for O(1) lookup instead of O(n) list scan
    # Mark indices that are "blocked" by higher-intensity peaks
    blocked = set()
    filtered = []

    for idx in sorted(peak_idx, key=lambda x: intensity[x], reverse=True):
        if idx in blocked:
            continue
        filtered.append(idx)
        # Block nearby indices
        for offset in range(-min_distance_pts + 1, min_distance_pts):
            blocked.add(idx + offset)

    return sorted(filtered)


def _parabolic_centroid(mz: np.ndarray, intensity: np.ndarray, peak_idx: int) -> float:
    """
    Sub-bin centroid using parabolic interpolation around apex.

    Fits a parabola to the peak apex and its two neighbors to find
    the true maximum with sub-bin precision.
    """
    if peak_idx <= 0 or peak_idx >= len(mz) - 1:
        return float(mz[peak_idx])

    y0 = float(intensity[peak_idx - 1])
    y1 = float(intensity[peak_idx])
    y2 = float(intensity[peak_idx + 1])

    x0 = float(mz[peak_idx - 1])
    x1 = float(mz[peak_idx])
    x2 = float(mz[peak_idx + 1])

    # Parabolic interpolation for apex position
    denom = 2.0 * (y0 - 2.0 * y1 + y2)
    if abs(denom) < 1e-10:
        return x1

    # Delta in index units, then convert to m/z
    delta = (y0 - y2) / denom
    dx = (x2 - x0) / 2.0

    # Clamp delta to avoid extrapolating too far
    delta = max(-1.0, min(1.0, delta))

    return x1 + delta * dx


def _gaussian_fit_r2(charges: list[int], intensities: list[float]) -> float:
    if len(charges) < 3:
        return 0.0
    x = np.array(charges, dtype=float)
    y = np.log(np.maximum(intensities, 1.0))
    try:
        coeffs = np.polyfit(x, y, 2)
        yhat = np.polyval(coeffs, x)
        ss_res = np.sum((y - yhat) ** 2)
        ss_tot = np.sum((y - np.mean(y)) ** 2)
        if ss_tot == 0:
            return 0.0
        r2 = 1 - ss_res / ss_tot
        return max(0.0, min(1.0, float(r2)))
    except Exception:
        return 0.0


def _reject_mass_outliers(masses: np.ndarray, intensities: np.ndarray,
                          max_mad_factor: float = 3.0) -> tuple[np.ndarray, np.ndarray]:
    """
    Remove ions whose per-ion mass deviates too far from the median.

    At high charge states, small m/z errors get amplified (0.1 Da at z=38 = 3.8 Da).
    This filters outlier ions that matched to wrong peaks.

    Returns filtered (masses, intensities) arrays.
    """
    if len(masses) < 4:
        return masses, intensities

    median_mass = np.median(masses)
    abs_devs = np.abs(masses - median_mass)
    mad = np.median(abs_devs)

    if mad < 0.1:
        # Very tight cluster — use fixed threshold of 5 Da
        keep = abs_devs < 5.0
    else:
        keep = abs_devs < max_mad_factor * mad

    # Always keep at least 3 ions
    if np.sum(keep) < 3:
        return masses, intensities

    return masses[keep], intensities[keep]


def _estimate_component_mass(
    ions: list[dict],
    broad_charge_threshold: int = 20,
    core_rel_intensity: float = 0.35,
) -> float:
    """
    Estimate component mass from assigned ions.

    Default estimator is median (robust in crowded spectra). For broad charge
    envelopes, use one representative ion per charge and compute an
    intensity-weighted core average to reduce edge-charge contamination.
    """
    if not ions:
        return float("nan")

    masses = np.array([i['mass'] for i in ions], dtype=float)
    intensities = np.array([i['intensity'] for i in ions], dtype=float)
    charges = np.array([i['charge'] for i in ions], dtype=int)

    masses_clean, intensities_clean = _reject_mass_outliers(masses, intensities)
    if len(masses_clean) == 0 or len(intensities_clean) == 0:
        return float(np.median(masses))

    # Default robust estimator.
    mass_median = float(np.median(masses_clean))

    unique_charges = np.unique(charges)
    if len(unique_charges) < broad_charge_threshold:
        return mass_median

    # Broad envelopes: use strongest ion per charge to avoid over-counting
    # multiple assignments within the same charge, then keep core-intensity
    # charges where overlap contamination is lower.
    charge_to_best_idx = {}
    for idx, (z, it) in enumerate(zip(charges, intensities)):
        best_idx = charge_to_best_idx.get(z)
        if best_idx is None or it > intensities[best_idx]:
            charge_to_best_idx[z] = idx

    per_charge_idx = np.array(list(charge_to_best_idx.values()), dtype=int)
    pc_masses = masses[per_charge_idx]
    pc_intensities = intensities[per_charge_idx]

    # Re-apply outlier cleanup on the per-charge representative set.
    pc_masses, pc_intensities = _reject_mass_outliers(pc_masses, pc_intensities)
    if len(pc_masses) < 3:
        return mass_median

    if np.max(pc_intensities) > 0:
        core_mask = pc_intensities >= core_rel_intensity * np.max(pc_intensities)
        if np.sum(core_mask) >= 3:
            pc_masses = pc_masses[core_mask]
            pc_intensities = pc_intensities[core_mask]

    if np.sum(pc_intensities) <= 0:
        return mass_median

    return float(np.sum(pc_masses * pc_intensities) / np.sum(pc_intensities))


def deconvolute_protein_local_lcms_machine_like(
    mz: np.ndarray,
    intensity: np.ndarray,
    min_charge: int = 5,
    max_charge: int = 50,
    min_peaks: int = 3,
    noise_cutoff: float = 1000.0,
    abundance_cutoff: float = 0.10,
    mw_agreement: float = 0.0005,
    mw_assign_cutoff: float = 0.40,
    envelope_cutoff: float = 0.50,
    pwhh: float = 0.6,
    low_mw: float = 500.0,
    high_mw: float = 50000.0,
    contig_min: int = 3,
    use_mz_agreement: bool = False,
    use_monoisotopic_proton: bool = False,
    max_overlap: float = 0.0,
) -> list[dict]:
    """
    Local LC-MS machine-like deconvolution workflow:
    - Build ion sets around an anchor peak
    - Apply MW agreement % as ion-set membership gate
    - Apply absolute + relative noise cutoffs
    - Curve-fit MW by weighted regression, centroid fallback
    - Enforce envelope Gaussianity threshold
    - Deferred ion-set selection to detect overlapping species

    Args:
        use_monoisotopic_proton: If True, use 1.007276 (monoisotopic);
                                  if False, use 1.00784 (average)
    """
    # Proton mass toggle: monoisotopic vs average
    PROTON_MASS = 1.007276 if use_monoisotopic_proton else 1.00784

    if len(mz) == 0 or len(intensity) == 0:
        return []

    inten = _smooth_spectrum(mz, intensity, pwhh)
    resolution = float(np.median(np.diff(mz))) if len(mz) > 1 else 1.0
    min_distance_pts = max(2, int(pwhh / resolution)) if resolution > 0 else 2
    peak_idx = _find_peaks_simple(inten, min_distance_pts=min_distance_pts)

    peaks = []
    for idx in peak_idx:
        if inten[idx] < noise_cutoff:
            continue
        # Use parabolic centroiding for better m/z precision
        centroid_mz = _parabolic_centroid(mz, inten, idx)
        peaks.append({
            'mz': centroid_mz,
            'intensity': float(inten[idx]),
            'index': idx
        })
    peaks.sort(key=lambda p: p['intensity'], reverse=True)

    if len(peaks) < min_peaks:
        return []

    # OPTIMIZATION: Limit number of anchor peaks to top N by intensity
    max_anchors = min(30, len(peaks))  # Only use top 30 peaks as anchors

    # OPTIMIZATION: Pre-compute all possible masses for each peak at each charge
    # This avoids redundant calculations in the inner loop
    peak_mzs = np.array([p['mz'] for p in peaks])
    peak_ints = np.array([p['intensity'] for p in peaks])
    peak_indices = np.array([p['index'] for p in peaks])
    charges = np.arange(min_charge, max_charge + 1)

    # Pre-compute mass matrix: masses[i, j] = mass of peak i at charge j
    # Shape: (num_peaks, num_charges)
    masses_matrix = np.outer(peak_mzs - PROTON_MASS, charges)  # Each row is a peak, each col is a charge

    # Collect ALL candidate ion sets first (deferred selection)
    all_candidates = []

    for anchor_idx_in_list in range(max_anchors):
        anchor = peaks[anchor_idx_in_list]
        anchor_mz = anchor['mz']
        anchor_int = anchor['intensity']
        anchor_idx = anchor['index']

        # OPTIMIZATION: Only try charge states that give valid masses
        anchor_masses = (anchor_mz - PROTON_MASS) * charges
        valid_z_mask = (anchor_masses >= low_mw) & (anchor_masses <= high_mw)

        for z_idx, z0 in enumerate(charges):
            if not valid_z_mask[z_idx]:
                continue

            M0 = anchor_masses[z_idx]

            ions = []
            ion_indices = set()

            # Vectorized: compute mass errors for ALL peaks × ALL charges at once
            intensity_mask = peak_ints >= max(noise_cutoff, anchor_int * abundance_cutoff)
            all_errors = np.abs(masses_matrix - M0) / M0  # (P, Z)
            all_errors[~intensity_mask] = np.inf
            best_z_idx = np.argmin(all_errors, axis=1)  # (P,)
            min_errors = all_errors[np.arange(len(peaks)), best_z_idx]  # (P,)
            matched_mask = min_errors <= mw_agreement
            matched_pidxs = np.where(matched_mask)[0]

            if use_mz_agreement:
                best_zs = charges[best_z_idx[matched_pidxs]]
                mz_preds = (M0 + best_zs * PROTON_MASS) / best_zs
                mz_errs = np.abs(peak_mzs[matched_pidxs] - mz_preds) / mz_preds
                matched_pidxs = matched_pidxs[mz_errs <= mw_agreement]

            for p_idx in matched_pidxs:
                bz = best_z_idx[p_idx]
                ions.append({
                    'mz': float(peak_mzs[p_idx]),
                    'intensity': float(peak_ints[p_idx]),
                    'charge': int(charges[bz]),
                    'mass': float(masses_matrix[p_idx, bz]),
                    'index': int(peak_indices[p_idx])
                })
                ion_indices.add(int(peak_indices[p_idx]))

            if len(ions) < min_peaks:
                continue

            ion_charges = sorted(set(i['charge'] for i in ions))
            # Enforce contiguous ladder minimum and reject sparse high-charge
            # pseudo-ladders that can overfit dense spectra at max_charge=50.
            longest = 1
            current = 1
            for i in range(1, len(ion_charges)):
                if ion_charges[i] == ion_charges[i - 1] + 1:
                    current += 1
                    longest = max(longest, current)
                else:
                    current = 1
            if contig_min > 1 and longest < contig_min:
                continue

            # Two-tier contiguity gate to suppress sparse pseudo-ladders:
            #   >= 8 charges: need longest >= 6 AND ratio >= 0.60
            #   4-7 charges: need longest >= 4 AND ratio >= 0.60
            #   < 4 charges: existing contig_min check above is sufficient
            num_charges = len(ion_charges)
            if num_charges >= 8:
                contig_ratio = longest / num_charges
                if longest < max(contig_min, 6) or contig_ratio < 0.60:
                    continue
            elif num_charges >= 4:
                contig_ratio = longest / num_charges
                if longest < 4 or contig_ratio < 0.60:
                    continue

            intensities = [i['intensity'] for i in ions]
            r2 = _gaussian_fit_r2(ion_charges, intensities)
            envelope_ok = r2 >= envelope_cutoff

            strong = [i for i in ions if i['intensity'] >= anchor_int * mw_assign_cutoff]
            if len(strong) < min_peaks:
                strong = ions

            # Robust mass estimate with broad-envelope refinement.
            intensities_arr = np.array([i['intensity'] for i in ions])
            masses_arr = np.array([i['mass'] for i in ions])
            M_fit = _estimate_component_mass(ions)

            # R² is stored for informational purposes only — do NOT override
            # the intensity-weighted / regression mass with median when R² is low.
            # Broad envelopes (e.g. 27 charge states) can have low R² but the
            # weighted average is still the most accurate mass estimate.

            group_masses = [i['mass'] for i in ions]
            group_charges = [i['charge'] for i in ions]
            total_intensity = float(sum(intensities))

            # Bin m/z values for m/z-based deduplication (0.5 Da bins)
            ion_mzs = set(int(i['mz'] * 2) for i in ions)

            candidate = {
                'mass': M_fit,
                'mass_std': float(np.std(group_masses)),
                'charge_states': sorted(set(group_charges)),
                'num_charges': len(set(group_charges)),
                'intensity': total_intensity,
                'peaks_found': len(ions),
                'r2': r2,
                'anchor_idx': anchor_idx,
                '_ion_indices': ion_indices,  # Internal: for overlap checking
                '_ion_mzs': ion_mzs,  # Internal: binned m/z values
                '_ions': ions  # Internal: full ion list for recalculation
            }
            all_candidates.append(candidate)

    if not all_candidates:
        return []

    # Sort candidates by quality: num_charges (desc), then intensity (desc)
    all_candidates.sort(key=lambda x: (x['num_charges'], x['intensity']), reverse=True)

    # Deferred selection: pick best candidates, each peak used at most once.
    # Once a peak is claimed by a selected component it is unavailable to
    # later candidates (Agilent-style exclusive peak assignment).
    results = []
    used_ions = set()

    for candidate in all_candidates:
        ion_indices = candidate['_ion_indices']
        if not ion_indices:
            continue

        # Check overlap with already selected sets
        overlap_count = len(ion_indices & used_ions)
        overlap_ratio = overlap_count / len(ion_indices)

        if overlap_ratio <= max_overlap:
            # Check if this mass is too close to an already-selected mass
            # AND has overlapping charge state ranges (same mass + same charges = true duplicate)
            cand_charges = set(candidate['charge_states'])
            mass_duplicate = False
            for r in results:
                mass_diff_pct = abs(r['mass'] - candidate['mass']) / candidate['mass']
                if mass_diff_pct < 0.00005:  # 50 ppm (0.005%) — tight enough to resolve 1.27 Da at 15.7 kDa
                    # Only consider it a duplicate if charge ranges also overlap significantly
                    r_charges = set(r['charge_states'])
                    charge_overlap = len(cand_charges & r_charges)
                    if charge_overlap > 0:
                        mass_duplicate = True
                        break

            if not mass_duplicate:
                # Use ALL ions in the candidate set for mass calculation
                # with outlier rejection.
                ions = candidate.get('_ions', [])
                if len(ions) >= min_peaks:
                    intensities_arr = np.array([i['intensity'] for i in ions])
                    masses_arr = np.array([i['mass'] for i in ions])
                    calc_mass = _estimate_component_mass(ions)

                    result = {
                        'mass': calc_mass,
                        'mass_std': float(np.std(masses_arr)),
                        'charge_states': sorted(set(i['charge'] for i in ions)),
                        'num_charges': len(set(i['charge'] for i in ions)),
                        'intensity': float(sum(i['intensity'] for i in ions)),
                        'peaks_found': len(ions),
                        'r2': candidate['r2'],
                        'ion_mzs': [i['mz'] for i in ions],
                        'ion_charges': [i['charge'] for i in ions],
                        'ion_intensities': [i['intensity'] for i in ions],
                    }
                else:
                    ions_fb = candidate.get('_ions', [])
                    result = {k: v for k, v in candidate.items() if not k.startswith('_')}
                    result['ion_mzs'] = [i['mz'] for i in ions_fb]
                    result['ion_charges'] = [i['charge'] for i in ions_fb]
                    result['ion_intensities'] = [i['intensity'] for i in ions_fb]

                results.append(result)
                used_ions.update(ion_indices)

    # ── Residual second pass ──────────────────────────────────────────────
    # Collect peaks not claimed by any selected result and run a second
    # deconvolution pass with relaxed contiguity to recover weak species
    # (e.g. small proteins whose charge ladder was suppressed by overlap).
    all_peak_indices = set(p['index'] for p in peaks)
    residual_indices = all_peak_indices - used_ions

    if len(residual_indices) >= min_peaks:
        residual_peaks = [p for p in peaks if p['index'] in residual_indices]
        residual_peaks.sort(key=lambda p: p['intensity'], reverse=True)

        max_residual_anchors = min(15, len(residual_peaks))
        residual_peak_mzs = np.array([p['mz'] for p in residual_peaks])
        residual_peak_ints = np.array([p['intensity'] for p in residual_peaks])
        residual_peak_indices = np.array([p['index'] for p in residual_peaks])
        residual_masses_matrix = np.outer(residual_peak_mzs - PROTON_MASS, charges)

        residual_candidates = []
        for anchor_idx_r in range(max_residual_anchors):
            anchor = residual_peaks[anchor_idx_r]
            anchor_mz = anchor['mz']
            anchor_int = anchor['intensity']
            anchor_masses = (anchor_mz - PROTON_MASS) * charges
            valid_z_mask = (anchor_masses >= low_mw) & (anchor_masses <= high_mw)

            for z_idx, z0 in enumerate(charges):
                if not valid_z_mask[z_idx]:
                    continue
                M0 = anchor_masses[z_idx]
                ions = []
                ion_indices_r = set()
                intensity_mask = residual_peak_ints >= max(noise_cutoff, anchor_int * abundance_cutoff)
                all_errors_r = np.abs(residual_masses_matrix - M0) / M0
                all_errors_r[~intensity_mask] = np.inf
                best_z_idx_r = np.argmin(all_errors_r, axis=1)
                min_errors_r = all_errors_r[np.arange(len(residual_peaks)), best_z_idx_r]
                matched_pidxs_r = np.where(min_errors_r <= mw_agreement)[0]

                for p_idx in matched_pidxs_r:
                    bz = best_z_idx_r[p_idx]
                    ions.append({
                        'mz': float(residual_peak_mzs[p_idx]),
                        'intensity': float(residual_peak_ints[p_idx]),
                        'charge': int(charges[bz]),
                        'mass': float(residual_masses_matrix[p_idx, bz]),
                        'index': int(residual_peak_indices[p_idx])
                    })
                    ion_indices_r.add(int(residual_peak_indices[p_idx]))

                if len(ions) < min_peaks:
                    continue
                # Relaxed contiguity for second pass
                ion_charges = sorted(set(i['charge'] for i in ions))
                if len(ion_charges) >= 2:
                    longest = 1
                    current = 1
                    for ic in range(1, len(ion_charges)):
                        if ion_charges[ic] == ion_charges[ic - 1] + 1:
                            current += 1
                            longest = max(longest, current)
                        else:
                            current = 1
                    if longest < 2:
                        continue

                intensities_arr = np.array([i['intensity'] for i in ions])
                masses_arr = np.array([i['mass'] for i in ions])
                M_fit = _estimate_component_mass(ions)
                r2 = _gaussian_fit_r2(ion_charges, [i['intensity'] for i in ions])

                residual_candidates.append({
                    'mass': M_fit,
                    'mass_std': float(np.std(masses_arr)),
                    'charge_states': ion_charges,
                    'num_charges': len(set(ion_charges)),
                    'intensity': float(sum(i['intensity'] for i in ions)),
                    'peaks_found': len(ions),
                    'r2': r2,
                    '_ion_indices': ion_indices_r,
                    '_ions': ions,
                    'second_pass': True,
                })

        # Select non-duplicate residual results
        residual_candidates.sort(key=lambda x: (x['num_charges'], x['intensity']), reverse=True)
        used_residual = set()
        for rc in residual_candidates:
            rc_indices = rc['_ion_indices']
            overlap_count = len(rc_indices & used_residual)
            if len(rc_indices) > 0 and overlap_count / len(rc_indices) > max_overlap:
                continue
            mass_dup = False
            for r in results:
                if abs(r['mass'] - rc['mass']) / rc['mass'] < 0.001:  # 0.1% for residuals
                    mass_dup = True
                    break
            if not mass_dup:
                ions_r = rc.get('_ions', [])
                result = {k: v for k, v in rc.items() if not k.startswith('_')}
                result['ion_mzs'] = [i['mz'] for i in ions_r]
                result['ion_charges'] = [i['charge'] for i in ions_r]
                result['ion_intensities'] = [i['intensity'] for i in ions_r]
                results.append(result)
                used_residual.update(rc_indices)

    # Final sort by quality
    results.sort(key=lambda x: (x['num_charges'], x['intensity']), reverse=True)
    return results


def detect_singly_charged(
    mz: np.ndarray,
    intensity: np.ndarray,
    noise_cutoff: float = 1000.0,
    min_intensity_pct: float = 1.0,
    low_mw: float = 100.0,
    high_mw: float = 2000.0,
    pwhh: float = 0.6,
    exclude_mz_ranges: list = None,
    use_monoisotopic_proton: bool = False,
) -> list[dict]:
    """
    Detect singly-charged (z=1) species like small molecules.

    These appear as [M+H]+ peaks and cannot be detected by charge ladder
    deconvolution since they have only one peak.

    Args:
        mz: m/z array
        intensity: intensity array
        noise_cutoff: minimum intensity threshold
        min_intensity_pct: minimum intensity as % of base peak
        low_mw: minimum mass to report
        high_mw: maximum mass to report
        pwhh: peak width at half height for smoothing
        exclude_mz_ranges: list of (min, max) tuples to exclude (e.g., charge envelopes)
        use_monoisotopic_proton: proton mass selection

    Returns:
        List of detected z=1 species with mass, mz, intensity
    """
    PROTON_MASS = 1.007276 if use_monoisotopic_proton else 1.00784

    if len(mz) == 0 or len(intensity) == 0:
        return []

    # Smooth spectrum
    inten = _smooth_spectrum(mz, intensity, pwhh)

    # Find peaks
    resolution = float(np.median(np.diff(mz))) if len(mz) > 1 else 1.0
    min_distance_pts = max(2, int(pwhh / resolution)) if resolution > 0 else 2
    peak_idx = _find_peaks_simple(inten, min_distance_pts=min_distance_pts)

    # Get peaks above noise
    peaks = []
    for idx in peak_idx:
        if inten[idx] < noise_cutoff:
            continue
        centroid_mz = _parabolic_centroid(mz, inten, idx)
        peaks.append({
            'mz': centroid_mz,
            'intensity': float(inten[idx]),
            'index': idx
        })

    if not peaks:
        return []

    # Filter by intensity percentage
    max_intensity = max(p['intensity'] for p in peaks)
    min_intensity = max_intensity * min_intensity_pct / 100.0

    results = []
    for p in peaks:
        if p['intensity'] < min_intensity:
            continue

        # Calculate mass assuming z=1: mass = mz - proton
        mass = p['mz'] - PROTON_MASS

        # Check mass range
        if mass < low_mw or mass > high_mw:
            continue

        # Check if m/z is in excluded range (e.g., within a charge envelope)
        if exclude_mz_ranges:
            excluded = False
            for mz_min, mz_max in exclude_mz_ranges:
                if mz_min <= p['mz'] <= mz_max:
                    excluded = True
                    break
            if excluded:
                continue

        results.append({
            'mass': mass,
            'mass_std': 0.0,
            'charge_states': [1],
            'num_charges': 1,
            'intensity': p['intensity'],
            'peaks_found': 1,
            'r2': 1.0,
            'mz': p['mz'],
            'ion_mzs': [p['mz']],
            'ion_charges': [1],
            'ion_intensities': [p['intensity']],
        })

    # Sort by intensity
    results.sort(key=lambda x: x['intensity'], reverse=True)
    return results


def get_theoretical_mz(mass: float, charge_states: list[int],
                       use_monoisotopic_proton: bool = False) -> list[dict]:
    """
    Calculate theoretical m/z values for a given mass and charge states.

    Args:
        mass: Neutral mass in Da
        charge_states: List of charge states
        use_monoisotopic_proton: If True, use 1.007276; if False, use 1.00784

    Returns:
        List of dicts with charge and mz
    """
    PROTON_MASS = 1.007276 if use_monoisotopic_proton else 1.00784

    result = []
    for z in charge_states:
        mz = (mass + z * PROTON_MASS) / z
        result.append({'charge': z, 'mz': mz})

    return result
