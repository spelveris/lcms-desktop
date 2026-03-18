/**
 * Main application logic for LC-MS Desktop Frontend.
 * Handles UI interactions, state management, and orchestrates API calls + chart rendering.
 */

// api and charts are loaded as global objects from their script tags

// ===== Application State =====
const CUSTOM_MOUNTS_STORAGE_KEY = 'lcms-custom-mounts';
const RUN_ROUTER_STORAGE_KEY = 'lcms-run-router-settings';
const RUN_ROUTER_LOG_STORAGE_KEY = 'lcms-run-router-recent-log';
const RUN_ROUTER_DEFAULT_MONITOR_LOOKBACK_DAYS = 7;
const DECONV_EXPERT_DEFAULTS = {
  minCharge: 1,
  maxCharge: 50,
  minIons: 3,
  mwAgreePct: 0.02,
  contigMin: 3,
  abundancePct: 5,
  envelopePct: 50,
  fwhm: 0.6,
  massLow: '',
  massHigh: '',
  noiseCutoff: '',
  monoisotopic: false,
};

const state = {
  currentPath: localStorage.getItem('lcms-browse-path') || '/',
  systemVolumes: [],
  customMountPaths: loadStoredCustomMounts(),
  runRouterSettings: loadStoredRunRouterSettings(),
  runRouterRecentLog: loadStoredRunRouterRecentLog(),
  runRouterBackendLogPath: '',
  deconvInteractionMode: localStorage.getItem('lcms-deconv-interaction-mode') || 'deconvolute',
  selectedFiles: JSON.parse(localStorage.getItem('lcms-selected-files') || '[]'),
  loadedSamples: {},      // path -> sample metadata
  mzTargets: JSON.parse(localStorage.getItem('lcms-mz-targets') || '[]'),
  sortMode: 'date-desc',
  singleSampleData: null,
  singleLoadInFlight: false,
  singleSpectrumSelections: {},
  backgroundSubtractionData: null,
  backgroundSubtractInFlight: false,
  progressionData: null,
  progressionLoadInFlight: false,
  uptakeAssayData: null,
  uptakeAssayEntries: {},
  uptakeAssayLoadInFlight: false,
  eicBatchData: null,
  eicBatchOriginalData: null,
  deconvResults: null,
  deconvDisplayComponents: [],
  deconvSamplePath: null,
  deconvTimeRange: null,
  deconvIonSelectionObjectUrl: null,
  deconvAutoRunSignature: '',
  deconvAutoRunInFlight: false,
  deconvDragSelectionInFlight: false,
  progressionAssignments: {},
  masscalcData: null,
  masscalcFigureUrls: { main: null, clean: null },
  batchDeconvData: null,
  batchDeconvPreviewUrls: {},
  batchDeconvTicCache: {},
  batchDeconvAutoRunSignature: '',
  batchDeconvAutoRunInFlight: false,
  eicCollapsedSections: {},
  timeChangeMSData: null,
  browseItems: [],
  watchInterval: null,
  watchKnownPaths: new Set(),
  runRouterResults: [],
  runRouterSummary: null,
  runRouterInterval: null,
  runRouterCycleInFlight: false,
  singleSketcher: null,
  singleSketcherType: '',
  singleSketcherWheelGuardBound: false,
  singleSketcherWheelHandler: null,
  emptyQuoteIndexes: {},
};

const DECONV_DISPLAY_TOP_N = 5;
const NPG_COLOR_PALETTE = [
  '#E64B35',
  '#4DBBD5',
  '#00A087',
  '#3C5488',
  '#F39B7F',
  '#8491B4',
  '#91D1C2',
  '#DC0000',
  '#7E6148',
  '#B09C85',
];

const PROTON_MASS = 1.007276466812;
const ADDUCT_SPECS = {
  '[M+H]+': { delta: PROTON_MASS, charge: 1 },
  '[M+Na]+': { delta: 22.989218, charge: 1 },
  '[M+K]+': { delta: 38.963158, charge: 1 },
  '[M+2H]2+': { delta: 2 * PROTON_MASS, charge: 2 },
  '[M-H]-': { delta: -PROTON_MASS, charge: -1 },
  '[M-2H]2-': { delta: -2 * PROTON_MASS, charge: -2 },
};

const FALLBACK_EMPTY_QUOTES = [
  { text: 'Data reveals patterns only after you ask a sharp question.', author: 'LCMS Desktop' },
  { text: 'Good analysis starts with a clean baseline and a clear hypothesis.', author: 'LCMS Desktop' },
  { text: 'Measure twice, deconvolute once.', author: 'LCMS Desktop' },
];

function loadStoredCustomMounts() {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_MOUNTS_STORAGE_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    return raw
      .map((entry) => {
        if (typeof entry === 'string') {
          const path = normalizeEnteredPath(entry);
          if (!path) return null;
          return { path, label: getPathLeafName(path) || path, source: '' };
        }
        if (!entry || typeof entry !== 'object') return null;
        const path = normalizeEnteredPath(entry.path);
        if (!path) return null;
        return {
          path,
          label: String(entry.label || getPathLeafName(path) || path).trim(),
          source: normalizeEnteredPath(entry.source || ''),
        };
      })
      .filter((entry) => {
        if (!entry || seen.has(entry.path)) return false;
        seen.add(entry.path);
        return true;
      });
  } catch (_) {
    return [];
  }
}

function loadStoredRunRouterSettings() {
  const defaults = {
    sourcePath: '',
    initialsRoot: '',
    recursive: true,
    autoCopy: true,
    pollSeconds: 15,
    monitorLookbackDays: RUN_ROUTER_DEFAULT_MONITOR_LOOKBACK_DAYS,
  };
  try {
    const raw = JSON.parse(localStorage.getItem(RUN_ROUTER_STORAGE_KEY) || '{}');
    if (!raw || typeof raw !== 'object') return defaults;
    return {
      sourcePath: normalizeEnteredPath(raw.sourcePath || ''),
      initialsRoot: normalizeEnteredPath(raw.initialsRoot || ''),
      recursive: raw.recursive !== false,
      autoCopy: raw.autoCopy !== false,
      pollSeconds: Math.max(5, Math.min(3600, parseInt(raw.pollSeconds, 10) || defaults.pollSeconds)),
      monitorLookbackDays: Math.max(
        0,
        Math.min(30, parseInt(raw.monitorLookbackDays, 10) || defaults.monitorLookbackDays)
      ),
    };
  } catch (_) {
    return defaults;
  }
}

function saveRunRouterSettings() {
  localStorage.setItem(RUN_ROUTER_STORAGE_KEY, JSON.stringify(state.runRouterSettings || {}));
}

function loadStoredRunRouterRecentLog() {
  try {
    const raw = JSON.parse(localStorage.getItem(RUN_ROUTER_LOG_STORAGE_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((entry) => entry && typeof entry === 'object')
      .slice(0, 50)
      .map((entry) => ({
        timestamp: String(entry.timestamp || ''),
        runName: String(entry.runName || ''),
        sourcePath: String(entry.sourcePath || ''),
        destinationPath: String(entry.destinationPath || ''),
        status: String(entry.status || 'scanned'),
        detail: String(entry.detail || ''),
      }));
  } catch (_) {
    return [];
  }
}

function saveRunRouterRecentLog() {
  localStorage.setItem(
    RUN_ROUTER_LOG_STORAGE_KEY,
    JSON.stringify((state.runRouterRecentLog || []).slice(0, 50))
  );
}

function saveCustomMounts() {
  localStorage.setItem(CUSTOM_MOUNTS_STORAGE_KEY, JSON.stringify(state.customMountPaths || []));
}

function normalizeEnteredPath(rawPath) {
  let path = String(rawPath || '').trim();
  if (!path) return '';
  if (
    (path.startsWith('"') && path.endsWith('"')) ||
    (path.startsWith("'") && path.endsWith("'"))
  ) {
    path = path.slice(1, -1).trim();
  }
  if (!path) return '';
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\') || path.startsWith('//')) {
    return path.replace(/\//g, '\\');
  }
  return path;
}

function getPathLeafName(path) {
  const cleaned = String(path || '').replace(/[\\/]+$/, '');
  if (!cleaned) return '';
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || cleaned;
}

function rememberCustomMountPath(resolvedPath, sourcePath = '') {
  const normalizedResolved = normalizeEnteredPath(resolvedPath);
  if (!normalizedResolved || normalizedResolved === '/') return;
  if (state.systemVolumes.some((vol) => vol.path === normalizedResolved)) return;

  const normalizedSource = normalizeEnteredPath(sourcePath);
  const entry = {
    path: normalizedResolved,
    label: getPathLeafName(normalizedResolved) || getPathLeafName(normalizedSource) || normalizedResolved,
    source: normalizedSource && normalizedSource !== normalizedResolved ? normalizedSource : '',
  };

  state.customMountPaths = [
    entry,
    ...(state.customMountPaths || []).filter((mount) => mount.path !== entry.path),
  ].slice(0, 8);
  saveCustomMounts();
  renderMountButtons();
}

function renderMountButtons() {
  const container = document.getElementById('mount-buttons');
  if (!container) return;

  const entries = [];
  const seen = new Set();

  (state.systemVolumes || []).forEach((vol) => {
    const path = normalizeEnteredPath(vol.path);
    if (!path || seen.has(path)) return;
    seen.add(path);
    entries.push({
      path,
      label: String(vol.name || getPathLeafName(path) || path),
      title: path,
    });
  });

  (state.customMountPaths || []).forEach((mount) => {
    const path = normalizeEnteredPath(mount.path);
    if (!path || seen.has(path)) return;
    seen.add(path);
    const source = normalizeEnteredPath(mount.source || '');
    entries.push({
      path,
      label: String(mount.label || getPathLeafName(path) || path),
      title: source && source !== path ? `${source} -> ${path}` : path,
    });
  });

  if (entries.length === 0) {
    container.innerHTML = '';
    container.style.display = 'none';
    return;
  }

  container.style.display = 'flex';
  container.innerHTML = '';
  entries.forEach((entry) => {
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm mount-btn';
    btn.textContent = entry.label;
    btn.title = entry.title;
    btn.addEventListener('click', () => browseTo(entry.path));
    container.appendChild(btn);
  });
}

// ===== Initialization =====
document.addEventListener('DOMContentLoaded', () => {
  initAppVersionBadge();
  initSidebar();
  initTabs();
  initSettings();
  initFileBrowser();
  initWatchFolder();
  initRunRouter();
  initSingleSample();
  initBackgroundSubtraction();
  initProgression();
  initUptakeAssayCC();
  initEICBatch();
  initDeconvolution();
  initBatchDeconvolution();
  initTimeChangeMS();
  initMassCalc();
  initReportExport();
  restoreState();
  renderDefaultTabEmptyStates();
  window.addEventListener('resize', () => schedulePlotlyResize(), { passive: true });
  window.addEventListener('focus', () => schedulePlotlyResize(), { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) schedulePlotlyResize();
  });
});

function getAppVersionLabel() {
  const fallback = 'vdev';
  try {
    const params = new URLSearchParams(window.location.search || '');
    const raw = String(params.get('appVersion') || window.LCMS_APP_VERSION || '').trim();
    if (!raw) return fallback;
    return raw.startsWith('v') ? raw : `v${raw}`;
  } catch (_) {
    return fallback;
  }
}

function initAppVersionBadge() {
  const el = document.getElementById('app-version-badge');
  if (!el) return;
  el.textContent = getAppVersionLabel();
}

// ===== Toast Notifications =====
function toast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  const msg = String(message || '').toLowerCase();
  const isLoadToast = msg.includes('loaded') || msg.startsWith('load:') || msg.startsWith('loaded:');
  const ttlMs = type === 'success' ? 2000 : (isLoadToast ? 2000 : 4000);
  setTimeout(() => { el.remove(); }, ttlMs);
}

// ===== Loading Overlay =====
function showLoading(text) {
  const overlay = document.getElementById('loading-overlay');
  overlay.classList.remove('hidden');
  const textEl = overlay.querySelector('.loading-text');
  if (textEl) textEl.textContent = text || 'Loading...';
}

function hideLoading() {
  document.getElementById('loading-overlay').classList.add('hidden');
}

function getQuotePool() {
  const pool = Array.isArray(window.LCMS_QUOTES) ? window.LCMS_QUOTES : [];
  if (pool.length > 0) return pool;
  return FALLBACK_EMPTY_QUOTES;
}

function pickQuoteIndex(slotKey, poolLength, disallow = -1, forceNew = false) {
  if (!Number.isFinite(poolLength) || poolLength <= 0) return 0;
  const existing = state.emptyQuoteIndexes[slotKey];
  if (!forceNew && Number.isInteger(existing) && existing >= 0 && existing < poolLength && existing !== disallow) {
    return existing;
  }

  let index = Math.floor(Math.random() * poolLength);
  if (poolLength > 1 && index === disallow) index = (index + 1) % poolLength;
  state.emptyQuoteIndexes[slotKey] = index;
  return index;
}

function renderQuoteEmptyState(containerId, keyPrefix, forceNew = false) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const pool = getQuotePool();
  if (pool.length === 0) {
    container.innerHTML = '';
    return;
  }

  const mainIdx = pickQuoteIndex(`${keyPrefix}-main`, pool.length, -1, forceNew);
  const main = pool[mainIdx] || pool[0];

  container.innerHTML = `
    <div class="quote-empty-card quote-empty-card-main">
      <div class="quote-empty-content">
        <div class="quote-empty-text">"${escapeHtml(main.text || '')}"</div>
        <div class="quote-empty-author">- ${escapeHtml(main.author || 'Unknown')}</div>
      </div>
    </div>
  `;
}

function setElementHidden(id, hidden) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('hidden', hidden);
}

function setDeconvolutionBusy(isBusy) {
  const runBtn = document.getElementById('btn-run-deconv');
  if (!runBtn) return;
  if (!runBtn.dataset.defaultLabel) {
    runBtn.dataset.defaultLabel = runBtn.textContent || 'Run Deconvolution';
  }
  runBtn.disabled = !!isBusy;
  runBtn.textContent = isBusy ? 'Deconvoluting...' : runBtn.dataset.defaultLabel;
}

function setQuoteContainerState(emptyId, keyPrefix, isEmpty, forceNew = false) {
  const empty = document.getElementById(emptyId);
  if (!empty) return;
  empty.classList.toggle('hidden', !isEmpty);
  if (isEmpty) renderQuoteEmptyState(emptyId, keyPrefix, forceNew);
}

function setSingleEmptyState(isEmpty, forceNew = false) {
  const empty = document.getElementById('single-empty-state');
  const results = document.getElementById('single-results');
  const metrics = document.getElementById('single-metrics');
  if (empty) {
    empty.classList.toggle('hidden', !isEmpty);
    if (isEmpty) renderQuoteEmptyState('single-empty-state', 'single', forceNew);
  }
  if (results) results.classList.toggle('hidden', isEmpty);
  if (metrics) metrics.classList.toggle('hidden', isEmpty);
}

function setBackgroundSubtractionEmptyState(isEmpty, forceNew = false) {
  const empty = document.getElementById('bgsub-empty-state');
  const results = document.getElementById('bgsub-results');
  const metrics = document.getElementById('bgsub-metrics');
  if (empty) {
    empty.classList.toggle('hidden', !isEmpty);
    if (isEmpty) renderQuoteEmptyState('bgsub-empty-state', 'background-subtraction', forceNew);
  }
  if (results) results.classList.toggle('hidden', isEmpty);
  if (metrics) metrics.classList.toggle('hidden', isEmpty);
}

function setEICBatchEmptyState(isEmpty, forceNew = false) {
  setQuoteContainerState('eic-empty-state', 'eic-batch', isEmpty, forceNew);
  setElementHidden('eic-batch-content', isEmpty);
}

function setDeconvEmptyState(isEmpty, forceNew = false) {
  setQuoteContainerState('deconv-empty-state', 'deconv', isEmpty, forceNew);
  setElementHidden('deconv-window-context', isEmpty);
  if (isEmpty) setElementHidden('deconv-results', true);
}

function setProgressionEmptyState(isEmpty, forceNew = false) {
  setQuoteContainerState('progression-empty-state', 'progression', isEmpty, forceNew);
  setElementHidden('progression-plots', isEmpty);
}

function setUptakeAssayEmptyState(isEmpty, forceNew = false) {
  setQuoteContainerState('uptake-assay-empty-state', 'uptake-assay', isEmpty, forceNew);
  setElementHidden('uptake-assay-content', isEmpty);
}

function setBatchDeconvEmptyState(isEmpty, forceNew = false) {
  setQuoteContainerState('batch-deconv-empty-state', 'batch-deconv', isEmpty, forceNew);
  setElementHidden('batch-deconv-content', isEmpty);
}

function setTimeChangeEmptyState(isEmpty, forceNew = false) {
  setQuoteContainerState('timechange-empty-state', 'timechange', isEmpty, forceNew);
  setElementHidden('timechange-content', isEmpty);
}

function setMasscalcEmptyState(isEmpty, forceNew = false) {
  setQuoteContainerState('masscalc-empty-state', 'masscalc', isEmpty, forceNew);
  setElementHidden('masscalc-results', isEmpty);
}

function setReportEmptyState(isEmpty, forceNew = false) {
  setQuoteContainerState('report-empty-state', 'report', isEmpty, forceNew);
  setElementHidden('report-summary', isEmpty);
}

function refreshVisibleTabQuote(tabId) {
  if (tabId === 'tab-single') {
    const visible = !document.getElementById('single-empty-state')?.classList.contains('hidden');
    if (visible) setSingleEmptyState(true, true);
    return;
  }
  if (tabId === 'tab-background-subtraction') {
    const visible = !document.getElementById('bgsub-empty-state')?.classList.contains('hidden');
    if (visible) setBackgroundSubtractionEmptyState(true, true);
    return;
  }
  if (tabId === 'tab-eic-batch') {
    const visible = !document.getElementById('eic-empty-state')?.classList.contains('hidden');
    if (visible) setEICBatchEmptyState(true, true);
    return;
  }
  if (tabId === 'tab-deconv') {
    const visible = !document.getElementById('deconv-empty-state')?.classList.contains('hidden');
    if (visible) setDeconvEmptyState(true, true);
    return;
  }
  if (tabId === 'tab-progression') {
    const visible = !document.getElementById('progression-empty-state')?.classList.contains('hidden');
    if (visible) setProgressionEmptyState(true, true);
    return;
  }
  if (tabId === 'tab-uptake-assay-cc') {
    const visible = !document.getElementById('uptake-assay-empty-state')?.classList.contains('hidden');
    if (visible) setUptakeAssayEmptyState(true, true);
    return;
  }
  if (tabId === 'tab-batch-deconv') {
    const visible = !document.getElementById('batch-deconv-empty-state')?.classList.contains('hidden');
    if (visible) setBatchDeconvEmptyState(true, true);
    return;
  }
  if (tabId === 'tab-time-change-ms') {
    const visible = !document.getElementById('timechange-empty-state')?.classList.contains('hidden');
    if (visible) setTimeChangeEmptyState(true, true);
    return;
  }
  if (tabId === 'tab-masscalc') {
    const visible = !document.getElementById('masscalc-empty-state')?.classList.contains('hidden');
    if (visible) setMasscalcEmptyState(true, true);
    return;
  }
  if (tabId === 'tab-report') {
    const visible = !document.getElementById('report-empty-state')?.classList.contains('hidden');
    if (visible) setReportEmptyState(true, true);
  }
}

function resetSingleSampleView() {
  const metrics = document.getElementById('single-metrics');
  const uv = document.getElementById('single-uv-plots');
  const tic = document.getElementById('single-tic-plot');
  const eic = document.getElementById('single-eic-plots');
  state.singleSpectrumSelections = {};
  if (metrics) metrics.innerHTML = '';
  if (uv) uv.innerHTML = '';
  if (tic) {
    tic.innerHTML = '';
    tic.className = 'plot-container';
  }
  if (eic) eic.innerHTML = '';
  setSingleEmptyState(true);
}

function getSingleSpectrumSelectionKey(polarity = null) {
  if (polarity === 'positive') return 'positive';
  if (polarity === 'negative') return 'negative';
  return 'default';
}

function getSingleSummedSpectrumPlaceholderHtml(panelLabel = '') {
  const labelText = panelLabel ? ` ${escapeHtml(panelLabel)}` : '';
  return `<p class="placeholder-msg">Drag over the TIC${labelText} to show the summed m/z spectrum for that retention-time window</p>`;
}

function renderSingleSummedSpectrumPlaceholder(plotId, panelLabel = '') {
  const el = document.getElementById(plotId);
  if (!el) return;
  el.innerHTML = getSingleSummedSpectrumPlaceholderHtml(panelLabel);
}

function getSingleSummedSpectrumXRange(mzValues) {
  if (!Array.isArray(mzValues) || mzValues.length === 0) return null;
  let maxMz = Number.NEGATIVE_INFINITY;
  mzValues.forEach((value) => {
    const mz = Number(value);
    if (Number.isFinite(mz) && mz > maxMz) maxMz = mz;
  });
  if (!Number.isFinite(maxMz) || maxMz <= 100) return null;
  return [100, Math.min(1000, maxMz)];
}

async function loadSingleSummedSpectrumWindow({ samplePath, plotId, start, end, polarity = null, panelLabel = '' }) {
  const plotEl = document.getElementById(plotId);
  if (!plotEl || !samplePath) return;

  const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  plotEl.dataset.requestToken = token;
  plotEl.innerHTML = '<p class="muted" style="padding:8px 4px;">Loading summed MS spectrum...</p>';

  try {
    const spectrum = await api.getSummedSpectrum(samplePath, start, end, polarity);
    if (!document.body.contains(plotEl) || plotEl.dataset.requestToken !== token) return;

    const labelSuffix = panelLabel ? ` ${panelLabel}` : '';
    charts.plotMassSpectrum(plotId, spectrum.mz || [], spectrum.intensities || [], [], {
      title: `Summed MS Spectrum${labelSuffix} (${start.toFixed(2)}-${end.toFixed(2)} min)`,
      xRange: getSingleSummedSpectrumXRange(spectrum.mz || []),
      heightPx: 300,
    });
    schedulePlotlyResize([plotId]);
  } catch (_) {
    if (!document.body.contains(plotEl) || plotEl.dataset.requestToken !== token) return;
    plotEl.innerHTML = `<p class="placeholder-msg">No summed MS spectrum could be generated for the selected TIC${panelLabel ? ` ${escapeHtml(panelLabel)}` : ''} window</p>`;
  }
}

function renderSingleInteractiveTicPlot({
  plotId,
  times,
  intensities,
  title,
  color,
  samplePath,
  polarity = null,
  panelLabel = '',
  spectrumPlotId,
}) {
  const selection = state.singleSpectrumSelections[getSingleSpectrumSelectionKey(polarity)] || null;
  charts.plotTIC(plotId, times, intensities, title, color, {
    startAtZero: true,
    dragmode: 'select',
    selectdirection: 'h',
    heightPx: 300,
    start: selection?.start,
    end: selection?.end,
    windowColor: 'rgba(255, 215, 0, 0.25)',
    showWindowAnnotation: false,
  });
  bindSingleTicSpectrumSelection(plotId, spectrumPlotId, samplePath, polarity, panelLabel, {
    times,
    intensities,
    title,
    color,
  });
}

function bindSingleTicSpectrumSelection(ticPlotId, spectrumPlotId, samplePath, polarity = null, panelLabel = '', renderArgs = null) {
  const plot = document.getElementById(ticPlotId);
  if (!plot || typeof plot.on !== 'function') return;

  if (typeof plot.removeAllListeners === 'function') {
    plot.removeAllListeners('plotly_selected');
  }

  plot.on('plotly_selected', async (eventData) => {
    if (!eventData) return;
    const points = Array.isArray(eventData.points) ? eventData.points : [];
    const startRaw = eventData.range?.x?.[0] ?? points[0]?.x;
    const endRaw = eventData.range?.x?.[1] ?? points[points.length - 1]?.x;
    const start = Number(startRaw);
    const end = Number(endRaw);

    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    if ((end - start) < 0.02) return;

    const normalizedStart = Math.max(0, Math.min(start, end));
    const normalizedEnd = Math.max(normalizedStart, end);
    state.singleSpectrumSelections[getSingleSpectrumSelectionKey(polarity)] = {
      start: normalizedStart,
      end: normalizedEnd,
    };

    if (renderArgs) {
      renderSingleInteractiveTicPlot({
        plotId: ticPlotId,
        times: renderArgs.times,
        intensities: renderArgs.intensities,
        title: renderArgs.title,
        color: renderArgs.color,
        samplePath,
        polarity,
        panelLabel,
        spectrumPlotId,
      });
    }

    await loadSingleSummedSpectrumWindow({
      samplePath,
      plotId: spectrumPlotId,
      start: normalizedStart,
      end: normalizedEnd,
      polarity,
      panelLabel,
    });
  });
}

function resetBackgroundSubtractionView() {
  const metrics = document.getElementById('bgsub-metrics');
  const uv = document.getElementById('bgsub-uv-plots');
  const tic = document.getElementById('bgsub-tic-plot');
  const spectrum = document.getElementById('bgsub-spectrum-plot');
  const spectrumTable = document.getElementById('bgsub-spectrum-table');
  const eic = document.getElementById('bgsub-eic-plots');
  if (metrics) metrics.innerHTML = '';
  if (uv) uv.innerHTML = '';
  if (tic) {
    tic.innerHTML = '';
    tic.className = 'plot-container';
  }
  if (spectrum) spectrum.innerHTML = '';
  if (spectrum) spectrum.className = 'plot-container';
  if (spectrumTable) {
    spectrumTable.innerHTML = '';
    spectrumTable.className = 'plot-container';
  }
  if (eic) eic.innerHTML = '';
  setBackgroundSubtractionEmptyState(true);
}

function resetEICBatchView() {
  const plot = document.getElementById('eic-combined-plot');
  const sections = document.getElementById('eic-peak-sections');
  const table = document.getElementById('eic-results-table-container');
  if (plot) plot.innerHTML = '';
  if (sections) sections.innerHTML = '';
  if (table) table.innerHTML = '';
  setEICBatchEmptyState(true);
}

function resetDeconvolutionView() {
  const uv = document.getElementById('deconv-uv-plot');
  const tic = document.getElementById('deconv-tic-plot');
  const table = document.getElementById('deconv-results-table-container');
  const ion = document.getElementById('deconv-ion-selection-plot');
  const detail = document.getElementById('deconv-ion-detail');
  const mass = document.getElementById('deconv-mass-plot');
  const spectrum = document.getElementById('deconv-spectrum-plot');
  if (uv) uv.innerHTML = '';
  if (tic) tic.innerHTML = '';
  if (table) table.innerHTML = '';
  if (ion) ion.innerHTML = '';
  if (detail) detail.innerHTML = '';
  if (mass) mass.innerHTML = '';
  if (spectrum) spectrum.innerHTML = '';
  setDeconvEmptyState(true);
}

function resetProgressionView() {
  const plots = document.getElementById('progression-plots');
  if (plots) plots.innerHTML = '';
  setProgressionEmptyState(true);
}

function resetUptakeAssayView() {
  const overlay = document.getElementById('uptake-assay-overlay-plot');
  const curve = document.getElementById('uptake-assay-curve-plot');
  const summary = document.getElementById('uptake-assay-summary');
  if (overlay) overlay.innerHTML = '';
  if (curve) curve.innerHTML = '';
  if (summary) summary.innerHTML = '';
  setUptakeAssayEmptyState(true);
}

function resetBatchDeconvView() {
  const summary = document.getElementById('batch-deconv-summary');
  const samples = document.getElementById('batch-deconv-samples');
  const table = document.getElementById('batch-deconv-table-container');
  if (summary) summary.innerHTML = '';
  if (samples) samples.innerHTML = '';
  if (table) table.innerHTML = '';
  setBatchDeconvEmptyState(true);
}

function resetTimeChangeView() {
  const plot = document.getElementById('timechange-ms-plot');
  const offset = document.getElementById('timechange-ms-offset-plot');
  const table = document.getElementById('timechange-ms-table-container');
  if (plot) plot.innerHTML = '';
  if (offset) offset.innerHTML = '';
  if (table) table.innerHTML = '';
  setTimeChangeEmptyState(true);
}

function resetMasscalcView() {
  const summary = document.getElementById('masscalc-summary');
  const mod = document.getElementById('masscalc-mod-table-container');
  const cmp = document.getElementById('masscalc-compare-table-container');
  const main = document.getElementById('masscalc-figure-main');
  const clean = document.getElementById('masscalc-figure-clean');
  if (summary) summary.innerHTML = '';
  if (mod) mod.innerHTML = '';
  if (cmp) cmp.innerHTML = '';
  if (main) main.innerHTML = '';
  if (clean) clean.innerHTML = '';
  setMasscalcEmptyState(true);
}

function renderDefaultTabEmptyStates() {
  if (state.singleSampleData) setSingleEmptyState(false);
  else resetSingleSampleView();

  if (state.backgroundSubtractionData) setBackgroundSubtractionEmptyState(false);
  else resetBackgroundSubtractionView();

  if (state.eicBatchData) setEICBatchEmptyState(false);
  else resetEICBatchView();

  const hasDeconvContext = Boolean(state.deconvResults || document.getElementById('deconv-sample-select')?.value);
  if (hasDeconvContext) setDeconvEmptyState(false);
  else resetDeconvolutionView();

  if (state.progressionData) setProgressionEmptyState(false);
  else resetProgressionView();

  if (state.uptakeAssayData) setUptakeAssayEmptyState(false);
  else resetUptakeAssayView();

  if (state.batchDeconvData) setBatchDeconvEmptyState(false);
  else resetBatchDeconvView();

  if (state.timeChangeMSData) setTimeChangeEmptyState(false);
  else resetTimeChangeView();

  if (state.masscalcData) setMasscalcEmptyState(false);
  else resetMasscalcView();

  renderReportSummary();
}

function resizePlotlyById(plotId) {
  if (!plotId || !(window.Plotly && window.Plotly.Plots && typeof window.Plotly.Plots.resize === 'function')) return;
  const el = document.getElementById(plotId);
  if (!el || !el.classList.contains('js-plotly-plot')) return;
  try {
    const width = Math.floor(el.clientWidth || 0);
    const fixedHeight = Number(el.dataset.fixedPlotHeight || 0);
    const height = Number.isFinite(fixedHeight) && fixedHeight > 0
      ? Math.floor(fixedHeight)
      : Math.floor(el.clientHeight || 0);
    if (Number.isFinite(fixedHeight) && fixedHeight > 0) {
      el.style.height = `${Math.floor(fixedHeight)}px`;
      el.style.minHeight = `${Math.floor(fixedHeight)}px`;
    }
    if (typeof window.Plotly.relayout === 'function' && width > 80 && height > 120) {
      window.Plotly.relayout(el, { width, height });
    }
    window.Plotly.Plots.resize(el);
  } catch (_) {
    // Ignore transient Plotly resize failures during layout transitions.
  }
}

function syncDeconvBottomLayout() {
  const spectrumPlot = document.getElementById('deconv-spectrum-plot');
  const massCard = document.querySelector('#deconv-results .deconv-mass-card');
  const massPlot = document.getElementById('deconv-mass-plot');
  if (!spectrumPlot || !massCard || !massPlot) return;

  const targetCardHeight = 440;
  spectrumPlot.style.height = `${targetCardHeight}px`;
  spectrumPlot.style.minHeight = `${targetCardHeight}px`;
  massCard.style.height = `${targetCardHeight}px`;
  massCard.style.minHeight = `${targetCardHeight}px`;

  const downloadRow = massCard.querySelector('.deconv-mass-download-row');
  const rowHeight = downloadRow ? downloadRow.offsetHeight : 0;
  const styles = window.getComputedStyle(massCard);
  const padTop = parseFloat(styles.paddingTop) || 0;
  const padBottom = parseFloat(styles.paddingBottom) || 0;
  const gap = 8;
  const plotHeight = Math.max(300, targetCardHeight - padTop - padBottom - rowHeight - gap);
  massPlot.style.height = `${plotHeight}px`;
  massPlot.style.minHeight = `${plotHeight}px`;

  const spectrumPlotHeight = Math.max(320, Math.floor(spectrumPlot.clientHeight || targetCardHeight));
  spectrumPlot.dataset.plotHeight = String(spectrumPlotHeight);
}

function schedulePlotlyResize(plotIds = []) {
  const ids = (Array.isArray(plotIds) && plotIds.length > 0)
    ? plotIds
    : [
      'deconv-spectrum-plot',
      'deconv-mass-plot',
      'deconv-uv-plot',
      'deconv-tic-plot',
      'deconv-ion-selection-plot',
      'single-tic-plot',
      'single-tic-plot-main',
      'single-tic-pos-plot',
      'single-tic-neg-plot',
      'single-spectrum-plot',
      'single-spectrum-pos-plot',
      'single-spectrum-neg-plot',
      'bgsub-tic-plot',
      'bgsub-spectrum-plot',
      'bgsub-tic-pos-plot',
      'bgsub-tic-neg-plot',
      'bgsub-spectrum-positive-plot',
      'bgsub-spectrum-negative-plot',
      'eic-overlay-plot',
      'uptake-assay-overlay-plot',
      'uptake-assay-curve-plot',
      'timechange-ms-plot',
      'timechange-ms-offset-plot',
    ];
  const includesDeconvBottom = ids.includes('deconv-spectrum-plot') || ids.includes('deconv-mass-plot');
  [0, 120, 280].forEach((delayMs) => {
    setTimeout(() => {
      if (includesDeconvBottom) syncDeconvBottomLayout();
      ids.forEach((id) => resizePlotlyById(id));
    }, delayMs);
  });
}

// ===== Sidebar =====
function initSidebar() {
  // Collapse/expand
  document.getElementById('sidebar-toggle-collapse').addEventListener('click', () => {
    document.getElementById('sidebar').classList.add('collapsed');
    document.getElementById('sidebar-expand').classList.remove('hidden');
    setTimeout(() => window.dispatchEvent(new Event('resize')), 180);
    schedulePlotlyResize();
  });

  document.getElementById('sidebar-expand').addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('collapsed');
    document.getElementById('sidebar-expand').classList.add('hidden');
    setTimeout(() => window.dispatchEvent(new Event('resize')), 180);
    schedulePlotlyResize();
  });

  // Collapsible sections
  document.querySelectorAll('.section-header[data-toggle]').forEach(header => {
    header.addEventListener('click', () => {
      const target = document.getElementById(header.dataset.toggle);
      if (target) {
        header.classList.toggle('collapsed');
        target.classList.toggle('collapsed');
      }
    });
  });

  // Collapsible settings sub-sections
  document.querySelectorAll('fieldset.settings-group legend[data-toggle]').forEach(legend => {
    legend.addEventListener('click', () => {
      const target = document.getElementById(legend.dataset.toggle);
      if (target) {
        legend.classList.toggle('collapsed');
        target.classList.toggle('collapsed');
      }
    });
  });
}

// ===== Tabs =====
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
      btn.classList.add('active');
      const panel = document.getElementById(btn.dataset.tab);
      if (panel) panel.classList.remove('hidden');
      refreshVisibleTabQuote(btn.dataset.tab);
      schedulePlotlyResize();
    });
  });
}

// ===== Settings =====
function initSettings() {
  // Slider value displays
  const sliderMap = {
    'uv-smoothing': 'uv-smooth-val',
    'eic-smoothing': 'eic-smooth-val',
    'mz-window': 'mz-window-val',
    'export-dpi': 'dpi-val',
    'fig-width': 'fig-width-val',
    'line-width': 'line-width-val',
  };

  Object.entries(sliderMap).forEach(([sliderId, displayId]) => {
    const slider = document.getElementById(sliderId);
    const display = document.getElementById(displayId);
    if (slider && display) {
      slider.addEventListener('input', () => { display.textContent = slider.value; });
    }
  });

  // m/z window slider (now in Single Sample tab toolbar)
  const mzWindowSlider = document.getElementById('mz-window');
  const mzWindowVal = document.getElementById('mz-window-val');
  if (mzWindowSlider && mzWindowVal) {
    mzWindowSlider.addEventListener('input', () => { mzWindowVal.textContent = mzWindowSlider.value; });
  }

  // Clear all m/z buttons
  const clearMzBtn = document.getElementById('btn-clear-mz');
  if (clearMzBtn) clearMzBtn.addEventListener('click', clearAllMzTargets);
  const eicClearMzBtn = document.getElementById('btn-eic-clear-mz');
  if (eicClearMzBtn) eicClearMzBtn.addEventListener('click', clearAllMzTargets);

  renderMzTargets();

  // Expert mode toggle
  document.getElementById('expert-mode-toggle').addEventListener('change', (e) => {
    document.getElementById('expert-params').classList.toggle('hidden', !e.target.checked);
  });
  const expertResetBtn = document.getElementById('btn-deconv-expert-reset');
  if (expertResetBtn) {
    expertResetBtn.addEventListener('click', () => {
      restoreDefaultDeconvExpertSettings();
      if (state.deconvResults) renderDeconvResults(state.deconvResults);
      if (state.batchDeconvData) renderBatchDeconvolution(state.batchDeconvData);
      toast('Expert defaults restored', 'success');
    });
  }

  function syncMassRangeInputs(source) {
    const axisMin = document.getElementById('mass-axis-min');
    const axisMax = document.getElementById('mass-axis-max');
    const expertMin = document.getElementById('dp-mass-low');
    const expertMax = document.getElementById('dp-mass-high');
    if (!axisMin || !axisMax || !expertMin || !expertMax) return;

    if (source === 'axis') {
      expertMin.value = axisMin.value;
      expertMax.value = axisMax.value;
      return;
    }
    if (source === 'expert') {
      axisMin.value = expertMin.value;
      axisMax.value = expertMax.value;
    }
  }

  // Keep Graph & Export mass axis limits and Expert mass range inputs visually synced.
  ['mass-axis-min', 'mass-axis-max'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => syncMassRangeInputs('axis'));
    el.addEventListener('change', () => syncMassRangeInputs('axis'));
  });
  ['dp-mass-low', 'dp-mass-high'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => syncMassRangeInputs('expert'));
    el.addEventListener('change', () => syncMassRangeInputs('expert'));
  });
  syncMassRangeInputs('axis');

  ['deconv-show-title', 'deconv-show-subtitle'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => {
      if (state.deconvResults) renderDeconvResults(state.deconvResults);
      if (state.batchDeconvData) renderBatchDeconvolution(state.batchDeconvData);
      if (state.masscalcData) renderMasscalcFigures();
    });
  });
}

function _getMzAddPolarity() {
  const sel = document.getElementById('mz-add-polarity');
  return sel ? sel.value : 'positive';
}

function addMzTargetFromInput(inputRef) {
  const input = typeof inputRef === 'string' ? document.getElementById(inputRef) : inputRef;
  if (!input) return false;
  const val = parseFloat(input.value);
  if (isNaN(val) || val <= 0) {
    toast('Enter a valid m/z value', 'warning');
    return false;
  }
  const polarity = _getMzAddPolarity();
  if (state.mzTargets.some((t) => Math.abs(t.mz - val) <= 1e-9 && t.polarity === polarity)) {
    toast('m/z already added', 'warning');
    return false;
  }
  state.mzTargets.push({ mz: val, polarity });
  normalizeMzTargets();
  input.value = '';
  saveMzTargets();
  renderMzTargets();
  return true;
}

function removeMzTarget(mz, polarity) {
  state.mzTargets = state.mzTargets.filter(
    (t) => !(Math.abs(t.mz - mz) <= 1e-9 && t.polarity === polarity)
  );
  normalizeMzTargets();
  saveMzTargets();
  renderMzTargets();
}

function clearAllMzTargets() {
  if (state.mzTargets.length === 0) return;
  state.mzTargets = [];
  saveMzTargets();
  renderMzTargets();
  toast('All m/z targets cleared', 'info');
}

function normalizeMzTargets() {
  const cleaned = [];
  (Array.isArray(state.mzTargets) ? state.mzTargets : []).forEach((raw) => {
    // Support legacy plain-number format from localStorage
    const t = (typeof raw === 'object' && raw !== null) ? raw : { mz: Number(raw), polarity: 'positive' };
    const mz = Number(t.mz);
    const polarity = t.polarity === 'negative' ? 'negative' : 'positive';
    if (!Number.isFinite(mz) || mz <= 0) return;
    if (cleaned.some((e) => Math.abs(e.mz - mz) <= 1e-9 && e.polarity === polarity)) return;
    cleaned.push({ mz, polarity });
  });
  cleaned.sort((a, b) => a.mz - b.mz || a.polarity.localeCompare(b.polarity));
  state.mzTargets = cleaned;
}

function saveMzTargets() {
  normalizeMzTargets();
  localStorage.setItem('lcms-mz-targets', JSON.stringify(state.mzTargets));
}

function renderMzTargets() {
  normalizeMzTargets();
  const containerIds = ['single-mz-targets-inline', 'eic-mz-targets-inline'];
  containerIds.forEach((id) => {
    const container = document.getElementById(id);
    if (!container) return;
    container.innerHTML = '';

    if (state.mzTargets.length === 0) {
      container.innerHTML = '<span class="muted">No m/z targets</span>';
      return;
    }

    state.mzTargets.forEach(({ mz, polarity }) => {
      const tag = document.createElement('span');
      const isNeg = polarity === 'negative';
      tag.className = `tag${isNeg ? ' tag-neg' : ' tag-pos'}`;
      tag.innerHTML = `${mz.toFixed(2)} <span class="tag-polarity">${isNeg ? '−' : '+'}</span> <button class="remove-tag" title="Remove">&times;</button>`;
      tag.querySelector('.remove-tag').addEventListener('click', () => removeMzTarget(mz, polarity));
      container.appendChild(tag);
    });
  });
}

// ===== File Browser =====
function initFileBrowser() {
  document.getElementById('btn-go').addEventListener('click', () => {
    const path = document.getElementById('path-input').value.trim();
    if (path) browseTo(path, { rememberMountCandidate: true, sourcePath: path });
  });

  document.getElementById('path-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const path = e.target.value.trim();
      if (path) browseTo(path, { rememberMountCandidate: true, sourcePath: path });
    }
  });

  document.getElementById('btn-up').addEventListener('click', () => {
    const parts = state.currentPath.replace(/\/+$/, '').split('/');
    parts.pop();
    const parent = parts.join('/') || '/';
    browseTo(parent);
  });

  document.getElementById('btn-home').addEventListener('click', async () => {
    try {
      const data = await api.config();
      browseTo(data.default_path || '/');
    } catch {
      browseTo('/');
    }
  });

  // Volumes / Drives button
  document.getElementById('btn-volumes').addEventListener('click', loadVolumes);

  // Auto-load volumes on startup
  loadVolumes();

  document.getElementById('sort-select').addEventListener('change', (e) => {
    state.sortMode = e.target.value;
    renderFileList();
  });

  document.getElementById('btn-clear-all').addEventListener('click', () => {
    state.selectedFiles = [];
    state.loadedSamples = {};
    state.singleSampleData = null;
    state.eicBatchData = null;
    state.eicBatchOriginalData = null;
    state.progressionData = null;
    state.uptakeAssayData = null;
    state.uptakeAssayEntries = {};
    state.deconvResults = null;
    state.deconvDisplayComponents = [];
    state.batchDeconvData = null;
    state.timeChangeMSData = null;
    state.masscalcData = null;
    state.deconvAutoRunSignature = '';
    state.batchDeconvAutoRunSignature = '';
    syncProgressionAssignmentsToSelectedFiles();
    refreshProgressionAssignmentsIfNeeded();
    syncUptakeAssayEntriesToSelectedFiles();
    refreshUptakeAssayInputsIfNeeded();
    saveSelectedFiles();
    updateWavelengthCheckboxes();
    resetSingleSampleView();
    resetEICBatchView();
    resetDeconvolutionView();
    resetProgressionView();
    resetUptakeAssayView();
    resetBatchDeconvView();
    resetTimeChangeView();
    resetMasscalcView();
    renderSelectedFiles();
    renderFileList();
    updateSampleDropdowns();
    renderDefaultTabEmptyStates();
  });
}

async function loadVolumes() {
  try {
    const data = await api.getVolumes();
    state.systemVolumes = Array.isArray(data.volumes) ? data.volumes : [];
    renderMountButtons();
  } catch (err) {
    state.systemVolumes = [];
    renderMountButtons();
  }
}

async function browseTo(path, options = {}) {
  const targetPath = normalizeEnteredPath(path);
  const silent = !!options.silent;
  const throwOnError = !!options.throwOnError;
  const rememberMountCandidate = !!options.rememberMountCandidate;
  const sourcePath = options.sourcePath || targetPath;
  try {
    const data = await api.browse(targetPath);
    state.currentPath = data.path;
    state.browseItems = data.items || [];
    document.getElementById('path-input').value = data.path;
    localStorage.setItem('lcms-browse-path', data.path);
    if (rememberMountCandidate) {
      rememberCustomMountPath(data.path, sourcePath);
    }
    renderFileList();
    return data;
  } catch (err) {
    if (!silent) toast(`Browse failed: ${err.message}`, 'error');
    if (throwOnError) throw err;
    return null;
  }
}

async function initializeBrowsePath() {
  const candidates = [];
  if (state.currentPath) candidates.push(state.currentPath);
  try {
    const cfg = await api.config();
    if (cfg && cfg.default_path) candidates.push(cfg.default_path);
  } catch (_) {
    // Ignore and keep fallbacks below.
  }

  candidates.push('/Users/dspelveris', '/Volumes', '/');

  const seen = new Set();
  for (const p of candidates) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    try {
      await browseTo(p, { silent: true, throwOnError: true });
      return;
    } catch (_) {
      // Try next fallback path.
    }
  }

  toast('Browse failed: could not open any default path', 'error');
}

function renderFileList() {
  const container = document.getElementById('file-list');
  let items = [...state.browseItems].filter((item) => {
    if (!item || item.is_dir || item.is_d_folder) return true;
    return !String(item.name || '').toLowerCase().endsWith('.pdf');
  });

  // Sort
  items = sortItems(items, state.sortMode);

  container.innerHTML = '';

  if (items.length === 0) {
    container.innerHTML = '<p class="muted" style="padding:12px;">Empty directory</p>';
    return;
  }

  // Separate: directories first, then .D folders
  const dirs = items.filter(i => i.is_dir && !i.is_d_folder);
  const dFolders = items.filter(i => i.is_d_folder);
  const others = items.filter(i => !i.is_dir && !i.is_d_folder);

  [...dirs, ...dFolders, ...others].forEach(item => {
    const el = document.createElement('div');
    el.className = 'file-item';

    if (item.is_d_folder) {
      const isWashPosition = item.is_wash_position === true;
      const isSelected = state.selectedFiles.some(f => f.path === item.path);
      if (isWashPosition) {
        el.classList.add('file-item-wash');
      }
      el.innerHTML = `
        <input type="checkbox" class="d-folder-check" data-path="${escapeAttr(item.path)}" data-name="${escapeAttr(item.name)}" ${isSelected ? 'checked' : ''}>
        <span class="file-icon d-folder">&#9670;</span>
        <span class="file-name" title="${escapeAttr(item.path)}">${escapeHtml(item.name)}</span>
        ${isWashPosition ? `<span class="file-item-badge" title="Autosampler location ${escapeAttr(String(item.sample_location || '91'))}">Wash ${escapeHtml(String(item.sample_location || '91'))}</span>` : ''}
      `;
      const checkbox = el.querySelector('.d-folder-check');
      checkbox.addEventListener('change', (e) => {
        if (e.target.checked) {
          selectFile(item);
        } else {
          deselectFile(item.path);
        }
      });
      el.style.cursor = 'pointer';
      el.addEventListener('click', (e) => {
        if (e.target === checkbox) return;
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      });
    } else if (item.is_dir) {
      el.innerHTML = `
        <span class="file-icon folder">&#128193;</span>
        <span class="file-name" title="${escapeAttr(item.path)}">${escapeHtml(item.name)}</span>
      `;
      el.addEventListener('click', () => browseTo(item.path));
      el.style.cursor = 'pointer';
    } else {
      el.innerHTML = `
        <span class="file-icon">&#128196;</span>
        <span class="file-name" title="${escapeAttr(item.path)}">${escapeHtml(item.name)}</span>
      `;
      el.style.opacity = '0.5';
    }

    container.appendChild(el);
  });
}

function sortItems(items, mode) {
  const sorted = [...items];
  const naturalNameCompare = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
  const washBias = (item) => (item && item.is_d_folder && item.is_wash_position ? 1 : 0);
  const applyWashBias = (a, b) => {
    const diff = washBias(a) - washBias(b);
    return diff !== 0 ? diff : null;
  };
  switch (mode) {
    case 'name-asc':
      sorted.sort((a, b) => applyWashBias(a, b) ?? naturalNameCompare(a.name, b.name));
      break;
    case 'name-desc':
      sorted.sort((a, b) => applyWashBias(a, b) ?? naturalNameCompare(b.name, a.name));
      break;
    case 'date-asc':
      sorted.sort((a, b) => applyWashBias(a, b) ?? ((a.modified || 0) - (b.modified || 0)));
      break;
    case 'date-desc':
    default:
      sorted.sort((a, b) => applyWashBias(a, b) ?? ((b.modified || 0) - (a.modified || 0)));
      break;
  }
  return sorted;
}

function selectFile(file) {
  if (!state.selectedFiles.some(f => f.path === file.path)) {
    state.selectedFiles.push(file);
    state.deconvAutoRunSignature = '';
    state.batchDeconvAutoRunSignature = '';
    state.uptakeAssayData = null;
    syncProgressionAssignmentsToSelectedFiles();
    refreshProgressionAssignmentsIfNeeded();
    syncUptakeAssayEntriesToSelectedFiles();
    refreshUptakeAssayInputsIfNeeded();
    saveSelectedFiles();
    renderSelectedFiles();
    updateSampleDropdowns();
    loadSampleMeta(file.path);
    renderReportSummary();
  }
}

function deselectFile(path) {
  state.selectedFiles = state.selectedFiles.filter(f => f.path !== path);
  delete state.loadedSamples[path];
  state.deconvAutoRunSignature = '';
  state.batchDeconvAutoRunSignature = '';
  state.uptakeAssayData = null;
  syncProgressionAssignmentsToSelectedFiles();
  refreshProgressionAssignmentsIfNeeded();
  syncUptakeAssayEntriesToSelectedFiles();
  refreshUptakeAssayInputsIfNeeded();
  saveSelectedFiles();
  renderSelectedFiles();
  renderFileList(); // update checkboxes
  updateSampleDropdowns();
  renderReportSummary();
}

function saveSelectedFiles() {
  localStorage.setItem('lcms-selected-files', JSON.stringify(state.selectedFiles));
}

function renderSelectedFiles() {
  const container = document.getElementById('selected-files-list');
  const count = document.getElementById('selected-count');
  const clearBtn = document.getElementById('btn-clear-all');

  count.textContent = state.selectedFiles.length;
  clearBtn.style.display = state.selectedFiles.length > 0 ? 'block' : 'none';

  if (state.selectedFiles.length === 0) {
    container.innerHTML = '<p class="muted">No files selected</p>';
    return;
  }

  container.innerHTML = '';
  state.selectedFiles.forEach(file => {
    const el = document.createElement('div');
    el.className = 'selected-file-item';
    el.innerHTML = `
      <span class="name" title="${escapeAttr(file.path)}">${escapeHtml(file.name)}</span>
      <button class="remove-btn" title="Remove">&times;</button>
    `;
    el.querySelector('.remove-btn').addEventListener('click', () => deselectFile(file.path));
    container.appendChild(el);
  });
}

function refreshProgressionAssignmentsIfNeeded() {
  const tab = document.getElementById('tab-progression');
  const container = document.getElementById('progression-assignments');
  if (!tab || !container) return;
  const tabIsVisible = !tab.classList.contains('hidden');
  if (tabIsVisible || container.children.length > 0) {
    renderProgressionAssignments();
  }
}

async function loadSampleMeta(path) {
  try {
    const meta = await api.loadSample(path);
    state.loadedSamples[path] = meta;
    updateWavelengthCheckboxes();
    const sampleLabel = meta.name || path.split(/[\\/]/).pop();
    if (meta.run_in_progress) {
      toast(`Loaded partial run: ${sampleLabel} (still acquiring, not cached)`, 'warning');
    } else {
      toast(`Loaded: ${sampleLabel}`, 'success');
    }
  } catch (err) {
    toast(`Failed to load sample: ${err.message}`, 'error');
  }
}

function updateWavelengthCheckboxes() {
  const container = document.getElementById('uv-wavelength-checks');
  // Collect all unique wavelengths across loaded samples
  const allWavelengths = new Set();
  Object.values(state.loadedSamples).forEach(meta => {
    (meta.uv_wavelengths || meta.wavelengths || []).forEach(wl => allWavelengths.add(wl));
  });

  if (allWavelengths.size === 0) {
    container.innerHTML = '<p class="muted">Load a sample to see wavelengths</p>';
    return;
  }

  const sorted = Array.from(allWavelengths).sort((a, b) => a - b);
  container.innerHTML = '';
  sorted.forEach(wl => {
    const label = document.createElement('label');
    label.className = 'checkbox-label';
    const isDefault = (wl === 194 || wl === '194');
    label.innerHTML = `<input type="checkbox" class="wl-check" value="${wl}" ${isDefault ? 'checked' : ''}> ${wl} nm`;
    container.appendChild(label);
  });
}

function getSelectedWavelengths() {
  return Array.from(document.querySelectorAll('.wl-check:checked')).map(cb => parseFloat(cb.value));
}

function updateSampleDropdowns() {
  const selects = [
    document.getElementById('single-sample-select'),
    document.getElementById('bgsub-sample-a-select'),
    document.getElementById('bgsub-sample-b-select'),
    document.getElementById('eic-sample-select'),
    document.getElementById('deconv-sample-select'),
    document.getElementById('masscalc-sample-select'),
    document.getElementById('report-sample-select'),
  ];

  selects.forEach(sel => {
    if (!sel) return;
    const currentVal = sel.value;
    sel.innerHTML = '<option value="">-- Select sample --</option>';
    state.selectedFiles.forEach(file => {
      const opt = document.createElement('option');
      opt.value = file.path;
      opt.textContent = file.name;
      sel.appendChild(opt);
    });
    // Restore selection if still valid
    if (state.selectedFiles.some(f => f.path === currentVal)) {
      sel.value = currentVal;
    }
  });

  syncBackgroundSubtractionSelections();
}

function syncBackgroundSubtractionSelections() {
  const backgroundSelect = document.getElementById('bgsub-background-select');
  const sampleASelect = document.getElementById('bgsub-sample-a-select');
  const sampleBSelect = document.getElementById('bgsub-sample-b-select');
  if (!backgroundSelect || !sampleASelect || !sampleBSelect) return;

  const candidatePaths = [sampleASelect.value, sampleBSelect.value]
    .filter(Boolean)
    .filter((path, index, arr) => arr.indexOf(path) === index);

  const currentBackground = backgroundSelect.value;
  if (candidatePaths.length === 0) {
    backgroundSelect.innerHTML = '<option value="">-- Choose two files first --</option>';
    return;
  }

  backgroundSelect.innerHTML = '<option value="">-- Select background --</option>';
  candidatePaths.forEach((path) => {
    const file = state.selectedFiles.find((entry) => entry.path === path);
    const opt = document.createElement('option');
    opt.value = path;
    opt.textContent = file?.name || path.split(/[\\/]/).pop() || path;
    backgroundSelect.appendChild(opt);
  });

  if (candidatePaths.includes(currentBackground)) {
    backgroundSelect.value = currentBackground;
  } else if (candidatePaths.length === 2) {
    backgroundSelect.value = candidatePaths[1];
  } else {
    backgroundSelect.value = candidatePaths[0];
  }
}

// ===== Background Subtraction Tab =====
function initBackgroundSubtraction() {
  const runBtn = document.getElementById('btn-run-bgsub');
  const sampleASelect = document.getElementById('bgsub-sample-a-select');
  const sampleBSelect = document.getElementById('bgsub-sample-b-select');
  const backgroundSelect = document.getElementById('bgsub-background-select');

  if (runBtn) runBtn.addEventListener('click', loadBackgroundSubtraction);
  [sampleASelect, sampleBSelect].forEach((sel) => {
    if (!sel) return;
    sel.addEventListener('change', () => {
      syncBackgroundSubtractionSelections();
    });
  });
  if (backgroundSelect) {
    backgroundSelect.addEventListener('change', () => {
      if (!backgroundSelect.value) return;
      const emptyVisible = !document.getElementById('bgsub-empty-state')?.classList.contains('hidden');
      if (emptyVisible) setBackgroundSubtractionEmptyState(true, true);
    });
  }

  syncBackgroundSubtractionSelections();
}

async function loadBackgroundSubtraction() {
  if (state.backgroundSubtractInFlight) return;

  const sampleAPath = document.getElementById('bgsub-sample-a-select')?.value || '';
  const sampleBPath = document.getElementById('bgsub-sample-b-select')?.value || '';
  const backgroundPath = document.getElementById('bgsub-background-select')?.value || '';

  if (!sampleAPath || !sampleBPath) {
    toast('Select two samples first', 'warning');
    return;
  }
  if (sampleAPath === sampleBPath) {
    toast('Choose two different samples for subtraction', 'warning');
    return;
  }
  if (!backgroundPath || (backgroundPath !== sampleAPath && backgroundPath !== sampleBPath)) {
    toast('Choose which selected file should be treated as the background', 'warning');
    return;
  }

  const samplePath = backgroundPath === sampleAPath ? sampleBPath : sampleAPath;
  const wavelengths = getSelectedWavelengths();
  const uvSmoothing = parseInt(document.getElementById('uv-smoothing').value, 10);
  const eicSmoothing = parseInt(document.getElementById('eic-smoothing').value, 10);
  const mzWindow = parseFloat(document.getElementById('mz-window').value);

  state.backgroundSubtractInFlight = true;
  showLoading('Subtracting background...');
  try {
    const data = await api.runBackgroundSubtraction({
      samplePath,
      backgroundPath,
      wavelengths,
      uvSmoothing,
      eicSmoothing,
      mzTargets: state.mzTargets,
      mzWindow,
    });
    state.backgroundSubtractionData = data;
    renderBackgroundSubtraction(data);
    toast('Background subtraction finished', 'success');
  } catch (err) {
    toast(`Background subtraction failed: ${err.message}`, 'error');
  } finally {
    state.backgroundSubtractInFlight = false;
    hideLoading();
  }
}

function renderBackgroundSubtraction(data) {
  setBackgroundSubtractionEmptyState(false);

  const metricsBar = document.getElementById('bgsub-metrics');
  metricsBar.innerHTML = '';

  const uvAvail = data.uv && data.uv.wavelengths && data.uv.wavelengths.length > 0;
  const hasDualTic = Boolean(data.tic && data.tic.has_dual_polarity);
  const msAvail = hasDualTic
    ? Boolean((data.tic.times_pos && data.tic.times_pos.length) || (data.tic.times_neg && data.tic.times_neg.length))
    : Boolean(data.tic && data.tic.times && data.tic.times.length);
  const scanCount = Number(data.ms_scan_count) || 0;
  const sampleTitle = data.sample_name || 'Sample';
  const backgroundTitle = data.background_name || 'Background';
  const sampleLabel = escapeHtml(sampleTitle);
  const backgroundLabel = escapeHtml(backgroundTitle);
  const residualChannels = (() => {
    if (Array.isArray(data.residual_channels) && data.residual_channels.length > 0) {
      return data.residual_channels;
    }
    if (data.spectrum || (Array.isArray(data.spectrum_peaks) && data.spectrum_peaks.length > 0)) {
      return [{
        polarity: data.spectrum_polarity === 'negative' ? 'negative' : 'positive',
        spectrum: data.spectrum || null,
        spectrum_peaks: Array.isArray(data.spectrum_peaks) ? data.spectrum_peaks : [],
      }];
    }
    return [];
  })();
  const residualChannelLabels = residualChannels.map((channel) => (
    channel.polarity === 'negative' ? 'Negative' : 'Positive'
  ));

  metricsBar.innerHTML = `
    <div class="metric"><span class="dot blue"></span> ${sampleLabel} - ${backgroundLabel}</div>
    <div class="metric"><span class="dot ${uvAvail ? 'green' : 'red'}"></span> UV Data ${uvAvail ? 'Available' : 'Not found'}</div>
    <div class="metric"><span class="dot ${msAvail ? 'green' : 'red'}"></span> MS Data ${msAvail ? 'Available' : 'Not found'}</div>
    ${residualChannelLabels.length > 0 ? `<div class="metric"><span class="dot blue"></span> Residual MS ${escapeHtml(residualChannelLabels.join(' + '))}</div>` : ''}
    ${msAvail ? `<div class="metric"><span class="dot blue"></span> ${scanCount} MS Scans</div>` : ''}
  `;

  const uvContainer = document.getElementById('bgsub-uv-plots');
  uvContainer.innerHTML = '';
  if (uvAvail) {
    const titleInput = document.getElementById('label-uv-panel');
    const baseTitle = (titleInput && titleInput.value) || 'UV Chromatogram';
    const plotTitle = `${baseTitle} (${sampleTitle} - ${backgroundTitle})`;

    if (data.uv.wavelengths.length > 1) {
      const combinedDiv = document.createElement('div');
      combinedDiv.className = 'plot-container';
      combinedDiv.id = 'bgsub-uv-combined-plot';
      uvContainer.appendChild(combinedDiv);
      charts.plotUV('bgsub-uv-combined-plot', data.uv.wavelengths, plotTitle);
    } else if (data.uv.wavelengths.length === 1) {
      const singleDiv = document.createElement('div');
      singleDiv.className = 'plot-container';
      singleDiv.id = 'bgsub-uv-plot-0';
      uvContainer.appendChild(singleDiv);
      charts.plotUV('bgsub-uv-plot-0', data.uv.wavelengths, `${plotTitle} (${data.uv.wavelengths[0].nm} nm)`);
    }

    if (data.uv.wavelengths.length > 2) {
      data.uv.wavelengths.forEach((wl, index) => {
        const div = document.createElement('div');
        div.className = 'plot-container';
        div.id = `bgsub-uv-plot-${index}`;
        uvContainer.appendChild(div);
        charts.plotUV(`bgsub-uv-plot-${index}`, [wl], `${plotTitle} (${wl.nm} nm)`);
      });
    }
  } else {
    uvContainer.innerHTML = '<p class="placeholder-msg">No UV data available for the selected subtraction</p>';
  }

  const ticContainer = document.getElementById('bgsub-tic-plot');
  ticContainer.innerHTML = '';
  if (hasDualTic) {
    const ticTitle = document.getElementById('label-tic-panel');
    const baseTitle = (ticTitle && ticTitle.value) || 'Total Ion Chromatogram';
    ticContainer.className = 'plot-stack';

    const posDiv = document.createElement('div');
    posDiv.className = 'plot-container';
    posDiv.id = 'bgsub-tic-pos-plot';
    ticContainer.appendChild(posDiv);
    charts.plotTIC('bgsub-tic-pos-plot', data.tic.times_pos, data.tic.intensities_pos, `${baseTitle} (+) (${sampleTitle} - ${backgroundTitle})`, '#1f77b4');

    const negDiv = document.createElement('div');
    negDiv.className = 'plot-container';
    negDiv.id = 'bgsub-tic-neg-plot';
    ticContainer.appendChild(negDiv);
    charts.plotTIC('bgsub-tic-neg-plot', data.tic.times_neg, data.tic.intensities_neg, `${baseTitle} (-) (${sampleTitle} - ${backgroundTitle})`, '#d62728');
  } else if (data.tic && data.tic.times && data.tic.times.length > 0) {
    const ticTitle = document.getElementById('label-tic-panel');
    ticContainer.className = 'plot-container';
    charts.plotTIC('bgsub-tic-plot', data.tic.times, data.tic.intensities, `${(ticTitle && ticTitle.value) || 'Total Ion Chromatogram'} (${sampleTitle} - ${backgroundTitle})`);
  } else {
    ticContainer.className = 'plot-container';
    ticContainer.innerHTML = '<p class="placeholder-msg">No TIC data available for the selected subtraction</p>';
  }

  const spectrumContainer = document.getElementById('bgsub-spectrum-plot');
  const spectrumTable = document.getElementById('bgsub-spectrum-table');
  if (spectrumContainer) {
    spectrumContainer.innerHTML = '';
    if (residualChannels.length > 0) {
      spectrumContainer.className = 'plot-stack';
      residualChannels.forEach((channel) => {
        const polarity = channel.polarity === 'negative' ? 'negative' : 'positive';
        const polarityLabel = polarity === 'negative' ? 'Negative' : 'Positive';
        const plotId = `bgsub-spectrum-${polarity}-plot`;
        const plotWrap = document.createElement('div');
        plotWrap.className = 'plot-container';
        plotWrap.id = plotId;
        spectrumContainer.appendChild(plotWrap);
        if (channel.spectrum && Array.isArray(channel.spectrum.mz) && channel.spectrum.mz.length > 0) {
          charts.plotMassSpectrum(plotId, channel.spectrum.mz, channel.spectrum.intensities || [], [], {
            title: `Residual Mass Spectrum (${polarityLabel} Channel, ${sampleTitle} - ${backgroundTitle})`,
          });
        } else {
          plotWrap.innerHTML = `<p class="placeholder-msg">No summed MS spectrum available on the ${escapeHtml(polarityLabel.toLowerCase())} channel</p>`;
        }
      });
    } else {
      spectrumContainer.className = 'plot-container';
      spectrumContainer.innerHTML = '<p class="placeholder-msg">No summed MS spectrum available for the selected subtraction</p>';
    }
  }

  if (spectrumTable) {
    spectrumTable.innerHTML = '';
    if (residualChannels.length === 0) {
      spectrumTable.className = 'plot-container';
      spectrumTable.innerHTML = '<p class="placeholder-msg">No dominant residual m/z peaks were detected after subtraction</p>';
    } else {
      spectrumTable.className = 'plot-stack';
      residualChannels.forEach((channel) => {
        const polarity = channel.polarity === 'negative' ? 'negative' : 'positive';
        const polarityLabel = polarity === 'negative' ? 'Negative' : 'Positive';
        const peaks = Array.isArray(channel.spectrum_peaks) ? channel.spectrum_peaks : [];
        const card = document.createElement('div');
        card.className = 'plot-container';
        if (peaks.length === 0) {
          card.innerHTML = `
            <div class="toolbar-note">Strongest single residual chromatographic peak per m/z. If one mass appears at multiple retention times, only the highest apex is kept.</div>
            <div class="toolbar-note">Residual peak channel: ${escapeHtml(polarityLabel)}</div>
            <p class="placeholder-msg">No dominant residual m/z peaks were detected after subtraction on the ${escapeHtml(polarityLabel.toLowerCase())} channel</p>
          `;
        } else {
          const rows = peaks.map((peak) => `
            <tr>
              <td>${escapeHtml(String(peak.polarity || polarity))}</td>
              <td>${Number(peak.mz).toFixed(4)}</td>
              <td>${Number(peak.apex_time).toFixed(3)}</td>
              <td>${Number(peak.intensity).toExponential(3)}</td>
              <td>${Number(peak.area).toExponential(3)}</td>
              <td>${Number(peak.relative_intensity).toFixed(1)}%</td>
            </tr>
          `).join('');
          card.innerHTML = `
            <div class="toolbar-note">Strongest single residual chromatographic peak per m/z. If one mass appears at multiple retention times, only the highest apex is kept.</div>
            <div class="toolbar-note">Residual peak channel: ${escapeHtml(polarityLabel)}</div>
            <div class="data-table-wrapper">
              <table class="data-table">
                <thead>
                  <tr><th>Polarity</th><th>m/z</th><th>Apex RT</th><th>Apex Intensity</th><th>Peak Area</th><th>Relative</th></tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          `;
        }
        spectrumTable.appendChild(card);
      });
    }
  }

  const eicContainer = document.getElementById('bgsub-eic-plots');
  eicContainer.innerHTML = '';
  if (data.eic && data.eic.targets && data.eic.targets.length > 0) {
    const eicXRange = (() => {
      let maxTime = Number.NEGATIVE_INFINITY;
      (data.eic.targets || []).forEach((target) => {
        (target.times || []).forEach((tv) => {
          const t = Number(tv);
          if (Number.isFinite(t) && t > maxTime) maxTime = t;
        });
      });
      return Number.isFinite(maxTime) && maxTime > 0 ? [0, maxTime] : null;
    })();

    const combinedDiv = document.createElement('div');
    combinedDiv.className = 'plot-container';
    combinedDiv.id = 'bgsub-eic-combined';
    eicContainer.appendChild(combinedDiv);
    charts.plotEIC('bgsub-eic-combined', data.eic.targets, `Background-Subtracted EICs (${sampleTitle} - ${backgroundTitle})`, {
      xRange: eicXRange,
    });

    data.eic.targets.forEach((target, index) => {
      const div = document.createElement('div');
      div.className = 'plot-container';
      div.id = `bgsub-eic-${index}`;
      eicContainer.appendChild(div);
      const traceColor = charts.getColor(index);
      const polarityLabel = target.polarity === 'negative' ? ' (-)' : ' (+)';
      charts.plotEIC(`bgsub-eic-${index}`, [target], `Background-Subtracted EIC m/z ${target.mz.toFixed(2)}${polarityLabel}`, {
        xRange: eicXRange,
        colorIndexStart: index,
        traceColor,
        titleColor: traceColor,
      });
    });
  } else if (state.mzTargets.length === 0) {
    eicContainer.innerHTML = '<p class="placeholder-msg">Add target m/z values to compare background-subtracted EICs</p>';
  } else {
    eicContainer.innerHTML = '<p class="placeholder-msg">No EIC data available for the selected subtraction</p>';
  }
}

// ===== Single Sample Tab =====
function initSingleSample() {
  document.getElementById('btn-load-single').addEventListener('click', loadSingleSample);
  const singleSelect = document.getElementById('single-sample-select');
  if (singleSelect) {
    singleSelect.addEventListener('change', () => {
      if (!singleSelect.value) return;
      loadSingleSample({ silentNoSelection: true });
    });
  }
  const singleAddBtn = document.getElementById('btn-single-add-mz');
  const singleAddInput = document.getElementById('single-mz-add-input');
  if (singleAddBtn && singleAddInput) {
    singleAddBtn.addEventListener('click', () => addMzTargetFromInput(singleAddInput));
    singleAddInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addMzTargetFromInput(singleAddInput);
    });
  }

  const smilesInput = document.getElementById('single-smiles-input');
  const smilesBtn = document.getElementById('btn-single-smiles-to-target');
  const sketcherToggleBtn = document.getElementById('btn-single-toggle-sketcher');
  const useDrawnBtn = document.getElementById('btn-single-use-drawn');
  if (smilesBtn) smilesBtn.addEventListener('click', () => addSmilesMzTarget());
  if (smilesInput) {
    smilesInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addSmilesMzTarget();
      }
    });
  }
  if (sketcherToggleBtn) sketcherToggleBtn.addEventListener('click', () => toggleSingleSketcher());
  if (useDrawnBtn) useDrawnBtn.addEventListener('click', () => useDrawnStructureAsSmiles());

  // Export buttons
  document.querySelectorAll('.btn-export').forEach(btn => {
    btn.addEventListener('click', () => exportSingle(btn.dataset.format));
  });
}

function setSingleSmilesResult(message, tone = 'muted') {
  const resultEl = document.getElementById('single-smiles-result');
  if (!resultEl) return;
  resultEl.textContent = message;
  if (tone === 'error') {
    resultEl.style.color = 'var(--danger)';
  } else if (tone === 'success') {
    resultEl.style.color = 'var(--success)';
  } else {
    resultEl.style.color = 'var(--text-muted)';
  }
}

function getSingleSmilesAdduct() {
  const adductSel = document.getElementById('single-smiles-adduct');
  const key = adductSel ? adductSel.value : 'auto';
  if (key === 'auto') return 'auto';
  return ADDUCT_SPECS[key] ? key : 'auto';
}

function normalizeSmilesMassForAdduct(exactMass, netCharge) {
  const numericMass = Number(exactMass);
  const numericCharge = Number(netCharge || 0);
  if (!Number.isFinite(numericMass) || numericMass <= 0) return numericMass;
  if (!Number.isFinite(numericCharge) || numericCharge === 0) return numericMass;
  return numericMass - (numericCharge * PROTON_MASS);
}

async function computeSmilesMz(smiles, adductKey) {
  const props = await api.computeSmiles(smiles);
  const formula = String(props.formula || '');
  const exactMass = Number(props.exact_mass);
  const netCharge = Number(props.net_charge || 0);
  if (!Number.isFinite(exactMass) || exactMass <= 0) {
    throw new Error('Unable to calculate molecular mass from this SMILES');
  }

  let mz;
  let modeLabel;
  const neutralizedMass = normalizeSmilesMassForAdduct(exactMass, netCharge);
  if (adductKey === 'auto') {
    if (netCharge !== 0) {
      const ionMode = document.querySelector('input[name="ion-mode"]:checked')?.value || 'positive';
      const autoAdductKey = ionMode === 'negative' ? '[M-H]-' : '[M+H]+';
      const adduct = ADDUCT_SPECS[autoAdductKey];
      const denom = Math.abs(Number(adduct.charge) || 1);
      mz = (neutralizedMass + Number(adduct.delta || 0)) / denom;
      modeLabel = `${autoAdductKey} (auto from ${ionMode} mode; normalized from formal charge ${netCharge > 0 ? `+${netCharge}` : String(netCharge)})`;
    } else {
      const ionMode = document.querySelector('input[name="ion-mode"]:checked')?.value || 'positive';
      const autoAdductKey = ionMode === 'negative' ? '[M-H]-' : '[M+H]+';
      const adduct = ADDUCT_SPECS[autoAdductKey];
      const denom = Math.abs(Number(adduct.charge) || 1);
      mz = (exactMass + Number(adduct.delta || 0)) / denom;
      modeLabel = `${autoAdductKey} (auto from ${ionMode} mode)`;
    }
  } else {
    const adduct = ADDUCT_SPECS[adductKey] || ADDUCT_SPECS['[M+H]+'];
    const denom = Math.abs(Number(adduct.charge) || 1);
    mz = (neutralizedMass + Number(adduct.delta || 0)) / denom;
    modeLabel = netCharge !== 0
      ? `${adductKey} (normalized from formal charge ${netCharge > 0 ? `+${netCharge}` : String(netCharge)})`
      : adductKey;
  }

  if (!Number.isFinite(mz) || mz <= 0) {
    throw new Error('Calculated m/z is invalid');
  }

  return { formula, exactMass, neutralizedMass, mz, adductKey: modeLabel, netCharge };
}

async function addSmilesMzTarget(smilesOverride = '') {
  const smilesInput = document.getElementById('single-smiles-input');
  const mzInput = document.getElementById('single-mz-add-input');
  if (!smilesInput || !mzInput) return;

  const smiles = String(smilesOverride || smilesInput.value || '').trim();
  if (!smiles) {
    toast('Enter a SMILES string first', 'warning');
    return;
  }

  const adductKey = getSingleSmilesAdduct();
  showLoading('Calculating m/z from SMILES...');
  try {
    const result = await computeSmilesMz(smiles, adductKey);
    mzInput.value = result.mz.toFixed(4);
    // Set polarity selector to match the adduct before adding
    const polaritySel = document.getElementById('mz-add-polarity');
    if (polaritySel) {
      polaritySel.value = result.adductKey.includes('-') && result.adductKey.includes('[M') ? 'negative' : 'positive';
    }
    const added = addMzTargetFromInput(mzInput);
    const massText = result.netCharge !== 0
      ? `Exact ion mass ${result.exactMass.toFixed(5)} Da | Neutralized mass ${result.neutralizedMass.toFixed(5)} Da`
      : `Exact mass ${result.exactMass.toFixed(5)} Da`;
    setSingleSmilesResult(
      `${result.formula || 'Formula n/a'} | ${massText} | ${result.adductKey}: m/z ${result.mz.toFixed(4)}`,
      'success'
    );
    if (added) toast(`Added m/z ${result.mz.toFixed(4)} from SMILES`, 'success');
  } catch (err) {
    setSingleSmilesResult(`SMILES calculation failed: ${err.message}`, 'error');
    toast(`SMILES calculation failed: ${err.message}`, 'error');
  } finally {
    hideLoading();
  }
}

// JSME runs inside an iframe (jsme-frame.html) for complete CSS isolation.
let _jsmeReady = false;

function _jsmeFrame() {
  return document.getElementById('single-sketcher-frame');
}

function _initJsmeInFrame() {
  return new Promise((resolve, reject) => {
    const frame = _jsmeFrame();
    if (!frame || !frame.contentWindow) { reject(new Error('Sketcher frame missing')); return; }

    const timeout = setTimeout(() => { reject(new Error('JSME init timed out')); }, 15000);

    function onMsg(e) {
      if (!e.data || !e.data.type) return;
      if (e.data.type === 'jsme-ready') {
        clearTimeout(timeout);
        window.removeEventListener('message', onMsg);
        _jsmeReady = true;
        resolve();
      }
      if (e.data.type === 'jsme-error') {
        clearTimeout(timeout);
        window.removeEventListener('message', onMsg);
        reject(new Error(e.data.msg || 'JSME error'));
      }
    }
    window.addEventListener('message', onMsg);

    const w = Math.max(420, frame.clientWidth || 760);
    const h = Math.max(380, frame.clientHeight || 420);
    frame.contentWindow.postMessage({ type: 'jsme-init', width: w, height: h }, '*');
  });
}

function _getSmilesFromFrame() {
  return new Promise((resolve) => {
    const frame = _jsmeFrame();
    if (!frame || !frame.contentWindow) { resolve(''); return; }

    const timeout = setTimeout(() => resolve(''), 3000);
    function onMsg(e) {
      if (e.data && e.data.type === 'jsme-smiles') {
        clearTimeout(timeout);
        window.removeEventListener('message', onMsg);
        resolve(String(e.data.smiles || '').trim());
      }
    }
    window.addEventListener('message', onMsg);
    frame.contentWindow.postMessage({ type: 'jsme-get-smiles' }, '*');
  });
}

async function toggleSingleSketcher() {
  const wrap = document.getElementById('single-sketcher-wrap');
  const btn = document.getElementById('btn-single-toggle-sketcher');
  if (!wrap || !btn) return;

  const opening = wrap.classList.contains('hidden');
  if (!opening) {
    wrap.classList.add('hidden');
    btn.textContent = 'Draw Molecule';
    return;
  }

  wrap.classList.remove('hidden');
  btn.textContent = 'Hide Drawer';

  if (!_jsmeReady) {
    showLoading('Loading molecule drawer...');
    try {
      await _initJsmeInFrame();
    } catch (err) {
      wrap.classList.add('hidden');
      btn.textContent = 'Draw Molecule';
      toast(`Molecule drawer failed: ${err.message}`, 'error');
    } finally {
      hideLoading();
    }
  }
}

async function useDrawnStructureAsSmiles() {
  try {
    if (!_jsmeReady) { toast('Open the molecule drawer first', 'warning'); return; }
    const smiles = await _getSmilesFromFrame();
    if (!smiles) {
      toast('Draw a molecule first', 'warning');
      return;
    }
    const smilesInput = document.getElementById('single-smiles-input');
    if (smilesInput) smilesInput.value = smiles;
    await addSmilesMzTarget(smiles);
  } catch (err) {
    toast(`Could not use drawn structure: ${err.message}`, 'error');
  }
}

async function loadSingleSample(options = {}) {
  if (state.singleLoadInFlight) return;
  const samplePath = document.getElementById('single-sample-select').value;
  if (!samplePath) {
    if (!options.silentNoSelection) toast('Select a sample first', 'warning');
    return;
  }

  const wavelengths = getSelectedWavelengths();
  const ionMode = document.querySelector('input[name="ion-mode"]:checked').value;
  const uvSmoothing = parseInt(document.getElementById('uv-smoothing').value);
  const eicSmoothing = parseInt(document.getElementById('eic-smoothing').value);
  const mzWindow = parseFloat(document.getElementById('mz-window').value);

  state.singleLoadInFlight = true;
  showLoading('Analyzing sample...');
  try {
    state.singleSpectrumSelections = {};
    const data = await api.getSingleSampleData({
      path: samplePath,
      wavelengths,
      ionMode,
      uvSmoothing,
      eicSmoothing,
      mzTargets: state.mzTargets,
      mzWindow,
    });

    state.singleSampleData = data;
    renderSingleSample(data);
    renderReportSummary();
    toast('Sample loaded successfully', 'success');
  } catch (err) {
    toast(`Analysis failed: ${err.message}`, 'error');
  } finally {
    state.singleLoadInFlight = false;
    hideLoading();
  }
}

function renderSingleSample(data) {
  setSingleEmptyState(false);
  const samplePath = document.getElementById('single-sample-select')?.value || '';
  const singlePlotIds = [];

  // Metrics
  const metricsBar = document.getElementById('single-metrics');
  metricsBar.innerHTML = '';

  const uvAvail = data.uv && data.uv.wavelengths && data.uv.wavelengths.length > 0;
  const msAvail = data.tic && data.tic.times && data.tic.times.length > 0;
  const scanCount = data.ms_scan_count || (msAvail ? data.tic.times.length : 0);

  metricsBar.innerHTML = `
    <div class="metric"><span class="dot ${uvAvail ? 'green' : 'red'}"></span> UV Data ${uvAvail ? 'Available' : 'Not found'}</div>
    <div class="metric"><span class="dot ${msAvail ? 'green' : 'red'}"></span> MS Data ${msAvail ? 'Available' : 'Not found'}</div>
    ${msAvail ? `<div class="metric"><span class="dot blue"></span> ${scanCount} MS Scans</div>` : ''}
  `;

  // UV plots
  const uvContainer = document.getElementById('single-uv-plots');
  uvContainer.innerHTML = '';
  if (data.uv && data.uv.wavelengths) {
    const titleInput = document.getElementById('label-uv-panel');
    const uvTitle = (titleInput && titleInput.value) || 'UV Chromatogram';

    if (data.uv.wavelengths.length > 1) {
      // One combined plot
      const div = document.createElement('div');
      div.className = 'plot-container';
      div.id = 'uv-combined-plot';
      uvContainer.appendChild(div);
      charts.plotUV('uv-combined-plot', data.uv.wavelengths, uvTitle);
    } else if (data.uv.wavelengths.length === 1) {
      const div = document.createElement('div');
      div.className = 'plot-container';
      div.id = 'uv-plot-0';
      uvContainer.appendChild(div);
      charts.plotUV('uv-plot-0', data.uv.wavelengths, `${uvTitle} (${data.uv.wavelengths[0].nm} nm)`);
    }

    // Also plot individual wavelengths if more than 2
    if (data.uv.wavelengths.length > 2) {
      data.uv.wavelengths.forEach((wl, i) => {
        const div = document.createElement('div');
        div.className = 'plot-container';
        div.id = `uv-plot-${i}`;
        uvContainer.appendChild(div);
        charts.plotUV(`uv-plot-${i}`, [wl], `${uvTitle} (${wl.nm} nm)`);
      });
    }
  }

  // TIC plot(s)
  const ticContainer = document.getElementById('single-tic-plot');
  ticContainer.innerHTML = '';
  ticContainer.className = 'plot-stack';
  if (data.tic && data.tic.has_dual_polarity && data.tic.times_pos && data.tic.times_neg) {
    const ticTitle = document.getElementById('label-tic-panel');
    const baseTitle = (ticTitle && ticTitle.value) || 'Total Ion Chromatogram';

    const posDiv = document.createElement('div');
    posDiv.className = 'plot-container single-tic-compact';
    posDiv.id = 'single-tic-pos-plot';
    ticContainer.appendChild(posDiv);
    renderSingleInteractiveTicPlot({
      plotId: 'single-tic-pos-plot',
      times: data.tic.times_pos,
      intensities: data.tic.intensities_pos,
      title: `${baseTitle} (+)`,
      color: '#1f77b4',
      samplePath,
      polarity: 'positive',
      panelLabel: '(+)',
      spectrumPlotId: 'single-spectrum-pos-plot',
    });
    singlePlotIds.push('single-tic-pos-plot');

    const posSpectrumDiv = document.createElement('div');
    posSpectrumDiv.className = 'plot-container single-spectrum-compact';
    posSpectrumDiv.id = 'single-spectrum-pos-plot';
    ticContainer.appendChild(posSpectrumDiv);
    renderSingleSummedSpectrumPlaceholder('single-spectrum-pos-plot', '(+)');

    const negDiv = document.createElement('div');
    negDiv.className = 'plot-container single-tic-compact';
    negDiv.id = 'single-tic-neg-plot';
    ticContainer.appendChild(negDiv);
    renderSingleInteractiveTicPlot({
      plotId: 'single-tic-neg-plot',
      times: data.tic.times_neg,
      intensities: data.tic.intensities_neg,
      title: `${baseTitle} (−)`,
      color: '#d62728',
      samplePath,
      polarity: 'negative',
      panelLabel: '(−)',
      spectrumPlotId: 'single-spectrum-neg-plot',
    });
    singlePlotIds.push('single-tic-neg-plot');

    const negSpectrumDiv = document.createElement('div');
    negSpectrumDiv.className = 'plot-container single-spectrum-compact';
    negSpectrumDiv.id = 'single-spectrum-neg-plot';
    ticContainer.appendChild(negSpectrumDiv);
    renderSingleSummedSpectrumPlaceholder('single-spectrum-neg-plot', '(−)');
  } else if (data.tic && data.tic.times && data.tic.times.length > 0) {
    const ticTitle = document.getElementById('label-tic-panel');
    const ticDiv = document.createElement('div');
    ticDiv.className = 'plot-container single-tic-compact';
    ticDiv.id = 'single-tic-plot-main';
    ticContainer.appendChild(ticDiv);
    renderSingleInteractiveTicPlot({
      plotId: 'single-tic-plot-main',
      times: data.tic.times,
      intensities: data.tic.intensities,
      title: (ticTitle && ticTitle.value) || 'Total Ion Chromatogram',
      color: '#ff7f0e',
      samplePath,
      polarity: null,
      panelLabel: '',
      spectrumPlotId: 'single-spectrum-plot',
    });
    singlePlotIds.push('single-tic-plot-main');

    const spectrumDiv = document.createElement('div');
    spectrumDiv.className = 'plot-container single-spectrum-compact';
    spectrumDiv.id = 'single-spectrum-plot';
    ticContainer.appendChild(spectrumDiv);
    renderSingleSummedSpectrumPlaceholder('single-spectrum-plot');
  } else {
    ticContainer.className = 'plot-container';
    ticContainer.innerHTML = '<p class="placeholder-msg">No MS data available</p>';
  }

  // EIC plots
  const eicContainer = document.getElementById('single-eic-plots');
  eicContainer.innerHTML = '';
  if (data.eic && data.eic.targets && data.eic.targets.length > 0) {
    const eicXRange = (() => {
      let maxTime = Number.NEGATIVE_INFINITY;
      (data.eic.targets || []).forEach((target) => {
        (target.times || []).forEach((tv) => {
          const t = Number(tv);
          if (Number.isFinite(t) && t > maxTime) maxTime = t;
        });
      });
      return Number.isFinite(maxTime) && maxTime > 0 ? [0, maxTime] : null;
    })();

    // Combined EIC
    const combinedDiv = document.createElement('div');
    combinedDiv.className = 'plot-container';
    combinedDiv.id = 'eic-combined-single';
    eicContainer.appendChild(combinedDiv);
    charts.plotEIC('eic-combined-single', data.eic.targets, 'Extracted Ion Chromatograms', {
      xRange: eicXRange,
    });
    const combinedDownloadRow = document.createElement('div');
    combinedDownloadRow.className = 'single-eic-download-row';
    combinedDownloadRow.innerHTML = `
      <button class="btn btn-sm" data-format="png">Download PNG</button>
      <button class="btn btn-sm" data-format="svg">Download SVG</button>
      <button class="btn btn-sm" data-format="pdf">Download PDF</button>
    `;
    eicContainer.appendChild(combinedDownloadRow);
    combinedDownloadRow.querySelectorAll('button[data-format]').forEach((btn) => {
      btn.addEventListener('click', () => exportSingleCombinedEic(btn.dataset.format));
    });

    // Individual EICs
    data.eic.targets.forEach((t, i) => {
      const div = document.createElement('div');
      div.className = 'plot-container';
      div.id = `eic-single-${i}`;
      eicContainer.appendChild(div);
      const traceColor = charts.getColor(i);
      const polarityLabel = t.polarity === 'negative' ? ' (−)' : ' (+)';
      charts.plotEIC(`eic-single-${i}`, [t], `EIC m/z ${t.mz.toFixed(2)}${polarityLabel}`, {
        xRange: eicXRange,
        colorIndexStart: i,
        traceColor,
        titleColor: traceColor,
      });
    });
  } else if (state.mzTargets.length === 0) {
    eicContainer.innerHTML = '<p class="placeholder-msg">Add target m/z values in Settings to view EIC plots</p>';
  } else {
    eicContainer.innerHTML = '<p class="placeholder-msg">No EIC data available</p>';
  }

  if (singlePlotIds.length > 0) {
    schedulePlotlyResize(singlePlotIds);
  }
}

async function exportSingle(format) {
  if (!state.singleSampleData) {
    toast('Load a sample first', 'warning');
    return;
  }
  const fileBase = getSingleSampleFilenameBase('single_sample');
  if (format === 'pdf') {
    const samplePath = document.getElementById('single-sample-select')?.value || '';
    if (!samplePath) {
      toast('Select a sample first', 'warning');
      return;
    }
    const dpi = parseInt(document.getElementById('export-dpi')?.value, 10) || 300;
    showLoading('Exporting PDF...');
    try {
      const response = await api.exportSingleSample({
        path: samplePath,
        kind: 'overview',
        format: 'pdf',
        dpi,
        mz_window: parseFloat(document.getElementById('mz-window')?.value) || 0.5,
        mz_targets: state.mzTargets,
        settings: getReportSettingsPayload(),
      });
      const blob = await response.blob();
      const filename = getFilenameFromContentDisposition(
        response.headers.get('content-disposition'),
        `${fileBase}_single_sample.pdf`
      );
      downloadBlob(blob, filename);
      toast('Exported PDF', 'success');
    } catch (err) {
      toast(`Export failed: ${err.message}`, 'error');
    } finally {
      hideLoading();
    }
    return;
  }
  await exportAllPlots('tab-single', fileBase, format, {
    singleSample: true,
    pdfPerPage: 4,
    pdfOrientation: 'portrait',
    pdfPreset: 'deconv-like',
  });
}

function getSingleSampleFilenameBase(fallback = 'single_sample') {
  const samplePath = document.getElementById('single-sample-select')?.value || '';
  const selected = state.selectedFiles.find((f) => f.path === samplePath);
  let sampleName = selected?.name || (samplePath ? samplePath.split(/[\\/]/).pop() : '') || fallback;
  if (sampleName.toLowerCase().endsWith('.d')) sampleName = sampleName.slice(0, -2);
  return sanitizeFilename(sampleName || fallback);
}

async function exportSingleCombinedEic(format) {
  if (!state.singleSampleData) {
    toast('Load a sample first', 'warning');
    return;
  }
  const fileBase = `${getSingleSampleFilenameBase('single_sample')}_extracted_ion_chromatograms`;
  if (format === 'pdf') {
    const samplePath = document.getElementById('single-sample-select')?.value || '';
    if (!samplePath) {
      toast('Select a sample first', 'warning');
      return;
    }
    const dpi = parseInt(document.getElementById('export-dpi')?.value, 10) || 300;
    showLoading('Exporting PDF...');
    try {
      const response = await api.exportSingleSample({
        path: samplePath,
        kind: 'eic-overlay',
        format: 'pdf',
        dpi,
        mz_window: parseFloat(document.getElementById('mz-window')?.value) || 0.5,
        mz_targets: state.mzTargets,
        settings: getReportSettingsPayload(),
      });
      const blob = await response.blob();
      const filename = getFilenameFromContentDisposition(
        response.headers.get('content-disposition'),
        `${fileBase}.pdf`
      );
      downloadBlob(blob, filename);
      toast('Exported PDF', 'success');
    } catch (err) {
      toast(`Export failed: ${err.message}`, 'error');
    } finally {
      hideLoading();
    }
    return;
  }
  const plotDiv = document.getElementById('eic-combined-single');
  const traceCount = Array.isArray(plotDiv?.data) ? plotDiv.data.length : 0;
  const firstTraceColor = getFirstTraceColor(plotDiv);
  const legendEntries = (Array.isArray(plotDiv?.data) ? plotDiv.data : []).map((trace, i) => {
    const traceName = String(trace?.name || `m/z ${i + 1}`);
    const color = (typeof trace?.line?.color === 'string' && trace.line.color)
      || (typeof trace?.marker?.color === 'string' && trace.marker.color)
      || charts.getColor(i);
    return { name: traceName, color };
  });
  const singleSampleEicYMax = computeSingleSampleEicGlobalYMax([plotDiv]);
  await exportPlotById('eic-combined-single', fileBase, format, {
    // Reuse the same high-quality export style used for polished single-sample outputs.
    pdfPreset: 'deconv-like',
    singleSample: format === 'pdf',
    pdfPerPage: 1,
    pdfOrientation: 'landscape',
    pdfCropToPlot: format === 'pdf',
    pdfCropMarginPt: 8,
    singleSampleEic: true,
    singleSampleEicFitLegend: true,
    singleSampleEicMultiColLegend: true,
    singleSampleEicLegendEntries: legendEntries,
    traceCount,
    firstTraceColor,
    singleSampleEicYMax,
    exportHeightScale: 2 / 3,
    traceLineWidthMultiplier: 1.5,
    exportTransparentBackground: format === 'pdf',
    exportFilenameLabel: `${fileBase}.${format}`,
  });
}

/** Export all Plotly plots in a tab container as images. */
async function exportAllPlots(containerId, filenameBase, format, options = {}) {
  const container = document.getElementById(containerId);
  const plotDivs = container.querySelectorAll('.js-plotly-plot');
  if (plotDivs.length === 0) {
    toast('No plots to export', 'warning');
    return;
  }

  const dpi = parseInt(document.getElementById('export-dpi').value) || 300;
  const scale = dpi / 96;

  showLoading(`Exporting ${format.toUpperCase()}...`);
  try {
    if (format === 'pdf') {
      await exportPlotsAsPDF(plotDivs, filenameBase, scale, options);
      toast(`Exported ${plotDivs.length} plot(s) as PDF`, 'success');
      return;
    }

    for (let i = 0; i < plotDivs.length; i++) {
      const div = plotDivs[i];
      const suffix = plotDivs.length > 1 ? `_${i + 1}` : '';
      const filename = `${filenameBase}${suffix}.${format}`;
      const dims = getExportDimensions(div, scale, options);
      const exportOptions = {
        ...options,
        exportPixelWidth: dims.width,
        exportPixelHeight: dims.height,
      };
      const imageDataUrl = await buildExportImage(
        div,
        format,
        dims.width,
        dims.height,
        exportOptions
      );
      downloadBlob(dataUrlToBlob(imageDataUrl), filename);
    }
    toast(`Exported ${plotDivs.length} plot(s) as ${format.toUpperCase()}`, 'success');
  } catch (err) {
    toast(`Export failed: ${err.message}`, 'error');
  } finally {
    hideLoading();
  }
}

async function exportPlotsAsPDF(plotDivs, filenameBase, scale, options = {}) {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    throw new Error('PDF library not loaded');
  }

  const { jsPDF } = window.jspdf;
  const isSingleSamplePdf = options.singleSample === true;
  const orientation = String(options.pdfOrientation || (isSingleSamplePdf ? 'portrait' : 'landscape'));
  const plotsPerPage = Math.max(1, parseInt(options.pdfPerPage, 10) || (isSingleSamplePdf ? 4 : 1));
  const singlePdfScale = isSingleSamplePdf
    ? Math.max(1.75, Math.min(3.0, Number(scale) || 1))
    : scale;
  const singleSampleEicYMax = Number.isFinite(Number(options.singleSampleEicYMax)) && Number(options.singleSampleEicYMax) > 0
    ? Number(options.singleSampleEicYMax)
    : (isSingleSamplePdf ? computeSingleSampleEicGlobalYMax(plotDivs) : null);

  if (options.pdfCropToPlot === true && plotDivs.length === 1) {
    const div = plotDivs[0];
    const singleSampleEic = (options.singleSampleEic === true && isSingleSampleEicPlot(div))
      || (isSingleSamplePdf && isSingleSampleEicPlot(div));
    const traceCount = Number(options.traceCount) || (Array.isArray(div?.data) ? div.data.length : 0);
    const firstTraceColor = options.firstTraceColor || getFirstTraceColor(div);
    const dims = getExportDimensions(div, scale, options);
    const dataUrl = await buildExportImage(
      div,
      'png',
      dims.width,
      dims.height,
      {
        singleSampleEic,
        singleSampleEicFitLegend: options.singleSampleEicFitLegend,
        singleSampleEicMultiColLegend: options.singleSampleEicMultiColLegend,
        singleSampleEicLegendEntries: options.singleSampleEicLegendEntries,
        traceCount,
        firstTraceColor,
        singleSampleEicYMax,
        pdfPreset: options.pdfPreset,
        pdfScale: singlePdfScale,
        exportFilenameLabel: options.exportFilenameLabel,
        exportPixelWidth: dims.width,
        exportPixelHeight: dims.height,
        traceLineWidthMultiplier: options.traceLineWidthMultiplier,
        exportTransparentBackground: options.exportTransparentBackground,
      }
    );
    const drawW = Math.max(120, Number(dims.width) || 120);
    const drawH = Math.max(120, Number(dims.height) || 120);
    const margin = Math.max(
      0,
      Number.isFinite(Number(options.pdfCropMarginPx))
        ? Number(options.pdfCropMarginPx)
        : (Number(options.pdfCropMarginPt) || 8)
    );
    const pageW = drawW + (margin * 2);
    const pageH = drawH + (margin * 2);
    const pdf = new jsPDF({
      orientation: pageW >= pageH ? 'landscape' : 'portrait',
      unit: 'px',
      format: [pageW, pageH],
      compress: true,
    });
    pdf.addImage(dataUrl, 'PNG', margin, margin, drawW, drawH, undefined, 'FAST');
    pdf.save(`${filenameBase}.pdf`);
    return;
  }

  const pdf = new jsPDF({
    orientation,
    unit: 'pt',
    format: 'a4',
    compress: true,
  });

  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 24;
  const contentWidth = pageWidth - margin * 2;
  const contentHeight = pageHeight - margin * 2;
  const verticalGap = isSingleSamplePdf ? 10 : 0;
  const slotHeight = isSingleSamplePdf
    ? ((contentHeight - (verticalGap * (plotsPerPage - 1))) / plotsPerPage)
    : contentHeight;

  for (let i = 0; i < plotDivs.length; i++) {
    const div = plotDivs[i];
    const singleSampleEic = (options.singleSampleEic === true && isSingleSampleEicPlot(div))
      || (isSingleSamplePdf && isSingleSampleEicPlot(div));
    const traceCount = Number(options.traceCount) || (Array.isArray(div?.data) ? div.data.length : 0);
    const firstTraceColor = options.firstTraceColor || getFirstTraceColor(div);
    const dims = getExportDimensions(div, scale, options);
    if (isSingleSamplePdf) {
      // Keep the same aspect ratio as the destination A4 slot to avoid squashing.
      dims.width = Math.max(900, Math.round(contentWidth * singlePdfScale));
      dims.height = Math.max(260, Math.round(slotHeight * singlePdfScale));
    }
    const dataUrl = await buildExportImage(
      div,
      'png',
      dims.width,
      dims.height,
      {
        singleSampleEic,
        singleSampleEicFitLegend: options.singleSampleEicFitLegend,
        singleSampleEicMultiColLegend: options.singleSampleEicMultiColLegend,
        singleSampleEicLegendEntries: options.singleSampleEicLegendEntries,
        traceCount,
        firstTraceColor,
        singleSampleEicYMax,
        pdfPreset: options.pdfPreset,
        pdfScale: singlePdfScale,
        exportFilenameLabel: options.exportFilenameLabel,
        exportPixelWidth: dims.width,
        exportPixelHeight: dims.height,
        traceLineWidthMultiplier: options.traceLineWidthMultiplier,
        exportTransparentBackground: options.exportTransparentBackground,
      }
    );

    if (i > 0 && (i % plotsPerPage) === 0) {
      pdf.addPage();
    }

    if (isSingleSamplePdf) {
      const slotIndex = i % plotsPerPage;
      const drawX = margin;
      const drawY = margin + (slotIndex * (slotHeight + verticalGap));
      pdf.addImage(dataUrl, 'PNG', drawX, drawY, contentWidth, slotHeight, undefined, 'FAST');
    } else {
      const sourceW = Math.max(1, Number(dims.width) || 1);
      const sourceH = Math.max(1, Number(dims.height) || 1);
      let drawW = contentWidth;
      let drawH = drawW * (sourceH / sourceW);
      if (drawH > contentHeight) {
        drawH = contentHeight;
        drawW = drawH * (sourceW / sourceH);
      }
      const drawX = margin + ((contentWidth - drawW) / 2);
      const drawY = margin + ((contentHeight - drawH) / 2);
      pdf.addImage(dataUrl, 'PNG', drawX, drawY, drawW, drawH, undefined, 'FAST');
    }
  }

  pdf.save(`${filenameBase}.pdf`);
}

function getPlotTitleText(plotDiv) {
  const title = plotDiv?.layout?.title;
  if (typeof title === 'string') return title;
  if (title && typeof title.text === 'string') return title.text;
  return '';
}

function isSingleSampleEicPlot(plotDiv) {
  const id = String(plotDiv?.id || '');
  if (id === 'eic-combined-single' || id.startsWith('eic-single-')) return true;
  const title = getPlotTitleText(plotDiv).toLowerCase();
  return title.includes('eic') || title.includes('extracted ion chromatograms');
}

function getExportDimensions(plotDiv, scale, options = {}) {
  const figWidthIn = parseFloat(document.getElementById('fig-width')?.value) || 6;
  const width = Math.max(600, Math.round(figWidthIn * 96 * scale));
  const layoutHeight = Number(plotDiv?.layout?.height);
  const baseHeight = Number.isFinite(layoutHeight) && layoutHeight > 0
    ? layoutHeight
    : (plotDiv?.offsetHeight || 320);
  const heightScale = Math.max(0.1, Number(options.exportHeightScale) || 1);
  const height = Math.max(120, Math.round(baseHeight * scale * heightScale));
  return { width, height };
}

function applyWebappExportStyle(layout) {
  return applyWebappExportStyleWithOptions(layout, {});
}

function applyWebappExportStyleWithOptions(layout, options = {}) {
  const styled = JSON.parse(JSON.stringify(layout || {}));
  const showGrid = document.getElementById('show-grid')?.checked ?? false;

  styled.paper_bgcolor = 'rgba(0,0,0,0)';
  styled.plot_bgcolor = 'rgba(0,0,0,0)';
  styled.font = {
    ...(styled.font || {}),
    family: 'Arial, Liberation Sans, DejaVu Sans, sans-serif',
    size: styled.font?.size || 10,
    color: '#000000',
  };
  if (styled.title && styled.title.font) {
    styled.title.font = { ...styled.title.font, color: '#000000' };
  }

  for (const key of Object.keys(styled)) {
    if (key.startsWith('xaxis') || key.startsWith('yaxis')) {
      const axis = styled[key] || {};
      styled[key] = {
        ...axis,
        color: '#000000',
        showgrid: showGrid,
        gridcolor: 'rgba(0,0,0,0.30)',
        zeroline: false,
      };
    }
  }

  if (styled.legend) {
    styled.legend = {
      ...styled.legend,
      bgcolor: 'rgba(0,0,0,0)',
      borderwidth: 0,
      font: { ...(styled.legend.font || {}), color: '#000000' },
    };
  }

  if (options.pdfPreset === 'deconv-like') {
    styled.paper_bgcolor = '#ffffff';
    styled.plot_bgcolor = '#ffffff';
    styled.showlegend = false;
    styled.font = {
      ...(styled.font || {}),
      size: 25,
      color: '#000000',
      family: 'Arial, Liberation Sans, DejaVu Sans, sans-serif',
    };
    if (styled.title) {
      const titleFont = (typeof styled.title === 'object' ? styled.title.font : null) || {};
      styled.title = {
        ...(typeof styled.title === 'object' ? styled.title : { text: String(styled.title || '') }),
        font: {
          ...titleFont,
          size: 30,
          color: '#000000',
          family: 'Arial, Liberation Sans, DejaVu Sans, sans-serif',
        },
      };
    }
    const m = styled.margin || {};
    styled.margin = {
      l: Math.max(120, Number(m.l) || 0),
      r: Math.max(40, Number(m.r) || 0),
      t: Math.max(90, Number(m.t) || 0),
      b: Math.max(100, Number(m.b) || 0),
      pad: Number(m.pad) || 0,
    };
    for (const key of Object.keys(styled)) {
      if (key.startsWith('xaxis') || key.startsWith('yaxis')) {
        const axis = styled[key] || {};
        const existingTitle = axis.title;
        const normalizedTitle = typeof existingTitle === 'string'
          ? { text: existingTitle }
          : (existingTitle || {});
        styled[key] = {
          ...axis,
          color: '#000000',
          linecolor: '#000000',
          linewidth: 1.4,
          showline: true,
          mirror: true,
          automargin: true,
          ticks: axis.ticks || 'outside',
          tickfont: {
            ...(axis.tickfont || {}),
            size: 23,
            color: '#000000',
            family: 'Arial, Liberation Sans, DejaVu Sans, sans-serif',
          },
          title: {
            ...normalizedTitle,
            font: {
              ...((normalizedTitle && normalizedTitle.font) || {}),
              size: 25,
              color: '#000000',
              family: 'Arial, Liberation Sans, DejaVu Sans, sans-serif',
            },
          },
          zeroline: false,
        };
      }
    }
  }

  if (options.exportTransparentBackground === true) {
    styled.paper_bgcolor = 'rgba(0,0,0,0)';
    styled.plot_bgcolor = 'rgba(0,0,0,0)';
    if (styled.legend) {
      styled.legend = {
        ...styled.legend,
        bgcolor: 'rgba(0,0,0,0)',
      };
    }
  }

  if (options.singleSampleEic === true) {
    const traceCount = Number(options.traceCount) || 0;
    const showLegend = traceCount > 1;
    const fitLegend = options.singleSampleEicFitLegend === true;
    const useMultiColumnLegend = fitLegend && options.singleSampleEicMultiColLegend === true;
    const axisTickSize = Number(styled?.xaxis?.tickfont?.size)
      || Number(styled?.yaxis?.tickfont?.size)
      || Number(styled?.font?.size)
      || 11;
    const exportPixelWidth = Math.max(600, Number(options.exportPixelWidth) || 1200);
    const exportPixelHeight = Math.max(240, Number(options.exportPixelHeight) || 520);
    styled.showlegend = showLegend;
    const m = styled.margin || {};
    styled.margin = {
      l: Math.max(60, Number(m.l) || 0),
      r: Math.max(showLegend ? (fitLegend ? 280 : 200) : 40, Number(m.r) || 0),
      t: Math.max(traceCount > 6 ? 64 : 72, Number(m.t) || 0),
      b: Math.max(56, Number(m.b) || 0),
      pad: Number(m.pad) || 0,
    };
    if (showLegend && !useMultiColumnLegend) {
      styled.legend = {
        ...(styled.legend || {}),
        x: 1.01,
        xanchor: 'left',
        y: 0.995,
        yanchor: 'top',
        bgcolor: 'rgba(255,255,255,0.9)',
        bordercolor: '#000000',
        borderwidth: 0.6,
        itemsizing: 'constant',
        font: {
          ...((styled.legend && styled.legend.font) || {}),
          color: '#000000',
          // Keep legend font synced with axis tick labels.
          size: axisTickSize,
          family: 'Arial, Liberation Sans, DejaVu Sans, sans-serif',
        },
      };
    }
    if (showLegend && useMultiColumnLegend) {
      const entries = Array.isArray(options.singleSampleEicLegendEntries)
        ? options.singleSampleEicLegendEntries.filter((e) => e && e.name)
        : [];
      if (entries.length > 0) {
        const rowHeightPx = Math.max(16, Math.round(axisTickSize * 1.30));
        const marginLeft = Number(styled.margin?.l) || 60;
        const marginTop = Number(styled.margin?.t) || 72;
        const marginBottom = Number(styled.margin?.b) || 56;
        const plotHeightPx = Math.max(100, exportPixelHeight - marginTop - marginBottom);
        const maxRows = Math.max(1, Math.floor(plotHeightPx / rowHeightPx));
        const columnCount = Math.max(1, Math.ceil(entries.length / maxRows));
        const rowsPerColumn = Math.ceil(entries.length / columnCount);

        const swatchWidth = Math.max(14, Math.round(axisTickSize * 1.25));
        const swatchGap = Math.max(6, Math.round(axisTickSize * 0.35));
        const textPadding = Math.max(10, Math.round(axisTickSize * 0.55));
        const maxNameLen = entries.reduce((acc, e) => Math.max(acc, String(e.name).length), 8);
        const columnWidth = Math.max(120, Math.round(swatchWidth + swatchGap + textPadding + (maxNameLen * axisTickSize * 0.56)));
        const requiredRightMargin = Math.round(columnCount * columnWidth + 18);

        styled.margin = {
          ...styled.margin,
          r: Math.max(Number(styled.margin?.r) || 0, requiredRightMargin),
        };
        styled.showlegend = false;

        const plotWidthPx = Math.max(140, exportPixelWidth - marginLeft - (Number(styled.margin?.r) || requiredRightMargin));
        const plotHeightPxAdjusted = Math.max(100, exportPixelHeight - marginTop - marginBottom);
        const legendLeftPad = 6;
        const firstColX = 1 + (legendLeftPad / plotWidthPx);
        const xStep = columnWidth / plotWidthPx;
        const yTop = 1 - ((axisTickSize * 0.15) / plotHeightPxAdjusted);
        const yStep = rowHeightPx / plotHeightPxAdjusted;

        const legendAnnotations = [];
        const legendShapes = [];
        entries.forEach((entry, idx) => {
          const col = Math.floor(idx / rowsPerColumn);
          const row = idx % rowsPerColumn;
          const y = yTop - (row * yStep);
          const xSwatch0 = firstColX + (col * xStep);
          const xSwatch1 = xSwatch0 + (swatchWidth / plotWidthPx);
          const xText = xSwatch1 + (swatchGap / plotWidthPx);
          legendShapes.push({
            type: 'line',
            xref: 'paper',
            yref: 'paper',
            x0: xSwatch0,
            x1: xSwatch1,
            y0: y,
            y1: y,
            line: {
              color: String(entry.color || '#000000'),
              width: Math.max(2, axisTickSize * 0.12),
            },
          });
          legendAnnotations.push({
            xref: 'paper',
            yref: 'paper',
            x: xText,
            y,
            xanchor: 'left',
            yanchor: 'middle',
            text: String(entry.name),
            showarrow: false,
            align: 'left',
            font: {
              family: 'Arial, Liberation Sans, DejaVu Sans, sans-serif',
              size: axisTickSize,
              color: '#000000',
            },
          });
        });
        styled.shapes = Array.isArray(styled.shapes) ? [...styled.shapes, ...legendShapes] : legendShapes;
        styled.annotations = Array.isArray(styled.annotations)
          ? [...styled.annotations, ...legendAnnotations]
          : legendAnnotations;
      }
    }
    if (!showLegend && options.firstTraceColor && styled.title) {
      const color = String(options.firstTraceColor);
      const titleObj = typeof styled.title === 'object'
        ? styled.title
        : { text: String(styled.title || '') };
      styled.title = {
        ...titleObj,
        font: {
          ...(titleObj.font || {}),
          color,
        },
      };
    }

    const yMax = Number(options.singleSampleEicYMax);
    if (Number.isFinite(yMax) && yMax > 0) {
      const yPad = yMax * 0.03;
      const yTop = yMax + yPad;
      styled.yaxis = {
        ...(styled.yaxis || {}),
        range: [0, yTop],
        autorange: false,
      };
    }
  }

  if (options.exportFilenameLabel) {
    const label = String(options.exportFilenameLabel);
    const marginLeft = Number(styled?.margin?.l) || 0;
    const marginBottom = Number(styled?.margin?.b) || 0;
    // Place filename under the x-axis title and aligned toward left tick labels.
    const labelXShift = -(Math.max(42, Math.min(110, marginLeft - 10)));
    const labelYShift = -(Math.max(58, Math.min(95, marginBottom - 8)));
    styled.annotations = Array.isArray(styled.annotations) ? [...styled.annotations] : [];
    styled.annotations.push({
      xref: 'paper',
      yref: 'paper',
      x: 0,
      y: 0,
      xanchor: 'left',
      yanchor: 'bottom',
      xshift: labelXShift,
      yshift: labelYShift,
      text: `<i>${label}</i>`,
      showarrow: false,
      align: 'left',
      font: {
        family: 'Arial, Liberation Sans, DejaVu Sans, sans-serif',
        size: 12,
        color: '#777777',
      },
    });
  }

  if (Array.isArray(styled.annotations)) {
    styled.annotations = styled.annotations.map((ann) => ({
      ...ann,
      font: { ...(ann.font || {}), color: ann?.font?.color || '#000000' },
      arrowcolor: ann.arrowcolor || '#000000',
    }));
  }

  return styled;
}

function applyExportTraceStyleWithOptions(data, options = {}) {
  const traces = Array.isArray(data) ? data : [];
  const customMultiplier = Number(options.traceLineWidthMultiplier);
  const hasCustomMultiplier = Number.isFinite(customMultiplier) && customMultiplier > 0;
  if (options.pdfPreset !== 'deconv-like' && !hasCustomMultiplier) return traces;
  const widthMultiplier = hasCustomMultiplier ? customMultiplier : 1.8;

  return traces.map((trace) => {
    if (!trace || typeof trace !== 'object') return trace;
    const next = { ...trace };
    const traceType = String(next.type || 'scatter');
    const mode = String(next.mode || '');
    const isLineLike = traceType === 'scatter' || traceType === 'scattergl';
    const drawsLines = mode.includes('lines') || mode === '' || mode === 'none';

    if (isLineLike && drawsLines) {
      const currentWidth = Number(next?.line?.width);
      const baseWidth = Number.isFinite(currentWidth) && currentWidth > 0 ? currentWidth : 1.8;
      next.line = {
        ...(next.line || {}),
        width: baseWidth * widthMultiplier,
      };
    }

    if (next.error_y && typeof next.error_y === 'object') {
      const ew = Number(next.error_y.width);
      if (Number.isFinite(ew) && ew > 0) {
        next.error_y = { ...next.error_y, width: ew * 1.5 };
      }
    }

    if (next.error_x && typeof next.error_x === 'object') {
      const ew = Number(next.error_x.width);
      if (Number.isFinite(ew) && ew > 0) {
        next.error_x = { ...next.error_x, width: ew * 1.5 };
      }
    }

    return next;
  });
}

function getFirstTraceColor(plotDiv) {
  const traces = Array.isArray(plotDiv?.data) ? plotDiv.data : [];
  if (traces.length === 0) return null;
  const t0 = traces[0] || {};
  if (typeof t0?.line?.color === 'string' && t0.line.color) return t0.line.color;
  if (typeof t0?.marker?.color === 'string' && t0.marker.color) return t0.marker.color;
  return null;
}

function computeSingleSampleEicGlobalYMax(plotDivs) {
  const divList = Array.from(plotDivs || []);
  let maxY = 0;
  divList.forEach((div) => {
    if (!isSingleSampleEicPlot(div)) return;
    const traces = Array.isArray(div?.data) ? div.data : [];
    traces.forEach((trace) => {
      const ys = Array.isArray(trace?.y) ? trace.y : [];
      ys.forEach((v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n > maxY) maxY = n;
      });
    });
  });
  return maxY > 0 ? maxY : null;
}

async function buildExportImage(plotDiv, format, width, height, options = {}) {
  const temp = document.createElement('div');
  temp.style.position = 'fixed';
  temp.style.left = '-10000px';
  temp.style.top = '-10000px';
  temp.style.width = `${width}px`;
  temp.style.height = `${height}px`;
  document.body.appendChild(temp);

  try {
    const exportData = applyExportTraceStyleWithOptions(
      JSON.parse(JSON.stringify(plotDiv.data || [])),
      options
    );
    await Plotly.newPlot(
      temp,
      exportData,
      applyWebappExportStyleWithOptions(plotDiv.layout || {}, options),
      { responsive: false, displaylogo: false }
    );

    return await Plotly.toImage(temp, {
      format,
      width,
      height,
      scale: 1,
    });
  } finally {
    Plotly.purge(temp);
    temp.remove();
  }
}

function dataUrlToBlob(dataUrl) {
  if (typeof dataUrl !== 'string') {
    throw new Error('Invalid image data');
  }

  // Plotly can return:
  // 1) data URLs with base64 payload (png),
  // 2) data URLs with URL-encoded text payload (svg),
  // 3) raw SVG text in some environments.
  if (dataUrl.startsWith('<svg') || dataUrl.startsWith('<?xml')) {
    return new Blob([dataUrl], { type: 'image/svg+xml;charset=utf-8' });
  }

  if (!dataUrl.startsWith('data:')) {
    throw new Error('Unsupported export payload format');
  }

  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx < 0) {
    throw new Error('Malformed data URL');
  }

  const header = dataUrl.slice(0, commaIdx);
  const data = dataUrl.slice(commaIdx + 1);
  const mimeMatch = header.match(/^data:([^;,]+)/i);
  const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
  const isBase64 = /;base64(?:;|$)/i.test(header);

  if (isBase64) {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime });
  }

  const text = decodeURIComponent(data);
  return new Blob([text], { type: mime });
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function maxFiniteValue(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  let maxVal = 0;
  for (let i = 0; i < values.length; i++) {
    const n = Number(values[i]);
    if (Number.isFinite(n) && n > maxVal) maxVal = n;
  }
  return maxVal;
}

function getDefaultProgressionRole(index, total) {
  if (index === 0) return 'initial';
  if (index === total - 1) return 'final';
  return 'mid';
}

function getProgressionRoleBaseLabel(role) {
  if (role === 'initial') return 'Initial';
  if (role === 'final') return 'Final';
  return 'Mid';
}

function buildAutoProgressionLabel(role, ordinal, totalForRole) {
  const base = getProgressionRoleBaseLabel(role);
  if (totalForRole <= 1) return base;
  return `${base} ${ordinal}`;
}

function computeAutoProgressionColorMap(assignments = state.progressionAssignments) {
  const colorsByPath = {};
  let activeIndex = 0;

  state.selectedFiles.forEach((file) => {
    const assignment = assignments?.[file.path] || {};
    if (assignment.active === false) return;
    colorsByPath[file.path] = NPG_COLOR_PALETTE[activeIndex % NPG_COLOR_PALETTE.length];
    activeIndex += 1;
  });

  state.selectedFiles.forEach((file) => {
    if (!colorsByPath[file.path]) {
      colorsByPath[file.path] = '#808080';
    }
  });

  return colorsByPath;
}

function computeAutoProgressionLabelMap() {
  const total = state.selectedFiles.length;
  const roleCounts = { initial: 0, mid: 0, final: 0 };
  const rolesByPath = {};

  state.selectedFiles.forEach((file, i) => {
    const assignment = state.progressionAssignments[file.path] || {};
    const role = assignment.role || getDefaultProgressionRole(i, total);
    rolesByPath[file.path] = role;
    if (roleCounts[role] == null) roleCounts[role] = 0;
    roleCounts[role] += 1;
  });

  const roleOrdinals = { initial: 0, mid: 0, final: 0 };
  const labelsByPath = {};
  state.selectedFiles.forEach((file) => {
    const role = rolesByPath[file.path] || 'mid';
    if (roleOrdinals[role] == null) roleOrdinals[role] = 0;
    roleOrdinals[role] += 1;
    labelsByPath[file.path] = buildAutoProgressionLabel(role, roleOrdinals[role], roleCounts[role] || 1);
  });

  return labelsByPath;
}

function syncProgressionAssignmentsToSelectedFiles() {
  const total = state.selectedFiles.length;
  const next = {};
  const autoColors = computeAutoProgressionColorMap(state.progressionAssignments);
  state.selectedFiles.forEach((file, i) => {
    const existing = state.progressionAssignments[file.path] || {};
    const defaultRole = getDefaultProgressionRole(i, total);
    const hasUserRole = existing.userRole === true;
    const hasUserLabel = existing.userLabel === true;
    const hasUserColor = existing.userColor === true;
    const autoColor = autoColors[file.path] || NPG_COLOR_PALETTE[i % NPG_COLOR_PALETTE.length];
    next[file.path] = {
      role: hasUserRole ? (existing.role || defaultRole) : defaultRole,
      label: hasUserLabel ? (existing.label || '') : '',
      color: hasUserColor ? (existing.color || autoColor) : autoColor,
      autoColor,
      active: existing.active !== false,
      userRole: hasUserRole,
      userLabel: hasUserLabel,
      userColor: hasUserColor,
    };
  });
  state.progressionAssignments = next;
}

function readProgressionAssignmentsFromDOM() {
  document.querySelectorAll('.prog-active').forEach((el) => {
    const path = el.dataset.path;
    if (!path) return;
    const item = state.progressionAssignments[path] || {};
    item.active = Boolean(el.checked);
    state.progressionAssignments[path] = item;
  });

  document.querySelectorAll('.prog-role').forEach((el) => {
    const path = el.dataset.path;
    if (!path) return;
    const item = state.progressionAssignments[path] || {};
    item.role = el.value || item.role || 'mid';
    item.userRole = true;
    state.progressionAssignments[path] = item;
  });

  const autoLabels = computeAutoProgressionLabelMap();
  document.querySelectorAll('.prog-label').forEach((el) => {
    const path = el.dataset.path;
    if (!path) return;
    const item = state.progressionAssignments[path] || {};
    const value = (el.value || '').trim();
    const autoLabel = String(autoLabels[path] || '').trim();
    item.label = value;
    item.userLabel = value.length > 0 && value !== autoLabel;
    state.progressionAssignments[path] = item;
  });

  document.querySelectorAll('.prog-color').forEach((el) => {
    const path = el.dataset.path;
    if (!path) return;
    const item = state.progressionAssignments[path] || {};
    const autoColor = String(item.autoColor || '#808080');
    const value = String(el.value || '').trim();
    item.color = value || item.color || autoColor;
    item.userColor = value.length > 0 && value.toLowerCase() !== String(autoColor).toLowerCase();
    state.progressionAssignments[path] = item;
  });
}

function getProgressionSamples(options = {}) {
  const activeOnly = options.activeOnly !== false;
  const total = state.selectedFiles.length;
  const autoLabels = computeAutoProgressionLabelMap();
  const autoColors = computeAutoProgressionColorMap();
  const samples = state.selectedFiles.map((file, i) => {
    const assignment = state.progressionAssignments[file.path] || {};
    const role = assignment.role || getDefaultProgressionRole(i, total);
    const autoLabel = String(autoLabels[file.path] || getProgressionRoleBaseLabel(role));
    const manualLabel = (assignment.userLabel === true ? String(assignment.label || '').trim() : '');
    const active = assignment.active !== false;
    return {
      path: file.path,
      name: file.name || file.path.split(/[\\/]/).pop() || '',
      role,
      label: manualLabel || autoLabel,
      color: assignment.userColor === true
        ? (assignment.color || autoColors[file.path] || NPG_COLOR_PALETTE[i % NPG_COLOR_PALETTE.length])
        : (autoColors[file.path] || NPG_COLOR_PALETTE[i % NPG_COLOR_PALETTE.length]),
      active,
    };
  });
  return activeOnly ? samples.filter((s) => s.active) : samples;
}

function updateRangeWithTimes(range, times) {
  if (!Array.isArray(times)) return range;
  let [minX, maxX] = range;
  times.forEach((t) => {
    const n = Number(t);
    if (!Number.isFinite(n)) return;
    if (n < minX) minX = n;
    if (n > maxX) maxX = n;
  });
  return [minX, maxX];
}

function computeProgressionXRange(data) {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;

  (data.uv_progression || []).forEach((s) => {
    [minX, maxX] = updateRangeWithTimes([minX, maxX], s.times);
  });
  (data.tic_progression || []).forEach((s) => {
    [minX, maxX] = updateRangeWithTimes([minX, maxX], s.times);
  });
  (data.eic_progressions || []).forEach((group) => {
    (group.samples || []).forEach((s) => {
      [minX, maxX] = updateRangeWithTimes([minX, maxX], s.times);
    });
  });

  if (!Number.isFinite(minX) || !Number.isFinite(maxX) || maxX <= minX) return null;
  return [minX, maxX];
}

function getProgressionBaseTitle() {
  const progTitle = document.getElementById('label-prog-title');
  return (progTitle && progTitle.value && progTitle.value.trim()) || 'Time Progression Analysis';
}

function formatProgressionPolarityLabel(polarity) {
  return polarity === 'negative' ? ' (−)' : ' (+)';
}

function buildProgressionEicTitle(eicGroup) {
  const mz = Number(eicGroup?.mz);
  const mzLabel = Number.isFinite(mz) ? mz.toFixed(2) : '?';
  return `${getProgressionBaseTitle()} - EIC m/z ${mzLabel}${formatProgressionPolarityLabel(eicGroup?.polarity)}`;
}

function buildProgressionExportStyle() {
  return {
    fig_width: 6.0,
    line_width: 0.8,
    show_grid: false,
    panel_width_multiplier: 2.0,
    panel_height_multiplier: 1.0,
  };
}

function buildProgressionEicFilename(eicGroup, progressionSamples) {
  const mz = Number(eicGroup?.mz);
  const mzLabel = Number.isFinite(mz) ? mz.toFixed(1) : 'EIC';
  const sampleText = (progressionSamples || [])
    .map((sample, index) => {
      const explicitName = String(sample?.name || '').trim();
      if (explicitName) return explicitName.replace(/\.[dD]$/, '');
      const pathName = String(sample?.path || '').split(/[\\/]/).pop() || '';
      if (pathName) return pathName.replace(/\.[dD]$/, '');
      return `Sample ${index + 1}`;
    })
    .filter(Boolean)
    .join(', ');
  return sanitizeDownloadFilename(sampleText ? `${mzLabel} ${sampleText}` : mzLabel);
}

function buildProgressionEicExportPayload(groupIndex) {
  if (!state.progressionData || !Array.isArray(state.progressionData.eic_progressions)) return null;
  const eicGroup = state.progressionData.eic_progressions[groupIndex];
  if (!eicGroup || !Array.isArray(eicGroup.samples)) return null;

  const progressionSamples = getProgressionSamples({ activeOnly: true });
  const traces = eicGroup.samples.map((sampleTrace, index) => {
    const sampleMeta = progressionSamples[index] || {};
    return {
      times: Array.isArray(sampleTrace?.times) ? sampleTrace.times : [],
      intensities: Array.isArray(sampleTrace?.intensities) ? sampleTrace.intensities : [],
      label: sampleMeta.label || `Sample ${index + 1}`,
      color: sampleMeta.color || NPG_COLOR_PALETTE[index % NPG_COLOR_PALETTE.length],
    };
  });

  return {
    title: buildProgressionEicTitle(eicGroup),
    x_label: 'Time (min)',
    y_label: 'Intensity',
    x_range: computeProgressionXRange(state.progressionData),
    style: buildProgressionExportStyle(),
    filename_base: buildProgressionEicFilename(eicGroup, progressionSamples),
    traces,
  };
}

async function exportProgressionEicPanel(groupIndex) {
  if (!state.progressionData) {
    toast('Generate progression first', 'warning');
    return;
  }

  readProgressionAssignmentsFromDOM();
  const payload = buildProgressionEicExportPayload(groupIndex);
  if (!payload) {
    toast('Progression panel not available for export', 'warning');
    return;
  }

  const dpi = parseInt(document.getElementById('export-dpi').value, 10) || 300;
  showLoading('Exporting PDF...');
  try {
    const response = await api.exportProgressionPanel({
      ...payload,
      format: 'pdf',
      dpi,
    });
    const blob = await backendResponseToBlob(response);
    downloadBlob(blob, `${payload.filename_base}.pdf`);
    toast('Exported PDF', 'success');
  } catch (err) {
    toast(`Export failed: ${err.message}`, 'error');
  } finally {
    hideLoading();
  }
}

function inferUptakeAssayConcentration(fileName) {
  const match = String(fileName || '').match(/CC\s*([1-6])(?:\b|[^0-9])/i) || String(fileName || '').match(/CC([1-6])/i);
  if (!match) return '';
  const concentrationMap = {
    1: 0,
    2: 6.25,
    3: 12.5,
    4: 25,
    5: 50,
    6: 100,
  };
  const value = concentrationMap[parseInt(match[1], 10)];
  return Number.isFinite(value) ? String(value) : '';
}

function syncUptakeAssayEntriesToSelectedFiles() {
  const next = {};
  state.selectedFiles.forEach((file, index) => {
    const existing = state.uptakeAssayEntries[file.path] || {};
    next[file.path] = {
      active: existing.active !== false,
      concentration: existing.concentration != null && String(existing.concentration).trim() !== ''
        ? String(existing.concentration)
        : inferUptakeAssayConcentration(file.name),
      color: existing.color || NPG_COLOR_PALETTE[index % NPG_COLOR_PALETTE.length],
    };
  });
  state.uptakeAssayEntries = next;
}

function refreshUptakeAssayInputsIfNeeded() {
  const tab = document.getElementById('tab-uptake-assay-cc');
  const container = document.getElementById('uptake-assay-samples');
  if (!tab || !container) return;
  const tabIsVisible = !tab.classList.contains('hidden');
  if (tabIsVisible || container.children.length > 0) {
    renderUptakeAssayEntries();
  }
}

function getUptakeAssaySamples(options = {}) {
  const activeOnly = options.activeOnly !== false;
  return state.selectedFiles
    .map((file, index) => {
      const entry = state.uptakeAssayEntries[file.path] || {};
      return {
        path: file.path,
        name: String(file.name || file.path.split(/[\\/]/).pop() || '').replace(/\.[dD]$/, ''),
        active: entry.active !== false,
        concentration: entry.concentration,
        color: entry.color || NPG_COLOR_PALETTE[index % NPG_COLOR_PALETTE.length],
      };
    })
    .filter((sample) => (activeOnly ? sample.active : true));
}

function getUptakeAssaySettings() {
  return {
    mz: parseFloat(document.getElementById('uptake-assay-mz')?.value),
    polarity: document.getElementById('uptake-assay-polarity')?.value === 'negative' ? 'negative' : 'positive',
    start: parseFloat(document.getElementById('uptake-assay-start')?.value),
    end: parseFloat(document.getElementById('uptake-assay-end')?.value),
    mzWindow: parseFloat(document.getElementById('mz-window')?.value || '0.5') || 0.5,
    smooth: parseInt(document.getElementById('eic-smoothing')?.value, 10) || 0,
  };
}

function computeUptakeAssayFit(points) {
  const usable = (Array.isArray(points) ? points : []).filter((point) =>
    Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y))
  );
  if (usable.length < 2) return null;
  const xVals = usable.map((point) => Number(point.x));
  const yVals = usable.map((point) => Number(point.y));
  if (new Set(xVals.map((x) => x.toFixed(9))).size < 2) return null;

  const xMean = xVals.reduce((sum, value) => sum + value, 0) / xVals.length;
  const yMean = yVals.reduce((sum, value) => sum + value, 0) / yVals.length;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < xVals.length; i++) {
    numerator += (xVals[i] - xMean) * (yVals[i] - yMean);
    denominator += (xVals[i] - xMean) ** 2;
  }
  if (denominator === 0) return null;
  const slope = numerator / denominator;
  const intercept = yMean - slope * xMean;
  const fitted = xVals.map((x) => (slope * x) + intercept);
  const ssRes = yVals.reduce((sum, y, index) => sum + ((y - fitted[index]) ** 2), 0);
  const ssTot = yVals.reduce((sum, y) => sum + ((y - yMean) ** 2), 0);
  const rSquared = ssTot <= 0 ? 1 : 1 - (ssRes / ssTot);
  return { slope, intercept, rSquared, r_squared: rSquared };
}

function getUptakeAssayMzLabel(dataOrSettings = null) {
  const source = dataOrSettings || getUptakeAssaySettings();
  const mz = Number(source?.mz);
  return Number.isFinite(mz) ? mz.toFixed(2) : '?';
}

function buildUptakeAssayOverlayTitle(dataOrSettings = null) {
  const source = dataOrSettings || getUptakeAssaySettings();
  return `Uptake Assay CC - EIC m/z ${getUptakeAssayMzLabel(source)}${formatProgressionPolarityLabel(source?.polarity)}`;
}

function buildUptakeAssayCurveTitle(dataOrSettings = null) {
  const source = dataOrSettings || getUptakeAssaySettings();
  return `Calibration Curve - EIC m/z ${getUptakeAssayMzLabel(source)}${formatProgressionPolarityLabel(source?.polarity)}`;
}

function buildUptakeAssayAreaLabel(dataOrSettings = null) {
  const source = dataOrSettings || getUptakeAssaySettings();
  const start = Number(source?.start);
  const end = Number(source?.end);
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
    return `Integrated Area (${start.toFixed(3)}-${end.toFixed(3)} min)`;
  }
  return 'Integrated Area';
}

function buildUptakeAssayFilenameBase(dataOrSettings = null) {
  const source = dataOrSettings || getUptakeAssaySettings();
  const mzLabel = getUptakeAssayMzLabel(source);
  return sanitizeDownloadFilename(`Uptake Assay CC ${mzLabel}`);
}

function buildUptakeAssayExportStyle() {
  return {
    fig_width: 6.0,
    line_width: 2.0,
    point_size: 26.0,
    point_edge_width: 0.8,
    line_color: '#1f77b4',
    point_face_color: '#1f77b4',
    point_edge_color: '#0d4f8a',
  };
}

function getUptakeAssayPointsFromData(data) {
  const samples = Array.isArray(data?.samples) ? data.samples : [];
  return samples
    .map((sample) => {
      const entry = state.uptakeAssayEntries[sample.path] || {};
      return {
        x: parseFloat(entry.concentration),
        y: Number(sample.area),
        label: sample.name,
        path: sample.path,
      };
    })
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .sort((a, b) => a.x - b.x || a.label.localeCompare(b.label));
}

function renderUptakeAssayEntries() {
  const container = document.getElementById('uptake-assay-samples');
  if (!container) return;

  syncUptakeAssayEntriesToSelectedFiles();
  if (state.selectedFiles.length === 0) {
    container.innerHTML = '<p class="muted">Select samples in the file browser first.</p>';
    return;
  }

  const sampleAreas = new Map(
    ((state.uptakeAssayData?.samples) || []).map((sample) => [sample.path, sample.area])
  );

  let html = `<table class="uptake-assay-sample-table"><thead><tr>
    <th>Use</th>
    <th>Sample</th>
    <th>Concentration (uM)</th>
    <th>Area</th>
  </tr></thead><tbody>`;

  state.selectedFiles.forEach((file, index) => {
    const entry = state.uptakeAssayEntries[file.path] || {};
    const area = sampleAreas.get(file.path);
    const isActive = entry.active !== false;
    html += `<tr>
      <td><input type="checkbox" class="uptake-assay-active" data-path="${escapeAttr(file.path)}" ${isActive ? 'checked' : ''}></td>
      <td>
        <div><strong>${escapeHtml(String(file.name || '').replace(/\.[dD]$/, ''))}</strong></div>
        <div class="uptake-assay-sample-path">${escapeHtml(file.path)}</div>
      </td>
      <td><input type="number" class="uptake-assay-concentration" data-path="${escapeAttr(file.path)}" value="${escapeAttr(entry.concentration ?? '')}" step="0.01" min="0"></td>
      <td><span class="uptake-assay-area">${Number.isFinite(Number(area)) ? Number(area).toExponential(3) : '-'}</span></td>
    </tr>`;
  });

  html += '</tbody></table>';
  container.innerHTML = html;

  container.querySelectorAll('.uptake-assay-active').forEach((input) => {
    input.addEventListener('change', () => {
      const path = input.dataset.path;
      if (!path) return;
      const entry = state.uptakeAssayEntries[path] || {};
      entry.active = input.checked;
      state.uptakeAssayEntries[path] = entry;
      state.uptakeAssayData = null;
      resetUptakeAssayView();
      renderUptakeAssayEntries();
    });
  });

  container.querySelectorAll('.uptake-assay-concentration').forEach((input) => {
    input.addEventListener('input', () => {
      const path = input.dataset.path;
      if (!path) return;
      const entry = state.uptakeAssayEntries[path] || {};
      entry.concentration = input.value;
      state.uptakeAssayEntries[path] = entry;
    });
    input.addEventListener('change', () => {
      if (state.uptakeAssayData) renderUptakeAssayData(state.uptakeAssayData);
    });
  });
}

function renderUptakeAssaySummary(data, fit, pointCount) {
  const summary = document.getElementById('uptake-assay-summary');
  if (!summary) return;
  const sampleCount = Array.isArray(data?.samples) ? data.samples.length : 0;
  const parts = [
    `<div class="metric"><span class="dot blue"></span> Samples: ${sampleCount}</div>`,
    `<div class="metric"><span class="dot green"></span> Points: ${pointCount}</div>`,
  ];
  if (fit && Number.isFinite(fit.slope) && Number.isFinite(fit.intercept) && Number.isFinite(fit.rSquared)) {
    parts.push(`<div class="metric"><span class="dot red"></span> y = ${fit.slope.toFixed(1)}x ${fit.intercept >= 0 ? '+' : '-'} ${Math.abs(fit.intercept).toFixed(1)}</div>`);
    parts.push(`<div class="metric"><span class="dot yellow"></span> R2 = ${fit.rSquared.toFixed(4)}</div>`);
  } else {
    parts.push('<div class="metric"><span class="dot yellow"></span> Enter at least 2 numeric concentrations to fit a line</div>');
  }
  summary.innerHTML = parts.join('');
}

function renderUptakeAssayData(data) {
  renderUptakeAssayEntries();
  if (!data || !Array.isArray(data.samples) || data.samples.length === 0) {
    resetUptakeAssayView();
    return;
  }

  setUptakeAssayEmptyState(false);
  const overlaySamples = data.samples.map((sample, index) => ({
    times: sample.times || [],
    intensities: sample.intensities || [],
    label: sample.name || `Sample ${index + 1}`,
    color: sample.color || NPG_COLOR_PALETTE[index % NPG_COLOR_PALETTE.length],
  }));
  const points = getUptakeAssayPointsFromData(data);
  const fit = computeUptakeAssayFit(points);

  charts.plotUptakeAssayOverlay('uptake-assay-overlay-plot', overlaySamples, {
    title: buildUptakeAssayOverlayTitle(data),
    yLabel: 'Intensity',
    start: data.start,
    end: data.end,
  });
  charts.plotCalibrationCurve('uptake-assay-curve-plot', points, fit, {
    title: buildUptakeAssayCurveTitle(data),
    xLabel: 'Concentration (uM)',
    yLabel: buildUptakeAssayAreaLabel(data),
  });
  renderUptakeAssaySummary(data, fit, points.length);
  schedulePlotlyResize(['uptake-assay-overlay-plot', 'uptake-assay-curve-plot']);
}

async function autoDetectUptakeAssayWindow() {
  const settings = getUptakeAssaySettings();
  if (!Number.isFinite(settings.mz) || settings.mz <= 0) {
    toast('Enter a valid target m/z first', 'warning');
    return;
  }
  const sample = getUptakeAssaySamples({ activeOnly: true })[0];
  if (!sample) {
    toast('Enable at least 1 sample first', 'warning');
    return;
  }

  showLoading('Detecting uptake assay window...');
  try {
    const response = await api.findPeaks(sample.path, 'eic', {
      mz: settings.mz,
      mzWindow: settings.mzWindow,
      ionMode: settings.polarity,
      smooth: settings.smooth,
      heightThreshold: 0.06,
      prominence: 0.03,
    });
    const peaks = Array.isArray(response?.peaks) ? response.peaks : [];
    if (peaks.length === 0) {
      throw new Error('No EIC peaks found');
    }
    peaks.sort((a, b) => (Number(b.area) || Number(b.intensity) || 0) - (Number(a.area) || Number(a.intensity) || 0));
    const bestPeak = peaks[0];
    document.getElementById('uptake-assay-start').value = Number(bestPeak.start_time).toFixed(3);
    document.getElementById('uptake-assay-end').value = Number(bestPeak.end_time).toFixed(3);
    toast(`Window detected: ${Number(bestPeak.start_time).toFixed(3)} - ${Number(bestPeak.end_time).toFixed(3)} min`, 'success');
  } catch (err) {
    toast(`Auto window failed: ${err.message}`, 'error');
  } finally {
    hideLoading();
  }
}

async function runUptakeAssayCC() {
  if (state.uptakeAssayLoadInFlight) return;
  const samples = getUptakeAssaySamples({ activeOnly: true });
  if (samples.length < 2) {
    toast('Enable at least 2 samples first', 'warning');
    return;
  }

  const settings = getUptakeAssaySettings();
  if (!Number.isFinite(settings.mz) || settings.mz <= 0) {
    toast('Enter a valid target m/z', 'warning');
    return;
  }
  if (!Number.isFinite(settings.start) || !Number.isFinite(settings.end) || settings.end <= settings.start) {
    toast('Enter a valid time window', 'warning');
    return;
  }

  state.uptakeAssayLoadInFlight = true;
  showLoading('Building uptake assay calibration curve...');
  try {
    const sampleResults = await Promise.all(samples.map(async (sample) => {
      const [eicData, areaData] = await Promise.all([
        api.getEIC(sample.path, settings.mz, settings.mzWindow, settings.smooth, settings.polarity),
        api.getPeakArea(sample.path, 'eic', settings.start, settings.end, {
          mz: settings.mz,
          mzWindow: settings.mzWindow,
          ionMode: settings.polarity,
          smooth: settings.smooth,
        }),
      ]);
      return {
        path: sample.path,
        name: sample.name,
        color: sample.color,
        times: Array.isArray(eicData?.times) ? eicData.times : [],
        intensities: Array.isArray(eicData?.intensities) ? eicData.intensities : [],
        area: Number(areaData?.area) || 0,
      };
    }));

    state.uptakeAssayData = {
      mz: settings.mz,
      polarity: settings.polarity,
      start: settings.start,
      end: settings.end,
      mzWindow: settings.mzWindow,
      samples: sampleResults,
    };
    renderUptakeAssayData(state.uptakeAssayData);
    toast('Uptake assay calibration curve built', 'success');
  } catch (err) {
    toast(`Uptake assay CC failed: ${err.message}`, 'error');
  } finally {
    state.uptakeAssayLoadInFlight = false;
    hideLoading();
  }
}

async function exportUptakeAssayCCPdf() {
  if (!state.uptakeAssayData) {
    toast('Build the calibration curve first', 'warning');
    return;
  }
  const points = getUptakeAssayPointsFromData(state.uptakeAssayData);
  if (points.length < 2) {
    toast('Enter at least 2 numeric concentrations first', 'warning');
    return;
  }

  const fit = computeUptakeAssayFit(points);
  const dpi = parseInt(document.getElementById('export-dpi')?.value, 10) || 300;
  const filenameBase = buildUptakeAssayFilenameBase(state.uptakeAssayData);

  showLoading('Exporting PDF...');
  try {
    const response = await api.exportUptakeAssayCC({
      points,
      fit,
      title: buildUptakeAssayCurveTitle(state.uptakeAssayData),
      x_label: 'Concentration (uM)',
      y_label: buildUptakeAssayAreaLabel(state.uptakeAssayData),
      filename_base: filenameBase,
      style: buildUptakeAssayExportStyle(),
      format: 'pdf',
      dpi,
    });
    const blob = await backendResponseToBlob(response);
    downloadBlob(blob, `${filenameBase}.pdf`);
    toast('Exported PDF', 'success');
  } catch (err) {
    toast(`Export failed: ${err.message}`, 'error');
  } finally {
    hideLoading();
  }
}

function initUptakeAssayCC() {
  document.getElementById('btn-uptake-assay-auto-window')?.addEventListener('click', autoDetectUptakeAssayWindow);
  document.getElementById('btn-uptake-assay-run')?.addEventListener('click', runUptakeAssayCC);
  document.getElementById('btn-uptake-assay-export-pdf')?.addEventListener('click', exportUptakeAssayCCPdf);
}

// ===== Time Progression Tab =====
function initProgression() {
  document.getElementById('btn-load-progression').addEventListener('click', loadProgression);

  document.querySelectorAll('.btn-export-prog').forEach(btn => {
    btn.addEventListener('click', () => exportProgression(btn.dataset.format));
  });
}

function renderProgressionAssignments() {
  const container = document.getElementById('progression-assignments');
  container.innerHTML = '';

  if (state.selectedFiles.length < 2) {
    state.progressionAssignments = {};
    setProgressionEmptyState(true);
    return;
  }

  if (!state.progressionData) setProgressionEmptyState(true);

  syncProgressionAssignmentsToSelectedFiles();

  const sampleDefs = getProgressionSamples({ activeOnly: false });
  const autoColors = computeAutoProgressionColorMap();
  state.selectedFiles.forEach((file, i) => {
    const card = document.createElement('div');
    const assignment = state.progressionAssignments[file.path] || {};
    const isActive = assignment.active !== false;
    card.className = `assignment-card${isActive ? '' : ' is-inactive'}`;
    const defaultRole = sampleDefs[i]?.role || assignment.role || getDefaultProgressionRole(i, state.selectedFiles.length);
    const defaultLabel = sampleDefs[i]?.label || buildAutoProgressionLabel(defaultRole, 1, 1);
    const defaultColor = assignment.userColor === true
      ? (assignment.color || autoColors[file.path] || NPG_COLOR_PALETTE[i % NPG_COLOR_PALETTE.length])
      : (autoColors[file.path] || NPG_COLOR_PALETTE[i % NPG_COLOR_PALETTE.length]);

    card.innerHTML = `
      <div class="assignment-card-head">
        <label class="prog-active-toggle" title="Include this sample in Time Progression (tab only)">
          <input type="checkbox" class="prog-active" data-path="${escapeAttr(file.path)}" ${isActive ? 'checked' : ''}>
          <span class="prog-active-name" title="${escapeAttr(file.path)}">${escapeHtml(file.name)}</span>
        </label>
      </div>
      <label>Role</label>
      <select class="prog-role" data-path="${escapeAttr(file.path)}" ${isActive ? '' : 'disabled'}>
        <option value="initial" ${defaultRole === 'initial' ? 'selected' : ''}>Initial (t=0)</option>
        <option value="mid" ${defaultRole === 'mid' ? 'selected' : ''}>Mid Timepoint</option>
        <option value="final" ${defaultRole === 'final' ? 'selected' : ''}>Overnight / Final</option>
      </select>
      <label>Custom Label</label>
      <div class="prog-label-row">
        <input type="text" class="prog-label" data-path="${escapeAttr(file.path)}" placeholder="${escapeAttr(file.name)}" value="${escapeAttr(defaultLabel)}" ${isActive ? '' : 'disabled'}>
        <input type="color" class="prog-color" data-path="${escapeAttr(file.path)}" value="${escapeAttr(defaultColor)}" title="Sample color" ${isActive ? '' : 'disabled'}>
      </div>
    `;
    container.appendChild(card);
  });

  container.querySelectorAll('.prog-active').forEach((el) => {
    el.addEventListener('change', () => {
      readProgressionAssignmentsFromDOM();
      renderProgressionAssignments();
      if (state.progressionData) loadProgression();
    });
  });

  container.querySelectorAll('.prog-role').forEach((el) => {
    el.addEventListener('change', () => {
      readProgressionAssignmentsFromDOM();
      renderProgressionAssignments();
    });
  });
  container.querySelectorAll('.prog-label, .prog-color').forEach((el) => {
    el.addEventListener('change', readProgressionAssignmentsFromDOM);
    if (el.classList.contains('prog-label')) {
      el.addEventListener('input', readProgressionAssignmentsFromDOM);
    }
  });
}

async function loadProgression() {
  if (state.progressionLoadInFlight) return;
  if (state.selectedFiles.length < 2) {
    toast('Select at least 2 samples', 'warning');
    return;
  }
  const assignmentsContainer = document.getElementById('progression-assignments');
  if (assignmentsContainer && assignmentsContainer.querySelectorAll('.prog-role').length === 0) {
    renderProgressionAssignments();
  }
  readProgressionAssignmentsFromDOM();
  const samples = getProgressionSamples({ activeOnly: true });
  if (samples.length < 2) {
    toast('Enable at least 2 samples in Time Progression', 'warning');
    return;
  }

  const wavelengths = getSelectedWavelengths();
  const uvSmoothing = parseInt(document.getElementById('uv-smoothing').value);
  const eicSmoothing = parseInt(document.getElementById('eic-smoothing').value);
  const mzWindow = parseFloat(document.getElementById('mz-window').value);

  state.progressionLoadInFlight = true;
  showLoading('Generating progression...');
  try {
    // Fetch data for each sample in parallel
    const perSample = await Promise.all(samples.map(async (s) => {
      const result = { path: s.path, role: s.role, label: s.label };

      // UV for first selected wavelength
      if (wavelengths.length > 0) {
        try {
          result.uv = await api.getUVChromatogram(s.path, wavelengths[0], uvSmoothing);
        } catch { result.uv = null; }
      }

      // TIC
      try {
        result.tic = await api.getTIC(s.path);
      } catch { result.tic = null; }

      // EICs
      result.eics = [];
      for (const t of state.mzTargets) {
        const mz = t.mz; const polarity = t.polarity || 'positive';
        try {
          const eic = await api.getEIC(s.path, mz, mzWindow, eicSmoothing, polarity);
          result.eics.push({ mz, polarity, ...eic });
        } catch { result.eics.push({ mz, polarity, times: [], intensities: [] }); }
      }

      return result;
    }));

    // Reshape into progression format
    const data = {};

    // UV progression
    const uvData = perSample.filter(s => s.uv).map(s => s.uv);
    if (uvData.length > 0) {
      data.uv_progression = uvData;
    }

    // TIC progression
    const ticData = perSample.filter(s => s.tic).map(s => s.tic);
    if (ticData.length > 0) {
      data.tic_progression = ticData;
    }

    // EIC progressions (one per m/z target)
    if (state.mzTargets.length > 0) {
      data.eic_progressions = state.mzTargets.map((t, mi) => ({
        mz: t.mz, polarity: t.polarity || 'positive',
        samples: perSample.map(s => s.eics[mi] || { times: [], intensities: [] }),
      }));
    }

    state.progressionData = data;
    renderProgression(data, samples);
    renderReportSummary();
    toast('Progression generated', 'success');
  } catch (err) {
    const msg = typeof err === 'object' ? (err.message || JSON.stringify(err)) : String(err);
    toast(`Progression failed: ${msg}`, 'error');
  } finally {
    state.progressionLoadInFlight = false;
    hideLoading();
  }
}

function renderProgression(data, samples) {
  const hasAnyProgression =
    Boolean(data.uv_progression) ||
    Boolean(data.tic_progression) ||
    (Array.isArray(data.eic_progressions) && data.eic_progressions.length > 0);

  if (!hasAnyProgression) {
    setProgressionEmptyState(true);
    return;
  }

  // Make plot container visible before Plotly renders to avoid first-render
  // width underestimation (half-width charts until second click).
  setProgressionEmptyState(false);
  const container = document.getElementById('progression-plots');
  container.innerHTML = '';

  const colors = {
    initial: document.getElementById('color-initial').value,
    mid: document.getElementById('color-mid').value,
    final: document.getElementById('color-final').value,
  };

  const baseTitle = getProgressionBaseTitle();
  const xRange = computeProgressionXRange(data);
  const progressionPlotIds = [];

  // UV progression
  if (data.uv_progression) {
    const div = document.createElement('div');
    div.className = 'plot-container';
    div.id = 'prog-uv-plot';
    container.appendChild(div);
    progressionPlotIds.push(div.id);

    const uvSamples = data.uv_progression.map((s, i) => ({
      times: s.times,
      intensities: s.intensities,
      label: samples[i]?.label || `Sample ${i + 1}`,
      role: samples[i]?.role || 'mid',
      color: samples[i]?.color,
    }));
    charts.plotProgression('prog-uv-plot', uvSamples, colors, {
      title: `${baseTitle} - UV`,
      yLabel: 'Absorbance (mAU)',
      xRange,
    });
  }

  // TIC progression
  if (data.tic_progression) {
    const hasDual = data.tic_progression.some(s => s.has_dual_polarity);
    if (hasDual) {
      // Positive panel
      const posDiv = document.createElement('div');
      posDiv.className = 'plot-container';
      posDiv.id = 'prog-tic-pos-plot';
      container.appendChild(posDiv);
      progressionPlotIds.push(posDiv.id);
      const ticPosSamples = data.tic_progression.map((s, i) => ({
        times: s.times_pos || s.times,
        intensities: s.intensities_pos || s.intensities,
        label: samples[i]?.label || `Sample ${i + 1}`,
        role: samples[i]?.role || 'mid',
        color: samples[i]?.color,
      }));
      charts.plotProgression('prog-tic-pos-plot', ticPosSamples, colors, {
        title: `${baseTitle} - TIC (+)`,
        yLabel: 'Intensity',
        xRange,
      });

      // Negative panel
      const negDiv = document.createElement('div');
      negDiv.className = 'plot-container';
      negDiv.id = 'prog-tic-neg-plot';
      container.appendChild(negDiv);
      progressionPlotIds.push(negDiv.id);
      const ticNegSamples = data.tic_progression.map((s, i) => ({
        times: s.times_neg || s.times,
        intensities: s.intensities_neg || s.intensities,
        label: samples[i]?.label || `Sample ${i + 1}`,
        role: samples[i]?.role || 'mid',
        color: samples[i]?.color,
      }));
      charts.plotProgression('prog-tic-neg-plot', ticNegSamples, colors, {
        title: `${baseTitle} - TIC (−)`,
        yLabel: 'Intensity',
        xRange,
      });
    } else {
      const div = document.createElement('div');
      div.className = 'plot-container';
      div.id = 'prog-tic-plot';
      container.appendChild(div);
      progressionPlotIds.push(div.id);
      const ticSamples = data.tic_progression.map((s, i) => ({
        times: s.times,
        intensities: s.intensities,
        label: samples[i]?.label || `Sample ${i + 1}`,
        role: samples[i]?.role || 'mid',
        color: samples[i]?.color,
      }));
      charts.plotProgression('prog-tic-plot', ticSamples, colors, {
        title: `${baseTitle} - TIC`,
        yLabel: 'Intensity',
        xRange,
      });
    }
  }

  // EIC progressions
  if (data.eic_progressions) {
    data.eic_progressions.forEach((eicGroup, gi) => {
      const div = document.createElement('div');
      div.className = 'plot-container';
      div.id = `prog-eic-plot-${gi}`;
      container.appendChild(div);
      progressionPlotIds.push(div.id);

      const eicSamples = eicGroup.samples.map((s, i) => ({
        times: s.times,
        intensities: s.intensities,
        label: samples[i]?.label || `Sample ${i + 1}`,
        role: samples[i]?.role || 'mid',
        color: samples[i]?.color,
      }));
      const polarityLabel = formatProgressionPolarityLabel(eicGroup.polarity);
      charts.plotProgression(`prog-eic-plot-${gi}`, eicSamples, colors, {
        title: `${baseTitle} - EIC m/z ${eicGroup.mz.toFixed(2)}${polarityLabel}`,
        yLabel: 'Intensity',
        xRange,
      });

      const downloadRow = document.createElement('div');
      downloadRow.className = 'single-eic-download-row';
      downloadRow.innerHTML = '<button class="btn btn-sm">Download PDF</button>';
      downloadRow.querySelector('button').addEventListener('click', () => exportProgressionEicPanel(gi));
      container.appendChild(downloadRow);
    });
  }
  schedulePlotlyResize(progressionPlotIds);
}

async function exportProgression(format) {
  if (!state.progressionData) {
    toast('Generate progression first', 'warning');
    return;
  }
  await exportAllPlots('tab-progression', 'progression', format);
}

// ===== EIC Batch Tab =====
function initEICBatch() {
  document.getElementById('btn-run-eic').addEventListener('click', runEICBatch);
  document.getElementById('btn-export-eic-csv').addEventListener('click', exportEICCSV);
  document.getElementById('eic-overlay').addEventListener('change', reRenderEICBatch);
  document.getElementById('eic-normalize').addEventListener('change', reRenderEICBatch);
  const eicAddBtn = document.getElementById('btn-eic-add-mz');
  const eicAddInput = document.getElementById('eic-mz-add-input');
  if (eicAddBtn && eicAddInput) {
    eicAddBtn.addEventListener('click', () => addMzTargetFromInput(eicAddInput));
    eicAddInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addMzTargetFromInput(eicAddInput);
    });
  }
}

async function runEICBatch() {
  const samplePath = document.getElementById('eic-sample-select').value;
  if (!samplePath) {
    toast('Select a sample first', 'warning');
    return;
  }
  if (state.mzTargets.length === 0) {
    toast('Add target m/z values in Settings first', 'warning');
    return;
  }

  showLoading('Running EIC batch analysis...');
  try {
    const data = await api.runEICBatch({
      path: samplePath,
      targets: state.mzTargets,
      mz_window: parseFloat(document.getElementById('mz-window').value),
      smoothing: parseInt(document.getElementById('eic-smoothing').value),
    });
    if (Array.isArray(data?.targets)) {
      data.targets.forEach((target) => normalizeTargetAutoPeaks(target));
    }

    state.eicBatchData = data;
    state.eicBatchOriginalData = deepClone(data);
    renderEICBatch(data);
    renderReportSummary();
    toast('EIC batch analysis complete', 'success');
  } catch (err) {
    toast(`EIC batch failed: ${err.message}`, 'error');
  } finally {
    hideLoading();
  }
}

function renderEICBatch(data) {
  setEICBatchEmptyState(false);

  const overlay = document.getElementById('eic-overlay').checked;
  const normalize = document.getElementById('eic-normalize').checked;

  // Combined/overlay plot
  const plotDiv = document.getElementById('eic-combined-plot');
  plotDiv.innerHTML = '';
  plotDiv.id = 'eic-combined-plot';

  if (data.targets && data.targets.length > 0) {
    if (overlay) {
      charts.plotEICOverlay('eic-combined-plot', data.targets, { normalize, title: 'EIC Overlay - All Targets' });
    } else {
      charts.plotEICOverlay('eic-combined-plot', data.targets, { normalize, title: 'EIC Combined View' });
    }
  }

  // Per-target expandable sections
  const sectionsContainer = document.getElementById('eic-peak-sections');
  sectionsContainer.querySelectorAll('.eic-section-body').forEach((body) => {
    const match = body.id.match(/^eic-section-body-(\d+)$/);
    if (match) {
      state.eicCollapsedSections[match[1]] = body.classList.contains('collapsed');
    }
  });
  sectionsContainer.innerHTML = '';

  if (data.targets) {
    data.targets.forEach((target, ti) => {
      const section = document.createElement('div');
      section.className = 'eic-section';
      const isCollapsed = state.eicCollapsedSections[String(ti)] === true;

      const peakCount = target.peaks ? target.peaks.length : 0;
      section.innerHTML = `
        <div class="eic-section-header" data-toggle="eic-section-body-${ti}">
          <span>m/z ${target.mz.toFixed(2)} (${peakCount} peak${peakCount !== 1 ? 's' : ''})</span>
          <span class="chevron" style="${isCollapsed ? 'transform: rotate(-90deg);' : ''}">&#9660;</span>
        </div>
        <div id="eic-section-body-${ti}" class="eic-section-body${isCollapsed ? ' collapsed' : ''}">
          <div id="eic-detail-plot-${ti}" class="plot-container" style="min-height:250px;"></div>
          <div id="eic-peaks-${ti}"></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
            <button type="button" class="btn btn-sm" data-target-idx="${ti}" style="margin-top:0;">+ Add Peak Manually</button>
            <button type="button" class="btn btn-sm" data-reset-target-idx="${ti}" style="margin-top:0;">Reset to Auto Peaks</button>
          </div>
        </div>
      `;

      sectionsContainer.appendChild(section);

      // Toggle section
      section.querySelector('.eic-section-header').addEventListener('click', function () {
        const body = document.getElementById(`eic-section-body-${ti}`);
        body.classList.toggle('collapsed');
        state.eicCollapsedSections[String(ti)] = body.classList.contains('collapsed');
        this.querySelector('.chevron').style.transform = body.classList.contains('collapsed') ? 'rotate(-90deg)' : '';
      });

      // Render detail plot
      charts.plotEICWithPeaks(`eic-detail-plot-${ti}`, target, {
        title: `EIC m/z ${target.mz.toFixed(2)}`,
        normalize,
      });

      // Render peak rows
      renderPeakRows(ti, target);

      // Manual peak add
      section.querySelector(`button[data-target-idx="${ti}"]`).addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        addManualPeak(ti);
      });

      // Reset to original auto-detected peaks for this target
      section.querySelector(`button[data-reset-target-idx="${ti}"]`).addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        resetTargetToAutoPeaks(ti);
      });
    });
  }

  // Results table
  renderEICResultsTable(data);
}

function findClosestTimeIndex(times, value) {
  if (!Array.isArray(times) || times.length === 0) return -1;
  const target = Number(value);
  if (!Number.isFinite(target)) return 0;

  let lo = 0;
  let hi = times.length - 1;
  if (target <= Number(times[lo])) return lo;
  if (target >= Number(times[hi])) return hi;

  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (Number(times[mid]) <= target) lo = mid;
    else hi = mid;
  }

  return Math.abs(Number(times[lo]) - target) <= Math.abs(Number(times[hi]) - target) ? lo : hi;
}

function findValleyIndex(intensities, leftIdx, rightIdx) {
  const n = Array.isArray(intensities) ? intensities.length : 0;
  if (n === 0) return 0;
  let left = Math.max(0, Math.min(n - 1, Math.floor(leftIdx)));
  let right = Math.max(0, Math.min(n - 1, Math.floor(rightIdx)));
  if (right < left) {
    const tmp = left;
    left = right;
    right = tmp;
  }
  let valleyIdx = left;
  let valleyVal = Number(intensities[left]) || 0;
  for (let i = left + 1; i <= right; i++) {
    const v = Number(intensities[i]) || 0;
    if (v < valleyVal) {
      valleyVal = v;
      valleyIdx = i;
    }
  }
  return valleyIdx;
}

function findThresholdEdgeIndex(intensities, apexIdx, limitIdx, threshold, direction) {
  const n = Array.isArray(intensities) ? intensities.length : 0;
  if (n === 0) return 0;
  let apex = Math.max(0, Math.min(n - 1, Math.floor(apexIdx)));
  let limit = Math.max(0, Math.min(n - 1, Math.floor(limitIdx)));
  const thr = Number.isFinite(Number(threshold)) ? Number(threshold) : 0;

  let edge = apex;
  if (direction < 0) {
    if (limit > apex) limit = apex;
    for (let i = apex; i >= limit; i--) {
      edge = i;
      const v = Number(intensities[i]) || 0;
      if (v <= thr) break;
    }
  } else {
    if (limit < apex) limit = apex;
    for (let i = apex; i <= limit; i++) {
      edge = i;
      const v = Number(intensities[i]) || 0;
      if (v <= thr) break;
    }
  }
  return edge;
}

function normalizeTargetAutoPeaks(target) {
  if (!target || !Array.isArray(target.peaks) || target.peaks.length === 0) return;
  if (target.peaks.some(p => (p.type || 'auto') !== 'auto')) return;

  const times = Array.isArray(target.times) ? target.times.map(v => Number(v)) : [];
  const intensities = Array.isArray(target.intensities) ? target.intensities.map(v => Number(v)) : [];
  if (times.length < 3 || times.length !== intensities.length) return;

  const nPts = times.length;
  const clippedInts = intensities.map(v => (Number.isFinite(v) ? Math.max(0, v) : 0));
  const maxInt = Math.max(...clippedInts, 0);
  if (maxInt <= 0) return;

  const sortedInts = [...clippedInts].sort((a, b) => a - b);
  const p10 = sortedInts[Math.floor((sortedInts.length - 1) * 0.10)] || 0;
  const noiseFloor = Math.max(p10, maxInt * 0.002);

  const peakWrappers = target.peaks.map((peak) => {
    const apexGuess = Number.isFinite(Number(peak.apex))
      ? Number(peak.apex)
      : ((Number(peak.start) + Number(peak.end)) / 2);
    let apexIdx = findClosestTimeIndex(times, apexGuess);
    if (apexIdx < 0) apexIdx = 0;

    const startIdx = findClosestTimeIndex(times, Number(peak.start));
    const endIdx = findClosestTimeIndex(times, Number(peak.end));
    if (startIdx >= 0 && endIdx >= 0) {
      const left = Math.min(startIdx, endIdx);
      const right = Math.max(startIdx, endIdx);
      let localMaxIdx = apexIdx;
      if (localMaxIdx < left || localMaxIdx > right) localMaxIdx = left;
      for (let i = left; i <= right; i++) {
        if (clippedInts[i] > clippedInts[localMaxIdx]) localMaxIdx = i;
      }
      apexIdx = localMaxIdx;
    }

    return { peak, apexIdx };
  });

  peakWrappers.sort((a, b) => {
    if (a.apexIdx !== b.apexIdx) return a.apexIdx - b.apexIdx;
    return (Number(a.peak.start) || 0) - (Number(b.peak.start) || 0);
  });

  for (let i = 1; i < peakWrappers.length; i++) {
    if (peakWrappers[i].apexIdx <= peakWrappers[i - 1].apexIdx) {
      peakWrappers[i].apexIdx = Math.min(nPts - 1, peakWrappers[i - 1].apexIdx + 1);
    }
  }

  const valleys = [];
  for (let i = 0; i < peakWrappers.length - 1; i++) {
    valleys.push(findValleyIndex(clippedInts, peakWrappers[i].apexIdx, peakWrappers[i + 1].apexIdx));
  }

  for (let i = 0; i < peakWrappers.length; i++) {
    const item = peakWrappers[i];
    const hardLeft = i === 0 ? 0 : valleys[i - 1];
    const hardRight = i === peakWrappers.length - 1 ? (nPts - 1) : valleys[i];
    const apexIdx = Math.max(hardLeft, Math.min(hardRight, item.apexIdx));
    const apexInt = clippedInts[apexIdx];
    const threshold = Math.max(noiseFloor, apexInt * 0.03);

    let startIdx = findThresholdEdgeIndex(clippedInts, apexIdx, hardLeft, threshold, -1);
    let endIdx = findThresholdEdgeIndex(clippedInts, apexIdx, hardRight, threshold, 1);

    startIdx = Math.max(hardLeft, Math.min(startIdx, hardRight));
    endIdx = Math.max(hardLeft, Math.min(endIdx, hardRight));
    if (endIdx <= startIdx) {
      startIdx = hardLeft;
      endIdx = hardRight;
    }
    if (endIdx <= startIdx) {
      endIdx = Math.min(nPts - 1, startIdx + 1);
    }

    item.peak.start = Number(times[startIdx]);
    item.peak.end = Number(times[endIdx]);
    item.peak.apex = Number(times[apexIdx]);
  }

  target.peaks = peakWrappers.map(item => item.peak);
  sortTargetPeaksByStart(target);
  enforcePeakBoundaries(target, 0, {});
  recalculateTargetPeaks(target);
}

function sortTargetPeaksByStart(target) {
  if (!target || !Array.isArray(target.peaks)) return;
  target.peaks.sort((a, b) => {
    const sa = Number.isFinite(Number(a.start)) ? Number(a.start) : Number.POSITIVE_INFINITY;
    const sb = Number.isFinite(Number(b.start)) ? Number(b.start) : Number.POSITIVE_INFINITY;
    return sa - sb;
  });
}

function recalculatePeakMetrics(target, peak) {
  const times = Array.isArray(target.times) ? target.times : [];
  const intensities = Array.isArray(target.intensities) ? target.intensities : [];
  if (times.length === 0 || intensities.length === 0 || times.length !== intensities.length) {
    peak.area = 0;
    peak.apex = Number(peak.start) || 0;
    peak.times = [];
    peak.intensities = [];
    return;
  }

  const tMin = Number(times[0]);
  const tMax = Number(times[times.length - 1]);
  let start = Number(peak.start);
  let end = Number(peak.end);
  if (!Number.isFinite(start)) start = tMin;
  if (!Number.isFinite(end)) end = start;
  start = Math.max(tMin, Math.min(tMax, start));
  end = Math.max(tMin, Math.min(tMax, end));
  if (end < start) {
    const temp = start;
    start = end;
    end = temp;
  }
  peak.start = start;
  peak.end = end;

  let first = -1;
  let last = -1;
  for (let i = 0; i < times.length; i++) {
    const t = Number(times[i]);
    if (t >= start && t <= end) {
      if (first === -1) first = i;
      last = i;
    }
  }

  if (first === -1 || last === -1 || last < first) {
    peak.area = 0;
    peak.apex = start;
    peak.times = [];
    peak.intensities = [];
    return;
  }

  const sliceTimes = times.slice(first, last + 1);
  const sliceInts = intensities.slice(first, last + 1);
  peak.times = sliceTimes;
  peak.intensities = sliceInts;

  let area = 0;
  for (let i = first; i < last; i++) {
    const x0 = Number(times[i]);
    const x1 = Number(times[i + 1]);
    const y0 = Number(intensities[i]) || 0;
    const y1 = Number(intensities[i + 1]) || 0;
    area += Math.max(0, x1 - x0) * (y0 + y1) / 2;
  }
  peak.area = area;

  let apexIdx = first;
  let apexInt = Number(intensities[first]) || 0;
  for (let i = first + 1; i <= last; i++) {
    const val = Number(intensities[i]) || 0;
    if (val > apexInt) {
      apexInt = val;
      apexIdx = i;
    }
  }
  peak.apex = Number(times[apexIdx]);
}

function recalculateTargetPeaks(target) {
  if (!target || !Array.isArray(target.peaks)) return;
  target.peaks.forEach((peak) => recalculatePeakMetrics(target, peak));
}

function enforcePeakBoundaries(target, movedIdx, changeInfo = {}) {
  if (!target || !Array.isArray(target.peaks) || target.peaks.length === 0) return;
  const peaks = target.peaks;
  const moved = peaks[movedIdx];
  if (!moved) return;

  if (changeInfo.field === 'end' && movedIdx < peaks.length - 1) {
    const next = peaks[movedIdx + 1];
    const prevNextStart = Number(changeInfo.prevNextStart);
    if (changeInfo.wasTouchingNext && Number.isFinite(prevNextStart) && moved.end > prevNextStart) {
      next.start = moved.end;
    }
  }

  for (let i = 0; i < peaks.length; i++) {
    const p = peaks[i];
    let s = Number(p.start);
    let e = Number(p.end);
    if (!Number.isFinite(s)) s = 0;
    if (!Number.isFinite(e)) e = s;
    if (e < s) e = s;
    p.start = s;
    p.end = e;
  }

  for (let i = 0; i < peaks.length - 1; i++) {
    const current = peaks[i];
    const next = peaks[i + 1];
    if (current.end > next.start) {
      if (changeInfo.field === 'end' && i === movedIdx && changeInfo.wasTouchingNext) {
        next.start = current.end;
      } else {
        current.end = next.start;
      }
    }
    if (current.end < current.start) current.end = current.start;
    if (next.start < current.end) next.start = current.end;
    if (next.end < next.start) next.end = next.start;
  }
}

function renderPeakRows(targetIdx, target) {
  const container = document.getElementById(`eic-peaks-${targetIdx}`);
  container.innerHTML = '';

  if (!target.peaks || target.peaks.length === 0) {
    container.innerHTML = '<p class="muted" style="padding:6px 0;">No peaks detected</p>';
    return;
  }

  sortTargetPeaksByStart(target);
  recalculateTargetPeaks(target);

  target.peaks.forEach((peak, pi) => {
    const startVal = Number.isFinite(peak.start) ? peak.start : 0;
    const endVal = Number.isFinite(peak.end) ? peak.end : startVal;
    const areaVal = Number.isFinite(peak.area) ? peak.area : 0;
    const row = document.createElement('div');
    row.className = 'peak-row';
    row.innerHTML = `
      <input type="checkbox" class="peak-check" data-ti="${targetIdx}" data-pi="${pi}" ${peak.selected !== false ? 'checked' : ''}>
      <span>Peak ${pi + 1}</span>
      <label style="display:flex;align-items:center;gap:4px;margin:0;">Start: <input type="number" class="peak-start" data-ti="${targetIdx}" data-pi="${pi}" value="${startVal.toFixed(3)}" step="0.01" style="width:80px;"></label>
      <label style="display:flex;align-items:center;gap:4px;margin:0;">End: <input type="number" class="peak-end" data-ti="${targetIdx}" data-pi="${pi}" value="${endVal.toFixed(3)}" step="0.01" style="width:80px;"></label>
      <span class="area-val">Area: ${areaVal.toExponential(3)}</span>
    `;
    container.appendChild(row);

    // Peak checkbox toggle
    row.querySelector('.peak-check').addEventListener('change', (e) => {
      state.eicBatchData.targets[targetIdx].peaks[pi].selected = e.target.checked;
      reRenderEICBatch({ preserveScroll: true });
    });

    // Peak start/end edit
    row.querySelector('.peak-start').addEventListener('change', (e) => {
      const targetRef = state.eicBatchData.targets[targetIdx];
      const peaks = targetRef.peaks || [];
      const current = peaks[pi];
      if (!current) return;
      const nextVal = parseFloat(e.target.value);
      if (!Number.isFinite(nextVal)) return;
      current.start = nextVal;
      enforcePeakBoundaries(targetRef, pi, { field: 'start' });
      recalculateTargetPeaks(targetRef);
      reRenderEICBatch({ preserveScroll: true });
    });
    row.querySelector('.peak-end').addEventListener('change', (e) => {
      const targetRef = state.eicBatchData.targets[targetIdx];
      const peaks = targetRef.peaks || [];
      const current = peaks[pi];
      if (!current) return;
      const oldEnd = Number(current.end);
      const next = peaks[pi + 1];
      const oldNextStart = next ? Number(next.start) : NaN;
      const nextVal = parseFloat(e.target.value);
      if (!Number.isFinite(nextVal)) return;
      current.end = nextVal;
      enforcePeakBoundaries(targetRef, pi, {
        field: 'end',
        prevNextStart: oldNextStart,
        wasTouchingNext: Number.isFinite(oldEnd) && Number.isFinite(oldNextStart) && Math.abs(oldEnd - oldNextStart) <= 1e-6,
      });
      recalculateTargetPeaks(targetRef);
      reRenderEICBatch({ preserveScroll: true });
    });
  });
}

function addManualPeak(targetIdx) {
  const target = state.eicBatchData.targets[targetIdx];
  if (!target.peaks) target.peaks = [];

  // Default: a small window in the middle of the time range
  const times = target.times;
  if (!Array.isArray(times) || times.length === 0) {
    toast('Cannot add manual peak: no EIC time axis available', 'warning');
    return;
  }
  const mid = times[Math.floor(times.length / 2)];
  const span = (times[times.length - 1] - times[0]) * 0.05;

  target.peaks.push({
    start: mid - span,
    end: mid + span,
    apex: mid,
    area: 0,
    type: 'manual',
    selected: true,
    times: [],
    intensities: [],
  });

  sortTargetPeaksByStart(target);
  enforcePeakBoundaries(target, target.peaks.length - 1, { field: 'end' });
  recalculateTargetPeaks(target);
  reRenderEICBatch({ preserveScroll: true });
  toast('Manual peak added. Adjust start/end times.', 'info');
}

function resetTargetToAutoPeaks(targetIdx) {
  const currentTarget = state.eicBatchData?.targets?.[targetIdx];
  const originalTarget = state.eicBatchOriginalData?.targets?.[targetIdx];
  if (!currentTarget || !originalTarget || !Array.isArray(originalTarget.peaks)) {
    toast('Auto peaks are not available for this target', 'warning');
    return;
  }

  currentTarget.peaks = deepClone(originalTarget.peaks);
  sortTargetPeaksByStart(currentTarget);
  enforcePeakBoundaries(currentTarget, 0, {});
  recalculateTargetPeaks(currentTarget);
  reRenderEICBatch({ preserveScroll: true });
  toast('Restored auto-calculated peaks', 'success');
}

function reRenderEICBatch(options = {}) {
  if (state.eicBatchData) {
    const preserveScroll = options.preserveScroll !== false;
    const panel = document.getElementById('tab-eic-batch');
    const prevScrollTop = (preserveScroll && panel) ? panel.scrollTop : null;
    renderEICBatch(state.eicBatchData);
    if (preserveScroll && panel && prevScrollTop != null) {
      requestAnimationFrame(() => {
        panel.scrollTop = prevScrollTop;
        requestAnimationFrame(() => {
          panel.scrollTop = prevScrollTop;
        });
      });
    }
  }
}

function renderEICResultsTable(data) {
  const container = document.getElementById('eic-results-table-container');
  container.innerHTML = '';

  if (!data.targets || data.targets.length === 0) return;

  const rows = [];
  data.targets.forEach(target => {
    if (target.peaks) {
      target.peaks.forEach((peak, pi) => {
        rows.push({
          mz: target.mz,
          peak: pi + 1,
          type: peak.type || 'auto',
          apex: peak.apex,
          start: peak.start,
          end: peak.end,
          area: peak.area,
        });
      });
    }
  });

  if (rows.length === 0) {
    container.innerHTML = '<p class="placeholder-msg">No peaks found</p>';
    return;
  }

  let html = `<div class="data-table-wrapper"><table class="data-table">
    <thead><tr>
      <th>m/z</th><th>Peak</th><th>Type</th><th>Apex (min)</th><th>Start (min)</th><th>End (min)</th><th>Area</th>
    </tr></thead><tbody>`;

  rows.forEach(r => {
    const startVal = Number.isFinite(r.start) ? r.start.toFixed(3) : '-';
    const endVal = Number.isFinite(r.end) ? r.end.toFixed(3) : '-';
    const areaVal = Number.isFinite(r.area) ? r.area.toExponential(3) : '-';
    const mzVal = Number.isFinite(r.mz) ? r.mz.toFixed(2) : '-';
    html += `<tr>
      <td>${mzVal}</td>
      <td>${r.peak}</td>
      <td>${r.type}</td>
      <td>${r.apex != null ? r.apex.toFixed(3) : '-'}</td>
      <td>${startVal}</td>
      <td>${endVal}</td>
      <td>${areaVal}</td>
    </tr>`;
  });

  html += '</tbody></table></div>';
  container.innerHTML = html;
}

async function exportEICCSV() {
  if (!state.eicBatchData) {
    toast('Run EIC batch analysis first', 'warning');
    return;
  }

  const rows = [['m/z', 'Peak', 'Type', 'Apex (min)', 'Start (min)', 'End (min)', 'Area']];
  state.eicBatchData.targets.forEach(target => {
    (target.peaks || []).forEach((peak, pi) => {
      rows.push([
        Number.isFinite(target.mz) ? target.mz.toFixed(2) : '',
        pi + 1,
        peak.type || 'auto',
        Number.isFinite(peak.apex) ? peak.apex.toFixed(3) : '',
        Number.isFinite(peak.start) ? peak.start.toFixed(3) : '',
        Number.isFinite(peak.end) ? peak.end.toFixed(3) : '',
        Number.isFinite(peak.area) ? peak.area.toExponential(4) : '',
      ]);
    });
  });

  const csv = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  downloadBlob(blob, 'eic_results.csv');
  toast('CSV exported', 'success');
}

// ===== Deconvolution Tab =====
function getGlobalDeconvMassRangeParams() {
  const massLowRaw = document.getElementById('mass-axis-min')?.value ?? '';
  const massHighRaw = document.getElementById('mass-axis-max')?.value ?? '';
  const massLow = parseFloat(massLowRaw);
  const massHigh = parseFloat(massHighRaw);
  const params = {};
  if (massLowRaw !== '' && Number.isFinite(massLow)) params.mass_range_low = massLow;
  if (massHighRaw !== '' && Number.isFinite(massHigh)) params.mass_range_high = massHigh;
  return params;
}

function restoreDefaultDeconvExpertSettings() {
  const idToValue = {
    'dp-min-charge': DECONV_EXPERT_DEFAULTS.minCharge,
    'dp-max-charge': DECONV_EXPERT_DEFAULTS.maxCharge,
    'dp-min-ions': DECONV_EXPERT_DEFAULTS.minIons,
    'dp-mw-agree': DECONV_EXPERT_DEFAULTS.mwAgreePct,
    'dp-contig-min': DECONV_EXPERT_DEFAULTS.contigMin,
    'dp-abundance': DECONV_EXPERT_DEFAULTS.abundancePct,
    'dp-r2': DECONV_EXPERT_DEFAULTS.envelopePct,
    'dp-fwhm': DECONV_EXPERT_DEFAULTS.fwhm,
    'dp-mass-low': DECONV_EXPERT_DEFAULTS.massLow,
    'dp-mass-high': DECONV_EXPERT_DEFAULTS.massHigh,
    'dp-noise': DECONV_EXPERT_DEFAULTS.noiseCutoff,
  };

  Object.entries(idToValue).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el) el.value = value;
  });

  const monoisotopic = document.getElementById('dp-monoisotopic');
  if (monoisotopic) monoisotopic.checked = DECONV_EXPERT_DEFAULTS.monoisotopic;

  const axisMin = document.getElementById('mass-axis-min');
  const axisMax = document.getElementById('mass-axis-max');
  if (axisMin) axisMin.value = DECONV_EXPERT_DEFAULTS.massLow;
  if (axisMax) axisMax.value = DECONV_EXPERT_DEFAULTS.massHigh;
}

function buildDeconvolutionRequest(path, startTime, endTime) {
  const params = {
    path,
    start_time: startTime,
    end_time: endTime,
    ion_mode: document.querySelector('input[name="ion-mode"]:checked')?.value || 'positive',
  };
  Object.assign(params, getGlobalDeconvMassRangeParams());

  if (document.getElementById('expert-mode-toggle')?.checked) {
    params.min_charge = parseInt(document.getElementById('dp-min-charge')?.value, 10);
    params.max_charge = parseInt(document.getElementById('dp-max-charge')?.value, 10);
    params.min_peaks = parseInt(document.getElementById('dp-min-ions')?.value, 10);
    const mwAgreePct = parseFloat(document.getElementById('dp-mw-agree')?.value);
    const abundancePct = parseFloat(document.getElementById('dp-abundance')?.value);
    const envelopePct = parseFloat(document.getElementById('dp-r2')?.value);
    params.mw_agreement = Number.isFinite(mwAgreePct) ? (mwAgreePct / 100.0) : undefined;
    params.contig_min = parseInt(document.getElementById('dp-contig-min')?.value, 10);
    params.abundance_cutoff = Number.isFinite(abundancePct) ? (abundancePct / 100.0) : undefined;
    params.r2_cutoff = Number.isFinite(envelopePct) ? (envelopePct / 100.0) : undefined;
    params.fwhm = parseFloat(document.getElementById('dp-fwhm')?.value);
    params.monoisotopic = document.getElementById('dp-monoisotopic')?.checked === true;

    const massLow = document.getElementById('dp-mass-low')?.value;
    const massHigh = document.getElementById('dp-mass-high')?.value;
    const noise = document.getElementById('dp-noise')?.value;
    if (massLow) params.mass_range_low = parseFloat(massLow);
    if (massHigh) params.mass_range_high = parseFloat(massHigh);
    if (noise) params.noise_cutoff = parseFloat(noise);
  }

  return params;
}

function getDeconvolutionRunSignature() {
  const samplePath = document.getElementById('deconv-sample-select')?.value || '';
  const start = parseFloat(document.getElementById('deconv-start')?.value);
  const end = parseFloat(document.getElementById('deconv-end')?.value);
  if (!samplePath || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return '';
  return JSON.stringify(buildDeconvolutionRequest(samplePath, start, end));
}

async function autoRunDeconvolutionOnTabOpen() {
  if (state.deconvAutoRunInFlight) return;
  const samplePath = document.getElementById('deconv-sample-select')?.value || '';
  if (!samplePath) return;

  state.deconvAutoRunInFlight = true;
  try {
    if (!state.deconvResults || state.deconvSamplePath !== samplePath) {
      try {
        const data = await api.autoDetectWindow(samplePath);
        if (Number.isFinite(data.start) && Number.isFinite(data.end) && data.end > data.start) {
          document.getElementById('deconv-start').value = data.start.toFixed(2);
          document.getElementById('deconv-end').value = data.end.toFixed(2);
        }
      } catch (_) {
        // Keep current range if auto-detect fails.
      }
      await refreshDeconvWindowContext(samplePath);
    }

    const signature = getDeconvolutionRunSignature();
    if (!signature) return;
    if (signature === state.deconvAutoRunSignature && state.deconvResults && state.deconvSamplePath === samplePath) {
      return;
    }

    state.deconvAutoRunSignature = signature;
    await runDeconvolution();
  } finally {
    state.deconvAutoRunInFlight = false;
  }
}

function initDeconvolution() {
  document.getElementById('btn-auto-detect-window').addEventListener('click', autoDetectDeconvWindow);
  document.getElementById('btn-run-deconv').addEventListener('click', runDeconvolution);
  document.getElementById('deconv-start').addEventListener('change', () => refreshDeconvWindowContext());
  document.getElementById('deconv-end').addEventListener('change', () => refreshDeconvWindowContext());
  document.getElementById('btn-deconv-mode-deconvolute')?.addEventListener('click', () => setDeconvInteractionMode('deconvolute'));
  document.getElementById('btn-deconv-mode-zoom')?.addEventListener('click', () => setDeconvInteractionMode('zoom'));
  document.querySelectorAll('.btn-export-deconv-masses').forEach((btn) => {
    btn.addEventListener('click', () => exportDeconvMasses(btn.dataset.format));
  });
  document.querySelectorAll('.btn-export-ion-selection').forEach((btn) => {
    btn.addEventListener('click', () => exportDeconvIonSelection(btn.dataset.format));
  });
  renderDeconvInteractionModeButtons();

  // Auto-detect window when sample is selected
  const select = document.getElementById('deconv-sample-select');
  if (select) {
    select.addEventListener('change', async () => {
      if (select.value) {
        await autoRunDeconvolutionOnTabOpen();
      } else {
        setDeconvEmptyState(true);
      }
    });
  }
}

function renderDeconvInteractionModeButtons() {
  const deconvoluteBtn = document.getElementById('btn-deconv-mode-deconvolute');
  const zoomBtn = document.getElementById('btn-deconv-mode-zoom');
  if (!deconvoluteBtn || !zoomBtn) return;

  const isDeconvolute = state.deconvInteractionMode !== 'zoom';
  deconvoluteBtn.classList.toggle('btn-primary', isDeconvolute);
  zoomBtn.classList.toggle('btn-primary', !isDeconvolute);
}

function setDeconvInteractionMode(mode) {
  state.deconvInteractionMode = mode === 'zoom' ? 'zoom' : 'deconvolute';
  localStorage.setItem('lcms-deconv-interaction-mode', state.deconvInteractionMode);
  renderDeconvInteractionModeButtons();

  const samplePath = document.getElementById('deconv-sample-select')?.value || '';
  if (samplePath) {
    refreshDeconvWindowContext(samplePath);
  }
}

function bindDeconvWindowDragSelection(divId) {
  const plot = document.getElementById(divId);
  if (!plot || typeof plot.on !== 'function') return;

  if (typeof plot.removeAllListeners === 'function') {
    plot.removeAllListeners('plotly_relayout');
    plot.removeAllListeners('plotly_selected');
  }

  if (state.deconvInteractionMode === 'zoom') return;

  plot.on('plotly_selected', async (eventData) => {
    if (!eventData || state.deconvDragSelectionInFlight) return;

    const points = Array.isArray(eventData.points) ? eventData.points : [];
    const startRaw = eventData.range?.x?.[0]
      ?? points[0]?.x;
    const endRaw = eventData.range?.x?.[1]
      ?? points[points.length - 1]?.x;
    const start = Number(startRaw);
    const end = Number(endRaw);

    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    if ((end - start) < 0.02) return;

    await applyDraggedDeconvWindow(start, end);
  });
}

async function applyDraggedDeconvWindow(start, end) {
  const samplePath = document.getElementById('deconv-sample-select')?.value || '';
  if (!samplePath) return;

  const normalizedStart = Math.max(0, Math.min(start, end));
  const normalizedEnd = Math.max(normalizedStart, end);
  if ((normalizedEnd - normalizedStart) < 0.02) return;

  state.deconvDragSelectionInFlight = true;
  try {
    document.getElementById('deconv-start').value = normalizedStart.toFixed(2);
    document.getElementById('deconv-end').value = normalizedEnd.toFixed(2);
    state.deconvAutoRunSignature = '';
    await refreshDeconvWindowContext(samplePath);
    await runDeconvolution({ useOverlay: false, silentSuccess: true });
  } finally {
    state.deconvDragSelectionInFlight = false;
  }
}

async function refreshDeconvWindowContext(samplePath = null) {
  const path = samplePath || document.getElementById('deconv-sample-select').value;
  const uvDiv = document.getElementById('deconv-uv-plot');
  const ticDiv = document.getElementById('deconv-tic-plot');

  if (!path) {
    setDeconvEmptyState(true);
    return;
  }
  setDeconvEmptyState(false);

  const start = parseFloat(document.getElementById('deconv-start').value);
  const end = parseFloat(document.getElementById('deconv-end').value);
  const uvSmoothing = parseInt(document.getElementById('uv-smoothing').value) || 0;

  let preferredWavelength = getSelectedWavelengths()[0];
  if (!Number.isFinite(preferredWavelength)) {
    const loadedMeta = state.loadedSamples[path];
    if (loadedMeta && Array.isArray(loadedMeta.uv_wavelengths) && loadedMeta.uv_wavelengths.length > 0) {
      preferredWavelength = Number(loadedMeta.uv_wavelengths[0]);
    }
  }
  if (!Number.isFinite(preferredWavelength)) preferredWavelength = 280;

  try {
    const uv = await api.getUVChromatogram(path, preferredWavelength, uvSmoothing);
    charts.plotChromatogramWithWindow('deconv-uv-plot', uv.times, uv.intensities, {
      title: `UV Chromatogram (${preferredWavelength.toFixed(0)} nm)`,
      yLabel: `UV ${preferredWavelength.toFixed(0)} nm (mAU)`,
      color: '#1f77b4',
      start,
      end,
      startAtZero: true,
      windowColor: 'rgba(255, 215, 0, 0.25)',
      dragmode: state.deconvInteractionMode === 'zoom' ? 'zoom' : 'select',
      selectdirection: state.deconvInteractionMode === 'zoom' ? undefined : 'h',
    });
    bindDeconvWindowDragSelection('deconv-uv-plot');
  } catch (_) {
    uvDiv.innerHTML = '<p class="placeholder-msg">No UV data available for this sample</p>';
  }

  try {
    const tic = await api.getTIC(path);
    charts.plotChromatogramWithWindow('deconv-tic-plot', tic.times, tic.intensities, {
      title: 'Total Ion Chromatogram (TIC)',
      yLabel: 'TIC Intensity',
      color: '#ff7f0e',
      start,
      end,
      startAtZero: true,
      windowColor: 'rgba(255, 215, 0, 0.25)',
      dragmode: state.deconvInteractionMode === 'zoom' ? 'zoom' : 'select',
      selectdirection: state.deconvInteractionMode === 'zoom' ? undefined : 'h',
    });
    bindDeconvWindowDragSelection('deconv-tic-plot');
  } catch (_) {
    ticDiv.innerHTML = '<p class="placeholder-msg">No TIC data available for this sample</p>';
  }
  schedulePlotlyResize(['deconv-uv-plot', 'deconv-tic-plot']);
}

async function autoDetectDeconvWindow() {
  const samplePath = document.getElementById('deconv-sample-select').value;
  if (!samplePath) {
    toast('Select a sample first', 'warning');
    return;
  }

  showLoading('Auto-detecting time window...');
  try {
    const data = await api.autoDetectWindow(samplePath);
    document.getElementById('deconv-start').value = data.start.toFixed(2);
    document.getElementById('deconv-end').value = data.end.toFixed(2);
    await refreshDeconvWindowContext(samplePath);
    toast(`Window detected: ${data.start.toFixed(2)} - ${data.end.toFixed(2)} min`, 'success');
  } catch (err) {
    toast(`Auto-detect failed: ${err.message}`, 'error');
  } finally {
    hideLoading();
  }
}

async function runDeconvolution(options = {}) {
  const samplePath = document.getElementById('deconv-sample-select').value;
  if (!samplePath) {
    toast('Select a sample first', 'warning');
    return;
  }

  const params = buildDeconvolutionRequest(
    samplePath,
    parseFloat(document.getElementById('deconv-start').value),
    parseFloat(document.getElementById('deconv-end').value),
  );

  const useOverlay = options.useOverlay !== false;
  const silentSuccess = options.silentSuccess === true;
  setDeconvolutionBusy(true);
  if (useOverlay) {
    showLoading('Running deconvolution...');
  }
  try {
    const data = await api.runDeconvolution(params);
    state.deconvResults = data;
    state.deconvDisplayComponents = filterDeconvDisplayResults(data.components || [], {
      expertMode: document.getElementById('expert-mode-toggle').checked,
      topN: DECONV_DISPLAY_TOP_N,
    });
    state.deconvSamplePath = samplePath;
    const resultRange = Array.isArray(data.time_range) ? data.time_range : null;
    state.deconvTimeRange = [
      Number.isFinite(params.start_time) ? params.start_time : (resultRange ? resultRange[0] : null),
      Number.isFinite(params.end_time) ? params.end_time : (resultRange ? resultRange[1] : null),
    ];
    state.deconvAutoRunSignature = getDeconvolutionRunSignature() || state.deconvAutoRunSignature;
    renderDeconvResults(data);
    renderReportSummary();
    if (!silentSuccess) {
      toast('Deconvolution complete', 'success');
    }
  } catch (err) {
    const msg = typeof err === 'object' ? (err.message || JSON.stringify(err)) : String(err);
    toast(`Deconvolution failed: ${msg}`, 'error');
  } finally {
    setDeconvolutionBusy(false);
    if (useOverlay) {
      hideLoading();
    }
  }
}

function isLikelyHalfMassAlias(component, allResults, ratioTol = 0.01) {
  const chargeStates = Array.isArray(component.charge_states) ? component.charge_states : [];
  if (chargeStates.length === 0) return false;
  if (Number(component.num_charges || 0) > 3) return false;
  if (Math.max(...chargeStates.map((z) => Number(z) || 0)) > 6) return false;

  const mass = Number(component.mass || 0);
  if (!(mass > 0)) return false;

  return allResults.some((other) => {
    if (other === component) return false;
    const otherMass = Number(other.mass || 0);
    if (!(otherMass > mass)) return false;
    return Math.abs((otherMass / mass) - 2.0) <= ratioTol;
  });
}

function filterDeconvDisplayResults(results, options = {}) {
  const expertMode = options.expertMode === true;
  const minRelIntensity = Number.isFinite(options.minRelIntensity) ? options.minRelIntensity : 0.05;
  const topN = Math.max(1, Math.min(20, parseInt(options.topN, 10) || DECONV_DISPLAY_TOP_N));

  if (!Array.isArray(results) || results.length === 0) return [];

  const ordered = [...results].sort((a, b) => (Number(b.intensity || 0) - Number(a.intensity || 0)));
  const topIntensity = Number(ordered[0]?.intensity || 0);
  if (!(topIntensity > 0)) return ordered.slice(0, topN);

  const filtered = ordered.filter((r) => Number(r.intensity || 0) >= minRelIntensity * topIntensity);
  const nonExpert = expertMode ? filtered : filtered.filter((r) => !isLikelyHalfMassAlias(r, ordered));
  if (nonExpert.length > 0) return nonExpert.slice(0, topN);
  return ordered.slice(0, topN);
}

function computeMassSpectrumGuideMzs(mzValues, components) {
  if (!Array.isArray(mzValues) || mzValues.length === 0 || !Array.isArray(components) || components.length === 0) {
    return [];
  }

  let mzMin = Number.POSITIVE_INFINITY;
  let mzMax = Number.NEGATIVE_INFINITY;
  mzValues.forEach((v) => {
    const mz = Number(v);
    if (!Number.isFinite(mz)) return;
    if (mz < mzMin) mzMin = mz;
    if (mz > mzMax) mzMax = mz;
  });
  if (!Number.isFinite(mzMin) || !Number.isFinite(mzMax) || mzMax <= mzMin) return [];

  const guides = [];
  const seen = new Set();
  const addGuide = (targetMz) => {
    const mz = Number(targetMz);
    if (!Number.isFinite(mz) || mz <= 0 || mz < mzMin || mz > mzMax) return;
    const key = mz.toFixed(6);
    if (seen.has(key)) return;
    seen.add(key);
    guides.push(mz);
  };

  const proton = 1.00784;

  // Include ion guides from all provided components (not only top component),
  // so secondary component charge states (e.g. z=4) are also highlighted.
  components.forEach((comp) => {
    const observedIons = Array.isArray(comp.ion_mzs) ? comp.ion_mzs.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0) : [];
    if (observedIons.length > 0) {
      observedIons.forEach((mz) => { addGuide(mz); });
      return;
    }

    const charges = Array.isArray(comp.charge_states) ? comp.charge_states : [];
    const mass = Number(comp.mass || 0);
    if (!(mass > 0) || charges.length === 0) return;

    charges.forEach((zRaw) => {
      const z = Number(zRaw);
      if (!(z > 0)) return;
      const theoMz = (mass + (z * proton)) / z;
      addGuide(theoMz);
    });
  });

  return guides;
}

function renderDeconvResults(data) {
  setDeconvEmptyState(false);
  const resultsDiv = document.getElementById('deconv-results');
  resultsDiv.classList.remove('hidden');
  syncDeconvBottomLayout();

  const components = getDeconvDisplayComponents();

  // Mass spectrum plot with annotations from detected components
  if (data.spectrum) {
    // Keep mass-spectrum guide lines consistent with Ion Selection per Component.
    const guideMzs = computeMassSpectrumGuideMzs(data.spectrum.mz, components);
    const spectrumPlotEl = document.getElementById('deconv-spectrum-plot');
    const spectrumHeight = Number(spectrumPlotEl?.dataset?.plotHeight || 0);
    charts.plotMassSpectrum('deconv-spectrum-plot', data.spectrum.mz, data.spectrum.intensities, [], {
      guideMzs,
      heightPx: Number.isFinite(spectrumHeight) && spectrumHeight > 0 ? spectrumHeight : undefined,
    });
  }

  // Deconvoluted masses stem plot (vertical lines like Streamlit)
  if (components.length > 0) {
    charts.plotDeconvMasses('deconv-mass-plot', components);
  } else {
    document.getElementById('deconv-mass-plot').innerHTML = '<p class="placeholder-msg">No masses deconvoluted</p>';
  }

  // Ensure both side-by-side Plotly canvases reflow to container width.
  schedulePlotlyResize(['deconv-spectrum-plot', 'deconv-mass-plot']);

  // Results table
  const tableContainer = document.getElementById('deconv-results-table-container');
  tableContainer.innerHTML = '';

  if (components.length > 0) {
    const maxIntensity = Math.max(...components.map(c => Number(c.intensity || 0)));
    let html = `<div class="data-table-wrapper"><table class="data-table">
      <thead><tr>
        <th>#</th><th>Mass (Da)</th><th>Charges</th><th>Num Ions</th><th>R&sup2;</th><th>Rel. Intensity (%)</th>
      </tr></thead><tbody>`;

    components.forEach((m, i) => {
      const chargeStr = m.charge_states ? m.charge_states.join(', ') : (m.ion_charges ? m.ion_charges.join(', ') : '-');
      const relInt = maxIntensity > 0 && m.intensity != null ? ((m.intensity / maxIntensity) * 100).toFixed(1) : '-';
      html += `<tr class="deconv-row" data-idx="${i}" style="cursor:pointer;">
        <td>${i + 1}</td>
        <td>${m.mass.toFixed(1)}</td>
        <td style="font-family:var(--font);max-width:150px;overflow:hidden;text-overflow:ellipsis;">${chargeStr}</td>
        <td>${m.peaks_found || m.num_charges || '-'}</td>
        <td>${m.r2 != null ? m.r2.toFixed(4) : '-'}</td>
        <td>${relInt}</td>
      </tr>`;
    });

    html += '</tbody></table></div>';
    tableContainer.innerHTML = html;

    // Row click -> show ion detail
    tableContainer.querySelectorAll('.deconv-row').forEach(row => {
      row.addEventListener('click', () => {
        const idx = parseInt(row.dataset.idx);
        showIonDetail(components[idx]);
      });
    });
  }

  // Ion detail area
  const ionDetail = document.getElementById('deconv-ion-detail');
  ionDetail.innerHTML = '<p class="muted" style="padding:12px;">Click a row above to see ion detail</p>';

  renderDeconvIonSelectionGraph();
}

function buildCurrentDeconvStyle() {
  const showTitle = document.getElementById('deconv-show-title')?.checked ?? true;
  const showSubtitle = document.getElementById('deconv-show-subtitle')?.checked ?? true;
  const figWidth = parseFloat(document.getElementById('fig-width').value) || 6;
  const lineWidth = parseFloat(document.getElementById('line-width').value) || 0.8;
  const showGrid = document.getElementById('show-grid').checked;
  const axisMinInput = document.getElementById('mass-axis-min').value;
  const axisMaxInput = document.getElementById('mass-axis-max').value;
  return {
    fig_width: figWidth,
    line_width: lineWidth,
    show_grid: showGrid,
    deconv_x_min_da: axisMinInput ? parseFloat(axisMinInput) : 1000.0,
    deconv_x_max_da: axisMaxInput ? parseFloat(axisMaxInput) : 50000.0,
    deconv_show_title: showTitle,
    deconv_show_subtitle: showSubtitle,
  };
}

function getDeconvDisplayComponents() {
  if (Array.isArray(state.deconvDisplayComponents) && state.deconvDisplayComponents.length > 0) {
    return state.deconvDisplayComponents;
  }
  const comps = state.deconvResults && Array.isArray(state.deconvResults.components) ? state.deconvResults.components : [];
  return filterDeconvDisplayResults(comps, {
    expertMode: document.getElementById('expert-mode-toggle')?.checked === true,
    topN: DECONV_DISPLAY_TOP_N,
  });
}

async function renderDeconvIonSelectionGraph() {
  const container = document.getElementById('deconv-ion-selection-plot');
  if (!container) return;

  const samplePath = state.deconvSamplePath;
  const tr = state.deconvTimeRange || (state.deconvResults && state.deconvResults.time_range);
  const components = getDeconvDisplayComponents();

  if (!samplePath || !Array.isArray(tr) || tr.length < 2 || !Number.isFinite(tr[0]) || !Number.isFinite(tr[1]) || tr[1] <= tr[0] || components.length === 0) {
    container.classList.remove('interactive-ion-selection');
    container.classList.remove('has-image');
    container.style.height = '';
    container.innerHTML = '<p class="placeholder-msg">Run deconvolution to render ion selection graph.</p>';
    return;
  }

  try {
    if (state.deconvIonSelectionObjectUrl) {
      URL.revokeObjectURL(state.deconvIonSelectionObjectUrl);
      state.deconvIonSelectionObjectUrl = null;
    }

    const spectrum = state.deconvResults && state.deconvResults.spectrum;
    const mz = spectrum && Array.isArray(spectrum.mz) ? spectrum.mz : [];
    const intensities = spectrum && Array.isArray(spectrum.intensities) ? spectrum.intensities : [];
    if (mz.length === 0 || intensities.length === 0) {
      throw new Error('No mass spectrum found for ion selection rendering');
    }

    container.classList.remove('has-image');
    container.classList.add('interactive-ion-selection');
    container.innerHTML = '';
    // Set container height based on number of subplot rows so Plotly autosize works
    const nComps = Math.max(1, Math.min(10, components.length));
    const cols = nComps > 1 ? 2 : 1;
    const ionRows = Math.ceil(nComps / cols);
    container.style.height = Math.max(400, 350 * ionRows + 70) + 'px';
    charts.plotIonSelectionInteractive('deconv-ion-selection-plot', mz, intensities, components, {
      title: 'Ion Selection per Component',
    });
  } catch (err) {
    container.classList.remove('interactive-ion-selection');
    container.classList.remove('has-image');
    container.style.height = '';
    const msg = err && err.message ? String(err.message) : String(err);
    const hint = msg.includes('Not Found')
      ? ' Backend is likely running old code. Restart ./start-dev.sh and hard refresh.'
      : '';
    container.innerHTML = `<p class="placeholder-msg">Ion selection graph failed: ${escapeHtml(msg + hint)}</p>`;
  }
}

async function exportDeconvIonSelection(format) {
  const samplePath = state.deconvSamplePath;
  const tr = state.deconvTimeRange || (state.deconvResults && state.deconvResults.time_range);
  const components = getDeconvDisplayComponents();

  if (!samplePath || !Array.isArray(tr) || tr.length < 2 || components.length === 0) {
    toast('Run deconvolution first', 'warning');
    return;
  }

  const dpi = parseInt(document.getElementById('export-dpi').value) || 300;
  const sampleName = state.selectedFiles.find((f) => f.path === samplePath)?.name || samplePath.split('/').pop() || 'sample';

  showLoading(`Exporting ${format.toUpperCase()}...`);
  try {
    const response = await api.exportIonSelection({
      path: samplePath,
      start: tr[0],
      end: tr[1],
      components,
      format,
      dpi,
      style: buildCurrentDeconvStyle(),
    });
    const blob = await backendResponseToBlob(response);
    downloadBlob(blob, `${sanitizeFilename(sampleName)}_ion_selection.${format}`);
    toast(`Exported ${format.toUpperCase()} (ion selection)`, 'success');
  } catch (err) {
    toast(`Export failed: ${err.message}`, 'error');
  } finally {
    hideLoading();
  }
}

async function exportDeconvMasses(format) {
  const samplePath = state.deconvSamplePath;
  const components = getDeconvDisplayComponents();
  if (!samplePath || components.length === 0) {
    toast('Run deconvolution first', 'warning');
    return;
  }

  const dpi = parseInt(document.getElementById('export-dpi').value) || 300;
  const sampleName = state.selectedFiles.find((f) => f.path === samplePath)?.name || samplePath.split('/').pop() || 'sample';

  showLoading(`Exporting ${String(format || '').toUpperCase()}...`);
  try {
    const response = await api.exportDeconvolutedMasses({
      sample_name: sampleName,
      components,
      format,
      dpi,
      style: buildCurrentDeconvStyle(),
    });
    const blob = await backendResponseToBlob(response);
    downloadBlob(blob, `${sanitizeFilename(sampleName)}_deconvoluted_masses.${format}`);
    toast(`Exported ${String(format || '').toUpperCase()} (deconvoluted masses)`, 'success');
  } catch (err) {
    toast(`Export failed: ${err.message}`, 'error');
  } finally {
    hideLoading();
  }
}

function showIonDetail(component) {
  const container = document.getElementById('deconv-ion-detail');
  container.innerHTML = '';

  const card = document.createElement('div');
  card.className = 'ion-detail-card';
  card.innerHTML = `<h4>Ion Detail: ${component.mass.toFixed(1)} Da</h4>`;
  container.appendChild(card);

  const charges = component.ion_charges || [];
  const mzs = component.ion_mzs || [];
  const intensities = component.ion_intensities || [];
  const maxIntensity = intensities.reduce((maxVal, value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > maxVal ? n : maxVal;
  }, 0);

  // Also show a small table of ions
  if (charges.length > 0) {
    const PROTON = 1.00784;
    let html = `<div class="data-table-wrapper ion-detail-table-wrapper"><table class="data-table ion-detail-table">
      <thead><tr><th>z</th><th>m/z Theoretical</th><th>m/z Observed</th><th>Intensity</th><th>Rel. %</th><th>&Delta; ppm</th></tr></thead><tbody>`;

    charges.forEach((z, i) => {
      const mzObs = mzs[i] || 0;
      const mzTheo = (component.mass + z * PROTON) / z;
      const int_ = intensities[i] || 0;
      const relPct = maxIntensity > 0 ? (Number(int_) / maxIntensity) * 100 : 0;
      const ppm = mzTheo > 0 ? (Math.abs(mzObs - mzTheo) / mzTheo * 1e6).toFixed(1) : '-';
      html += `<tr>
        <td>${z}</td>
        <td>${mzTheo.toFixed(4)}</td>
        <td>${mzObs.toFixed(4)}</td>
        <td>${int_.toExponential(2)}</td>
        <td>${relPct.toFixed(1)}</td>
        <td>${ppm}</td>
      </tr>`;
    });

    html += '</tbody></table></div>';
    card.insertAdjacentHTML('beforeend', html);
  } else {
    card.insertAdjacentHTML('beforeend', '<p class="muted" style="margin-top:8px;">No ion assignments available for this component.</p>');
  }
}

// ===== Batch Deconvolution Tab =====
function getBatchDeconvRunSignature() {
  if (!Array.isArray(state.selectedFiles) || state.selectedFiles.length < 2) return '';
  const fallbackStart = parseFloat(document.getElementById('deconv-start')?.value);
  const fallbackEnd = parseFloat(document.getElementById('deconv-end')?.value);
  const sampleSig = state.selectedFiles.map((f) => f.path).join('||');
  const requestSig = JSON.stringify(buildDeconvolutionRequest('__batch__', fallbackStart, fallbackEnd));
  return `${sampleSig}|${requestSig}`;
}

async function autoRunBatchDeconvolutionOnTabOpen() {
  if (state.batchDeconvAutoRunInFlight) return;
  const signature = getBatchDeconvRunSignature();
  if (!signature) return;
  if (signature === state.batchDeconvAutoRunSignature && state.batchDeconvData) return;

  state.batchDeconvAutoRunInFlight = true;
  try {
    state.batchDeconvAutoRunSignature = signature;
    await runBatchDeconvolution();
  } finally {
    state.batchDeconvAutoRunInFlight = false;
  }
}

function initBatchDeconvolution() {
  document.getElementById('btn-run-batch-deconv').addEventListener('click', runBatchDeconvolution);
  document.getElementById('btn-export-batch-deconv-csv').addEventListener('click', exportBatchDeconvCSV);
  document.getElementById('batch-deconv-top-n').addEventListener('change', () => {
    if (state.batchDeconvData) renderBatchDeconvolution(state.batchDeconvData);
  });
  document.querySelectorAll('.btn-export-batch-deconv').forEach(btn => {
    btn.addEventListener('click', () => exportAllPlots('tab-batch-deconv', 'batch_deconvolution', btn.dataset.format));
  });
}

function sanitizeFilename(name) {
  return String(name || 'sample')
    .replace(/\.[dD]$/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100) || 'sample';
}

function sanitizeDownloadFilename(name) {
  return String(name || 'sample')
    .replace(/\.[dD]$/, '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'sample';
}

async function exportPlotById(plotId, filenameBase, format, options = {}) {
  const div = document.getElementById(plotId);
  if (!div || !div.classList.contains('js-plotly-plot')) {
    toast('Plot not available for export', 'warning');
    return;
  }

  const dpi = parseInt(document.getElementById('export-dpi').value) || 300;
  const scale = dpi / 96;

  showLoading(`Exporting ${format.toUpperCase()}...`);
  try {
    if (format === 'pdf') {
      await exportPlotsAsPDF([div], filenameBase, scale, options);
    } else {
      const dims = getExportDimensions(div, scale, options);
      const exportOptions = {
        ...options,
        exportPixelWidth: dims.width,
        exportPixelHeight: dims.height,
      };
      const imageDataUrl = await buildExportImage(div, format, dims.width, dims.height, exportOptions);
      downloadBlob(dataUrlToBlob(imageDataUrl), `${filenameBase}.${format}`);
    }
    toast(`Exported ${format.toUpperCase()}`, 'success');
  } catch (err) {
    toast(`Export failed: ${err.message}`, 'error');
  } finally {
    hideLoading();
  }
}

function buildBatchDeconvExportStyle() {
  const base = buildCurrentDeconvStyle();
  return {
    ...base,
    deconv_show_obs_calc: false,
    deconv_calc_mass_da: null,
    deconv_show_peak_labels: true,
  };
}

async function fetchBatchDeconvPreviewBlob(sample, displayComponents, dpi = 180) {
  const response = await api.exportDeconvolutedMasses({
    sample_name: sample.name,
    components: displayComponents,
    format: 'png',
    dpi,
    style: buildBatchDeconvExportStyle(),
  });
  return backendResponseToBlob(response);
}

async function renderBatchDeconvExportPreview(sample, displayComponents, previewId) {
  const previewEl = document.getElementById(previewId);
  if (!previewEl) return;
  previewEl.innerHTML = '<p class="muted" style="padding:10px 0;">Rendering export preview...</p>';

  try {
    const blob = await fetchBatchDeconvPreviewBlob(sample, displayComponents, 180);
    const url = URL.createObjectURL(blob);
    state.batchDeconvPreviewUrls[previewId] = url;

    const currentPreviewEl = document.getElementById(previewId);
    if (!currentPreviewEl) {
      URL.revokeObjectURL(url);
      delete state.batchDeconvPreviewUrls[previewId];
      return;
    }

    currentPreviewEl.innerHTML = '';
    const img = document.createElement('img');
    img.src = url;
    img.alt = `${sample.name} export preview`;
    currentPreviewEl.appendChild(img);
  } catch (err) {
    previewEl.innerHTML = `<p class="placeholder-msg" style="padding:14px 8px;">Preview failed: ${escapeHtml(err.message || String(err))}</p>`;
  }
}

async function getBatchDeconvTic(path) {
  if (!path) return null;
  if (state.batchDeconvTicCache[path]) return state.batchDeconvTicCache[path];
  const tic = await api.getTIC(path);
  if (tic && Array.isArray(tic.times) && Array.isArray(tic.intensities) && tic.times.length > 0 && tic.intensities.length > 0) {
    state.batchDeconvTicCache[path] = tic;
    return tic;
  }
  return null;
}

async function renderBatchDeconvTicWindow(sample, ticPlotId) {
  const ticPlotEl = document.getElementById(ticPlotId);
  if (!ticPlotEl) return;

  ticPlotEl.innerHTML = '<p class="muted" style="padding:8px 4px;">Loading TIC...</p>';
  try {
    const tic = await getBatchDeconvTic(sample.path);
    if (!tic) throw new Error('No TIC data');
    charts.plotChromatogramWithWindow(ticPlotId, tic.times, tic.intensities, {
      title: 'TIC',
      color: '#ff7f0e',
      start: Number(sample.start),
      end: Number(sample.end),
      windowColor: 'rgba(255, 215, 0, 0.28)',
      showWindowAnnotation: false,
      compact: true,
      margin: { l: 8, r: 8, t: 28, b: 8 },
    });
  } catch (_) {
    ticPlotEl.innerHTML = '<p class="placeholder-msg" style="padding:8px 4px;">No TIC</p>';
  }
}

async function exportBatchDeconvWebappStyle(sample, displayComponents, format, plotId) {
  const dpi = parseInt(document.getElementById('export-dpi').value) || 300;
  const style = buildBatchDeconvExportStyle();

  showLoading(`Exporting ${format.toUpperCase()}...`);
  try {
    const response = await api.exportDeconvolutedMasses({
      sample_name: sample.name,
      components: displayComponents,
      format,
      dpi,
      style,
    });
    const blob = await backendResponseToBlob(response);
    const fileBase = `${sanitizeFilename(sample.name)}_batch_deconvoluted_masses`;
    downloadBlob(blob, `${fileBase}.${format}`);
    toast(`Exported ${format.toUpperCase()}`, 'success');
  } catch (err) {
    if (format === 'png') {
      const fileBase = `${sanitizeFilename(sample.name)}_batch_deconvoluted_masses`;
      const didFallback = await fallbackBatchDeconvExport(plotId, fileBase, format, dpi);
      if (didFallback) {
        toast(`Exported ${format.toUpperCase()} (frontend fallback)`, 'success');
        return;
      }
    }
    toast(`Export failed: ${err.message}`, 'error');
  } finally {
    hideLoading();
  }
}

async function fallbackBatchDeconvExport(plotId, filenameBase, format, dpi) {
  const plotDiv = document.getElementById(plotId);
  if (!plotDiv || !plotDiv.classList.contains('js-plotly-plot')) {
    return false;
  }

  const scale = dpi / 96;
  if (format === 'pdf') {
    await exportPlotsAsPDF([plotDiv], filenameBase, scale);
    return true;
  }

  const dims = getExportDimensions(plotDiv, scale);
  const imageDataUrl = await buildExportImage(plotDiv, format, dims.width, dims.height);
  downloadBlob(dataUrlToBlob(imageDataUrl), `${filenameBase}.${format}`);
  return true;
}

async function runBatchDeconvolution() {
  if (state.selectedFiles.length < 2) {
    toast('Select at least 2 samples for batch deconvolution', 'warning');
    return;
  }

  const runSignature = getBatchDeconvRunSignature();
  const fallbackStart = parseFloat(document.getElementById('deconv-start').value) || 0;
  const fallbackEnd = parseFloat(document.getElementById('deconv-end').value) || (fallbackStart + 1);

  showLoading('Running batch deconvolution...');
  try {
    const results = [];

    for (const file of state.selectedFiles) {
      let start = fallbackStart;
      let end = fallbackEnd;

      try {
        const autoWindow = await api.autoDetectWindow(file.path);
        if (Number.isFinite(autoWindow.start) && Number.isFinite(autoWindow.end) && autoWindow.end > autoWindow.start) {
          start = autoWindow.start;
          end = autoWindow.end;
        }
      } catch (_) {
        // Keep fallback start/end for this sample
      }

      try {
        const req = buildDeconvolutionRequest(file.path, start, end);
        const data = await api.runDeconvolution(req);
        results.push({
          name: file.name,
          path: file.path,
          start,
          end,
          status: 'ok',
          error: '',
          components: Array.isArray(data.components) ? data.components : [],
        });
      } catch (err) {
        results.push({
          name: file.name,
          path: file.path,
          start,
          end,
          status: 'error',
          error: err.message || String(err),
          components: [],
        });
      }
    }

    state.batchDeconvData = {
      generatedAt: new Date().toISOString(),
      samples: results,
    };
    if (runSignature) state.batchDeconvAutoRunSignature = runSignature;
    renderBatchDeconvolution(state.batchDeconvData);
    renderReportSummary();

    const okCount = results.filter(r => r.status === 'ok').length;
    toast(`Batch deconvolution complete (${okCount}/${results.length} succeeded)`, okCount > 0 ? 'success' : 'warning');
  } catch (err) {
    toast(`Batch deconvolution failed: ${err.message}`, 'error');
  } finally {
    hideLoading();
  }
}

function renderBatchDeconvolution(data) {
  const summary = document.getElementById('batch-deconv-summary');
  const tableContainer = document.getElementById('batch-deconv-table-container');
  const samplesContainer = document.getElementById('batch-deconv-samples');
  const topNInput = document.getElementById('batch-deconv-top-n');
  const topN = Math.max(1, Math.min(20, parseInt(topNInput.value) || 5));
  const expertMode = document.getElementById('expert-mode-toggle')?.checked === true;
  topNInput.value = String(topN);

  Object.values(state.batchDeconvPreviewUrls || {}).forEach((url) => {
    try {
      URL.revokeObjectURL(url);
    } catch (_) {
      // Ignore stale object URLs.
    }
  });
  state.batchDeconvPreviewUrls = {};

  summary.innerHTML = '';
  samplesContainer.innerHTML = '';
  tableContainer.innerHTML = '';

  const samples = (data.samples || []).map((sample) => ({
    ...sample,
    displayComponents: filterDeconvDisplayResults(sample.components || [], {
      expertMode,
      topN,
    }),
  }));
  if (samples.length === 0) {
    setBatchDeconvEmptyState(true);
    return;
  }
  setBatchDeconvEmptyState(false);

  const okCount = samples.filter(s => s.status === 'ok').length;
  const displayedComponents = samples.reduce((acc, s) => acc + ((s.displayComponents || []).length), 0);
  summary.innerHTML = `
    <div class="metric"><span class="dot blue"></span> Samples: ${samples.length}</div>
    <div class="metric"><span class="dot green"></span> Successful: ${okCount}</div>
    <div class="metric"><span class="dot ${okCount === samples.length ? 'green' : 'red'}"></span> Failed: ${samples.length - okCount}</div>
    <div class="metric"><span class="dot blue"></span> Mode: ${expertMode ? 'Expert' : 'Basic'}</div>
    <div class="metric"><span class="dot blue"></span> Displayed Components: ${displayedComponents}</div>
    <div class="metric"><span class="dot blue"></span> Showing Top N: ${topN}</div>
  `;

  samples.forEach((sample, idx) => {
    const section = document.createElement('div');
    section.className = 'ion-detail-card';
    const sampleTitle = sample.name.toLowerCase().endsWith('.d') ? sample.name.slice(0, -2) : sample.name;
    section.innerHTML = `
      <h4>${idx + 1}. ${escapeHtml(sampleTitle)}</h4>
      <p class="muted" style="margin-bottom:10px;">Auto window: ${Number.isFinite(sample.start) ? sample.start.toFixed(2) : '-'} - ${Number.isFinite(sample.end) ? sample.end.toFixed(2) : '-'} min</p>
    `;

    if (sample.status !== 'ok') {
      section.insertAdjacentHTML('beforeend', `<p class="placeholder-msg" style="padding:16px 10px;">${escapeHtml(sample.error || 'No masses detected for this sample.')}</p>`);
      samplesContainer.appendChild(section);
      return;
    }

    const components = sample.displayComponents || [];
    if (components.length === 0) {
      section.insertAdjacentHTML('beforeend', '<p class="placeholder-msg" style="padding:16px 10px;">No masses detected for this sample.</p>');
      samplesContainer.appendChild(section);
      return;
    }

    const plotId = `batch-deconv-sample-plot-${idx}`;
    const ticPlotId = `batch-deconv-tic-plot-${idx}`;
    const previewId = `batch-deconv-export-preview-${idx}`;
    section.insertAdjacentHTML('beforeend', `
      <div class="batch-deconv-sample-layout">
        <div class="batch-deconv-interactive">
          <div id="${plotId}" class="batch-deconv-interactive-plot"></div>
        </div>
        <div class="batch-deconv-tic-wrap">
          <div class="batch-deconv-tic">
            <div id="${ticPlotId}" class="batch-deconv-tic-plot">
              <p class="muted" style="padding:8px 4px;">Loading TIC...</p>
            </div>
          </div>
        </div>
        <div class="batch-deconv-preview-wrap">
          <div id="${previewId}" class="batch-deconv-preview">
            <p class="muted" style="padding:10px 0;">Rendering export preview...</p>
          </div>
        </div>
      </div>
    `);
    section.insertAdjacentHTML('beforeend', `
      <div class="batch-deconv-download-row">
        <button class="btn btn-sm" data-format="png">Download PNG</button>
        <button class="btn btn-sm" data-format="svg">Download SVG</button>
        <button class="btn btn-sm" data-format="pdf">Download PDF</button>
      </div>
    `);

    samplesContainer.appendChild(section);
    charts.plotDeconvMasses(plotId, components, { height: 320 });
    renderBatchDeconvTicWindow(sample, ticPlotId);
    renderBatchDeconvExportPreview(sample, components, previewId);

    section.querySelectorAll('button[data-format]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await exportBatchDeconvWebappStyle(sample, components, btn.dataset.format, plotId);
      });
    });
  });

  let html = `<div class="data-table-wrapper"><table class="data-table">
    <thead><tr>
      <th>Sample</th><th>Status</th><th>Window (min)</th><th>Components</th><th>Top Masses (Da)</th><th>Rel. Intensity (%)</th>
    </tr></thead><tbody>`;

  samples.forEach((sample) => {
    const windowStr = `${Number.isFinite(sample.start) ? sample.start.toFixed(2) : '-'} - ${Number.isFinite(sample.end) ? sample.end.toFixed(2) : '-'}`;
    const comps = sample.displayComponents || [];
    const topMasses = comps.map(c => c.mass.toFixed(1)).join(', ') || '-';
    const maxIntensity = Math.max(0, ...comps.map((c) => Number(c.intensity || 0)));
    const relInts = comps
      .map((c) => (maxIntensity > 0 ? ((Number(c.intensity || 0) / maxIntensity) * 100).toFixed(1) : '-'))
      .join(', ') || '-';
    html += `<tr>
      <td>${escapeHtml(sample.name)}</td>
      <td title="${escapeHtml(sample.error || '')}">${sample.status}</td>
      <td>${windowStr}</td>
      <td>${comps.length}</td>
      <td>${topMasses}</td>
      <td>${relInts}</td>
    </tr>`;
  });
  html += '</tbody></table></div>';
  tableContainer.innerHTML = html;
}

function exportBatchDeconvCSV() {
  if (!state.batchDeconvData || !state.batchDeconvData.samples || state.batchDeconvData.samples.length === 0) {
    toast('Run batch deconvolution first', 'warning');
    return;
  }

  const rows = [[
    'Sample',
    'Status',
    'Window Start (min)',
    'Window End (min)',
    'Component Index',
    'Mass (Da)',
    'Intensity',
    'R2',
    'Num Charges',
    'Error',
  ]];

  state.batchDeconvData.samples.forEach((sample) => {
    const comps = sample.components || [];
    if (comps.length === 0) {
      rows.push([
        sample.name,
        sample.status,
        Number.isFinite(sample.start) ? sample.start.toFixed(3) : '',
        Number.isFinite(sample.end) ? sample.end.toFixed(3) : '',
        '',
        '',
        '',
        '',
        '',
        sample.error || '',
      ]);
      return;
    }
    comps.forEach((c, idx) => {
      rows.push([
        sample.name,
        sample.status,
        Number.isFinite(sample.start) ? sample.start.toFixed(3) : '',
        Number.isFinite(sample.end) ? sample.end.toFixed(3) : '',
        idx + 1,
        Number.isFinite(c.mass) ? c.mass.toFixed(4) : '',
        Number.isFinite(c.intensity) ? c.intensity : '',
        Number.isFinite(c.r2) ? c.r2.toFixed(6) : '',
        Number.isFinite(c.num_charges) ? c.num_charges : '',
        sample.error || '',
      ]);
    });
  });

  const csv = rows.map(r => r.join(',')).join('\n');
  downloadBlob(new Blob([csv], { type: 'text/csv' }), 'batch_deconvolution_results.csv');
  toast('Batch deconvolution CSV exported', 'success');
}

// ===== Time Change MS Tab =====
function initTimeChangeMS() {
  document.getElementById('btn-run-time-change-ms').addEventListener('click', runTimeChangeMS);
  document.getElementById('timechange-normalize').addEventListener('change', async () => {
    if (!state.timeChangeMSData) return;
    const panel = document.getElementById('tab-time-change-ms');
    showLoading('Updating normalization...');
    if (panel) panel.classList.add('is-busy');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    try {
      renderTimeChangeMS(state.timeChangeMSData);
    } catch (err) {
      toast(`Time Change MS render failed: ${err.message}`, 'error');
    } finally {
      if (panel) panel.classList.remove('is-busy');
      hideLoading();
    }
  });
  document.querySelectorAll('.btn-export-timechange').forEach(btn => {
    btn.addEventListener('click', () => exportAllPlots('tab-time-change-ms', 'time_change_ms', btn.dataset.format));
  });
}

async function runTimeChangeMS() {
  if (state.selectedFiles.length < 2) {
    toast('Select at least 2 samples for Time Change MS', 'warning');
    return;
  }

  showLoading('Generating summed spectra...');
  try {
    const spectra = [];
    for (const file of state.selectedFiles) {
      let start = parseFloat(document.getElementById('deconv-start').value) || 0;
      let end = parseFloat(document.getElementById('deconv-end').value) || (start + 1);

      try {
        const autoWindow = await api.autoDetectWindow(file.path);
        if (Number.isFinite(autoWindow.start) && Number.isFinite(autoWindow.end) && autoWindow.end > autoWindow.start) {
          start = autoWindow.start;
          end = autoWindow.end;
        }
      } catch (_) {
        // Keep fallback window for this sample
      }

      try {
        const summed = await api.getSummedSpectrum(file.path, start, end);
        spectra.push({
          name: file.name,
          path: file.path,
          start,
          end,
          status: 'ok',
          error: '',
          mz: summed.mz || [],
          intensities: summed.intensities || [],
        });
      } catch (err) {
        spectra.push({
          name: file.name,
          path: file.path,
          start,
          end,
          status: 'error',
          error: err.message || String(err),
          mz: [],
          intensities: [],
        });
      }
    }

    state.timeChangeMSData = { generatedAt: new Date().toISOString(), spectra };
    renderTimeChangeMS(state.timeChangeMSData);
    renderReportSummary();

    const okCount = spectra.filter(s => s.status === 'ok').length;
    toast(`Time Change MS complete (${okCount}/${spectra.length} succeeded)`, okCount > 0 ? 'success' : 'warning');
  } catch (err) {
    toast(`Time Change MS failed: ${err.message}`, 'error');
  } finally {
    hideLoading();
  }
}

function renderTimeChangeMS(data) {
  const spectra = data.spectra || [];
  const normalize = document.getElementById('timechange-normalize').checked;
  const plotContainer = document.getElementById('timechange-ms-plot');
  const offsetPlotContainer = document.getElementById('timechange-ms-offset-plot');
  const tableContainer = document.getElementById('timechange-ms-table-container');

  if (spectra.length === 0) {
    setTimeChangeEmptyState(true);
    return;
  }
  setTimeChangeEmptyState(false);

  const plotSpectra = spectra
    .filter(s => Array.isArray(s.mz) && Array.isArray(s.intensities) && s.mz.length > 0 && s.intensities.length > 0)
    .map((s) => ({
      label: s.name,
      mz: s.mz,
      intensities: s.intensities,
      maxIntensity: maxFiniteValue(s.intensities),
    }));

  if (plotSpectra.length === 0) {
    plotContainer.innerHTML = '<p class="placeholder-msg">No summed spectra available</p>';
    offsetPlotContainer.innerHTML = '<p class="placeholder-msg">No offset spectra available</p>';
  } else {
    charts.plotMassSpectraOverlay('timechange-ms-plot', plotSpectra, {
      normalize,
      title: 'Summed Mass Spectrum',
    });

    const xOffsetStep = 20.0;
    let yOffsetStep = 10.0;
    if (!normalize) {
      const globalYMax = plotSpectra.reduce((acc, s) => Math.max(acc, s.maxIntensity || 0), 0);
      yOffsetStep = globalYMax > 0 ? globalYMax * 0.10 : 1.0;
    }

    const shifted = plotSpectra.map((s, i) => ({
      label: s.label,
      mz: (s.mz || []).map(v => v + i * xOffsetStep),
      intensities: (s.intensities || []).map((v) => {
        const raw = Number(v);
        const base = Number.isFinite(raw) ? raw : 0;
        if (!normalize) return base + i * yOffsetStep;
        const scale = s.maxIntensity > 0 ? (100 / s.maxIntensity) : 1;
        return base * scale + i * yOffsetStep;
      }),
    }));

    charts.plotMassSpectraOverlay('timechange-ms-offset-plot', shifted, {
      normalize: false,
      title: `Summed Mass Spectrum (Diagonal Offset: +${xOffsetStep.toFixed(0)} m/z, +${normalize ? yOffsetStep.toFixed(0) : yOffsetStep.toPrecision(2)} intensity units per trace)`,
    });
  }

  let html = `<div class="data-table-wrapper"><table class="data-table">
    <thead><tr>
      <th>Sample</th><th>Status</th><th>Window (min)</th><th>Points</th><th>Error</th>
    </tr></thead><tbody>`;

  spectra.forEach((s) => {
    const pointCount = Array.isArray(s.mz) ? s.mz.length : 0;
    html += `<tr>
      <td>${escapeHtml(s.name)}</td>
      <td>${s.status}</td>
      <td>${Number.isFinite(s.start) ? s.start.toFixed(2) : '-'} - ${Number.isFinite(s.end) ? s.end.toFixed(2) : '-'}</td>
      <td>${pointCount}</td>
      <td>${escapeHtml(s.error || '')}</td>
    </tr>`;
  });
  html += '</tbody></table></div>';
  tableContainer.innerHTML = html;
}

// ===== Report Export Tab =====
function initReportExport() {
  document.getElementById('btn-export-session-json').addEventListener('click', exportSessionJSON);
  document.getElementById('btn-export-report-summary-csv').addEventListener('click', exportReportSummaryCSV);
  document.getElementById('btn-export-report-pdf').addEventListener('click', exportReportPDF);
  const sampleSelect = document.getElementById('report-sample-select');
  if (sampleSelect) sampleSelect.addEventListener('change', renderReportSummary);
  const includeUv = document.getElementById('report-include-uv');
  if (includeUv) includeUv.addEventListener('change', renderReportSummary);
  const includeDeconv = document.getElementById('report-include-deconv');
  if (includeDeconv) includeDeconv.addEventListener('change', renderReportSummary);
}

function renderReportSummary() {
  const container = document.getElementById('report-summary');
  if (!container) return;

  const hasAnyAnalysis = Boolean(
    state.singleSampleData ||
    state.eicBatchData ||
    state.deconvResults ||
    state.batchDeconvData ||
    state.progressionData ||
    state.timeChangeMSData ||
    state.masscalcData
  );

  if (!hasAnyAnalysis) {
    container.innerHTML = '';
    setReportEmptyState(true);
    return;
  }
  setReportEmptyState(false);

  const reportSamplePath = getCurrentReportSamplePath();
  const reportSample = state.selectedFiles.find((f) => f.path === reportSamplePath);
  const includeUv = document.getElementById('report-include-uv')?.checked ?? true;
  const includeDeconv = document.getElementById('report-include-deconv')?.checked ?? true;

  const lines = [];
  lines.push(`<p><strong>Report sample:</strong> ${reportSample ? escapeHtml(reportSample.name) : 'not selected'}</p>`);
  lines.push(`<p><strong>Report options:</strong> UV ${includeUv ? 'included' : 'excluded'}, Deconvolution ${includeDeconv ? 'included' : 'excluded'}</p>`);
  lines.push(`<p><strong>Selected samples:</strong> ${state.selectedFiles.length}</p>`);
  lines.push(`<p><strong>Single sample analysis:</strong> ${state.singleSampleData ? 'ready' : 'not run'}</p>`);
  lines.push(`<p><strong>EIC batch:</strong> ${state.eicBatchData ? 'ready' : 'not run'}</p>`);
  lines.push(`<p><strong>Deconvolution:</strong> ${state.deconvResults ? 'ready' : 'not run'}</p>`);
  lines.push(`<p><strong>Batch deconvolution:</strong> ${state.batchDeconvData ? 'ready' : 'not run'}</p>`);
  lines.push(`<p><strong>Time progression:</strong> ${state.progressionData ? 'ready' : 'not run'}</p>`);
  lines.push(`<p><strong>Time Change MS:</strong> ${state.timeChangeMSData ? 'ready' : 'not run'}</p>`);
  container.innerHTML = lines.join('');
}

function exportSessionJSON() {
  const payload = {
    exported_at: new Date().toISOString(),
    selected_files: state.selectedFiles,
    mz_targets: state.mzTargets,
    analyses: {
      single_sample: state.singleSampleData,
      progression: state.progressionData,
      eic_batch: state.eicBatchData,
      deconvolution: state.deconvResults,
      batch_deconvolution: state.batchDeconvData,
      time_change_ms: state.timeChangeMSData,
    },
  };
  downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), 'lcms_session_report.json');
  toast('Session JSON exported', 'success');
}

function exportReportSummaryCSV() {
  const rows = [['Section', 'Status', 'Detail']];
  rows.push(['Selected Samples', state.selectedFiles.length > 0 ? 'ok' : 'empty', String(state.selectedFiles.length)]);
  rows.push(['Single Sample', state.singleSampleData ? 'ok' : 'not_run', '']);
  rows.push(['EIC Batch', state.eicBatchData ? 'ok' : 'not_run', state.eicBatchData ? `${(state.eicBatchData.targets || []).length} targets` : '']);
  rows.push(['Deconvolution', state.deconvResults ? 'ok' : 'not_run', state.deconvResults ? `${(state.deconvResults.components || []).length} components` : '']);
  rows.push(['Batch Deconvolution', state.batchDeconvData ? 'ok' : 'not_run', state.batchDeconvData ? `${(state.batchDeconvData.samples || []).length} samples` : '']);
  rows.push(['Time Progression', state.progressionData ? 'ok' : 'not_run', '']);
  rows.push(['Time Change MS', state.timeChangeMSData ? 'ok' : 'not_run', state.timeChangeMSData ? `${(state.timeChangeMSData.spectra || []).length} spectra` : '']);

  const csv = rows.map(r => r.join(',')).join('\n');
  downloadBlob(new Blob([csv], { type: 'text/csv' }), 'lcms_report_summary.csv');
  toast('Report summary CSV exported', 'success');
}

function getCurrentReportSamplePath() {
  const explicit = document.getElementById('report-sample-select')?.value;
  if (explicit) return explicit;

  const single = document.getElementById('single-sample-select')?.value;
  if (single) return single;

  const deconv = document.getElementById('deconv-sample-select')?.value;
  if (deconv) return deconv;

  return state.selectedFiles.length > 0 ? state.selectedFiles[0].path : '';
}

function getReportSettingsPayload() {
  const uvWavelengths = getSelectedWavelengths();
  const colors = {
    initial: document.getElementById('color-initial')?.value || '#808080',
    mid: document.getElementById('color-mid')?.value || '#1f77b4',
    final: document.getElementById('color-final')?.value || '#d62728',
  };
  const labels = {
    title_single: document.getElementById('label-single-title')?.value || 'Sample: {name}',
    title_progression: document.getElementById('label-prog-title')?.value || 'Time Progression Analysis',
    x_label: document.getElementById('label-x-axis')?.value || 'Time (min)',
    y_label_uv: document.getElementById('label-uv-y')?.value || 'UV {wavelength}nm (mAU)',
    y_label_tic: document.getElementById('label-tic-y')?.value || 'TIC Intensity',
    y_label_eic: document.getElementById('label-eic-y')?.value || 'EIC Intensity',
    panel_title_uv: document.getElementById('label-uv-panel')?.value || 'UV Chromatogram ({wavelength} nm)',
    panel_title_tic: document.getElementById('label-tic-panel')?.value || 'Total Ion Chromatogram (TIC)',
    panel_title_eic: document.getElementById('label-eic-panel')?.value || 'EIC m/z {mz} (±{window})',
  };

  return {
    uv_wavelengths: uvWavelengths,
    uv_smoothing: parseInt(document.getElementById('uv-smoothing')?.value) || 0,
    eic_smoothing: parseInt(document.getElementById('eic-smoothing')?.value) || 0,
    line_width: parseFloat(document.getElementById('line-width')?.value) || 0.8,
    show_grid: !!document.getElementById('show-grid')?.checked,
    deconv_x_min_da: parseFloat(document.getElementById('mass-axis-min')?.value) || 1000.0,
    deconv_x_max_da: parseFloat(document.getElementById('mass-axis-max')?.value) || 50000.0,
    colors,
    labels,
  };
}

function getFilenameFromContentDisposition(disposition, fallback) {
  if (!disposition) return fallback;
  const starMatch = disposition.match(/filename\\*=UTF-8''([^;]+)/i);
  if (starMatch && starMatch[1]) {
    try {
      return decodeURIComponent(starMatch[1].replace(/["']/g, ''));
    } catch (_) {
      return starMatch[1].replace(/["']/g, '');
    }
  }
  const match = disposition.match(/filename=\"?([^\";]+)\"?/i);
  return match && match[1] ? match[1] : fallback;
}

async function exportReportPDF() {
  const samplePath = getCurrentReportSamplePath();
  if (!samplePath) {
    toast('Select a sample for report export', 'warning');
    return;
  }

  const includeUv = document.getElementById('report-include-uv')?.checked ?? true;
  const includeDeconv = document.getElementById('report-include-deconv')?.checked ?? true;
  const payload = {
    path: samplePath,
    include_uv: includeUv,
    include_deconv: includeDeconv,
    app_version: getAppVersionLabel(),
    settings: getReportSettingsPayload(),
  };

  if (includeDeconv && state.deconvResults && state.deconvSamplePath === samplePath) {
    if (Array.isArray(state.deconvResults.components)) {
      payload.deconv_results = state.deconvResults.components;
    }
    const tr = state.deconvTimeRange || state.deconvResults.time_range;
    if (Array.isArray(tr) && tr.length === 2) {
      payload.deconv_time_range = tr;
    }
  }

  const sampleName = (state.selectedFiles.find((f) => f.path === samplePath)?.name || samplePath.split('/').pop() || 'sample');
  const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const fallbackFilename = `${sanitizeFilename(sampleName)}_report_${dateStamp}.pdf`;

  showLoading('Generating report PDF...');
  try {
    const response = await api.exportReportPdf(payload);
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition');
    const filename = getFilenameFromContentDisposition(disposition, fallbackFilename);
    downloadBlob(blob, filename);
    toast('Report PDF exported', 'success');
  } catch (err) {
    toast(`Report PDF failed: ${err.message}`, 'error');
  } finally {
    hideLoading();
  }
}

// ===== Mass Calculator Tab =====
const AA_MASSES = {
  G: 57.0519, A: 71.0788, V: 99.1326, L: 113.1594, I: 113.1594,
  P: 97.1167, F: 147.1766, W: 186.2132, M: 131.1926, S: 87.0782,
  T: 101.1051, C: 103.1388, Y: 163.1760, H: 137.1411, D: 115.0886,
  E: 129.1155, N: 114.1038, Q: 128.1307, K: 128.1741, R: 156.1875,
};

const WATER_MASS = 18.01524;

const KNOWN_MODS = {
  'Oxidation (+O)': 15.999,
  Acetylation: 42.011,
  Phosphorylation: 79.966,
  Methylation: 14.016,
  'Met loss (-M)': -131.040,
  'Met loss + Acetyl': -89.030,
  Atto488: 572.0,
  'Ubiquitin GG': 114.043,
  'Disulfide (-2H)': -2.016,
  Deamidation: 0.984,
  'Na adduct': 21.982,
  'K adduct': 37.956,
  Glucuronidation: 176.032,
  'Formic acid adduct': 46.005,
  'TFA adduct': 113.993,
  'Unknown mod (x1)': 251.30,
  'Unknown mod (x2)': 502.60,
  'Unknown mod (x3)': 753.90,
};

const DECONV_RANK_COLORS = [
  '#2ca02c', '#1f77b4', '#ff7f0e', '#d62728', '#9467bd',
  '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf',
];

function initMassCalc() {
  const runBtn = document.getElementById('btn-run-masscalc');
  if (runBtn) runBtn.addEventListener('click', runMassCalculator);

  const input = document.getElementById('masscalc-input');
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') runMassCalculator();
    });
  }

  document.querySelectorAll('.btn-export-masscalc').forEach((btn) => {
    btn.addEventListener('click', () => {
      exportMasscalcFigure(btn.dataset.target, btn.dataset.format);
    });
  });
}

function parseMasscalcInput(rawInput) {
  const raw = (rawInput || '').trim();
  if (!raw) return { masses: [], mode: 'empty', unknownResidues: [] };

  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  const numbers = [];
  let allNumeric = true;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isFinite(v) || v <= 0) {
      allNumeric = false;
      break;
    }
    numbers.push(v);
  }

  if (allNumeric && numbers.length > 0) {
    return { masses: numbers.slice(0, 10), mode: 'numbers', unknownResidues: [] };
  }

  const seq = raw.toUpperCase().replace(/[^A-Z]/g, '');
  if (!seq) return { masses: [], mode: 'invalid', unknownResidues: [] };

  let mass = WATER_MASS;
  const unknown = [];
  for (const aa of seq) {
    if (AA_MASSES[aa] != null) {
      mass += AA_MASSES[aa];
    } else if (!unknown.includes(aa)) {
      unknown.push(aa);
    }
  }

  return { masses: [mass], mode: 'sequence', unknownResidues: unknown };
}

async function getDeconvForMasscalc(samplePath) {
  const deconvSelectedPath = document.getElementById('deconv-sample-select')?.value || '';
  const shouldUseCached =
    state.deconvResults &&
    Array.isArray(state.deconvResults.components) &&
    state.deconvResults.components.length > 0 &&
    (
      state.deconvSamplePath === samplePath ||
      (state.deconvSamplePath == null && deconvSelectedPath === samplePath)
    );

  if (shouldUseCached) {
    const tr = state.deconvTimeRange || state.deconvResults.time_range;
    if (state.deconvSamplePath == null && deconvSelectedPath === samplePath) {
      state.deconvSamplePath = samplePath;
    }
    return { data: state.deconvResults, timeRange: tr };
  }

  const auto = await api.autoDetectWindow(samplePath);
  const massRange = getGlobalDeconvMassRangeParams();
  const req = {
    path: samplePath,
    start_time: auto.start,
    end_time: auto.end,
    ...massRange,
  };
  const deconvData = await api.runDeconvolution(req);

  return { data: deconvData, timeRange: [auto.start, auto.end] };
}

function annotateMassMatch(obsMass, theoreticalMasses, tolerance) {
  const bestRef = theoreticalMasses.reduce((best, m) => (
    Math.abs(obsMass - m) < Math.abs(obsMass - best) ? m : best
  ), theoreticalMasses[0]);
  const delta = obsMass - bestRef;

  // If this observed mass directly matches any theoretical mass, keep the
  // annotation unambiguous: report only "Observed".
  for (const tm of theoreticalMasses) {
    if (Math.abs(obsMass - tm) <= tolerance) {
      return { bestRef, delta, annotations: ['Observed'] };
    }
  }

  const annotations = [];
  for (const tm of theoreticalMasses) {
    const d = obsMass - tm;
    for (const [name, modMass] of Object.entries(KNOWN_MODS)) {
      if (Math.abs(d - modMass) <= tolerance) {
        annotations.push(modMass >= 0 ? `+${name}` : name);
      }
      if (Math.abs(d + modMass) <= tolerance) {
        annotations.push(modMass >= 0 ? `-${name}` : `+${name.replace(/^-/, '')}`);
      }
    }
  }

  const unique = [];
  const seen = new Set();
  for (const a of annotations) {
    if (!seen.has(a)) {
      seen.add(a);
      unique.push(a);
    }
  }

  return { bestRef, delta, annotations: unique };
}

function buildMasscalcStyle(theoreticalMasses, clean = false) {
  const axisMinInput = document.getElementById('mass-axis-min').value;
  const axisMaxInput = document.getElementById('mass-axis-max').value;
  const showTitle = document.getElementById('deconv-show-title')?.checked ?? true;
  const showSubtitle = document.getElementById('deconv-show-subtitle')?.checked ?? true;
  return {
    fig_width: parseFloat(document.getElementById('fig-width').value) || 6,
    show_grid: false,
    deconv_x_min_da: axisMinInput ? parseFloat(axisMinInput) : 1000.0,
    deconv_x_max_da: axisMaxInput ? parseFloat(axisMaxInput) : 50000.0,
    deconv_show_title: showTitle,
    deconv_show_subtitle: showSubtitle,
    deconv_show_obs_calc: true,
    deconv_calc_mass_da: theoreticalMasses.length > 1 ? theoreticalMasses : theoreticalMasses[0],
    deconv_show_peak_labels: !clean,
  };
}

async function fetchMasscalcFigureBlob(target = 'main', format = 'png', dpi = null) {
  if (!state.masscalcData) throw new Error('Run Mass Calculator first');
  const calc = state.masscalcData;
  const clean = target === 'clean';
  const payload = {
    sample_name: calc.sampleName,
    components: calc.displayResults,
    format,
    dpi: dpi || (parseInt(document.getElementById('export-dpi').value) || 300),
    style: buildMasscalcStyle(calc.theoreticalMasses, clean),
  };
  const response = await api.exportDeconvolutedMasses(payload);
  return backendResponseToBlob(response);
}

function setMasscalcFigureImage(target, blob) {
  const container = document.getElementById(target === 'clean' ? 'masscalc-figure-clean' : 'masscalc-figure-main');
  if (!container) return;

  if (state.masscalcFigureUrls[target]) {
    URL.revokeObjectURL(state.masscalcFigureUrls[target]);
    state.masscalcFigureUrls[target] = null;
  }

  const url = URL.createObjectURL(blob);
  state.masscalcFigureUrls[target] = url;

  container.innerHTML = '';
  container.classList.add('has-image');
  const img = document.createElement('img');
  img.src = url;
  img.alt = target === 'clean' ? 'Mass calculator clean figure' : 'Mass calculator figure';
  img.style.width = 'auto';
  img.style.maxWidth = '100%';
  img.style.maxHeight = '390px';
  img.style.height = 'auto';
  img.style.display = 'block';
  img.style.margin = '0 auto';
  container.appendChild(img);
}

async function renderMasscalcFigures() {
  if (!state.masscalcData) return;
  try {
    const [mainBlob, cleanBlob] = await Promise.all([
      fetchMasscalcFigureBlob('main', 'png', 240),
      fetchMasscalcFigureBlob('clean', 'png', 240),
    ]);
    setMasscalcFigureImage('main', mainBlob);
    setMasscalcFigureImage('clean', cleanBlob);
  } catch (err) {
    const main = document.getElementById('masscalc-figure-main');
    const clean = document.getElementById('masscalc-figure-clean');
    if (main) {
      main.classList.remove('has-image');
      main.innerHTML = `<p class="placeholder-msg">Figure rendering failed: ${escapeHtml(err.message || String(err))}</p>`;
    }
    if (clean) {
      clean.classList.remove('has-image');
      clean.innerHTML = `<p class="placeholder-msg">Figure rendering failed: ${escapeHtml(err.message || String(err))}</p>`;
    }
  }
}

async function exportMasscalcFigure(target, format) {
  if (!state.masscalcData) {
    toast('Run Mass Calculator first', 'warning');
    return;
  }

  showLoading(`Exporting ${format.toUpperCase()}...`);
  try {
    const blob = await fetchMasscalcFigureBlob(target, format);
    const suffix = target === 'clean' ? 'masscalc_clean' : 'masscalc';
    const filename = `${sanitizeFilename(state.masscalcData.sampleName)}_${suffix}.${format}`;
    downloadBlob(blob, filename);
    toast(`Exported ${format.toUpperCase()}`, 'success');
  } catch (err) {
    toast(`Export failed: ${err.message}`, 'error');
  } finally {
    hideLoading();
  }
}

function renderMasscalcTables(calcData) {
  const summary = document.getElementById('masscalc-summary');
  const modContainer = document.getElementById('masscalc-mod-table-container');
  const compareContainer = document.getElementById('masscalc-compare-table-container');

  summary.innerHTML = `
    <div class="metric"><span class="dot blue"></span> Sample: ${escapeHtml(calcData.sampleName)}</div>
    <div class="metric"><span class="dot blue"></span> Input mass(es): ${calcData.theoreticalMasses.length}</div>
    <div class="metric"><span class="dot ${calcData.matches > 0 ? 'green' : 'red'}"></span> Matches: ${calcData.matches}</div>
    <div class="metric"><span class="dot blue"></span> Tolerance: ${calcData.tolerance.toFixed(1)} Da</div>
  `;

  const modRows = Object.entries(KNOWN_MODS).flatMap(([name, mass]) => ([
    { mod: mass >= 0 ? `+${name}` : name, delta: mass, expected: calcData.theoreticalMasses[0] + mass },
    { mod: mass >= 0 ? `-${name}` : `+${name.replace(/^-/, '')}`, delta: -mass, expected: calcData.theoreticalMasses[0] - mass },
  ]));

  let modHtml = `<div class="data-table-wrapper" style="max-height:220px;overflow-y:auto;"><table class="data-table">
    <thead><tr><th>Modification</th><th>Δm (Da)</th><th>Expected Mass</th></tr></thead><tbody>`;
  modRows.forEach((r) => {
    modHtml += `<tr>
      <td>${escapeHtml(r.mod)}</td>
      <td>${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(3)}</td>
      <td>${r.expected.toFixed(2)}</td>
    </tr>`;
  });
  modHtml += '</tbody></table></div>';
  modContainer.innerHTML = modHtml;

  let cmpHtml = `<div class="data-table-wrapper"><table class="data-table">
    <thead><tr><th>Rank</th><th>Observed (Da)</th><th>Ref. Mass</th><th>Δm (Da)</th><th>Rel. Intensity</th><th>Match</th></tr></thead><tbody>`;
  calcData.rows.forEach((r, i) => {
    const rankColor = DECONV_RANK_COLORS[i % DECONV_RANK_COLORS.length];
    const hasMatch = !!r.matchText && r.matchText !== '-' && r.matchText !== '—';
    const rowColor = hasMatch ? rankColor : '#666666';
    const rowWeight = hasMatch ? '700' : '400';
    const cellStyle = `color:${rowColor};font-weight:${rowWeight};`;
    cmpHtml += `<tr>
      <td style="${cellStyle}">${r.rank}</td>
      <td style="${cellStyle}">${r.observed.toFixed(2)}</td>
      <td style="${cellStyle}">${r.refMass.toFixed(2)}</td>
      <td style="${cellStyle}">${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(2)}</td>
      <td style="${cellStyle}">${r.relIntensity.toFixed(1)}%</td>
      <td style="${cellStyle}">${escapeHtml(r.matchText)}</td>
    </tr>`;
  });
  cmpHtml += '</tbody></table></div>';
  compareContainer.innerHTML = cmpHtml;
}

async function runMassCalculator() {
  const input = document.getElementById('masscalc-input').value;
  const parsed = parseMasscalcInput(input);
  if (!parsed.masses.length) {
    toast('Enter valid mass value(s) or amino acid sequence', 'warning');
    return;
  }
  if (parsed.unknownResidues.length > 0) {
    toast(`Unknown residues ignored: ${parsed.unknownResidues.join(', ')}`, 'warning');
  }

  const samplePath = document.getElementById('masscalc-sample-select').value || (state.selectedFiles[0] && state.selectedFiles[0].path);
  if (!samplePath) {
    toast('Select a sample for mass comparison', 'warning');
    return;
  }

  const tolerance = parseFloat(document.getElementById('masscalc-tol').value) || 2.0;
  const topN = Math.max(1, Math.min(20, parseInt(document.getElementById('masscalc-top-n').value) || 5));

  showLoading('Running mass calculator...');
  try {
    const { data: deconvData } = await getDeconvForMasscalc(samplePath);
    const rawComponents = Array.isArray(deconvData.components) ? deconvData.components : [];
    const components = filterDeconvDisplayResults(rawComponents, {
      expertMode: false,
      topN: 20,
    });
    if (components.length === 0) {
      throw new Error('No deconvolution components available for selected sample');
    }

    const sampleName = state.selectedFiles.find((f) => f.path === samplePath)?.name || samplePath.split('/').pop() || 'sample';
    const displayResults = components.slice(0, Math.min(topN, components.length));
    const baseIntensity = displayResults[0]?.intensity || 1;

    const rows = [];
    let matches = 0;
    displayResults.forEach((comp, idx) => {
      const observed = Number(comp.mass) || 0;
      const ann = annotateMassMatch(observed, parsed.masses, tolerance);
      const matchText = ann.annotations.length > 0 ? ann.annotations.join(', ') : '-';
      if (ann.annotations.length > 0) matches += 1;
      rows.push({
        rank: idx + 1,
        observed,
        refMass: ann.bestRef,
        delta: ann.delta,
        relIntensity: baseIntensity > 0 ? (Number(comp.intensity || 0) / baseIntensity) * 100 : 0,
        matchText,
      });
    });

    state.masscalcData = {
      samplePath,
      sampleName,
      theoreticalMasses: parsed.masses,
      tolerance,
      displayResults,
      rows,
      matches,
    };

    setMasscalcEmptyState(false);
    renderMasscalcTables(state.masscalcData);
    await renderMasscalcFigures();
    toast('Mass calculator updated', 'success');
  } catch (err) {
    toast(`Mass calculator failed: ${err.message}`, 'error');
  } finally {
    hideLoading();
  }
}

// ===== Restore State =====
function restoreState() {
  normalizeMzTargets();
  syncProgressionAssignmentsToSelectedFiles();
  syncUptakeAssayEntriesToSelectedFiles();
  renderSelectedFiles();
  updateSampleDropdowns();
  renderMzTargets();

  initializeBrowsePath();

  // Re-load metadata for already selected files
  state.selectedFiles.forEach(file => {
    loadSampleMeta(file.path);
  });

  // Render progression assignments when switching to that tab
  const progressionTabBtn = document.querySelector('[data-tab="tab-progression"]');
  if (progressionTabBtn) {
    progressionTabBtn.addEventListener('click', () => {
      renderProgressionAssignments();
    });
  }

  const uptakeAssayTabBtn = document.querySelector('[data-tab="tab-uptake-assay-cc"]');
  if (uptakeAssayTabBtn) {
    uptakeAssayTabBtn.addEventListener('click', () => {
      renderUptakeAssayEntries();
    });
  }

  const deconvTabBtn = document.querySelector('[data-tab="tab-deconv"]');
  if (deconvTabBtn) {
    deconvTabBtn.addEventListener('click', () => {
      autoRunDeconvolutionOnTabOpen();
    });
  }

  const batchDeconvTabBtn = document.querySelector('[data-tab="tab-batch-deconv"]');
  if (batchDeconvTabBtn) {
    batchDeconvTabBtn.addEventListener('click', () => {
      autoRunBatchDeconvolutionOnTabOpen();
    });
  }

  const reportTabBtn = document.querySelector('[data-tab="tab-report"]');
  if (reportTabBtn) {
    reportTabBtn.addEventListener('click', () => {
      renderReportSummary();
    });
  }

  renderReportSummary();
}

// ===== Transfer Router =====
function syncRunRouterInputsFromState() {
  const settings = state.runRouterSettings || {};
  const sourceInput = document.getElementById('router-source-path');
  const initialsInput = document.getElementById('router-initials-root');
  const pollInput = document.getElementById('router-poll-seconds');
  const lookbackInput = document.getElementById('router-monitor-lookback-days');
  const recursiveInput = document.getElementById('router-recursive');
  const autoCopyInput = document.getElementById('router-auto-copy');

  if (sourceInput) sourceInput.value = settings.sourcePath || '';
  if (initialsInput) initialsInput.value = settings.initialsRoot || '';
  if (pollInput) pollInput.value = String(settings.pollSeconds || 15);
  if (lookbackInput) lookbackInput.value = String(
    Number.isFinite(settings.monitorLookbackDays)
      ? settings.monitorLookbackDays
      : RUN_ROUTER_DEFAULT_MONITOR_LOOKBACK_DAYS
  );
  if (recursiveInput) recursiveInput.checked = settings.recursive !== false;
  if (autoCopyInput) autoCopyInput.checked = settings.autoCopy !== false;
}

function updateRunRouterSettingsFromInputs() {
  const sourcePath = normalizeEnteredPath(document.getElementById('router-source-path')?.value || '');
  const initialsRoot = normalizeEnteredPath(document.getElementById('router-initials-root')?.value || '');
  const destinationRoot = initialsRoot;
  const pollSeconds = Math.max(5, Math.min(3600, parseInt(document.getElementById('router-poll-seconds')?.value, 10) || 15));
  const monitorLookbackDays = Math.max(
    0,
    Math.min(
      30,
      parseInt(
        document.getElementById('router-monitor-lookback-days')?.value,
        10,
      ) || RUN_ROUTER_DEFAULT_MONITOR_LOOKBACK_DAYS
    ),
  );
  const recursive = document.getElementById('router-recursive')?.checked !== false;
  const autoCopy = document.getElementById('router-auto-copy')?.checked !== false;

  state.runRouterSettings = {
    sourcePath,
    initialsRoot,
    destinationRoot,
    recursive,
    autoCopy,
    pollSeconds,
    monitorLookbackDays,
  };
  saveRunRouterSettings();
  return state.runRouterSettings;
}

function buildRunRouterPayload(extra = {}) {
  const settings = updateRunRouterSettingsFromInputs();
  const monitoring = extra.forMonitoring === true;
  const payload = {
    source_path: settings.sourcePath,
    initials_root: settings.initialsRoot,
    destination_root: settings.destinationRoot || settings.initialsRoot,
    recursive: settings.recursive,
    limit: 200,
    ...extra,
  };
  delete payload.forMonitoring;
  if (monitoring) {
    payload.monitor_recent_days = settings.monitorLookbackDays ?? RUN_ROUTER_DEFAULT_MONITOR_LOOKBACK_DAYS;
  }
  return payload;
}

function formatRunRouterTimestamp(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}

function getRunRouterStatusMeta(status, routeMode = '') {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'ready-unnamed') {
    return { className: 'router-status router-status-unnamed', label: 'Ready -> Unnamed' };
  }
  if (normalized === 'running') {
    return { className: 'router-status router-status-running', label: 'Running' };
  }
  if (normalized === 'waiting-completion') {
    return { className: 'router-status router-status-waiting', label: 'Waiting' };
  }
  if (normalized === 'already-copied') {
    return { className: 'router-status router-status-already-copied', label: 'Already There' };
  }
  if (normalized === 'copied') {
    return { className: 'router-status router-status-copied', label: 'Copied' };
  }
  if (normalized === 'copying') {
    return { className: 'router-status router-status-copying', label: 'Copying' };
  }
  if (normalized === 'ready') {
    return routeMode === 'unnamed'
      ? { className: 'router-status router-status-unnamed', label: 'Ready -> Unnamed' }
      : { className: 'router-status router-status-ready', label: 'Ready' };
  }
  if (normalized === 'exists') {
    return { className: 'router-status router-status-exists', label: 'Already There' };
  }
  if (normalized === 'scanning') {
    return { className: 'router-status router-status-scanning', label: 'Scanning' };
  }
  if (normalized === 'skipped') {
    return { className: 'router-status router-status-skipped', label: 'Not Transferred' };
  }
  if (normalized === 'error') {
    return { className: 'router-status router-status-error', label: 'Error' };
  }
  return { className: 'router-status router-status-unmatched', label: 'Unmatched' };
}

function upsertRunRouterLogEntry(entry) {
  const normalized = {
    timestamp: new Date().toISOString(),
    runName: String(entry.runName || ''),
    sourcePath: String(entry.sourcePath || ''),
    destinationPath: String(entry.destinationPath || ''),
    status: String(entry.status || 'scanned'),
    detail: String(entry.detail || ''),
  };
  const key = normalized.sourcePath || `${normalized.runName}|${normalized.destinationPath}`;
  const existing = Array.isArray(state.runRouterRecentLog) ? state.runRouterRecentLog : [];
  const current = existing.find((item) => {
    const itemKey = item.sourcePath || `${item.runName}|${item.destinationPath}`;
    return itemKey === key;
  });
  if (
    current
    && current.status === normalized.status
    && current.detail === normalized.detail
    && current.destinationPath === normalized.destinationPath
  ) {
    return;
  }
  const filtered = existing.filter((item) => {
    const itemKey = item.sourcePath || `${item.runName}|${item.destinationPath}`;
    return itemKey !== key;
  });
  state.runRouterRecentLog = [normalized, ...filtered].slice(0, 50);
  saveRunRouterRecentLog();
  renderRunRouterLog();
}

function renderRunRouterSummary() {
  const summary = state.runRouterSummary || {};
  const readyEl = document.getElementById('router-ready-count');
  const copiedEl = document.getElementById('router-copied-count');
  const unnamedEl = document.getElementById('router-unnamed-count');
  const inProgressEl = document.getElementById('router-inprogress-count');
  if (readyEl) readyEl.textContent = String(summary.ready || 0);
  if (copiedEl) copiedEl.textContent = String(summary.already_copied || 0);
  if (unnamedEl) unnamedEl.textContent = String(summary.unnamed || 0);
  if (inProgressEl) inProgressEl.textContent = String(summary.in_progress || 0);
}

function renderRunRouterResults() {
  const container = document.getElementById('router-results-table-container');
  if (!container) return;

  const rows = Array.isArray(state.runRouterResults) ? state.runRouterResults : [];
  if (rows.length === 0) {
    container.innerHTML = '<p class="placeholder-msg">Scan a source folder to list finished runs and their transfer targets.</p>';
    return;
  }

  let html = `<div class="data-table-wrapper"><table class="data-table">
    <thead><tr>
      <th>Status</th><th>Step</th><th>Route</th><th>Run</th><th>Last Activity</th><th>Source</th><th>Destination</th>
    </tr></thead><tbody>`;

  rows.forEach((row) => {
    const statusMeta = getRunRouterStatusMeta(row.status, row.route_mode);
    const routeLabel = row.status === 'running'
      ? (row.route_mode === 'unnamed' ? 'Will go to Unnamed' : (row.initials ? `Will go to ${row.initials}` : 'Waiting'))
      : row.status === 'waiting-completion'
      ? (row.route_mode === 'unnamed' ? 'Waiting for completion log, then Unnamed' : (row.initials ? `Waiting for completion log, then ${row.initials}` : 'Waiting for completion log'))
      : row.route_mode === 'unnamed'
      ? 'Fallback to Unnamed'
      : (row.initials || 'No match');
    const stepLabel = row.run_log_last_line || '-';
    html += `<tr>
      <td><span class="${statusMeta.className}">${escapeHtml(statusMeta.label)}</span></td>
      <td><span class="router-step" title="${escapeAttr(stepLabel)}">${escapeHtml(stepLabel)}</span></td>
      <td>${escapeHtml(routeLabel)}</td>
      <td><span class="router-run-name">${escapeHtml(row.name || '')}</span></td>
      <td>${escapeHtml(formatRunRouterTimestamp(row.latest_mtime_iso))}</td>
      <td><span class="router-path" title="${escapeAttr(row.path || '')}">${escapeHtml(row.path || '')}</span></td>
      <td><span class="router-path" title="${escapeAttr(row.destination_path || '')}">${escapeHtml(row.destination_path || '-')}</span></td>
    </tr>`;
  });

  html += '</tbody></table></div>';
  container.innerHTML = html;
}

function renderRunRouterLog() {
  const container = document.getElementById('router-log-table-container');
  if (!container) return;

  const rows = Array.isArray(state.runRouterRecentLog) ? state.runRouterRecentLog : [];
  if (rows.length === 0) {
    container.innerHTML = '<p class="placeholder-msg">No transfer activity yet.</p>';
    return;
  }

  let html = `<div class="data-table-wrapper"><table class="data-table">
    <thead><tr>
      <th>Time</th><th>Status</th><th>Run</th><th>Detail</th><th>Destination</th>
    </tr></thead><tbody>`;

  rows.forEach((row) => {
    const statusMeta = getRunRouterStatusMeta(row.status, row.status === 'ready-unnamed' ? 'unnamed' : '');
    const statusLabel = row.status === 'ready-unnamed' ? 'Ready -> Unnamed' : statusMeta.label;
    html += `<tr>
      <td>${escapeHtml(formatRunRouterTimestamp(row.timestamp))}</td>
      <td><span class="${statusMeta.className}">${escapeHtml(statusLabel)}</span></td>
      <td><span class="router-run-name">${escapeHtml(row.runName || '-')}</span></td>
      <td>${escapeHtml(row.detail || '-')}</td>
      <td><span class="router-path" title="${escapeAttr(row.destinationPath || '')}">${escapeHtml(row.destinationPath || '-')}</span></td>
    </tr>`;
  });

  html += '</tbody></table></div>';
  container.innerHTML = html;
}

function renderRunRouterBackendLogPath() {
  const el = document.getElementById('router-debug-log-path');
  if (!el) return;
  if (state.runRouterBackendLogPath) {
    el.textContent = `Debug log file: ${state.runRouterBackendLogPath}`;
  } else {
    el.textContent = 'Debug log file will appear here after the first scan or copy.';
  }
}

function updateRunRouterMonitorState() {
  const btn = document.getElementById('btn-router-toggle');
  const dot = document.getElementById('router-status-dot');
  const text = document.getElementById('router-status-text');
  if (!btn || !dot || !text) return;

  if (state.runRouterInterval) {
    btn.textContent = 'Stop Monitoring';
    dot.style.display = 'inline-block';
    const lookbackDays = Math.max(
      0,
      parseInt(state.runRouterSettings?.monitorLookbackDays, 10) || RUN_ROUTER_DEFAULT_MONITOR_LOOKBACK_DAYS,
    );
    text.textContent = lookbackDays > 0
      ? `Monitoring every ${state.runRouterSettings?.pollSeconds || 15}s (today + previous ${lookbackDays} days)`
      : `Monitoring every ${state.runRouterSettings?.pollSeconds || 15}s (today only)`;
  } else {
    btn.textContent = 'Start Monitoring';
    dot.style.display = 'none';
    text.textContent = 'Idle';
  }
}

async function scanRunRouter(options = {}) {
  const payload = buildRunRouterPayload({
    forMonitoring: options.forMonitoring === true,
  });
  if (!payload.source_path || !payload.initials_root) {
    if (!options.silent) toast('Enter source and initials root folders first', 'warning');
    return null;
  }

  if (options.showLoading !== false) showLoading('Scanning finished runs...');
  try {
    const data = await api.runRouterScan(payload);
    state.runRouterResults = Array.isArray(data.items) ? data.items : [];
    state.runRouterSummary = data.summary || null;

    if (data.source_path) {
      state.runRouterSettings.sourcePath = normalizeEnteredPath(data.source_path);
      state.runRouterSettings.initialsRoot = normalizeEnteredPath(data.initials_root || payload.initials_root);
      state.runRouterSettings.destinationRoot = normalizeEnteredPath(data.destination_root || payload.destination_root);
      saveRunRouterSettings();
      syncRunRouterInputsFromState();
      rememberCustomMountPath(state.runRouterSettings.sourcePath, payload.source_path);
      rememberCustomMountPath(state.runRouterSettings.initialsRoot, payload.initials_root);
      rememberCustomMountPath(state.runRouterSettings.destinationRoot, payload.destination_root);
    }
    state.runRouterBackendLogPath = String(data.log_path || state.runRouterBackendLogPath || '');

    state.runRouterResults.forEach((item) => {
      const detail = item.status === 'running'
        ? (item.run_log_last_line || (
          item.route_mode === 'unnamed'
            ? 'Run still active, will route to Unnamed when finished'
            : (item.initials ? `Run still active, will route to ${item.initials}` : 'Run still active')
        ))
        : item.status === 'waiting-completion'
          ? (item.run_log_last_line || (
            item.route_mode === 'unnamed'
              ? 'No completion marker yet, waiting before routing to Unnamed'
              : (item.initials ? `No completion marker yet, waiting before routing to ${item.initials}` : 'No completion marker yet')
          ))
        : item.status === 'ready' || item.status === 'ready-unnamed' || item.status === 'already-copied'
          ? (item.run_log_last_line || (item.route_mode === 'unnamed' ? 'Method completed, routing to Unnamed' : (item.initials ? `Method completed, matched ${item.initials}` : 'Method completed')))
        : item.route_mode === 'unnamed'
          ? 'No recognizable initials, routing to Unnamed'
          : (item.initials ? `Matched ${item.initials}` : 'No transfer target');
      upsertRunRouterLogEntry({
        runName: item.name,
        sourcePath: item.path,
        destinationPath: item.destination_path,
        status: item.route_mode === 'unnamed' && item.status === 'ready' ? 'ready-unnamed' : item.status,
        detail,
      });
    });

    renderRunRouterSummary();
    renderRunRouterResults();
    renderRunRouterBackendLogPath();
    if (!options.silent) {
      toast(`Router scan complete: ${state.runRouterResults.length} runs shown`, 'success');
    }
    return data;
  } catch (err) {
    if (!options.silent) toast(`Transfer scan failed: ${err.message}`, 'error');
    return null;
  } finally {
    if (options.showLoading !== false) hideLoading();
  }
}

async function copyRunRouterRuns(runPaths = null, options = {}) {
  const payload = buildRunRouterPayload({
    forMonitoring: options.forMonitoring === true,
    run_paths: Array.isArray(runPaths) ? runPaths : undefined,
  });
  const displayedReadyPaths = (state.runRouterResults || [])
    .filter((item) => item.status === 'ready')
    .map((item) => item.path);
  const readyPaths = Array.isArray(runPaths)
    ? runPaths
    : displayedReadyPaths;

  if (Array.isArray(runPaths) && readyPaths.length === 0) {
    if (!options.silent) toast('No ready runs to copy', 'warning');
    return null;
  }

  readyPaths.forEach((path) => {
    const item = (state.runRouterResults || []).find((row) => row.path === path);
    upsertRunRouterLogEntry({
      runName: item?.name || getPathLeafName(path),
      sourcePath: path,
      destinationPath: item?.destination_path || '',
      status: 'copying',
      detail: 'Copy in progress',
    });
  });

  if (options.showLoading !== false) showLoading('Copying finished runs...');
  try {
    const copyPayload = { ...payload };
    if (Array.isArray(runPaths)) {
      copyPayload.run_paths = readyPaths;
    } else {
      delete copyPayload.run_paths;
    }
    const data = await api.runRouterCopy(copyPayload);
    state.runRouterBackendLogPath = String(data.log_path || state.runRouterBackendLogPath || '');

    const items = Array.isArray(data.items) ? data.items : [];
    items.forEach((item) => {
      upsertRunRouterLogEntry({
        runName: item.name,
        sourcePath: item.path,
        destinationPath: item.destination_path,
        status: item.status,
        detail: item.detail || (item.status === 'copied' ? 'Copied to destination' : ''),
      });
    });

    if (!options.skipRefresh) {
      await scanRunRouter({
        silent: true,
        showLoading: false,
        forMonitoring: options.forMonitoring === true,
      });
    }
    renderRunRouterBackendLogPath();

    if (!options.silent) {
      const summary = data.summary || {};
      toast(
        `Copied ${summary.copied || 0}, already there ${summary.exists || 0}, skipped ${summary.skipped || 0}`,
        'success'
      );
    }
    return data;
  } catch (err) {
    if (!options.silent) toast(`Transfer copy failed: ${err.message}`, 'error');
    return null;
  } finally {
    if (options.showLoading !== false) hideLoading();
  }
}

async function runRunRouterCycle(options = {}) {
  if (state.runRouterCycleInFlight) return;
  state.runRouterCycleInFlight = true;
  try {
    const scanData = await scanRunRouter({
      forMonitoring: options.forMonitoring === true,
      silent: options.silent !== false,
      showLoading: options.showLoading === true,
    });
    if (!scanData) return;

    const shouldAutoCopy = state.runRouterSettings?.autoCopy !== false;
    const readyCount = Number(scanData.summary?.ready || 0);

    if (shouldAutoCopy && readyCount > 0) {
      await copyRunRouterRuns(null, {
        silent: options.silent !== false,
        showLoading: false,
        forMonitoring: options.forMonitoring === true,
      });
    }
  } finally {
    state.runRouterCycleInFlight = false;
  }
}

async function startRunRouterMonitoring() {
  updateRunRouterSettingsFromInputs();
  await runRunRouterCycle({ silent: false, showLoading: true, forMonitoring: true });
  if (state.runRouterInterval) clearInterval(state.runRouterInterval);
  state.runRouterInterval = setInterval(() => {
    runRunRouterCycle({ silent: true, showLoading: false, forMonitoring: true });
  }, (state.runRouterSettings?.pollSeconds || 15) * 1000);
  updateRunRouterMonitorState();
}

function stopRunRouterMonitoring() {
  if (state.runRouterInterval) {
    clearInterval(state.runRouterInterval);
    state.runRouterInterval = null;
  }
  updateRunRouterMonitorState();
}

function initRunRouter() {
  syncRunRouterInputsFromState();
  renderRunRouterSummary();
  renderRunRouterResults();
  renderRunRouterLog();
  renderRunRouterBackendLogPath();
  updateRunRouterMonitorState();

  document.getElementById('btn-router-use-current')?.addEventListener('click', () => {
    const sourceInput = document.getElementById('router-source-path');
    if (!sourceInput) return;
    sourceInput.value = state.currentPath || '';
    updateRunRouterSettingsFromInputs();
  });

  document.getElementById('btn-router-scan')?.addEventListener('click', () => {
    scanRunRouter({ silent: false, showLoading: true });
  });

  document.getElementById('btn-router-copy')?.addEventListener('click', () => {
    copyRunRouterRuns(null, { silent: false, showLoading: true });
  });

  document.getElementById('btn-router-toggle')?.addEventListener('click', async () => {
    if (state.runRouterInterval) {
      stopRunRouterMonitoring();
      return;
    }
    await startRunRouterMonitoring();
  });

  ['router-source-path', 'router-initials-root', 'router-poll-seconds', 'router-monitor-lookback-days'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => {
      updateRunRouterSettingsFromInputs();
      if (state.runRouterInterval) {
        stopRunRouterMonitoring();
      }
    });
  });

  ['router-recursive', 'router-auto-copy'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => {
      updateRunRouterSettingsFromInputs();
    });
  });
}

// ===== Watch Folder =====
function initWatchFolder() {
  const toggleBtn = document.getElementById('btn-watch-toggle');
  const pathInput = document.getElementById('watch-path-input');

  toggleBtn.addEventListener('click', () => {
    if (state.watchInterval) {
      stopWatching();
    } else {
      const p = pathInput.value.trim() || state.currentPath;
      pathInput.value = p;
      startWatching(p);
    }
  });

  // pre-fill with current browse path when input is focused empty
  pathInput.addEventListener('focus', () => {
    if (!pathInput.value) pathInput.value = state.currentPath;
  });
}

async function startWatching(watchPath) {
  const toggleBtn = document.getElementById('btn-watch-toggle');
  const dot = document.getElementById('watch-status-dot');
  const statusText = document.getElementById('watch-status-text');
  const log = document.getElementById('watch-log');
  const pathInput = document.getElementById('watch-path-input');
  const sourcePath = normalizeEnteredPath(watchPath);
  let resolvedWatchPath = sourcePath;

  // Seed known paths (don't auto-select existing .D folders)
  try {
    const data = await api.browse(sourcePath);
    const items = Array.isArray(data.items) ? data.items : [];
    resolvedWatchPath = data.path || sourcePath;
    if (pathInput) pathInput.value = resolvedWatchPath;
    rememberCustomMountPath(resolvedWatchPath, sourcePath);
    state.watchKnownPaths = new Set(
      items
        .filter((item) => item.is_d_folder && !item.run_in_progress && !item.is_wash_position)
        .map((item) => item.path),
    );
  } catch (e) {
    toast(`Watch: cannot access ${sourcePath}`, 'error');
    return;
  }

  toggleBtn.textContent = 'Stop Watching';
  dot.style.display = 'inline-block';
  statusText.textContent = 'Watching…';
  log.innerHTML = '';

  state.watchInterval = setInterval(async () => {
    try {
      const data = await api.browse(resolvedWatchPath);
      const dFolders = (Array.isArray(data.items) ? data.items : []).filter((item) => item.is_d_folder);
      for (const item of dFolders) {
        if (item.run_in_progress) continue;
        if (item.is_wash_position) continue;
        if (!state.watchKnownPaths.has(item.path)) {
          state.watchKnownPaths.add(item.path);
          selectFile(item);
          toast(`New run: ${item.name}`, 'success');
          const entry = document.createElement('div');
          entry.textContent = `${new Date().toLocaleTimeString()} — ${item.name}`;
          log.prepend(entry);
        }
      }
    } catch (e) {
      // silently skip if path momentarily unavailable
    }
  }, 5000);
}

function stopWatching() {
  if (state.watchInterval) {
    clearInterval(state.watchInterval);
    state.watchInterval = null;
  }
  state.watchKnownPaths.clear();
  document.getElementById('btn-watch-toggle').textContent = 'Start Watching';
  document.getElementById('watch-status-dot').style.display = 'none';
  document.getElementById('watch-status-text').textContent = 'Off';
}

// ===== Utility =====
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function backendResponseToBlob(response) {
  if (!response || typeof response.blob !== 'function') {
    throw new Error('Invalid download response');
  }
  const contentType = String(response.headers?.get('content-type') || '').toLowerCase();
  if (contentType.includes('image/svg+xml')) {
    const text = await response.text();
    return new Blob([text], { type: 'image/svg+xml;charset=utf-8' });
  }
  return response.blob();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
