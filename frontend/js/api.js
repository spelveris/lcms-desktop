/**
 * API client for LC-MS FastAPI backend.
 * All endpoints target http://127.0.0.1:8741
 * Uses the actual backend GET/POST endpoints.
 */

const API_BASE = 'http://127.0.0.1:8741';

/**
 * Generic fetch wrapper with error handling.
 */
async function apiFetch(endpoint, options = {}) {
  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`;
  const response = await fetch(url, options);

  if (!response.ok) {
    let errorMsg = `API Error ${response.status}`;
    try {
      const errData = await response.json();
      errorMsg = errData.detail || errData.message || errorMsg;
    } catch (_) {}
    throw new Error(errorMsg);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response;
}

function qs(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

// ---- Endpoints matching backend server.py ----

const api = {
  health() {
    return apiFetch('/api/health');
  },

  config() {
    return apiFetch('/api/config');
  },

  browse(path) {
    return apiFetch(`/api/browse?path=${encodeURIComponent(path)}`);
  },

  findDFolders(path, search) {
    return apiFetch(`/api/find-d-folders?${qs({ path, search })}`);
  },

  loadSample(path) {
    return apiFetch(`/api/load-sample?path=${encodeURIComponent(path)}`);
  },

  getUVChromatogram(path, wavelength, smooth) {
    return apiFetch(`/api/uv-chromatogram?${qs({ path, wavelength, smooth })}`);
  },

  getTIC(path) {
    return apiFetch(`/api/tic?path=${encodeURIComponent(path)}`);
  },

  getEIC(path, mz, window_, smooth) {
    return apiFetch(`/api/eic?${qs({ path, mz, window: window_, smooth })}`);
  },

  getMSSpectrum(path, time) {
    return apiFetch(`/api/ms-spectrum?${qs({ path, time })}`);
  },

  getSummedSpectrum(path, start, end) {
    return apiFetch(`/api/summed-spectrum?${qs({ path, start, end })}`);
  },

  findPeaks(path, dataType, opts = {}) {
    return apiFetch(`/api/peaks?${qs({
      path,
      data_type: dataType,
      wavelength: opts.wavelength,
      mz: opts.mz,
      mz_window: opts.mzWindow,
      smooth: opts.smooth,
      height_threshold: opts.heightThreshold,
      prominence: opts.prominence,
    })}`);
  },

  getPeakArea(path, dataType, start, end, opts = {}) {
    return apiFetch(`/api/peak-area?${qs({
      path,
      data_type: dataType,
      start,
      end,
      mz: opts.mz,
      mz_window: opts.mzWindow,
      wavelength: opts.wavelength,
      smooth: opts.smooth,
    })}`);
  },

  autoDetectWindow(path) {
    return apiFetch(`/api/detect-deconv-window?path=${encodeURIComponent(path)}`);
  },

  runDeconvolution(params) {
    const q = qs({
      path: params.path,
      start: params.start_time || params.start,
      end: params.end_time || params.end,
      min_charge: params.min_charge,
      max_charge: params.max_charge,
      mw_agreement: params.mw_agreement,
      contig_min: params.contig_min,
      abundance_cutoff: params.abundance_cutoff,
      envelope_cutoff: params.r2_cutoff || params.envelope_cutoff,
      max_overlap: params.max_overlap,
      pwhh: params.fwhm || params.pwhh,
      noise_cutoff: params.noise_cutoff,
      low_mw: params.mass_range_low || params.low_mw,
      high_mw: params.mass_range_high || params.high_mw,
      mw_assign_cutoff: params.mw_assign_cutoff,
      use_mz_agreement: params.use_mz_agreement,
      use_monoisotopic: params.monoisotopic || params.use_monoisotopic,
      include_singly_charged: params.include_singly_charged,
    });
    return apiFetch(`/api/deconvolute?${q}`, { method: 'POST' });
  },

  theoreticalMZ(mass, minCharge, maxCharge, useMonoisotopic) {
    return apiFetch(`/api/theoretical-mz?${qs({
      mass,
      min_charge: minCharge,
      max_charge: maxCharge,
      use_monoisotopic: useMonoisotopic,
    })}`);
  },

  clearCache() {
    return apiFetch('/api/cache', { method: 'DELETE' });
  },

  exportDeconvolutedMasses(payload) {
    return apiFetch('/api/export-deconvoluted-masses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  exportReportPdf(payload) {
    return apiFetch('/api/export-report-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  exportIonSelection(payload) {
    return apiFetch('/api/export-ion-selection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  getVolumes() {
    return apiFetch('/api/volumes');
  },

  /**
   * Convenience: get single sample data (UV + TIC + EICs) by making parallel calls.
   */
  async getSingleSampleData(params) {
    const path = params.path;
    const wavelengths = params.wavelengths || [];
    const mzTargets = params.mzTargets || params.mz_targets || [];
    const mzWindow = params.mzWindow ?? params.mz_window;
    const uvSmoothing = params.uvSmoothing ?? params.uv_smoothing ?? 0;
    const eicSmoothing = params.eicSmoothing ?? params.eic_smoothing ?? 0;

    const promises = [];

    // UV chromatograms
    const uvPromises = (wavelengths || []).map(wl =>
      this.getUVChromatogram(path, wl, uvSmoothing).catch(() => null)
    );
    promises.push(Promise.all(uvPromises));

    // TIC
    promises.push(this.getTIC(path).catch(() => null));

    // EICs
    const eicPromises = (mzTargets || []).map(mz =>
      this.getEIC(path, mz, mzWindow, eicSmoothing).catch(() => null)
    );
    promises.push(Promise.all(eicPromises));

    const [uvResults, ticResult, eicResults] = await Promise.all(promises);

    const uvWavelengths = uvResults
      .filter(Boolean)
      .map((uv) => ({
        nm: uv.wavelength,
        wavelength: uv.wavelength,
        times: uv.times || [],
        intensities: uv.intensities || [],
      }));

    const eicTargets = eicResults
      .filter(Boolean)
      .map((eic) => ({
        mz: eic.target_mz ?? eic.mz,
        target_mz: eic.target_mz ?? eic.mz,
        times: eic.times || [],
        intensities: eic.intensities || [],
      }));

    return {
      uv: { wavelengths: uvWavelengths },
      tic: ticResult || null,
      eic: { targets: eicTargets },
      eics: eicTargets, // Backward-compatible alias
      ms_scan_count: ticResult && Array.isArray(ticResult.times) ? ticResult.times.length : 0,
    };
  },

  /**
   * Run EIC batch: fetch EIC + peaks for each target m/z.
   */
  async runEICBatch(params) {
    const { path, targets, mz_window, smoothing } = params;

    const results = await Promise.all(targets.map(async (mz) => {
      const [eicData, peakData] = await Promise.all([
        this.getEIC(path, mz, mz_window, smoothing).catch(() => null),
        this.findPeaks(path, 'eic', { mz, mzWindow: mz_window, smooth: smoothing }).catch(() => ({ peaks: [] })),
      ]);

      const peaks = (peakData.peaks || []).map(p => ({
        apex: p.time,
        start: p.start_time ?? p.time,
        end: p.end_time ?? p.time,
        area: p.area ?? 0,
        intensity: p.intensity ?? 0,
        type: 'auto',
        selected: true,
      }));

      return {
        mz,
        times: eicData ? eicData.times : [],
        intensities: eicData ? eicData.intensities : [],
        peaks,
      };
    }));

    return { targets: results };
  },
};
