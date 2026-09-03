Warning: truncated output (original token count: 110752)
Total output lines: 11560

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
const DEFAULT_DECONV_NOISE_CUTOFF = 1000.0;
const DEFAULT_DECONV_LOW_MASS_DA = 500.0;
const DEFAULT_DECONV_HIGH_MASS_DA = 50000.0;
const DECONV_EXPERT_DEFAULTS = {
  minCharge: 1,
  maxCharge: 50,
  minIons: 3,
  mwAgreePct: 0.05,
  contigMin: 3,
  abundancePct: 5,
  envelopePct: 50,
  fwhm: 0.6,
  minInputMz: 100,
  massLow: '',
  massHigh: '',
  noiseCutoff: '',
  monoisotopic: false,
  mwAlgorithm: 'apex',
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
  backgroundSubtractionSpectrumSelections: {},
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
  deconvDenseProfileRenderId: 0,
  deconvAutoRunSignature: '',
  deconvAutoRunInFlight: false,
  deconvWindowEditTimer: null,
  deconvWindowEditRunId: 0,
  deconvSelectedComponentIndex: null,
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
  sequenceModSelectedIndices: [149],
  sequenceModActiveIndex: 149,
  sequenceModReplacementMode: 'standard',
  sequenceModCustomMods: {},
  browseItems: [],
  fileSearchQuery: '',
  fileSearchResults: [],
  fileSearchScopePath: '',
  fileSearchInFlight: false,
  fileSearchError: '',
  fileSearchTruncated: false,
  fileSearchRequestId: 0,
  fileSearchDebounceId: null,
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

const FILE_BROWSER_SEARCH_MIN_CHARS = 2;
const FILE_BROWSER_SEARCH_DEBOUNCE_MS = 250;
const FILE_BROWSER_SEARCH_LIMIT = 200;
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

function isPreferredLcmsDataPath(path) {
  return getPathLeafName(path).toLowerCase() === 'lc-ms agilent data';
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
      label: vol.pinned === true || isPreferredLcmsDataPath(path)
        ? 'LC-MS Agilent data'
        : String(vol.name || getPathLeafName(path) || path),
      title: path,
      pinned: vol.pinned === true || isPreferredLcmsDataPath(path),
    });
  });

  (state.customMountPaths || []).forEach((mount) => {
    const path = normalizeEnteredPath(mount.path);
    if (!path || seen.has(path)) return;
    seen.add(path);
    const source = normalizeEnteredPath(mount.source || '');
    entries.push({
      path,
      label: isPreferredLcmsDataPath(path)
        ? 'LC-MS Agilent data'
        : String(mount.label || getPathLeafName(path) || path),
      title: source && source !== path ? `${source} -> ${path}` : path,
      pinned: isPreferredLcmsDataPath(path),
    });
  });

  entries.sort((left, right) => Number(right.pinned) - Number(left.pinned));

  if (entries.length === 0) {
    container.innerHTML = '';
    container.style.display = 'none';
    return;
  }

  container.style.display = 'flex';
  container.innerHTML = '';
  entries.forEach((entry) => {
    const btn = document.createElement('button');
    btn.className = `btn btn-sm mount-btn${entry.pinned ? ' mount-btn-pinned' : ''}`;
    btn.textContent = entry.label;
    btn.title = entry.title;
    btn.addEventListener('click', () => browseTo(entry.path));
    container.appendChild(btn);
  });
}

// ===== Initialization =====
document.addEventListener('DOMContentLoaded', () => {
  initAppVersionBadge();
  initUpdateIndicator();
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
  initSequenceModTool();
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

function initUpdateIndicator() {
  const badge = document.getElementById('update-available-badge');
  const label = document.getElementById('update-status-label');
  const version = document.getElementById('update-available-version');
  const updates = window.catrupoleUpdates;
  if (!badge || !label || !version || !updates) return;

  const render = (status) => {
    const state = String(status?.state || 'idle');
    const available = Boolean(status?.available);
    const current = state === 'current';
    const offline = state === 'offline';
    const updateError = state === 'error';
    const checking = state === 'checking';
    const downloading = state === 'downloading';
    const ready = state === 'ready';
    const installing = state === 'installing';
    const canOpenDevelopmentRelease = available && status?.installable === false;
    const actionable = ready || canOpenDevelopmentRelease;
    badge.hidden = !available && !current && !offline && !updateError && !checking;
    badge.disabled = !actionable;
    badge.classList.toggle('is-current', current);
    badge.classList.toggle('is-offline', offline || updateError);
    badge.classList.toggle('is-downloading', downloading || checking);
    badge.classList.toggle('is-ready', ready);
    if (installing) label.textContent = 'Installing update…';
    else if (ready) label.textContent = 'Restart to update';
    else if (downloading) label.textContent = `Downloading update ${Number(status?.progressPercent) || 0}%`;
    else if (available) label.textContent = status?.installable === false ? 'Update available' : 'Preparing update…';
    else if (current) label.textContent = 'You are up to date!';
    else if (checking) label.textContent = 'Checking for updates…';
    else if (updateError) label.textContent = 'Update problem';
    else label.textContent = 'Update check unavailable';
    badge.title = ready
      ? 'Restart CATrupole now and install the downloaded update'
      : (downloading || available
        ? 'CATrupole is downloading the update automatically'
        : (current
          ? 'This is the latest CATrupole release'
          : (updateError
            ? String(status?.errorMessage || 'CATrupole could not install the update')
            : 'CATrupole could not check GitHub for updates')));
    version.textContent = available && status.latestVersion ? `v${status.latestVersion}` : '';
  };

  badge.addEventListener('click', async () => {
    try {
      if (typeof updates.performAction === 'function') await updates.performAction();
      else await updates.openRelease();
    } catch (_) {
      toast('CATrupole could not start the update.', 'error');
    }
  });

  updates.onStatus(render);
  updates.getStatus().then(render).catch(() => {
    // Update checks stay quiet when GitHub is unavailable.
  });
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

function syncDeconvExpertModeUI() {
  const expertMode = document.getElementById('expert-mode-toggle')?.checked === true;
  document.getElementById('expert-params')?.classList.toggle('hidden', !expertMode);
  document.querySelectorAll('.deconv-expert-only').forEach((el) => {
    el.classList.toggle('hidden', !expertMode);
  });
  if (expertMode) {
    syncDeconvMwAlgorithmDefault(document.getElementById('deconv-sample-select')?.value || '');
  }
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

function getBgsubSpectrumSelectionKey(polarity = null) {
  if (polarity === 'negative') return 'negative';
  if (polarity === 'positive') return 'positive';
  return 'default';
}

function renderBgsubSummedSpectrumPlaceholder(plotId, panelLabel = '') {
  const plotEl = document.getElementById(plotId);
  if (!plotEl) return;
  const labelSuffix = panelLabel ? ` ${panelLabel}` : '';
  plotEl.innerHTML = `<p class="placeholder-msg">Drag on the TIC${labelSuffix} to populate a summed MS spectrum</p>`;
}

async function loadBgsubSummedSpectrumWindow({
  samplePath,
  plotId,
  start,
  end,
  polarity = null,
  panelLabel = '',
}) {
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

function renderBgsubInteractiveTicPlot({
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
  const selection = state.backgroundSubtractionSpectrumSelections[getBgsubSpectrumSelectionKey(polarity)] || null;
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
  bindBgsubTicSpectrumSelection(plotId, spectrumPlotId, samplePath, polarity, panelLabel, {
    times,
    intensities,
    title,
    color,
  });
}

function bindBgsubTicSpectrumSelection(ticPlotId, spectrumPlotId, samplePath, polarity = null, panelLabel = '', renderArgs = null) {
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
    state.backgroundSubtractionSpectrumSelections[getBgsubSpectrumSelectionKey(polarity)] = {
      start: normalizedStart,
      end: normalizedEnd,
    };

    if (renderArgs) {
      renderBgsubInteractiveTicPlot({
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

    await loadBgsubSummedSpectrumWindow({
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
  const summedSpectrumPanel = document.getElementById('bgsub-summed-spectrum-panel');
  const spectrum = document.getElementById('bgsub-spectrum-plot');
  const spectrumTable = document.getElementById('bgsub-spectrum-table');
  const eic = document.getElementById('bgsub-eic-plots');
  if (metrics) metrics.innerHTML = '';
  if (uv) uv.innerHTML = '';
  if (tic) {
    tic.innerHTML = '';
    tic.className = 'plot-container';
  }
  if (summedSpectrumPanel) {
    summedSpectrumPanel.innerHTML = '';
    summedSpectrumPanel.className = 'plot-container hidden';
  }
  if (spectrum) spectrum.innerHTML = '';
  if (spectrum) spectrum.className = 'plot-container';
  if (spectrumTable) {
    spectrumTable.innerHTML = '';
    spectrumTable.className = 'plot-container';
  }
  if (eic) eic.innerHTML = '';
  state.backgroundSubtractionSpectrumSelections = {};
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
  const densePreview = document.getElementById('deconv-dense-mass-preview');
  const spectrum = document.getElementById('deconv-spectrum-plot');
  if (uv) uv.innerHTML = '';
  if (tic) tic.innerHTML = '';
  if (table) table.innerHTML = '';
  if (ion) ion.innerHTML = '';
  if (detail) detail.innerHTML = '';
  if (mass) mass.innerHTML = '';
  if (densePreview) {
    state.deconvDenseProfileRenderId += 1;
    try { charts.clearPlot('deconv-dense-mass-preview'); } catch (_) {}
    densePreview.innerHTML = '<p class="placeholder-msg">Run deconvolution to render the full dense mass profile.</p>';
  }
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
  const bar = document.getElementById('uptake-assay-bar-plot');
  const summary = document.getElementById('uptake-assay-summary');
  if (overlay) overlay.innerHTML = '';
  if (curve) curve.innerHTML = '';
  if (bar) bar.innerHTML = '';
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
    const layoutHeight = Number(el.layout?.height || el._fullLayout?.height || 0);
    const height = Number.isFinite(fixedHeight) && fixedHeight > 0
      ? Math.floor(fixedHeight)
      : Number.isFinite(layoutHeight) && layoutHeight > 120
        ? Math.floor(layoutHeight)
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
      'deconv-dense-mass-preview',
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
      'bgsub-tic-plot-main',
      'bgsub-summed-spectrum-plot',
      'bgsub-spectrum-plot',
      'bgsub-tic-pos-plot',
      'bgsub-tic-neg-plot',
      'bgsub-summed-spectrum-pos-plot',
      'bgsub-summed-spectrum-neg-plot',
      'bgsub-spectrum-positive-plot',
      'bgsub-spectrum-negative-plot',
      'eic-overlay-plot',
      'uptake-assay-overlay-plot',
      'uptake-assay-curve-plot',
      'timechange-ms-plot',
      'timechange-ms-offset-plot',
    ];
  const includesDeconvBottom = ids.includes('deconv-spectrum-plot') || ids.includes('deconv-mass-plot') || ids.includes('deconv-dense-mass-preview');
  [0, 120, 280].forEach((delayMs) => {
    setTimeout(() => {
      if (includesDeconvBottom) syncDeconvBottomLayout();
      ids.forEach((id) => resizePlotlyById(id));
    }, delayMs);
  });
}

// ===== Sidebar =====
function initSidebar() {
  const sidebar = document.getElementById('sidebar');
  const resizeHandle = document.getElementById('sidebar-resize-handle');
  const sidebarWidthStorageKey = 'catrupole.sidebarWidth';
  const defaultSidebarWidth = 320;
  const minimumSidebarWidth = 240;
  const maximumSidebarWidth = () => Math.max(minimumSidebarWidth, Math.min(640, Math.floor(window.innerWidth * 0.6)));
  const clampSidebarWidth = (width) => Math.min(maximumSidebarWidth(), Math.max(minimumSidebarWidth, Math.round(width)));
  const applySidebarWidth = (width, persist = false) => {
    const normalizedWidth = clampSidebarWidth(Number(width) || defaultSidebarWidth);
    document.documentElement.style.setProperty('--sidebar-width', `${normalizedWidth}px`);
    resizeHandle?.setAttribute('aria-valuenow', String(normalizedWidth));
    resizeHandle?.setAttribute('aria-valuemax', String(maximumSidebarWidth()));
    if (persist) {
      try {
        localStorage.setItem(sidebarWidthStorageKey, String(normalizedWidth));
      } catch (_) {
        // Resizing still works when local storage is unavailable.
      }
    }
    return normalizedWidth;
  };

  try {
    applySidebarWidth(localStorage.getItem(sidebarWidthStorageKey) || defaultSidebarWidth);
  } catch (_) {
    applySidebarWidth(defaultSidebarWidth);
  }

  if (sidebar && resizeHandle) {
    let activePointerId = null;
    let startingX = 0;
    let startingWidth = defaultSidebarWidth;

    const finishResize = (event) => {
      if (activePointerId === null || (event?.pointerId !== undefined && event.pointerId !== activePointerId)) return;
      activePointerId = null;
      document.body.classList.remove('sidebar-resizing');
      applySidebarWidth(sidebar.getBoundingClientRect().width, true);
      schedulePlotlyResize();
    };

    resizeHandle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      activePointerId = event.pointerId;
      startingX = event.clientX;
      startingWidth = sidebar.getBoundingClientRect().width;
      document.body.classList.add('sidebar-resizing');
      resizeHandle.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });

    resizeHandle.addEventListener('pointermove', (event) => {
      if (activePointerId !== event.pointerId) return;
      applySidebarWidth(startingWidth + event.clientX - startingX);
    });
    resizeHandle.addEventListener('pointerup', finishResize);
    resizeHandle.addEventListener('pointercancel', finishResize);
    resizeHandle.addEventListener('dblclick', () => {
      applySidebarWidth(defaultSidebarWidth, true);
      schedulePlotlyResize();
    });
    resizeHandle.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
      const currentWidth = sidebar.getBoundingClientRect().width;
      const nextWidth = event.key === 'Home'
        ? defaultSidebarWidth
        : currentWidth + (event.key === 'ArrowRight' ? 16 : -16);
      applySidebarWidth(nextWidth, true);
      schedulePlotlyResize();
      event.preventDefault();
    });
    window.addEventListener('resize', () => applySidebarWidth(sidebar.getBoundingClientRect().width), { passive: true });
  }

  // Collapse/expand
  document.getElementById('sidebar-toggle-collapse').addEventListener('click', () => {
    sidebar.classList.add('collapsed');
    document.getElementById('sidebar-expand').classList.remove('hidden');
    setTimeout(() => window.dispatchEvent(new Event('resize')), 180);
    schedulePlotlyResize();
  });

  document.getElementById('sidebar-expand').addEventListener('click', () => {
    sidebar.classList.remove('collapsed');
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
  document.getElementById('expert-mode-toggle').addEventListener('change', () => {
    syncDeconvExpertModeUI();
  });
  syncDeconvExpertModeUI();
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
  const searchInput = document.getElementById('file-search-input');

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

  searchInput.addEventListener('input', (e) => {
    state.fileSearchQuery = e.target.value.trim();
    state.fileSearchError = '';
    state.fileSearchTruncated = false;
    scheduleFileSearch();
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    state.fileSearchQuery = e.target.value.trim();
    state.fileSearchError = '';
    state.fileSearchTruncated = false;
    scheduleFileSearch({ immediate: true });
  });

  document.getElementById('file-search-clear').addEventListener('click', () => {
    resetFileSearchState();
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

function getFileSearchQuery() {
  return String(state.fileSearchQuery || '').trim();
}

function isRecursiveFileSearchActive() {
  return getFileSearchQuery().length >= FILE_BROWSER_SEARCH_MIN_CHARS;
}

function clearPendingFileSearch() {
  if (state.fileSearchDebounceId) {
    clearTimeout(state.fileSearchDebounceId);
    state.fileSearchDebounceId = null;
  }
}

function resetFileSearchState(options = {}) {
  const render = options.render !== false;
  const input = document.getElementById('file-search-input');
  clearPendingFileSearch();
  state.fileSearchRequestId += 1;
  state.fileSearchQuery = '';
  state.fileSearchResults = [];
  state.fileSearchScopePath = '';
  state.fileSearchInFlight = false;
  state.fileSearchError = '';
  state.fileSearchTruncated = false;
  if (input) input.value = '';
  if (render) renderFileList();
}

function scheduleFileSearch(options = {}) {
  const immediate = options.immediate === true;
  const query = getFileSearchQuery();

  clearPendingFileSearch();

  if (!query) {
    state.fileSearchRequestId += 1;
    state.fileSearchResults = [];
    state.fileSearchScopePath = '';
    state.fileSearchInFlight = false;
    state.fileSearchError = '';
    state.fileSearchTruncated = false;
    renderFileList();
    return;
  }

  if (query.length < FILE_BROWSER_SEARCH_MIN_CHARS) {
    state.fileSearchRequestId += 1;
    state.fileSearchResults = [];
    state.fileSearchScopePath = '';
    state.fileSearchInFlight = false;
    state.fileSearchError = '';
    state.fileSearchTruncated = false;
    renderFileList();
    return;
  }

  if (immediate) {
    runFileSearch();
    return;
  }

  state.fileSearchDebounceId = setTimeout(() => {
    runFileSearch();
  }, FILE_BROWSER_SEARCH_DEBOUNCE_MS);
}

async function runFileSearch() {
  const query = getFileSearchQuery();
  if (query.length < FILE_BROWSER_SEARCH_MIN_CHARS) {
    renderFileList();
    return;
  }

  clearPendingFileSearch();

  const requestId = state.fileSearchRequestId + 1;
  state.fileSearchRequestId = requestId;
  state.fileSearchResults = [];
  state.fileSearchScopePath = state.currentPath;
  state.fileSearchInFlight = true;
  state.fileSearchError = '';
  state.fileSearchTruncated = false;
  renderFileList();

  try {
    const data = await api.searchBrowser(
      state.currentPath,
      query,
      FILE_BROWSER_SEARCH_LIMIT,
      state.runRouterSettings.initialsRoot || state.currentPath
    );
    if (requestId !== state.fileSearchRequestId) return;
    state.fileSearchResults = Array.isArray(data.items) ? data.items : [];
    state.fileSearchScopePath = data.path || state.currentPath;
    state.fileSearchInFlight = false;
    state.fileSearchError = '';
    state.fileSearchTruncated = data.truncated === true;
    renderFileList();
  } catch (err) {
    if (requestId !== state.fileSearchRequestId) return;
    state.fileSearchResults = [];
    state.fileSearchScopePath = state.currentPath;
    state.fileSearchInFlight = false;
    state.fileSearchError = err.message || 'Search failed';
    state.fileSearchTruncated = false;
    renderFileList();
  }
}

async function browseTo(path, options = {}) {
  const targetPath = normalizeEnteredPath(path);
  const silent = !!options.silent;
  const throwOnError = !!options.throwOnError;
  const rememberMountCandidate = !!options.rememberMountCandidate;
  const sourcePath = options.sourcePath || targetPath;
  try {
    const data = await api.browse(targetPath, {
      includeState: options.includeState === true,
    });
    state.currentPath = data.path;
    state.browseItems = data.items || [];
    document.getElementById('path-input').value = data.path;
    localStorage.setItem('lcms-browse-path', data.path);
    if (rememberMountCandidate) {
      rememberCustomMountPath(data.path, sourcePath);
    }
    if (isRecursiveFileSearchActive()) {
      scheduleFileSearch({ immediate: true });
    } else {
      renderFileList();
    }
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

function describeFileSearchItem(item) {
  switch (item?.kind) {
    case 'sample-folder':
      return 'Sample';
    case 'rslt-run':
    case 'olax-run':
      return 'Run';
    case 'rslt-container':
    case 'olax-container':
      return 'Container';
    case 'directory':
      return 'Folder';
    case 'file':
      return 'File';
    default:
      if (item?.is_d_folder) return 'Sample';
      if (item?.is_dir) return 'Folder';
      return 'File';
  }
}

function formatFileSearchMeta(item) {
  const parent = String(item?.parent || '.');
  return `${describeFileSearchItem(item)} • ${parent}`;
}

function renderFileSearchStatus() {
  const el = document.getElementById('file-search-status');
  if (!el) return;

  const query = getFileSearchQuery();
  if (!query) {
    el.textContent = '';
    el.classList.remove('is-error');
    el.style.display = 'none';
    return;
  }

  let text = '';
  let isError = false;
  if (query.length < FILE_BROWSER_SEARCH_MIN_CHARS) {
    text = `Type at least ${FILE_BROWSER_SEARCH_MIN_CHARS} characters to search recursively under ${state.currentPath}`;
  } else if (state.fileSearchInFlight) {
    text = `Searching for "${query}" under ${state.currentPath}...`;
  } else if (state.fileSearchError) {
    text = `Search failed: ${state.fileSearchError}`;
    isError = true;
  } else {
    const count = state.fileSearchResults.length;
    const countLabel = state.fileSearchTruncated ? `Showing first ${count}` : String(count);
    text = `${countLabel} match${count === 1 ? '' : 'es'} for "${query}" under ${state.fileSearchScopePath || state.currentPath}`;
  }

  el.textContent = text;
  el.classList.toggle('is-error', isError);
  el.style.display = 'block';
}

function renderFileList() {
  const container = document.getElementById('file-list');
  const searchMode = isRecursiveFileSearchActive();
  renderFileSearchStatus();

  let items = searchMode
    ? [...state.fileSearchResults]
    : [...state.browseItems].filter((item) => {
        if (!item || item.is_dir || item.is_d_folder) return true;
        return !String(item.name || '').toLowerCase().endsWith('.pdf');
      });

  // Sort
  items = sortItems(items, state.sortMode);

  container.innerHTML = '';

  if (searchMode && state.fileSearchError) {
    container.innerHTML = `<p class="muted" style="padding:12px;">Search failed: ${escapeHtml(state.fileSearchError)}</p>`;
    return;
  }

  if (items.length === 0) {
    if (searchMode && state.fileSearchInFlight) {
      container.innerHTML = '<p class="muted" style="padding:12px;">Searching...</p>';
    } else if (searchMode) {
      container.innerHTML = '<p class="muted" style="padding:12px;">No matching items under this path</p>';
    } else {
      container.innerHTML = '<p class="muted" style="padding:12px;">Empty directory</p>';
    }
    return;
  }

  const renderLabelHtml = (item) => {
    const titlePath = escapeAttr(String(item.path || ''));
    const name = escapeHtml(String(item.name || ''));
    if (!searchMode) {
      return `<span class="file-name" title="${titlePath}">${name}</span>`;
    }
    const metaTitle = escapeAttr(String(item.parent_path || item.path || ''));
    const meta = escapeHtml(formatFileSearchMeta(item));
    return `
      <div class="file-item-text">
        <span class="file-name" title="${titlePath}">${name}</span>
        <span class="file-item-meta" title="${metaTitle}">${meta}</span>
      </div>
    `;
  };

  const orderedItems = searchMode
    ? items
    : [
        ...items.filter((item) => item.is_dir && !item.is_d_folder),
        ...items.filter((item) => item.is_d_folder),
        ...items.filter((item) => !item.is_dir && !item.is_d_folder),
      ];

  orderedItems.forEach(item => {
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
        ${renderLabelHtml(item)}
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
        ${renderLabelHtml(item)}
      `;
      el.addEventListener('click', () => {
        if (searchMode) resetFileSearchState({ render: false });
        browseTo(item.path);
      });
      el.style.cursor = 'pointer';
    } else {
      el.innerHTML = `
        <span class="file-icon">&#128196;</span>
        ${renderLabelHtml(item)}
      `;
      if (searchMode) {
        el.addEventListener('click', () => {
          resetFileSearchState({ render: false });
          browseTo(item.parent_path || state.currentPath);
        });
        el.style.cursor = 'pointer';
      } else {
        el.style.opacity = '0.5';
      }
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

async function loadSampleMeta(path, options = {}) {
  const silent = options.silent === true;
  try {
    const meta = await api.loadSample(path);
    state.loadedSamples[path] = meta;
    updateWavelengthCheckboxes();
    const sampleLabel = meta.name || path.split(/[\\/]/).pop();
    if (silent) {
      return meta;
    }
    if (meta.run_in_progress) {
      toast(`Loaded partial run: ${sampleLabel} (still acquiring, not cached)`, 'warning');
    } else {
      toast(`Loaded: ${sampleLabel}`, 'success');
    }
    return meta;
  } catch (err) {
    if (!silent) {
      toast(`Failed to load sample: ${err.message}`, 'error');
      return null;
    }
    throw err;
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
  syncDeconvBackgroundSelection();
  syncDeconvMwAlgorithmDefault(document.getElementById('deconv-sample-select')?.value || '');
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

function syncDeconvBackgroundSelection() {
  const sampleSelect = document.getElementById('deconv-sample-select');
  const backgroundSelect = document.getElementById('deconv-background-select');
  if (!sampleSelect || !backgroundSelect) return;

  const samplePath = sampleSelect.value || '';
  const currentBackground = backgroundSelect.value || '';
  const candidates = state.selectedFiles
    .map((file) => ({ path: file.path, name: file.name }))
    .filter((file) => file.path && file.path !== samplePath);

  backgroundSelect.innerHTML = '<option value="">-- No background --</option>';
  candidates.forEach((file) => {
    const opt = document.createElement('option');
    opt.value = file.path;
    opt.textContent = file.name;
    backgroundSelect.appendChild(opt);
  });

  if (candidates.some((file) => file.path === currentBackground)) {
    backgroundSelect.value = currentBackground;
  } else {
    backgroundSelect.value = '';
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
    state.backgroundSubtractionSpectrumSelections = {};
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
  const summedSpectrumPanel = document.getElementById('bgsub-summed-spectrum-panel');
  ticContainer.innerHTML = '';
  if (summedSpectrumPanel) {
    summedSpectrumPanel.innerHTML = '';
    summedSpectrumPanel.className = 'plot-container hidden';
  }
  if (hasDualTic) {
    const ticTitle = document.getElementById('label-tic-panel');
    const baseTitle = (ticTitle && ticTitle.value) || 'Total Ion Chromatogram';
    ticContainer.className = 'plot-stack';

    const posDiv = document.createElement('div');
    posDiv.className = 'plot-container';
    posDiv.id = 'bgsub-tic-pos-plot';
    ticContainer.appendChild(posDiv);
    const posSpectrumDiv = document.createElement('div');
    posSpectrumDiv.className = 'plot-container';
    posSpectrumDiv.id = 'bgsub-summed-spectrum-pos-plot';
    ticContainer.appendChild(posSpectrumDiv);
    renderBgsubSummedSpectrumPlaceholder('bgsub-summed-spectrum-pos-plot', '(+)');
    renderBgsubInteractiveTicPlot({
      plotId: 'bgsub-tic-pos-plot',
      times: data.tic.times_pos,
      intensities: data.tic.intensities_pos,
      title: `${baseTitle} (+) (${sampleTitle} - ${backgroundTitle})`,
      color: '#1f77b4',
      samplePath: data.sample_path,
      polarity: 'positive',
      panelLabel: '(+)',
      spectrumPlotId: 'bgsub-summed-spectrum-pos-plot',
    });

    const negDiv = document.createElement('div');
    negDiv.className = 'plot-container';
    negDiv.id = 'bgsub-tic-neg-plot';
    ticContainer.appendChild(negDiv);
    const negSpectrumDiv = document.createElement('div');
    negSpectrumDiv.className = 'plot-container';
    negSpectrumDiv.id = 'bgsub-summed-spectrum-neg-plot';
    ticContainer.appendChild(negSpectrumDiv);
    renderBgsubSummedSpectrumPlaceholder('bgsub-summed-spectrum-neg-plot', '(−)');
    renderBgsubInteractiveTicPlot({
      plotId: 'bgsub-tic-neg-plot',
      times: data.tic.times_neg,
      intensities: data.tic.intensities_neg,
      title: `${baseTitle} (-) (${sampleTitle} - ${backgroundTitle})`,
      color: '#d62728',
      samplePath: data.sample_path,
      polarity: 'negative',
      panelLabel: '(−)',
      spectrumPlotId: 'bgsub-summed-spectrum-neg-plot',
    });
  } else if (data.tic && data.tic.times && data.tic.times.length > 0) {
    const ticTitle = document.getElementById('label-tic-panel');
    ticContainer.className = 'plot-stack';
    const ticDiv = document.createElement('div');
    ticDiv.className = 'plot-container';
    ticDiv.id = 'bgsub-tic-plot-main';
    ticContainer.appendChild(ticDiv);
    const spectrumDiv = document.createElement('div');
    spectrumDiv.className = 'plot-container';
    spectrumDiv.id = 'bgsub-summed-spectrum-plot';
    ticContainer.appendChild(spectrumDiv);
    renderBgsubSummedSpectrumPlaceholder('bgsub-summed-spectrum-plot');
    renderBgsubInteractiveTicPlot({
      plotId: 'bgsub-tic-plot-main',
      times: data.tic.times,
      intensities: data.tic.intensities,
      title: `${(ticTitle && ticTitle.value) || 'Total Ion Chromatogram'} (${sampleTitle} - ${backgroundTitle})`,
      color: '#ff7f0e',
      samplePath: data.sample_path,
      polarity: null,
      panelLabel: '',
      spectrumPlotId: 'bgsub-summed-spectrum-plot',
    });
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

function normalizeMassForFormalCharge(mass, netCharge) {
  const numericMass = Number(mass);
  const numericCharge = Number(netCharge || 0);
  if (!Number.isFinite(numericMass) || numericMass <= 0) return numericMass;
  if (!Number.isFinite(numericCharge) || numericCharge === 0) return numericMass;
  return numericMass - (numericCharge * PROTON_MASS);
}

function normalizeSmilesMassForAdduct(exactMass, netCharge) {
  return normalizeMassForFormalCharge(exactMass, netCharge);
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
    frame.contentWindow.postMessage({ typ…60752 tokens truncated…d;

  let active = Number.isInteger(state.sequenceModActiveIndex) ? state.sequenceModActiveIndex : -1;
  if (!normalized.includes(active)) {
    active = normalized.length > 0 ? normalized[normalized.length - 1] : -1;
  }
  state.sequenceModActiveIndex = active;

  const nextCustomMods = {};
  Object.entries(state.sequenceModCustomMods || {}).forEach(([key, value]) => {
    const index = Number.parseInt(key, 10);
    if (!Number.isInteger(index) || index < 0 || index >= maxLength) return;
    nextCustomMods[String(index)] = {
      ...createSequenceModCustomEntry(),
      ...(value || {}),
    };
  });
  state.sequenceModCustomMods = nextCustomMods;

  return normalized;
}

function summarizeSequenceModTokens(tokens, maxVisible = 4) {
  const values = (Array.isArray(tokens) ? tokens : []).filter(Boolean);
  if (values.length === 0) return 'none';
  if (values.length <= maxVisible) return values.join(', ');
  return `${values.slice(0, maxVisible).join(', ')} +${values.length - maxVisible} more`;
}

function formatSequenceModSiteBaseToken(site) {
  return site ? `${site.originalResidue}${site.position}` : 'none';
}

function formatSequenceModSiteChangeToken(site) {
  if (!site) return 'None';
  if (site.hasCustomReplacement) {
    return `${site.originalResidue}${site.position}->${site.effectiveReplacementLabel}`;
  }
  if (site.replacementMode === 'standard' && site.canonicalReplacementResidue && site.canonicalReplacementResidue !== site.originalResidue) {
    return `${site.originalResidue}${site.position}${site.canonicalReplacementResidue}`;
  }
  return formatSequenceModSiteBaseToken(site);
}

function buildSequenceModSelectionChipText(context) {
  if (!context?.sequence || context.selectedSiteCount === 0) {
    return 'Selected sites: none';
  }
  const activeLabel = context.activeSite ? formatSequenceModSiteBaseToken(context.activeSite) : 'none';
  return `Selected sites: ${context.selectedSiteLabel} | Active: ${activeLabel}`;
}

function getSequenceModGlobalSmilesStatus(context) {
  if (!context?.sequence || context.selectedSiteCount === 0) {
    return {
      message: 'Select one or more residues in the viewer to create custom modification inputs.',
      tone: 'muted',
    };
  }
  if (context.activeSite?.smilesResult) {
    return buildSequenceModCustomEntryStatus(context.activeSite);
  }
  return {
    message: `Active site ${formatSequenceModSiteBaseToken(context.activeSite)}. ${SEQUENCE_MOD_SMILES_HELP_TEXT}`,
    tone: 'muted',
  };
}

function buildSequenceModCustomEntryStatus(site) {
  if (!site) {
    return {
      message: SEQUENCE_MOD_SMILES_HELP_TEXT,
      tone: 'muted',
    };
  }
  if (site.smilesResult) {
    const chargeNote = site.smilesResult.netCharge !== 0
      ? ` | normalized from formal charge ${site.smilesResult.netCharge > 0 ? `+${site.smilesResult.netCharge}` : String(site.smilesResult.netCharge)}`
      : '';
    const insertionNote = site.residueInsertionMessage ? ` | ${site.residueInsertionMessage}` : '';
    return {
      message: `${site.smilesResult.formula || 'Formula n/a'} | Average ${site.rawCustomResidueAverageMass.toFixed(5)} Da | Monoisotopic ${site.rawCustomResidueMonoMass.toFixed(5)} Da${chargeNote}${insertionNote}`,
      tone: 'success',
    };
  }
  if (Math.abs(site.rawCustomResidueAverageMass) > 0.0000001) {
    return {
      message: `${site.customResidueLabel} manual mass loaded: ${site.rawCustomResidueAverageMass.toFixed(5)} Da average. The monoisotopic value is approximated from the entered residue mass.`,
      tone: 'muted',
    };
  }
  return {
    message: `Site ${formatSequenceModSiteBaseToken(site)} is selected. Paste SMILES, draw a residue, or enter a residue mass to change this site.`,
    tone: 'muted',
  };
}

function applySequenceModToneToElement(el, tone) {
  if (!el) return;
  if (tone === 'error') {
    el.style.color = 'var(--danger)';
  } else if (tone === 'success') {
    el.style.color = 'var(--success)';
  } else {
    el.style.color = 'var(--text-muted)';
  }
}

function syncSequenceModCustomEntryStatusElement(index, context = null) {
  const el = document.querySelector(`.sequence-mod-custom-entry-status[data-index="${index}"]`);
  if (!el) return;
  const resolvedContext = context || getSequenceModContext();
  const site = (resolvedContext.siteEdits || []).find((item) => item.index === index);
  const status = buildSequenceModCustomEntryStatus(site);
  el.textContent = status.message;
  applySequenceModToneToElement(el, status.tone);
}

function syncSequenceModReplacementModeUI() {
  const mode = getSequenceModReplacementMode();
  state.sequenceModReplacementMode = mode;

  const standardPanel = document.getElementById('seqmod-standard-panel');
  const customPanel = document.getElementById('seqmod-custom-panel');
  const replacementSelect = document.getElementById('seqmod-replacement-residue');

  if (standardPanel) standardPanel.classList.toggle('hidden', mode !== 'standard');
  if (customPanel) {
    customPanel.classList.toggle('hidden', mode !== 'custom');
    customPanel.querySelectorAll('input, button, textarea, select').forEach((el) => {
      el.disabled = mode !== 'custom';
    });
  }
  if (replacementSelect) replacementSelect.disabled = mode !== 'standard';

  document.querySelectorAll('.sequence-mod-mode-card').forEach((card) => {
    const cardMode = card.dataset.mode === 'custom' ? 'custom' : 'standard';
    card.classList.toggle('is-active', cardMode === mode);
  });
}

function setSequenceModReplacementMode(mode, { render = true } = {}) {
  const normalized = mode === 'custom' ? 'custom' : 'standard';
  state.sequenceModReplacementMode = normalized;
  document.querySelectorAll('input[name="seqmod-replacement-mode"]').forEach((input) => {
    input.checked = input.value === normalized;
  });
  syncSequenceModReplacementModeUI();
  if (render) renderSequenceModTool();
}

function focusSequenceModSite(index, { addIfMissing = true, renderCustomEditors = true } = {}) {
  if (!Number.isInteger(index) || index < 0) return;
  const current = Array.isArray(state.sequenceModSelectedIndices) ? [...state.sequenceModSelectedIndices] : [];
  if (!current.includes(index) && addIfMissing) {
    current.push(index);
    current.sort((a, b) => a - b);
    state.sequenceModSelectedIndices = current;
    ensureSequenceModCustomEntry(index);
  }
  state.sequenceModActiveIndex = index;
  renderSequenceModTool({ renderCustomEditors });
}

function removeSequenceModSelectedSite(index, { render = true } = {}) {
  if (!Number.isInteger(index)) return;
  const current = Array.isArray(state.sequenceModSelectedIndices) ? state.sequenceModSelectedIndices : [];
  state.sequenceModSelectedIndices = current.filter((value) => value !== index);
  if (state.sequenceModActiveIndex === index) {
    const next = state.sequenceModSelectedIndices;
    state.sequenceModActiveIndex = next.length > 0 ? next[next.length - 1] : -1;
  }
  if (render) renderSequenceModTool();
}

function renderSequenceModCustomEditors(context) {
  const container = document.getElementById('seqmod-custom-list');
  if (!container) return;

  if (!context?.sequence || context.selectedSiteCount === 0) {
    container.innerHTML = '<p class="placeholder-msg">Select one or more residues in the viewer to create custom modification inputs.</p>';
    const status = getSequenceModGlobalSmilesStatus(context);
    setSequenceModSmilesResult(status.message, status.tone);
    return;
  }

  container.innerHTML = context.siteEdits.map((site) => {
    const status = buildSequenceModCustomEntryStatus(site);
    const isActive = site.index === context.activeIndex;
    return `
      <div class="sequence-mod-custom-entry${isActive ? ' is-active' : ''}" data-index="${site.index}">
        <div class="sequence-mod-custom-entry-header">
          <div>
            <div class="sequence-mod-custom-entry-title">Site ${escapeHtml(formatSequenceModSiteBaseToken(site))}</div>
            <div class="sequence-mod-custom-entry-subtitle">${escapeHtml(describeResidue(site.originalResidue))} at position ${site.position}${isActive ? ' | active editor' : ''}</div>
          </div>
          <div class="sequence-mod-custom-entry-actions">
            <button type="button" class="btn btn-sm btn-seqmod-clear-site" data-index="${site.index}">Clear</button>
            <button type="button" class="btn btn-sm btn-seqmod-remove-site" data-index="${site.index}">Remove Site</button>
          </div>
        </div>
        <div class="molecule-tools-row">
          <label class="sequence-mod-inline-label">Custom Residue Label
            <input type="text" class="seqmod-custom-label-input" data-index="${site.index}" value="${escapeAttr(site.customResidueLabel)}" placeholder="e.g. BocK, AzF, custom ncAA">
          </label>
          <label class="sequence-mod-inline-label">Custom Residue Mass Input (Da)
            <input type="number" class="seqmod-custom-mass-input" data-index="${site.index}" value="${escapeAttr(site.customMassInput)}" step="0.00001">
          </label>
        </div>
        <div class="molecule-tools-row">
          <label class="sequence-mod-smiles-label">SMILES For Custom Replacement Residue
            <input type="text" class="seqmod-custom-smiles-input" data-index="${site.index}" spellcheck="false" value="${escapeAttr(site.smilesInput)}" placeholder="Paste the custom residue or precursor you want to insert at this site">
          </label>
          <button type="button" class="btn btn-sm btn-primary btn-seqmod-use-site-smiles" data-index="${site.index}">Use SMILES</button>
        </div>
        <div class="sequence-mod-custom-entry-status" data-index="${site.index}">${escapeHtml(status.message)}</div>
      </div>
    `;
  }).join('');

  const status = getSequenceModGlobalSmilesStatus(context);
  setSequenceModSmilesResult(status.message, status.tone);
}

function initSequenceModTool() {
  const sequenceInput = document.getElementById('seqmod-sequence-input');
  const loadDefaultBtn = document.getElementById('btn-seqmod-load-default');
  const replacementModeInputs = Array.from(document.querySelectorAll('input[name="seqmod-replacement-mode"]'));
  const replacementSelect = document.getElementById('seqmod-replacement-residue');
  const maturationSelect = document.getElementById('seqmod-maturation-mode');
  const sketcherToggleBtn = document.getElementById('btn-seqmod-toggle-sketcher');
  const useDrawnBtn = document.getElementById('btn-seqmod-use-drawn');
  const viewer = document.getElementById('seqmod-sequence-viewer');
  const customList = document.getElementById('seqmod-custom-list');

  if (sequenceInput && !sequenceInput.value.trim()) {
    sequenceInput.value = DEFAULT_SEQUENCE_MOD_SEQUENCE;
  }
  if (replacementSelect && !replacementSelect.value) {
    replacementSelect.value = 'K';
  }
  state.sequenceModSelectedIndices = DEFAULT_SEQUENCE_MOD_SELECTED_INDICES.slice();
  state.sequenceModActiveIndex = DEFAULT_SEQUENCE_MOD_SELECTED_INDEX;
  if (replacementModeInputs.length > 0) {
    const desiredMode = state.sequenceModReplacementMode === 'custom' ? 'custom' : 'standard';
    replacementModeInputs.forEach((input) => {
      input.checked = input.value === desiredMode;
    });
  }
  syncSequenceModReplacementModeUI();

  if (loadDefaultBtn) {
    loadDefaultBtn.addEventListener('click', () => loadDefaultSequenceModSequence());
  }
  replacementModeInputs.forEach((input) => {
    input.addEventListener('change', () => {
      if (input.checked) setSequenceModReplacementMode(input.value);
    });
  });
  if (sequenceInput) {
    sequenceInput.addEventListener('input', () => {
      renderSequenceModTool();
    });
  }
  [replacementSelect, maturationSelect].forEach((el) => {
    if (!el) return;
    el.addEventListener('input', () => renderSequenceModTool({ renderCustomEditors: false }));
    el.addEventListener('change', () => renderSequenceModTool({ renderCustomEditors: false }));
  });
  if (sketcherToggleBtn) sketcherToggleBtn.addEventListener('click', () => toggleSequenceModSketcher());
  if (useDrawnBtn) useDrawnBtn.addEventListener('click', () => useDrawnStructureForSequenceMod());

  if (viewer) {
    viewer.addEventListener('click', (event) => {
      const btn = event.target.closest('.sequence-mod-residue');
      if (!btn) return;
      const idx = Number.parseInt(btn.dataset.index, 10);
      if (!Number.isFinite(idx)) return;
      if ((event.metaKey || event.ctrlKey || event.altKey) && state.sequenceModSelectedIndices.includes(idx)) {
        removeSequenceModSelectedSite(idx);
        return;
      }
      focusSequenceModSite(idx, { addIfMissing: true, renderCustomEditors: true });
    });
  }

  if (customList) {
    customList.addEventListener('focusin', (event) => {
      const entry = event.target.closest('.sequence-mod-custom-entry');
      if (!entry) return;
      const idx = Number.parseInt(entry.dataset.index, 10);
      if (!Number.isFinite(idx) || idx === state.sequenceModActiveIndex) return;
      state.sequenceModActiveIndex = idx;
      renderSequenceModTool({ renderCustomEditors: false });
    });

    customList.addEventListener('click', (event) => {
      const actionEl = event.target.closest('[data-index]');
      const entry = event.target.closest('.sequence-mod-custom-entry');
      const rawIndex = actionEl?.dataset.index || entry?.dataset.index;
      const idx = Number.parseInt(rawIndex, 10);
      if (!Number.isFinite(idx)) return;

      state.sequenceModActiveIndex = idx;

      if (event.target.closest('.btn-seqmod-remove-site')) {
        removeSequenceModSelectedSite(idx);
        return;
      }
      if (event.target.closest('.btn-seqmod-clear-site')) {
        clearSequenceModExternalModification(idx);
        return;
      }
      if (event.target.closest('.btn-seqmod-use-site-smiles')) {
        applySequenceModSmilesMass('', idx);
        return;
      }
      if (entry && !event.target.closest('input, button, textarea, select')) {
        renderSequenceModTool({ renderCustomEditors: true });
      }
    });

    customList.addEventListener('keydown', (event) => {
      const smilesInput = event.target.closest('.seqmod-custom-smiles-input');
      if (!smilesInput || event.key !== 'Enter') return;
      event.preventDefault();
      const idx = Number.parseInt(smilesInput.dataset.index, 10);
      if (!Number.isFinite(idx)) return;
      applySequenceModSmilesMass('', idx);
    });

    customList.addEventListener('input', (event) => {
      const target = event.target;
      const index = Number.parseInt(target?.dataset?.index, 10);
      if (!Number.isFinite(index)) return;
      state.sequenceModActiveIndex = index;

      if (target.matches('.seqmod-custom-label-input')) {
        patchSequenceModCustomEntry(index, { label: target.value });
        renderSequenceModTool({ renderCustomEditors: false });
        syncSequenceModCustomEntryStatusElement(index);
        return;
      }

      if (target.matches('.seqmod-custom-mass-input')) {
        const current = getSequenceModCustomEntry(index);
        const nextMass = String(target.value ?? '');
        const parsedMass = Number.parseFloat(nextMass || '0');
        const smilesResult = current.smilesResult;
        const smilesMatchesMass = Boolean(
          smilesResult
          && Number.isFinite(smilesResult.normalizedAverageMass)
          && Number.isFinite(parsedMass)
          && Math.abs(parsedMass - smilesResult.normalizedAverageMass) < 0.0001
        );
        patchSequenceModCustomEntry(index, {
          mass: nextMass,
          smilesResult: smilesMatchesMass ? smilesResult : null,
        });
        renderSequenceModTool({ renderCustomEditors: false });
        syncSequenceModCustomEntryStatusElement(index);
        return;
      }

      if (target.matches('.seqmod-custom-smiles-input')) {
        const current = getSequenceModCustomEntry(index);
        const nextSmiles = String(target.value || '').trim();
        patchSequenceModCustomEntry(index, {
          smiles: nextSmiles,
          smilesResult: current.smilesResult && nextSmiles === current.smilesResult.smiles ? current.smilesResult : null,
        });
        renderSequenceModTool({ renderCustomEditors: false });
        syncSequenceModCustomEntryStatusElement(index);
      }
    });
  }

  renderSequenceModTool();
}

function loadDefaultSequenceModSequence() {
  const sequenceInput = document.getElementById('seqmod-sequence-input');
  const replacementSelect = document.getElementById('seqmod-replacement-residue');
  const maturationSelect = document.getElementById('seqmod-maturation-mode');

  if (sequenceInput) sequenceInput.value = DEFAULT_SEQUENCE_MOD_SEQUENCE;
  if (replacementSelect) replacementSelect.value = 'K';
  if (maturationSelect) maturationSelect.value = 'auto';
  state.sequenceModSelectedIndices = DEFAULT_SEQUENCE_MOD_SELECTED_INDICES.slice();
  state.sequenceModActiveIndex = DEFAULT_SEQUENCE_MOD_SELECTED_INDEX;
  state.sequenceModReplacementMode = 'standard';
  state.sequenceModCustomMods = {};
  setSequenceModReplacementMode('standard', { render: false });
  setSequenceModSmilesResult(SEQUENCE_MOD_SMILES_HELP_TEXT, 'muted');
  renderSequenceModTool();
  toast('Default GFP sequence loaded', 'success');
}

function setSequenceModStatus(message, tone = 'muted') {
  const el = document.getElementById('seqmod-sequence-status');
  if (!el) return;
  el.textContent = message;
  applySequenceModToneToElement(el, tone);
}

function setSequenceModSmilesResult(message, tone = 'muted') {
  const el = document.getElementById('seqmod-smiles-result');
  if (!el) return;
  el.textContent = message;
  applySequenceModToneToElement(el, tone);
}

function normalizeProteinSequenceInput(rawInput) {
  return String(rawInput || '')
    .toUpperCase()
    .replace(/[^A-Z*]/g, '');
}

function getResidueMass(residue, basis = 'average') {
  if (!residue || residue === '*') return 0;
  const table = basis === 'mono' ? AA_MONO_MASSES : AA_MASSES;
  const value = table[residue];
  return Number.isFinite(value) ? Number(value) : 0;
}

function describeResidue(residue) {
  if (!residue) return 'none';
  const label = RESIDUE_LABELS[residue] || 'Unknown';
  return residue === '*' ? '* (Stop)' : `${residue} (${label})`;
}

function computeProteinSequenceMass(sequence, basis = 'average') {
  const clean = normalizeProteinSequenceInput(sequence);
  if (!clean) {
    return { mass: 0, unknownResidues: [] };
  }

  const table = basis === 'mono' ? AA_MONO_MASSES : AA_MASSES;
  const water = basis === 'mono' ? WATER_MONO_MASS : WATER_MASS;
  let total = 0;
  let residueCount = 0;
  const unknownResidues = [];

  for (const residue of clean) {
    if (residue === '*') continue;
    const value = table[residue];
    if (Number.isFinite(value)) {
      total += Number(value);
      residueCount += 1;
    } else if (!unknownResidues.includes(residue)) {
      unknownResidues.push(residue);
    }
  }

  if (residueCount > 0) {
    total += water;
  }

  return { mass: total, unknownResidues };
}

function formatSignedMass(value, decimals = 2) {
  const num = Number(value || 0);
  const sign = num > 0 ? '+' : '';
  return `${sign}${num.toFixed(decimals)}`;
}

function applySequenceResidueReplacement(sequence, index, replacementResidue = '') {
  if (!sequence || !replacementResidue || index < 0 || index >= sequence.length) return sequence;
  return `${sequence.slice(0, index)}${replacementResidue}${sequence.slice(index + 1)}`;
}

function editedSequenceStartsWithMet(context) {
  return Boolean(context && context.startsWithMet);
}

function calculateSequenceEditDistance(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left) return right.length;
  if (!right) return left.length;

  let previous = Array.from({ length: right.length + 1 }, (_, idx) => idx);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function calculateSequenceSimilarity(a, b) {
  const left = String(a || '').replace(/\*/g, '');
  const right = String(b || '').replace(/\*/g, '');
  const maxLen = Math.max(left.length, right.length);
  if (!maxLen) return 0;
  const distance = calculateSequenceEditDistance(left, right);
  return Math.max(0, 1 - (distance / maxLen));
}

function findLikelyGfpChromophore(sequence) {
  const clean = String(sequence || '').replace(/\*/g, '');
  if (clean.length < 3) return null;

  const refStart = DEFAULT_GFP_CHROMOPHORE_START;
  const refWindowStart = Math.max(0, refStart - 10);
  const refWindowEnd = Math.min(DEFAULT_SEQUENCE_MOD_REFERENCE.length, refStart + 13);
  const refWindow = DEFAULT_SEQUENCE_MOD_REFERENCE.slice(refWindowStart, refWindowEnd);
  const leftSpan = refStart - refWindowStart;
  const rightSpan = refWindowEnd - (refStart + 3);
  let best = null;

  for (let i = 0; i < clean.length - 2; i += 1) {
    const triad = clean.slice(i, i + 3);
    if (!/^[A-Z]YG$/.test(triad)) continue;

    const queryWindowStart = Math.max(0, i - leftSpan);
    const queryWindowEnd = Math.min(clean.length, i + 3 + rightSpan);
    const queryWindow = clean.slice(queryWindowStart, queryWindowEnd);
    const localSimilarity = calculateSequenceSimilarity(queryWindow, refWindow);
    const shift = i - refStart;
    const score = localSimilarity - (Math.abs(shift) * 0.002);
    const matureStart = clean.startsWith('M') ? i : i + 1;

    const candidate = {
      triad,
      start: i,
      end: i + 2,
      rawStart: i + 1,
      rawEnd: i + 3,
      matureStart,
      matureEnd: matureStart + 2,
      shift,
      localSimilarity,
      score,
    };

    if (!best || candidate.score > best.score) {
      best = candidate;
    }
  }

  return best;
}

function detectAutoSequenceModMaturationModel(sequence) {
  if (!sequence) return null;
  const similarity = calculateSequenceSimilarity(sequence, DEFAULT_SEQUENCE_MOD_REFERENCE);
  const chromophoreCandidate = findLikelyGfpChromophore(sequence);
  if (chromophoreCandidate && (
    chromophoreCandidate.localSimilarity >= GFP_CHROMOPHORE_LOCAL_SIMILARITY_THRESHOLD
    || similarity >= GFP_REFERENCE_SIMILARITY_THRESHOLD
  )) {
    const shiftNote = chromophoreCandidate.shift === 0
      ? ''
      : ` Motif shift relative to the default GFP reference: ${chromophoreCandidate.shift > 0 ? '+' : ''}${chromophoreCandidate.shift} residues.`;
    const numberingNote = chromophoreCandidate.rawStart !== chromophoreCandidate.matureStart
      ? ` Entered-sequence numbering: ${chromophoreCandidate.rawStart}-${chromophoreCandidate.rawEnd}; after initiator-Met removal this corresponds to ${chromophoreCandidate.matureStart}-${chromophoreCandidate.matureEnd}.`
      : '';
    return {
      key: 'gfp-like',
      chromophoreTriad: chromophoreCandidate.triad,
      chromophoreStart: chromophoreCandidate.rawStart,
      chromophoreEnd: chromophoreCandidate.rawEnd,
      similarity,
      localSimilarity: chromophoreCandidate.localSimilarity,
      reason: `Auto-detected fluorescent-protein chromophore motif ${chromophoreCandidate.triad} at residues ${chromophoreCandidate.rawStart}-${chromophoreCandidate.rawEnd}. Local GFP-context similarity ${(chromophoreCandidate.localSimilarity * 100).toFixed(1)}%.${shiftNote}${numberingNote}`,
    };
  }
  if (similarity >= GFP_REFERENCE_SIMILARITY_THRESHOLD) {
    return {
      key: 'gfp-like',
      chromophoreTriad: chromophoreCandidate ? chromophoreCandidate.triad : '',
      chromophoreStart: chromophoreCandidate ? chromophoreCandidate.rawStart : null,
      chromophoreEnd: chromophoreCandidate ? chromophoreCandidate.rawEnd : null,
      similarity,
      reason: `Auto-detected GFP-like sequence by ${(similarity * 100).toFixed(1)}% similarity to the default GFP reference.`,
    };
  }
  return null;
}

function resolveSequenceModMaturation(sequence, requestedMode) {
  const mode = String(requestedMode || 'auto').trim().toLowerCase();
  if (mode === 'none') {
    return {
      key: 'none',
      label: 'No maturation model',
      shortLabel: 'No maturation',
      averageDelta: 0,
      monoDelta: 0,
      description: 'No fluorescent-protein maturation mass shift applied.',
      isAuto: false,
      reason: 'No maturation model applied.',
      applies: false,
    };
  }

  if (mode === 'auto') {
    const auto = detectAutoSequenceModMaturationModel(sequence);
    if (auto) {
      const model = FP_MATURATION_MODELS[auto.key];
      return {
        key: auto.key,
        label: model.label,
        shortLabel: model.shortLabel,
        averageDelta: model.averageDelta,
        monoDelta: model.monoDelta,
        description: model.description,
        isAuto: true,
        reason: auto.reason,
        applies: true,
      };
    }
	    return {
	      key: 'none',
	      label: 'No maturation model',
	      shortLabel: 'No maturation',
	      averageDelta: 0,
	      monoDelta: 0,
	      description: 'No fluorescent-protein maturation mass shift applied.',
	      isAuto: true,
	      reason: 'Auto mode did not detect a GFP-like chromophore motif with sufficiently GFP-like local context or >=80% similarity to the default GFP reference. Set the maturation model manually if needed.',
	      applies: false,
	    };
  }

  const model = FP_MATURATION_MODELS[mode] || FP_MATURATION_MODELS['gfp-like'];
  return {
    key: mode in FP_MATURATION_MODELS ? mode : 'gfp-like',
    label: model.label,
    shortLabel: model.shortLabel,
    averageDelta: model.averageDelta,
    monoDelta: model.monoDelta,
    description: model.description,
    isAuto: false,
    reason: `Manually applied ${model.label.toLowerCase()}.`,
    applies: true,
  };
}

function resolveSequenceModChemistry(hasCustomReplacement) {
  const applies = Boolean(hasCustomReplacement);
  const idleReason = 'No custom replacement residue mass was supplied, so no automatic residue correction was applied.';
  return {
    key: 'auto-minus-water',
    label: SEQUENCE_MOD_AUTO_CHEMISTRY.label,
    shortLabel: SEQUENCE_MOD_AUTO_CHEMISTRY.shortLabel,
    averageDelta: applies ? SEQUENCE_MOD_AUTO_CHEMISTRY.averageDelta : 0,
    monoDelta: applies ? SEQUENCE_MOD_AUTO_CHEMISTRY.monoDelta : 0,
    description: SEQUENCE_MOD_AUTO_CHEMISTRY.description,
    applies,
    reason: applies ? `${SEQUENCE_MOD_AUTO_CHEMISTRY.label} applied automatically.` : idleReason,
  };
}

function getSequenceModContext() {
  const sequenceInput = document.getElementById('seqmod-sequence-input');
  const replacementSelect = document.getElementById('seqmod-replacement-residue');
  const maturationSelect = document.getElementById('seqmod-maturation-mode');

  const sequence = normalizeProteinSequenceInput(sequenceInput?.value || '');
  const replacementMode = getSequenceModReplacementMode();
  const replacementResidue = String(replacementSelect?.value || '').trim().toUpperCase();
  const maturationMode = String(maturationSelect?.value || 'auto').trim().toLowerCase();

  const selectedIndices = normalizeSequenceModSelectedIndices(sequence.length);
  const activeIndex = state.sequenceModActiveIndex;
  const selectedIndexSet = new Set(selectedIndices);
  const baseAverage = computeProteinSequenceMass(sequence, 'average');
  const baseMono = computeProteinSequenceMass(sequence, 'mono');

  const siteEdits = selectedIndices.map((index) => {
    const originalResidue = sequence[index] || '';
    const originalAverageMass = getResidueMass(originalResidue, 'average');
    const originalMonoMass = getResidueMass(originalResidue, 'mono');
    const customEntry = getSequenceModCustomEntry(index);
    const customResidueLabel = String(customEntry.label || '').trim() || 'Custom residue';
    const customMassInput = String(customEntry.mass ?? '0');
    const customResidueMassAvgInput = Number.parseFloat(customMassInput || '0');
    const safeCustomResidueMassAvg = Number.isFinite(customResidueMassAvgInput) ? customResidueMassAvgInput : 0;
    const smilesInput = String(customEntry.smiles || '').trim();
    const rawSmilesResult = customEntry.smilesResult || null;
    const smilesMatch = Boolean(
      rawSmilesResult
      && Number.isFinite(rawSmilesResult.normalizedAverageMass)
      && Math.abs(safeCustomResidueMassAvg - rawSmilesResult.normalizedAverageMass) < 0.0001
    );
    const smilesResult = smilesMatch ? rawSmilesResult : null;
    const rawCustomResidueMonoMass = smilesResult
      ? Number(smilesResult.normalizedExactMass || 0)
      : safeCustomResidueMassAvg;
    const hasCustomReplacement = replacementMode === 'custom' && (
      smilesMatch
      || Math.abs(safeCustomResidueMassAvg) > 0.0000001
    );
    const chemistry = resolveSequenceModChemistry(hasCustomReplacement);
    const customResidueNetAverageMass = safeCustomResidueMassAvg + chemistry.averageDelta;
    const customResidueNetMonoMass = rawCustomResidueMonoMass + chemistry.monoDelta;
    const canonicalReplacementResidue = replacementMode === 'standard'
      ? (replacementResidue || originalResidue)
      : originalResidue;
    const canonicalReplacementAverageMass = getResidueMass(canonicalReplacementResidue, 'average');
    const canonicalReplacementMonoMass = getResidueMass(canonicalReplacementResidue, 'mono');
    const effectiveReplacementAverageMass = hasCustomReplacement ? customResidueNetAverageMass : canonicalReplacementAverageMass;
    const effectiveReplacementMonoMass = hasCustomReplacement ? customResidueNetMonoMass : canonicalReplacementMonoMass;
    const replacementDeltaAvg = hasCustomReplacement
      ? (effectiveReplacementAverageMass - originalAverageMass)
      : (replacementMode === 'standard' ? (canonicalReplacementAverageMass - originalAverageMass) : 0);
    const replacementDeltaMono = hasCustomReplacement
      ? (effectiveReplacementMonoMass - originalMonoMass)
      : (replacementMode === 'standard' ? (canonicalReplacementMonoMass - originalMonoMass) : 0);
    const displayedResidue = replacementMode === 'standard' ? (canonicalReplacementResidue || originalResidue) : originalResidue;
    const hasSiteEdit = hasCustomReplacement || (replacementMode === 'standard' && canonicalReplacementResidue !== originalResidue);
    const residueInsertionPossible = Boolean(smilesResult?.residueInsertionPossible);
    const residueInsertionMessage = String(smilesResult?.residueInsertionMessage || '').trim();
    const effectiveReplacementLabel = hasCustomReplacement
      ? customResidueLabel
      : describeResidue(canonicalReplacementResidue || originalResidue);

    return {
      index,
      position: index + 1,
      replacementMode,
      originalResidue,
      originalAverageMass,
      originalMonoMass,
      customResidueLabel,
      customMassInput,
      smilesInput,
      smilesResult,
      rawCustomResidueAverageMass: safeCustomResidueMassAvg,
      rawCustomResidueMonoMass,
      hasCustomReplacement,
      chemistry,
      customResidueNetAverageMass,
      customResidueNetMonoMass,
      canonicalReplacementResidue,
      effectiveReplacementLabel,
      effectiveReplacementAverageMass,
      effectiveReplacementMonoMass,
      replacementDeltaAvg,
      replacementDeltaMono,
      displayedResidue,
      hasSiteEdit,
      residueInsertionPossible,
      residueInsertionMessage,
    };
  });

  const activeSite = siteEdits.find((site) => site.index === activeIndex) || null;
  const editedSites = siteEdits.filter((site) => site.hasSiteEdit);
  const selectedSiteLabel = summarizeSequenceModTokens(siteEdits.map((site) => formatSequenceModSiteBaseToken(site)));
  const editedSiteLabel = editedSites.length > 0
    ? summarizeSequenceModTokens(editedSites.map((site) => formatSequenceModSiteChangeToken(site)))
    : 'None';
  const changeToken = editedSites.length > 0
    ? editedSites.map((site) => formatSequenceModSiteChangeToken(site)).join('; ')
    : (siteEdits.length > 0 ? siteEdits.map((site) => formatSequenceModSiteBaseToken(site)).join(', ') : 'None');
  const totalReplacementDeltaAvg = siteEdits.reduce((sum, site) => sum + site.replacementDeltaAvg, 0);
  const totalReplacementDeltaMono = siteEdits.reduce((sum, site) => sum + site.replacementDeltaMono, 0);

  let editedSequence = sequence;
  if (replacementMode === 'standard' && siteEdits.length > 0) {
    const chars = sequence.split('');
    siteEdits.forEach((site) => {
      if (site.index >= 0 && site.index < chars.length) {
        chars[site.index] = site.canonicalReplacementResidue || chars[site.index];
      }
    });
    editedSequence = chars.join('');
  }

  let maturationProbeSequence = editedSequence;
  if (replacementMode === 'custom' && siteEdits.length > 0) {
    maturationProbeSequence = siteEdits.reduce((currentSequence, site) => {
      if (!site.hasCustomReplacement || site.index < 64 || site.index > 66) return currentSequence;
      return applySequenceResidueReplacement(currentSequence, site.index, '*');
    }, sequence);
  }

  const hasCustomReplacementAtStart = siteEdits.some((site) => site.hasCustomReplacement && site.index === 0);
  const editedAverageMass = baseAverage.mass + totalReplacementDeltaAvg;
  const editedMonoMass = baseMono.mass + totalReplacementDeltaMono;
  const startsWithMet = !hasCustomReplacementAtStart && editedSequence.startsWith('M');
  const initiatorMetDeltaAvg = startsWithMet ? -getResidueMass('M', 'average') : 0;
  const initiatorMetDeltaMono = startsWithMet ? -getResidueMass('M', 'mono') : 0;
  const maturation = resolveSequenceModMaturation(maturationProbeSequence, maturationMode);
  const metRemovedAverageMass = startsWithMet ? editedAverageMass + initiatorMetDeltaAvg : null;
  const metRemovedMonoMass = startsWithMet ? editedMonoMass + initiatorMetDeltaMono : null;
  const maturedAverageMass = maturation.applies ? editedAverageMass + maturation.averageDelta : null;
  const maturedMonoMass = maturation.applies ? editedMonoMass + maturation.monoDelta : null;
  const metRemovedMaturedAverageMass = (startsWithMet && maturation.applies)
    ? editedAverageMass + initiatorMetDeltaAvg + maturation.averageDelta
    : null;
  const metRemovedMaturedMonoMass = (startsWithMet && maturation.applies)
    ? editedMonoMass + initiatorMetDeltaMono + maturation.monoDelta
    : null;
  const unknownResidues = Array.from(new Set([...(baseAverage.unknownResidues || []), ...(baseMono.unknownResidues || [])]));

  let primaryTargetLabel = 'Edited Full-Length Target';
  let primaryTargetAverageMass = editedAverageMass;
  let primaryTargetMonoMass = editedMonoMass;
  if (maturation.applies && startsWithMet && Number.isFinite(metRemovedMaturedAverageMass)) {
    primaryTargetLabel = 'Edited -Initiator Met + Matured Target';
    primaryTargetAverageMass = metRemovedMaturedAverageMass;
    primaryTargetMonoMass = metRemovedMaturedMonoMass;
  } else if (maturation.applies && Number.isFinite(maturedAverageMass)) {
    primaryTargetLabel = `Edited + ${maturation.shortLabel}`;
    primaryTargetAverageMass = maturedAverageMass;
    primaryTargetMonoMass = maturedMonoMass;
  } else if (startsWithMet && Number.isFinite(metRemovedAverageMass)) {
    primaryTargetLabel = 'Edited -Initiator Met Target';
    primaryTargetAverageMass = metRemovedAverageMass;
    primaryTargetMonoMass = metRemovedMonoMass;
  }

  return {
    sequence,
    editedSequence,
    selectedIndices,
    selectedIndexSet,
    selectedSiteCount: siteEdits.length,
    editedSiteCount: editedSites.length,
    selectedSiteLabel,
    editedSiteLabel,
    siteEdits,
    activeIndex,
    activeSite,
    replacementMode,
    replacementResidue,
    maturationMode,
    maturation,
    totalReplacementDeltaAvg,
    totalReplacementDeltaMono,
    hasAnyCustomReplacement: siteEdits.some((site) => site.hasCustomReplacement),
    baseAverageMass: baseAverage.mass,
    baseMonoMass: baseMono.mass,
    fullLengthAverageMass: editedAverageMass,
    fullLengthMonoMass: editedMonoMass,
    initiatorMetDeltaAvg,
    initiatorMetDeltaMono,
    metRemovedAverageMass,
    metRemovedMonoMass,
    maturedAverageMass,
    maturedMonoMass,
    metRemovedMaturedAverageMass,
    metRemovedMaturedMonoMass,
    startsWithMet,
    primaryTargetLabel,
    primaryTargetAverageMass,
    primaryTargetMonoMass,
    changeToken,
    unknownResidues,
    selectedIndex: activeSite ? activeSite.index : -1,
    position: activeSite ? activeSite.position : 0,
    originalResidue: activeSite ? activeSite.originalResidue : '',
    editedResidue: activeSite ? activeSite.displayedResidue : '',
    canonicalReplacementResidue: activeSite ? activeSite.canonicalReplacementResidue : '',
    effectiveReplacementLabel: activeSite ? activeSite.effectiveReplacementLabel : 'None',
    effectiveReplacementAverageMass: activeSite ? activeSite.effectiveReplacementAverageMass : 0,
    effectiveReplacementMonoMass: activeSite ? activeSite.effectiveReplacementMonoMass : 0,
    hasCustomReplacement: activeSite ? activeSite.hasCustomReplacement : false,
    residueInsertionPossible: activeSite ? activeSite.residueInsertionPossible : false,
    residueInsertionMessage: activeSite ? activeSite.residueInsertionMessage : '',
    chemistry: activeSite ? activeSite.chemistry : resolveSequenceModChemistry(false),
    customResidueLabel: activeSite ? activeSite.customResidueLabel : 'Custom residue',
    rawCustomResidueAverageMass: activeSite ? activeSite.rawCustomResidueAverageMass : 0,
    rawCustomResidueMonoMass: activeSite ? activeSite.rawCustomResidueMonoMass : 0,
    originalAverageMass: activeSite ? activeSite.originalAverageMass : 0,
    originalMonoMass: activeSite ? activeSite.originalMonoMass : 0,
    replacementDeltaAvg: activeSite ? activeSite.replacementDeltaAvg : 0,
    replacementDeltaMono: activeSite ? activeSite.replacementDeltaMono : 0,
    smilesResult: activeSite ? activeSite.smilesResult : null,
  };
}

function renderSequenceModViewer(context) {
  const container = document.getElementById('seqmod-sequence-viewer');
  if (!container) return;

  if (!context.sequence) {
    container.innerHTML = '<p class="placeholder-msg">Paste or type a protein sequence to begin.</p>';
    return;
  }

  const lines = [];
  const siteByIndex = new Map((context.siteEdits || []).map((site) => [site.index, site]));
  for (let lineStart = 0; lineStart < context.sequence.length; lineStart += SEQUENCE_MOD_LINE_LENGTH) {
    const lineSequence = context.sequence.slice(lineStart, lineStart + SEQUENCE_MOD_LINE_LENGTH);
    const rulerGroups = [];
    const residueGroups = [];

    for (let groupStart = 0; groupStart < lineSequence.length; groupStart += SEQUENCE_MOD_GROUP_SIZE) {
      const groupSequence = lineSequence.slice(groupStart, groupStart + SEQUENCE_MOD_GROUP_SIZE);
      const groupEnd = lineStart + groupStart + groupSequence.length;
      rulerGroups.push(`<span class="sequence-mod-ruler-group">${groupEnd}</span>`);

      const residueHtml = groupSequence.split('').map((residue, offset) => {
        const index = lineStart + groupStart + offset;
        const site = siteByIndex.get(index);
        const isSelected = context.selectedIndexSet.has(index);
        const isActive = index === context.activeIndex;
        const displayResidue = site ? site.displayedResidue : residue;
        const isEdited = Boolean(site?.hasSiteEdit);
        const classes = ['sequence-mod-residue'];
        if (displayResidue === '*') classes.push('is-stop');
        if (isEdited) classes.push('is-edited');
        if (isSelected) classes.push('is-selected');
        if (isActive) classes.push('is-active');
        const title = site
          ? (site.hasCustomReplacement
            ? `Position ${index + 1}: ${residue} -> ${site.effectiveReplacementLabel}`
            : (site.hasSiteEdit
              ? `Position ${index + 1}: ${residue} -> ${displayResidue}`
              : `Position ${index + 1}: ${displayResidue} (selected site)`))
          : `Position ${index + 1}: ${displayResidue}`;
        return `<button type="button" class="${classes.join(' ')}" data-index="${index}" title="${escapeAttr(title)}">${escapeHtml(displayResidue)}</button>`;
      }).join('');

      residueGroups.push(`<span class="sequence-mod-group">${residueHtml}</span>`);
    }

    lines.push(`
      <div class="sequence-mod-line">
        <div class="sequence-mod-line-start">${lineStart + 1}</div>
        <div class="sequence-mod-line-body">
          <div class="sequence-mod-ruler">${rulerGroups.join('')}</div>
          <div class="sequence-mod-group-row">${residueGroups.join('')}</div>
        </div>
      </div>
    `);
  }

  container.innerHTML = lines.join('');
}

function renderSequenceModSummary(context) {
  const container = document.getElementById('seqmod-summary');
  if (!container) return;

  if (!context.sequence) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = `
    <div class="metric-card">
      <span class="metric-label">Selected Sites</span>
      <span class="metric-value" style="font-size:16px;">${escapeHtml(context.selectedSiteCount > 0 ? context.selectedSiteLabel : 'None')}</span>
    </div>
    <div class="metric-card">
      <span class="metric-label">Applied Site Changes</span>
      <span class="metric-value" style="font-size:16px;">${escapeHtml(context.editedSiteCount > 0 ? context.editedSiteLabel : 'No mass-changing edits')}</span>
    </div>
    <div class="metric-card">
      <span class="metric-label">Replacement Input</span>
      <span class="metric-value" style="font-size:16px;">${escapeHtml(context.replacementMode === 'custom' ? 'Custom residues per selected site' : 'Standard amino acid across selected sites')}</span>
    </div>
    <div class="metric-card metric-card-primary">
      <span class="metric-label">Primary Deconv Mass</span>
      <span class="metric-value">${context.primaryTargetAverageMass.toFixed(2)}</span>
    </div>
    <div class="metric-card">
      <span class="metric-label">Processed Form</span>
      <span class="metric-value" style="font-size:16px;">${escapeHtml(context.primaryTargetLabel)}</span>
    </div>
  `;
}

function renderSequenceModMassTable(context) {
  const container = document.getElementById('seqmod-mass-table-container');
  const siteChip = document.getElementById('seqmod-selected-site');
  if (!container || !siteChip) return;

  if (!context.sequence) {
    siteChip.textContent = 'Selected sites: none';
    container.innerHTML = '<p class="placeholder-msg">Load a sequence to see the mass breakdown.</p>';
    return;
  }

  siteChip.textContent = buildSequenceModSelectionChipText(context);

  const replacementDescription = context.replacementMode === 'custom'
    ? (context.hasAnyCustomReplacement
      ? `Custom residue mode is active with ${context.editedSiteCount} mass-changing site-specific edit${context.editedSiteCount === 1 ? '' : 's'} loaded`
      : 'Custom residue mode is active, but no selected site has a loaded custom residue mass yet')
    : (context.selectedSiteCount > 0
      ? `Using the standard amino-acid dropdown with ${describeResidue(context.replacementResidue || context.activeSite?.canonicalReplacementResidue)} across ${context.selectedSiteCount} selected site${context.selectedSiteCount === 1 ? '' : 's'}`
      : 'No sites selected yet');
  const chemistryDescription = context.hasAnyCustomReplacement
    ? 'Automatic residue insertion correction (-H2O) is applied independently to each custom residue with a loaded mass.'
    : 'No custom replacement residue mass was supplied, so no automatic residue correction was applied.';
  const monoDescription = context.hasAnyCustomReplacement
    ? 'Monoisotopic total uses SMILES-derived exact masses for custom sites where available; manual custom entries use the entered residue mass as an approximation.'
    : 'Monoisotopic total follows the current site-replacement model.';
  let primaryDescription = `${context.primaryTargetLabel}.`;
  if (context.primaryTargetLabel === 'Edited -Initiator Met + Matured Target') {
    primaryDescription += ' This processed target is shown first because it is usually the best mass to match in deconvolution.';
  } else if (context.primaryTargetLabel === 'Edited -Initiator Met Target') {
    primaryDescription += ' Initiator-methionine removal is applied and shown first because that processed species is often what deconvolution sees.';
  } else if (context.primaryTargetLabel.startsWith('Edited + ')) {
    primaryDescription += ' Maturation is applied and shown first because that processed species is often what deconvolution sees.';
  } else {
    primaryDescription += ' No additional processing model is applied, so the full-length edited construct is shown first.';
  }
  if (context.maturation.reason) {
    primaryDescription += ` ${context.maturation.reason}`;
  }

  const overviewRows = [
    {
      term: 'Selected Sites',
      value: context.selectedSiteCount > 0 ? context.selectedSiteLabel : 'None',
      description: context.selectedSiteCount > 0
        ? `Currently tracking ${context.selectedSiteCount} selected site${context.selectedSiteCount === 1 ? '' : 's'}. Click residues in the viewer to add more sites or remove them from the custom editor list.`
        : 'No sites selected yet. Click one or more residues in the viewer to add editable positions.',
    },
    {
      term: 'Applied Site Changes',
      value: context.editedSiteCount > 0 ? context.changeToken : 'No mass-changing edits',
      description: context.editedSiteCount > 0
        ? `Mass-changing edits are currently applied at ${context.editedSiteCount} site${context.editedSiteCount === 1 ? '' : 's'}.`
        : 'Selected sites are tracked, but none of them currently changes the theoretical mass.',
    },
    {
      term: 'Replacement Input',
      value: context.replacementMode === 'custom' ? 'Custom residues per site' : 'Standard amino acid',
      description: `${replacementDescription}. ${context.replacementMode === 'custom' ? chemistryDescription : 'Each selected site uses the same canonical residue chosen in the dropdown.'}`,
    },
    {
      term: 'Combined Site Delta',
      value: formatSignedMass(context.totalReplacementDeltaAvg, 2),
      description: `${context.editedSiteCount > 0 ? `Summed delta across ${context.editedSiteCount} edited site${context.editedSiteCount === 1 ? '' : 's'}.` : 'No summed site delta yet because no mass-changing edit is loaded.'} ${chemistryDescription}`,
    },
    {
      term: 'Primary Theoretical Deconv Mass',
      value: context.primaryTargetAverageMass.toFixed(2),
      description: primaryDescription,
      isPrimary: true,
    },
    {
      term: 'Primary Reference Mono Mass',
      value: context.primaryTargetMonoMass.toFixed(5),
      description: monoDescription,
    },
  ];
  if (context.activeSite?.smilesResult) {
    overviewRows.splice(3, 0, {
      term: 'Active Site Insertability',
      value: context.activeSite.residueInsertionPossible ? 'Likely Yes' : 'Needs Review',
      description: context.activeSite.residueInsertionMessage || 'No residue-insertability assessment was returned for the active-site SMILES.',
    });
  }

  const detailRows = [
    {
      term: 'Base Sequence Mass',
      avgValue: context.baseAverageMass.toFixed(5),
      monoValue: context.baseMonoMass.toFixed(5),
      description: 'Average intact protein mass from the current sequence. Any * characters are shown in the viewer but contribute 0 Da until replaced.',
      final: false,
    },
    ...context.siteEdits.map((site) => {
      let description = `${describeResidue(site.originalResidue)} at position ${site.position}. `;
      if (site.hasCustomReplacement) {
        description += site.smilesResult
          ? `${site.effectiveReplacementLabel} loaded from SMILES${site.smilesResult.formula ? ` (${site.smilesResult.formula})` : ''}. Net inserted mass ${site.effectiveReplacementAverageMass.toFixed(5)} Da average / ${site.effectiveReplacementMonoMass.toFixed(5)} Da mono.`
          : `${site.effectiveReplacementLabel} loaded from manual residue mass. Net inserted mass ${site.effectiveReplacementAverageMass.toFixed(5)} Da average / ${site.effectiveReplacementMonoMass.toFixed(5)} Da mono.`;
      } else if (context.replacementMode === 'custom') {
        description += 'Selected but unchanged. Load a custom residue mass or SMILES for this site to change the mass.';
      } else if (site.hasSiteEdit) {
        description += `Replaced with ${describeResidue(site.canonicalReplacementResidue)} across the standard-mode selection.`;
      } else {
        description += `Selected but unchanged because the current dropdown leaves this site as ${describeResidue(site.canonicalReplacementResidue)}.`;
      }
      return {
        term: `Site ${formatSequenceModSiteBaseToken(site)} Delta`,
        avgValue: formatSignedMass(site.replacementDeltaAvg, 5),
        monoValue: formatSignedMass(site.replacementDeltaMono, 5),
        description,
        final: false,
      };
    }),
    {
      term: 'Combined Site Delta',
      avgValue: formatSignedMass(context.totalReplacementDeltaAvg, 5),
      monoValue: formatSignedMass(context.totalReplacementDeltaMono, 5),
      description: 'Summed mass shift from all selected site edits.',
      final: false,
    },
    {
      term: 'Edited Full-Length Target',
      avgValue: context.fullLengthAverageMass.toFixed(2),
      monoValue: context.fullLengthMonoMass.toFixed(5),
      description: `Edited construct before initiator-methionine processing or fluorescent-protein maturation. Raw average mass: ${context.fullLengthAverageMass.toFixed(5)} Da.`,
      final: context.primaryTargetLabel === 'Edited Full-Length Target',
    },
  ];

  if (editedSequenceStartsWithMet(context)) {
    detailRows.push({
      term: 'Edited -Initiator Met Target',
      avgValue: context.metRemovedAverageMass.toFixed(2),
      monoValue: context.metRemovedMonoMass.toFixed(5),
      description: `Common N-terminal processing when the initiator methionine is removed. Delta: ${formatSignedMass(context.initiatorMetDeltaAvg, 5)} Da average / ${formatSignedMass(context.initiatorMetDeltaMono, 5)} Da mono.`,
      final: context.primaryTargetLabel === 'Edited -Initiator Met Target',
    });
  }

  if (context.maturation.applies && Number.isFinite(context.maturedAverageMass)) {
    detailRows.push({
      term: `Edited + ${context.maturation.shortLabel}`,
      avgValue: context.maturedAverageMass.toFixed(2),
      monoValue: context.maturedMonoMass.toFixed(5),
      description: `${context.maturation.description} Delta: ${formatSignedMass(context.maturation.averageDelta, 5)} Da average / ${formatSignedMass(context.maturation.monoDelta, 5)} Da mono. ${context.maturation.reason}`,
      final: context.primaryTargetLabel === `Edited + ${context.maturation.shortLabel}`,
    });
  }

  if (editedSequenceStartsWithMet(context) && context.maturation.applies && Number.isFinite(context.metRemovedMaturedAverageMass)) {
    detailRows.push({
      term: 'Edited -Initiator Met + Matured Target',
      avgValue: context.metRemovedMaturedAverageMass.toFixed(2),
      monoValue: context.metRemovedMaturedMonoMass.toFixed(5),
      description: `Combined initiator-methionine removal plus ${context.maturation.label.toLowerCase()}. This is often the most relevant processed intact-mass target for deconvolution.`,
      final: context.primaryTargetLabel === 'Edited -Initiator Met + Matured Target',
    });
  }

  let html = `<div class="sequence-mod-primary-intro">Showing the processed mass first. Expand the dropdown for site recognition, replacement details, raw full-length, methionine-processing, and intermediate maturation values.</div>`;
  html += `<details class="sequence-mod-details"><summary>Show full mass breakdown</summary>`;
  html += `<div class="data-table-wrapper"><table class="data-table sequence-mod-primary-table">
    <thead><tr><th>Component</th><th>Value</th><th>Description</th></tr></thead><tbody>`;
  overviewRows.forEach((row) => {
    html += `<tr${row.isPrimary ? ' class="sequence-mod-primary-row"' : ''}>
      <td>${escapeHtml(row.term)}</td>
      <td>${escapeHtml(row.value)}</td>
      <td>${escapeHtml(row.description)}</td>
    </tr>`;
  });
  html += '</tbody></table></div>';
  html += `<div class="data-table-wrapper"><table class="data-table sequence-mod-mass-table">
    <thead><tr><th>Component</th><th>Average (Da)</th><th>Monoisotopic (Da)</th><th>Description</th></tr></thead><tbody>`;
  detailRows.forEach((row) => {
    html += `<tr${row.final ? ' class="sequence-mod-final-row"' : ''}>
      <td>${escapeHtml(row.term)}</td>
      <td>${escapeHtml(row.avgValue)}</td>
      <td>${escapeHtml(row.monoValue)}</td>
      <td>${escapeHtml(row.description)}</td>
    </tr>`;
  });
  html += '</tbody></table></div></details>';

  if (context.unknownResidues.length > 0) {
    html += `<div class="sequence-mod-inline-note">Unknown residues ignored in mass calculation: ${escapeHtml(context.unknownResidues.join(', '))}</div>`;
  }
  if (context.hasAnyCustomReplacement) {
    html += `<div class="sequence-mod-inline-note">Custom replacement residue mode is active. ${escapeHtml(chemistryDescription)}</div>`;
  } else if (context.replacementMode === 'custom') {
    html += '<div class="sequence-mod-inline-note">Custom residue mode is selected. Load site-specific SMILES, drawn residues, or manual residue masses to change the selected sites.</div>';
  }
  if (context.activeSite?.smilesResult && context.activeSite.residueInsertionMessage) {
    html += `<div class="sequence-mod-inline-note">Active site ${escapeHtml(formatSequenceModSiteBaseToken(context.activeSite))}: ${escapeHtml(context.activeSite.residueInsertionMessage)}</div>`;
  }
  if (!context.maturation.applies) {
    html += `<div class="sequence-mod-inline-note">${escapeHtml(context.maturation.reason)}</div>`;
  }
  container.innerHTML = html;
}

function renderSequenceModTool(options = {}) {
  const context = getSequenceModContext();
  if (options.renderCustomEditors !== false) {
    renderSequenceModCustomEditors(context);
  } else if (context.replacementMode === 'custom') {
    const status = getSequenceModGlobalSmilesStatus(context);
    setSequenceModSmilesResult(status.message, status.tone);
  }
  renderSequenceModViewer(context);
  renderSequenceModSummary(context);
  renderSequenceModMassTable(context);

  if (!context.sequence) {
    setSequenceModStatus('Paste a sequence to start. Use * for stop codons or placeholder edit sites.', 'muted');
    return;
  }

  if (context.unknownResidues.length > 0) {
    setSequenceModStatus(`Sequence loaded with unknown residues ignored in mass calculations: ${context.unknownResidues.join(', ')}`, 'error');
    return;
  }

  const chemistryStatus = context.hasAnyCustomReplacement
    ? ' Automatic residue insertion correction is applied to each custom residue with a loaded mass.'
    : '';
  const insertionStatus = context.activeSite?.smilesResult && context.activeSite.residueInsertionMessage
    ? ` Active site ${formatSequenceModSiteBaseToken(context.activeSite)}: ${context.activeSite.residueInsertionMessage}`
    : '';
  const maturationStatus = ` ${context.maturation.reason}`;
  const selectionStatus = context.selectedSiteCount > 0
    ? ` Selected ${context.selectedSiteCount} site${context.selectedSiteCount === 1 ? '' : 's'}: ${context.selectedSiteLabel}.`
    : ' No edit sites selected yet.';
  const editStatus = context.editedSiteCount > 0
    ? ` ${context.editedSiteCount} site-specific edit${context.editedSiteCount === 1 ? '' : 's'} currently change the theoretical mass.`
    : ' No mass-changing site edits are currently loaded.';
  const replacementModeStatus = context.replacementMode === 'custom'
    ? (context.selectedSiteCount > 0
      ? ' Custom residue mode is active with one editor row per selected site.'
      : ' Custom residue mode is selected. Click residues in the viewer to create per-site editors.')
    : (context.selectedSiteCount > 0
      ? ' Standard amino-acid dropdown mode is active across the selected sites.'
      : ' Standard amino-acid dropdown mode is active, but no site is selected.');
  const status = `${context.sequence.length} sequence characters loaded.${selectionStatus}${editStatus} Terminal or internal * sites stay at 0 Da until replaced.${replacementModeStatus}${chemistryStatus}${insertionStatus}${maturationStatus}`;
  setSequenceModStatus(status, 'success');
}

async function applySequenceModSmilesMass(smilesOverride = '', targetIndex = null) {
  const context = getSequenceModContext();
  const resolvedIndex = Number.isInteger(targetIndex) ? targetIndex : context.activeIndex;
  if (!Number.isInteger(resolvedIndex) || resolvedIndex < 0) {
    toast('Select a target residue first', 'warning');
    return;
  }

  const smilesInput = document.querySelector(`.seqmod-custom-smiles-input[data-index="${resolvedIndex}"]`);
  const modDeltaInput = document.querySelector(`.seqmod-custom-mass-input[data-index="${resolvedIndex}"]`);
  const modLabelInput = document.querySelector(`.seqmod-custom-label-input[data-index="${resolvedIndex}"]`);
  const currentEntry = getSequenceModCustomEntry(resolvedIndex);
  const smiles = String(smilesOverride || smilesInput?.value || currentEntry.smiles || '').trim();
  if (!smiles) {
    toast('Enter a SMILES string for the replacement residue first', 'warning');
    return;
  }

  showLoading('Calculating replacement residue mass...');
  try {
    if (getSequenceModReplacementMode() !== 'custom') {
      setSequenceModReplacementMode('custom', { render: false });
    }
    state.sequenceModActiveIndex = resolvedIndex;
    const props = await api.computeSmiles(smiles);
    const formula = String(props.formula || '');
    const exactMass = Number(props.exact_mass);
    const averageMass = Number(props.average_mass);
    const netCharge = Number(props.net_charge || 0);
    const freeCarboxylCount = Number(props.free_carboxyl_count || 0);
    const freeAmineCount = Number(props.free_amine_count || 0);
    const residueInsertionPossible = Boolean(props.residue_insertion_possible);
    const residueInsertionMessage = String(props.residue_insertion_message || '').trim();
    if (!Number.isFinite(exactMass) || exactMass <= 0 || !Number.isFinite(averageMass) || averageMass <= 0) {
      throw new Error('Unable to calculate replacement residue mass from this SMILES');
    }

    const normalizedAverageMass = normalizeMassForFormalCharge(averageMass, netCharge);
    const normalizedExactMass = normalizeMassForFormalCharge(exactMass, netCharge);
    const nextLabel = (!String(currentEntry.label || '').trim() || String(currentEntry.label || '').trim() === 'Custom residue')
      ? (formula || 'SMILES residue')
      : String(currentEntry.label || '').trim();

    const nextEntry = patchSequenceModCustomEntry(resolvedIndex, {
      label: nextLabel,
      mass: normalizedAverageMass.toFixed(5),
      smiles,
      smilesResult: {
        smiles,
        formula,
        exactMass,
        averageMass,
        normalizedAverageMass,
        normalizedExactMass,
        netCharge,
        freeCarboxylCount,
        freeAmineCount,
        residueInsertionPossible,
        residueInsertionMessage,
      },
    });

    if (smilesInput) smilesInput.value = smiles;
    if (modDeltaInput) modDeltaInput.value = nextEntry.mass;
    if (modLabelInput) modLabelInput.value = nextEntry.label;

    renderSequenceModTool();
    const chargeNote = netCharge !== 0
      ? ` | normalized from formal charge ${netCharge > 0 ? `+${netCharge}` : String(netCharge)}`
      : '';
    const insertionNote = residueInsertionMessage ? ` | ${residueInsertionMessage}` : '';
    setSequenceModSmilesResult(
      `Active site ${(context.sequence?.[resolvedIndex] || '')}${resolvedIndex + 1}: ${formula || 'Formula n/a'} | Average ${normalizedAverageMass.toFixed(5)} Da | Monoisotopic ${normalizedExactMass.toFixed(5)} Da${chargeNote}${insertionNote}`,
      'success'
    );
    toast(`Loaded replacement residue mass ${normalizedAverageMass.toFixed(2)} Da from SMILES`, 'success');
  } catch (err) {
    patchSequenceModCustomEntry(resolvedIndex, {
      smiles,
      smilesResult: null,
    });
    renderSequenceModTool({ renderCustomEditors: false });
    syncSequenceModCustomEntryStatusElement(resolvedIndex);
    setSequenceModSmilesResult(`SMILES calculation failed: ${err.message}`, 'error');
    toast(`SMILES calculation failed: ${err.message}`, 'error');
  } finally {
    hideLoading();
  }
}

function clearSequenceModExternalModification(targetIndex = null, { render = true } = {}) {
  const context = getSequenceModContext();
  const resolvedIndex = Number.isInteger(targetIndex) ? targetIndex : context.activeIndex;
  if (!Number.isInteger(resolvedIndex) || resolvedIndex < 0) return;

  patchSequenceModCustomEntry(resolvedIndex, createSequenceModCustomEntry());
  if (render) {
    renderSequenceModTool();
  } else {
    syncSequenceModCustomEntryStatusElement(resolvedIndex);
  }
  const siteLabel = `${context.sequence?.[resolvedIndex] || ''}${resolvedIndex + 1}`;
  setSequenceModSmilesResult(`Active site ${siteLabel}. ${SEQUENCE_MOD_SMILES_HELP_TEXT}`, 'muted');
}

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
  if (normalized === 'failed') {
    return { className: 'router-status router-status-error', label: 'Failed' };
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
        : item.status === 'failed'
          ? (item.run_log_last_line || 'Run was aborted or failed')
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
    const data = await api.browse(sourcePath, { includeState: true });
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
      const data = await api.browse(resolvedWatchPath, { includeState: true });
      const dFolders = (Array.isArray(data.items) ? data.items : []).filter((item) => item.is_d_folder);
      for (const item of dFolders) {
        if (item.run_in_progress) continue;
        if (item.run_failed) continue;
        if (!item.run_complete) continue;
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
