/**
 * Main application logic for LC-MS Desktop Frontend.
 * Handles UI interactions, state management, and orchestrates API calls + chart rendering.
 */

// api and charts are loaded as global objects from their script tags

// ===== Application State =====
const state = {
  currentPath: localStorage.getItem('lcms-browse-path') || '/',
  selectedFiles: JSON.parse(localStorage.getItem('lcms-selected-files') || '[]'),
  loadedSamples: {},      // path -> sample metadata
  mzTargets: JSON.parse(localStorage.getItem('lcms-mz-targets') || '[]'),
  sortMode: 'date-desc',
  singleSampleData: null,
  progressionData: null,
  eicBatchData: null,
  eicBatchOriginalData: null,
  deconvResults: null,
  deconvDisplayComponents: [],
  deconvSamplePath: null,
  deconvTimeRange: null,
  deconvIonSelectionObjectUrl: null,
  deconvAutoRunSignature: '',
  deconvAutoRunInFlight: false,
  progressionAssignments: {},
  masscalcData: null,
  masscalcFigureUrls: { main: null, clean: null },
  batchDeconvData: null,
  batchDeconvPreviewUrls: {},
  batchDeconvAutoRunSignature: '',
  batchDeconvAutoRunInFlight: false,
  eicCollapsedSections: {},
  timeChangeMSData: null,
  browseItems: [],
  singleSketcher: null,
  singleSketcherType: '',
  singleJSMEDisabled: true,
  openChemLibPromise: null,
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

// ===== Initialization =====
document.addEventListener('DOMContentLoaded', () => {
  initSidebar();
  initTabs();
  initSettings();
  initFileBrowser();
  initSingleSample();
  initProgression();
  initEICBatch();
  initDeconvolution();
  initBatchDeconvolution();
  initTimeChangeMS();
  initMassCalc();
  initReportExport();
  restoreState();
});

// ===== Toast Notifications =====
function toast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => { el.remove(); }, 4000);
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

// ===== Sidebar =====
function initSidebar() {
  // Collapse/expand
  document.getElementById('sidebar-toggle-collapse').addEventListener('click', () => {
    document.getElementById('sidebar').classList.add('collapsed');
    document.getElementById('sidebar-expand').classList.remove('hidden');
  });

  document.getElementById('sidebar-expand').addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('collapsed');
    document.getElementById('sidebar-expand').classList.add('hidden');
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

  // m/z target management
  document.getElementById('btn-add-mz').addEventListener('click', addMzTarget);
  document.getElementById('mz-add-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addMzTarget();
  });

  renderMzTargets();

  // Expert mode toggle
  document.getElementById('expert-mode-toggle').addEventListener('change', (e) => {
    document.getElementById('expert-params').classList.toggle('hidden', !e.target.checked);
  });

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

function addMzTarget() {
  addMzTargetFromInput('mz-add-input');
}

function addMzTargetFromInput(inputRef) {
  const input = typeof inputRef === 'string' ? document.getElementById(inputRef) : inputRef;
  if (!input) return false;
  const val = parseFloat(input.value);
  if (isNaN(val) || val <= 0) {
    toast('Enter a valid m/z value', 'warning');
    return false;
  }
  if (state.mzTargets.some((mz) => Math.abs(mz - val) <= 1e-9)) {
    toast('m/z already added', 'warning');
    return false;
  }
  state.mzTargets.push(val);
  input.value = '';
  saveMzTargets();
  renderMzTargets();
  return true;
}

function removeMzTarget(val) {
  state.mzTargets = state.mzTargets.filter(v => v !== val);
  saveMzTargets();
  renderMzTargets();
}

function saveMzTargets() {
  localStorage.setItem('lcms-mz-targets', JSON.stringify(state.mzTargets));
}

function renderMzTargets() {
  const containerIds = ['mz-targets-list', 'single-mz-targets-inline', 'eic-mz-targets-inline'];
  containerIds.forEach((id) => {
    const container = document.getElementById(id);
    if (!container) return;
    container.innerHTML = '';

    if (state.mzTargets.length === 0) {
      if (id !== 'mz-targets-list') {
        container.innerHTML = '<span class="muted">No m/z targets set</span>';
      }
      return;
    }

    state.mzTargets.forEach((mz) => {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.innerHTML = `${mz.toFixed(2)} <button class="remove-tag" title="Remove">&times;</button>`;
      tag.querySelector('.remove-tag').addEventListener('click', () => removeMzTarget(mz));
      container.appendChild(tag);
    });
  });
}

// ===== File Browser =====
function initFileBrowser() {
  document.getElementById('btn-go').addEventListener('click', () => {
    const path = document.getElementById('path-input').value.trim();
    if (path) browseTo(path);
  });

  document.getElementById('path-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const path = e.target.value.trim();
      if (path) browseTo(path);
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
    state.deconvResults = null;
    state.deconvDisplayComponents = [];
    state.batchDeconvData = null;
    state.deconvAutoRunSignature = '';
    state.batchDeconvAutoRunSignature = '';
    syncProgressionAssignmentsToSelectedFiles();
    saveSelectedFiles();
    renderSelectedFiles();
    updateSampleDropdowns();
    renderReportSummary();
  });
}

async function loadVolumes() {
  const container = document.getElementById('mount-buttons');
  try {
    const data = await api.getVolumes();
    if (data.volumes && data.volumes.length > 0) {
      container.style.display = 'flex';
      container.innerHTML = '';
      data.volumes.forEach(vol => {
        const btn = document.createElement('button');
        btn.className = 'btn btn-sm mount-btn';
        btn.textContent = vol.name;
        btn.title = vol.path;
        btn.addEventListener('click', () => browseTo(vol.path));
        container.appendChild(btn);
      });
    }
  } catch (err) {
    // Volumes not available, hide the section
    container.style.display = 'none';
  }
}

async function browseTo(path, options = {}) {
  const silent = !!options.silent;
  const throwOnError = !!options.throwOnError;
  try {
    const data = await api.browse(path);
    state.currentPath = data.path;
    state.browseItems = data.items || [];
    document.getElementById('path-input').value = data.path;
    localStorage.setItem('lcms-browse-path', data.path);
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
  let items = [...state.browseItems];

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
      const isSelected = state.selectedFiles.some(f => f.path === item.path);
      el.innerHTML = `
        <input type="checkbox" class="d-folder-check" data-path="${escapeAttr(item.path)}" data-name="${escapeAttr(item.name)}" ${isSelected ? 'checked' : ''}>
        <span class="file-icon d-folder">&#9670;</span>
        <span class="file-name" title="${escapeAttr(item.path)}">${escapeHtml(item.name)}</span>
      `;
      const checkbox = el.querySelector('.d-folder-check');
      checkbox.addEventListener('change', (e) => {
        if (e.target.checked) {
          selectFile({ name: item.name, path: item.path });
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
  switch (mode) {
    case 'name-asc':
      sorted.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case 'name-desc':
      sorted.sort((a, b) => b.name.localeCompare(a.name));
      break;
    case 'date-asc':
      sorted.sort((a, b) => (a.modified || 0) - (b.modified || 0));
      break;
    case 'date-desc':
    default:
      sorted.sort((a, b) => (b.modified || 0) - (a.modified || 0));
      break;
  }
  return sorted;
}

function selectFile(file) {
  if (!state.selectedFiles.some(f => f.path === file.path)) {
    state.selectedFiles.push(file);
    state.deconvAutoRunSignature = '';
    state.batchDeconvAutoRunSignature = '';
    syncProgressionAssignmentsToSelectedFiles();
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
  syncProgressionAssignmentsToSelectedFiles();
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

async function loadSampleMeta(path) {
  try {
    const meta = await api.loadSample(path);
    state.loadedSamples[path] = meta;
    updateWavelengthCheckboxes();
    toast(`Loaded: ${meta.name || path.split('/').pop()}`, 'success');
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
}

// ===== Single Sample Tab =====
function initSingleSample() {
  document.getElementById('btn-load-single').addEventListener('click', loadSingleSample);
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

async function getOpenChemLib() {
  if (!state.openChemLibPromise) {
    const globalObj = typeof window !== 'undefined' ? window : globalThis;
    const hadOwnProcess = Object.prototype.hasOwnProperty.call(globalObj, 'process');
    const previousProcess = globalObj.process;
    const restoreProcess = () => {
      try {
        if (hadOwnProcess) globalObj.process = previousProcess;
        else delete globalObj.process;
      } catch (_) {
        // Ignore non-writable globals.
      }
    };

    try {
      globalObj.process = undefined;
    } catch (_) {
      // Ignore non-writable globals.
    }

    state.openChemLibPromise = import('../../node_modules/openchemlib/dist/openchemlib.js')
      .then((mod) => mod.default || mod)
      .catch((err) => {
        state.openChemLibPromise = null;
        throw err;
      })
      .finally(() => {
        restoreProcess();
      });
  }
  return state.openChemLibPromise;
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

async function computeSmilesMz(smiles, adductKey) {
  const OCL = await getOpenChemLib();
  let mol;
  try {
    mol = OCL.Molecule.fromSmiles(smiles);
  } catch (_) {
    throw new Error('Invalid SMILES syntax');
  }

  if (!mol) throw new Error('Could not parse SMILES');
  const mf = mol.getMolecularFormula();
  const formula = String(mf.formula || '');
  const exactMass = Number(mf.absoluteWeight);
  if (!Number.isFinite(exactMass) || exactMass <= 0) {
    throw new Error('Unable to calculate molecular mass from this SMILES');
  }

  let netCharge = 0;
  const atomCount = Number(mol.getAllAtoms?.()) || 0;
  for (let i = 0; i < atomCount; i++) {
    netCharge += Number(mol.getAtomCharge?.(i)) || 0;
  }

  let mz;
  let modeLabel;
  if (adductKey === 'auto') {
    if (netCharge !== 0) {
      mz = exactMass / Math.abs(netCharge);
      modeLabel = `Intrinsic charge z=${netCharge > 0 ? `+${netCharge}` : String(netCharge)}`;
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
    mz = (exactMass + Number(adduct.delta || 0)) / denom;
    modeLabel = adductKey;
  }

  if (!Number.isFinite(mz) || mz <= 0) {
    throw new Error('Calculated m/z is invalid');
  }

  return { formula, exactMass, mz, adductKey: modeLabel, netCharge };
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
    const added = addMzTargetFromInput(mzInput);
    setSingleSmilesResult(
      `${result.formula || 'Formula n/a'} | Exact mass ${result.exactMass.toFixed(5)} Da | ${result.adductKey}: m/z ${result.mz.toFixed(4)}`,
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

async function waitForJSME(timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (window.JSApplet && window.JSApplet.JSME) return;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error('JSME editor did not finish loading');
}

async function ensureSingleSketcher() {
  if (state.singleSketcher) return state.singleSketcher;

  const host = document.getElementById('single-sketcher-canvas');
  if (!host) throw new Error('Sketcher container is missing');
  host.innerHTML = '';

  if (!state.singleJSMEDisabled) {
    try {
      await waitForJSME(2000);
      const widthPx = Math.max(380, host.clientWidth || 760);
      state.singleSketcher = new window.JSApplet.JSME(
        'single-sketcher-canvas',
        `${widthPx}px`,
        '320px',
        'query,hydrogens'
      );
      state.singleSketcherType = 'jsme';
      return state.singleSketcher;
    } catch (_) {
      state.singleJSMEDisabled = true;
    }
  }

  const OCL = await getOpenChemLib();
  state.singleSketcher = new OCL.CanvasEditor(host, {
    initialMode: 'molecule',
    initialFragment: false,
    readOnly: false,
  });
  state.singleSketcherType = 'ocl';
  setSingleSmilesResult('Using built-in molecule drawer fallback (OpenChemLib editor).', 'muted');
  return state.singleSketcher;
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
  showLoading('Loading molecule drawer...');
  try {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await ensureSingleSketcher();
  } catch (err) {
    wrap.classList.add('hidden');
    btn.textContent = 'Draw Molecule';
    toast(`Molecule drawer failed: ${err.message}`, 'error');
  } finally {
    hideLoading();
  }
}

async function useDrawnStructureAsSmiles() {
  try {
    const sketcher = await ensureSingleSketcher();
    let smiles = '';
    if (state.singleSketcherType === 'jsme') {
      smiles = typeof sketcher.smiles === 'function' ? String(sketcher.smiles() || '').trim() : '';
    } else {
      const mol = typeof sketcher.getMolecule === 'function' ? sketcher.getMolecule() : null;
      if (mol && typeof mol.toSmiles === 'function') {
        smiles = String(mol.toSmiles() || '').trim();
      }
    }
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

async function loadSingleSample() {
  const samplePath = document.getElementById('single-sample-select').value;
  if (!samplePath) {
    toast('Select a sample first', 'warning');
    return;
  }

  const wavelengths = getSelectedWavelengths();
  const ionMode = document.querySelector('input[name="ion-mode"]:checked').value;
  const uvSmoothing = parseInt(document.getElementById('uv-smoothing').value);
  const eicSmoothing = parseInt(document.getElementById('eic-smoothing').value);
  const mzWindow = parseFloat(document.getElementById('mz-window').value);

  showLoading('Analyzing sample...');
  try {
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
    hideLoading();
  }
}

function renderSingleSample(data) {
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

  // TIC plot
  const ticContainer = document.getElementById('single-tic-plot');
  ticContainer.innerHTML = '';
  if (data.tic && data.tic.times && data.tic.times.length > 0) {
    const ticTitle = document.getElementById('label-tic-panel');
    ticContainer.id = 'single-tic-plot';
    charts.plotTIC('single-tic-plot', data.tic, (ticTitle && ticTitle.value) || 'Total Ion Chromatogram');
  } else {
    ticContainer.innerHTML = '<p class="placeholder-msg">No MS data available</p>';
  }

  // EIC plots
  const eicContainer = document.getElementById('single-eic-plots');
  eicContainer.innerHTML = '';
  if (data.eic && data.eic.targets && data.eic.targets.length > 0) {
    // Combined EIC
    const combinedDiv = document.createElement('div');
    combinedDiv.className = 'plot-container';
    combinedDiv.id = 'eic-combined-single';
    eicContainer.appendChild(combinedDiv);
    charts.plotEIC('eic-combined-single', data.eic.targets, 'Extracted Ion Chromatograms');

    // Individual EICs
    data.eic.targets.forEach((t, i) => {
      const div = document.createElement('div');
      div.className = 'plot-container';
      div.id = `eic-single-${i}`;
      eicContainer.appendChild(div);
      charts.plotEIC(`eic-single-${i}`, [t], `EIC m/z ${t.mz.toFixed(2)}`);
    });
  } else if (state.mzTargets.length === 0) {
    eicContainer.innerHTML = '<p class="placeholder-msg">Add target m/z values in Settings to view EIC plots</p>';
  } else {
    eicContainer.innerHTML = '<p class="placeholder-msg">No EIC data available</p>';
  }
}

async function exportSingle(format) {
  if (!state.singleSampleData) {
    toast('Load a sample first', 'warning');
    return;
  }
  await exportAllPlots('tab-single', 'single_sample', format);
}

/** Export all Plotly plots in a tab container as images. */
async function exportAllPlots(containerId, filenameBase, format) {
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
      await exportPlotsAsPDF(plotDivs, filenameBase, scale);
      toast(`Exported ${plotDivs.length} plot(s) as PDF`, 'success');
      return;
    }

    for (let i = 0; i < plotDivs.length; i++) {
      const div = plotDivs[i];
      const suffix = plotDivs.length > 1 ? `_${i + 1}` : '';
      const filename = `${filenameBase}${suffix}.${format}`;
      const dims = getExportDimensions(div, scale);
      const imageDataUrl = await buildExportImage(
        div,
        format,
        dims.width,
        dims.height
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

async function exportPlotsAsPDF(plotDivs, filenameBase, scale) {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    throw new Error('PDF library not loaded');
  }

  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({
    orientation: 'landscape',
    unit: 'pt',
    format: 'a4',
    compress: true,
  });

  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 24;
  const contentWidth = pageWidth - margin * 2;
  const contentHeight = pageHeight - margin * 2;

  for (let i = 0; i < plotDivs.length; i++) {
    const div = plotDivs[i];
    const dims = getExportDimensions(div, scale);
    const dataUrl = await buildExportImage(
      div,
      'png',
      dims.width,
      dims.height
    );

    if (i > 0) pdf.addPage();
    pdf.addImage(dataUrl, 'PNG', margin, margin, contentWidth, contentHeight, undefined, 'FAST');
  }

  pdf.save(`${filenameBase}.pdf`);
}

function getExportDimensions(plotDiv, scale) {
  const figWidthIn = parseFloat(document.getElementById('fig-width')?.value) || 6;
  const width = Math.max(600, Math.round(figWidthIn * 96 * scale));
  const layoutHeight = Number(plotDiv?.layout?.height);
  const baseHeight = Number.isFinite(layoutHeight) && layoutHeight > 0
    ? layoutHeight
    : (plotDiv?.offsetHeight || 320);
  const height = Math.max(320, Math.round(baseHeight * scale));
  return { width, height };
}

function applyWebappExportStyle(layout) {
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

  if (Array.isArray(styled.annotations)) {
    styled.annotations = styled.annotations.map((ann) => ({
      ...ann,
      font: { ...(ann.font || {}), color: '#000000' },
      arrowcolor: ann.arrowcolor || '#000000',
    }));
  }

  return styled;
}

async function buildExportImage(plotDiv, format, width, height) {
  const temp = document.createElement('div');
  temp.style.position = 'fixed';
  temp.style.left = '-10000px';
  temp.style.top = '-10000px';
  temp.style.width = `${width}px`;
  temp.style.height = `${height}px`;
  document.body.appendChild(temp);

  try {
    await Plotly.newPlot(
      temp,
      JSON.parse(JSON.stringify(plotDiv.data || [])),
      applyWebappExportStyle(plotDiv.layout || {}),
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
  const [header, data] = dataUrl.split(',');
  const mimeMatch = header.match(/data:(.*?);base64/);
  const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
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

function syncProgressionAssignmentsToSelectedFiles() {
  const next = {};
  state.selectedFiles.forEach((file, i) => {
    const existing = state.progressionAssignments[file.path] || {};
    next[file.path] = {
      role: existing.role || getDefaultProgressionRole(i, state.selectedFiles.length),
      label: existing.label || file.name,
      color: existing.color || NPG_COLOR_PALETTE[i % NPG_COLOR_PALETTE.length],
    };
  });
  state.progressionAssignments = next;
}

function readProgressionAssignmentsFromDOM() {
  document.querySelectorAll('.prog-role').forEach((el) => {
    const path = el.dataset.path;
    if (!path) return;
    const item = state.progressionAssignments[path] || {};
    item.role = el.value || item.role || 'mid';
    state.progressionAssignments[path] = item;
  });

  document.querySelectorAll('.prog-label').forEach((el) => {
    const path = el.dataset.path;
    if (!path) return;
    const item = state.progressionAssignments[path] || {};
    item.label = (el.value || '').trim() || path.split('/').pop() || 'Sample';
    state.progressionAssignments[path] = item;
  });

  document.querySelectorAll('.prog-color').forEach((el) => {
    const path = el.dataset.path;
    if (!path) return;
    const item = state.progressionAssignments[path] || {};
    item.color = el.value || item.color || '#808080';
    state.progressionAssignments[path] = item;
  });
}

function getProgressionSamples() {
  return state.selectedFiles.map((file, i) => {
    const assignment = state.progressionAssignments[file.path] || {};
    return {
      path: file.path,
      role: assignment.role || getDefaultProgressionRole(i, state.selectedFiles.length),
      label: (assignment.label || '').trim() || file.name,
      color: assignment.color || NPG_COLOR_PALETTE[i % NPG_COLOR_PALETTE.length],
    };
  });
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
    container.innerHTML = '<p class="placeholder-msg">Select at least 2 samples to use Time Progression</p>';
    return;
  }

  syncProgressionAssignmentsToSelectedFiles();

  state.selectedFiles.forEach((file, i) => {
    const card = document.createElement('div');
    card.className = 'assignment-card';
    const assignment = state.progressionAssignments[file.path] || {};
    const defaultRole = assignment.role || getDefaultProgressionRole(i, state.selectedFiles.length);
    const defaultLabel = (assignment.label || file.name || '').trim() || file.name;
    const defaultColor = assignment.color || NPG_COLOR_PALETTE[i % NPG_COLOR_PALETTE.length];

    card.innerHTML = `
      <h4 title="${escapeAttr(file.path)}">${escapeHtml(file.name)}</h4>
      <label>Role</label>
      <select class="prog-role" data-path="${escapeAttr(file.path)}">
        <option value="initial" ${defaultRole === 'initial' ? 'selected' : ''}>Initial (t=0)</option>
        <option value="mid" ${defaultRole === 'mid' ? 'selected' : ''}>Mid Timepoint</option>
        <option value="final" ${defaultRole === 'final' ? 'selected' : ''}>Overnight / Final</option>
      </select>
      <label>Custom Label</label>
      <div class="prog-label-row">
        <input type="text" class="prog-label" data-path="${escapeAttr(file.path)}" placeholder="${escapeAttr(file.name)}" value="${escapeAttr(defaultLabel)}">
        <input type="color" class="prog-color" data-path="${escapeAttr(file.path)}" value="${escapeAttr(defaultColor)}" title="Sample color">
      </div>
    `;
    container.appendChild(card);
  });

  container.querySelectorAll('.prog-role, .prog-label, .prog-color').forEach((el) => {
    el.addEventListener('change', readProgressionAssignmentsFromDOM);
    if (el.classList.contains('prog-label')) {
      el.addEventListener('input', readProgressionAssignmentsFromDOM);
    }
  });
}

async function loadProgression() {
  if (state.selectedFiles.length < 2) {
    toast('Select at least 2 samples', 'warning');
    return;
  }
  const assignmentsContainer = document.getElementById('progression-assignments');
  if (assignmentsContainer && assignmentsContainer.querySelectorAll('.prog-role').length === 0) {
    renderProgressionAssignments();
  }
  readProgressionAssignmentsFromDOM();
  const samples = getProgressionSamples();

  const wavelengths = getSelectedWavelengths();
  const uvSmoothing = parseInt(document.getElementById('uv-smoothing').value);
  const eicSmoothing = parseInt(document.getElementById('eic-smoothing').value);
  const mzWindow = parseFloat(document.getElementById('mz-window').value);

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
      for (const mz of state.mzTargets) {
        try {
          const eic = await api.getEIC(s.path, mz, mzWindow, eicSmoothing);
          result.eics.push({ mz, ...eic });
        } catch { result.eics.push({ mz, times: [], intensities: [] }); }
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
      data.eic_progressions = state.mzTargets.map((mz, mi) => ({
        mz,
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
    hideLoading();
  }
}

function renderProgression(data, samples) {
  const container = document.getElementById('progression-plots');
  container.innerHTML = '';

  const colors = {
    initial: document.getElementById('color-initial').value,
    mid: document.getElementById('color-mid').value,
    final: document.getElementById('color-final').value,
  };

  const progTitle = document.getElementById('label-prog-title');
  const baseTitle = (progTitle && progTitle.value) || 'Time Progression';

  // UV progression
  if (data.uv_progression) {
    const div = document.createElement('div');
    div.className = 'plot-container';
    div.id = 'prog-uv-plot';
    container.appendChild(div);

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
    });
  }

  // TIC progression
  if (data.tic_progression) {
    const div = document.createElement('div');
    div.className = 'plot-container';
    div.id = 'prog-tic-plot';
    container.appendChild(div);

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
    });
  }

  // EIC progressions
  if (data.eic_progressions) {
    data.eic_progressions.forEach((eicGroup, gi) => {
      const div = document.createElement('div');
      div.className = 'plot-container';
      div.id = `prog-eic-plot-${gi}`;
      container.appendChild(div);

      const eicSamples = eicGroup.samples.map((s, i) => ({
        times: s.times,
        intensities: s.intensities,
        label: samples[i]?.label || `Sample ${i + 1}`,
        role: samples[i]?.role || 'mid',
        color: samples[i]?.color,
      }));
      charts.plotProgression(`prog-eic-plot-${gi}`, eicSamples, colors, {
        title: `${baseTitle} - EIC m/z ${eicGroup.mz.toFixed(2)}`,
        yLabel: 'Intensity',
      });
    });
  }

  if (!data.uv_progression && !data.tic_progression && (!data.eic_progressions || data.eic_progressions.length === 0)) {
    container.innerHTML = '<p class="placeholder-msg">No progression data returned</p>';
  }
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
      ion_mode: document.querySelector('input[name="ion-mode"]:checked').value,
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
function getDeconvolutionRunSignature() {
  const samplePath = document.getElementById('deconv-sample-select')?.value || '';
  const start = parseFloat(document.getElementById('deconv-start')?.value);
  const end = parseFloat(document.getElementById('deconv-end')?.value);
  const expert = document.getElementById('expert-mode-toggle')?.checked === true;
  const minCharge = parseInt(document.getElementById('dp-min-charge')?.value, 10) || 1;
  const maxCharge = parseInt(document.getElementById('dp-max-charge')?.value, 10) || 50;
  if (!samplePath || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return '';
  return [
    samplePath,
    start.toFixed(4),
    end.toFixed(4),
    expert ? 'expert' : 'basic',
    String(minCharge),
    String(maxCharge),
  ].join('|');
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
  document.querySelectorAll('.btn-export-ion-selection').forEach((btn) => {
    btn.addEventListener('click', () => exportDeconvIonSelection(btn.dataset.format));
  });

  // Auto-detect window when sample is selected
  const select = document.getElementById('deconv-sample-select');
  if (select) {
    select.addEventListener('change', async () => {
      if (select.value) {
        await autoRunDeconvolutionOnTabOpen();
      }
    });
  }
}

async function refreshDeconvWindowContext(samplePath = null) {
  const path = samplePath || document.getElementById('deconv-sample-select').value;
  const uvDiv = document.getElementById('deconv-uv-plot');
  const ticDiv = document.getElementById('deconv-tic-plot');

  if (!path) {
    uvDiv.innerHTML = '<p class="placeholder-msg">Select a sample to preview UV window</p>';
    ticDiv.innerHTML = '<p class="placeholder-msg">Select a sample to preview TIC window</p>';
    return;
  }

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
      windowColor: 'rgba(255, 215, 0, 0.25)',
    });
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
      windowColor: 'rgba(255, 215, 0, 0.25)',
    });
  } catch (_) {
    ticDiv.innerHTML = '<p class="placeholder-msg">No TIC data available for this sample</p>';
  }
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

async function runDeconvolution() {
  const samplePath = document.getElementById('deconv-sample-select').value;
  if (!samplePath) {
    toast('Select a sample first', 'warning');
    return;
  }

  const params = {
    path: samplePath,
    start_time: parseFloat(document.getElementById('deconv-start').value),
    end_time: parseFloat(document.getElementById('deconv-end').value),
    ion_mode: document.querySelector('input[name="ion-mode"]:checked').value,
  };

  // Expert parameters
  if (document.getElementById('expert-mode-toggle').checked) {
    params.min_charge = parseInt(document.getElementById('dp-min-charge').value);
    params.max_charge = parseInt(document.getElementById('dp-max-charge').value);
    params.mw_agreement = parseFloat(document.getElementById('dp-mw-agree').value);
    params.contig_min = parseInt(document.getElementById('dp-contig-min').value);
    params.abundance_cutoff = parseFloat(document.getElementById('dp-abundance').value);
    params.r2_cutoff = parseFloat(document.getElementById('dp-r2').value);
    params.fwhm = parseFloat(document.getElementById('dp-fwhm').value);
    params.monoisotopic = document.getElementById('dp-monoisotopic').checked;

    const massLow = document.getElementById('dp-mass-low').value;
    const massHigh = document.getElementById('dp-mass-high').value;
    const noise = document.getElementById('dp-noise').value;
    if (massLow) params.mass_range_low = parseFloat(massLow);
    if (massHigh) params.mass_range_high = parseFloat(massHigh);
    if (noise) params.noise_cutoff = parseFloat(noise);
  }

  showLoading('Running deconvolution...');
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
    toast('Deconvolution complete', 'success');
  } catch (err) {
    const msg = typeof err === 'object' ? (err.message || JSON.stringify(err)) : String(err);
    toast(`Deconvolution failed: ${msg}`, 'error');
  } finally {
    hideLoading();
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
  const top = components[0];
  const observedIons = Array.isArray(top.ion_mzs) ? top.ion_mzs.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0) : [];

  const snapTolerance = 1.5;
  const guides = [];
  const used = new Set();
  const snapToSpectrum = (targetMz) => {
    let bestIdx = 0;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (let i = 0; i < mzValues.length; i++) {
      const diff = Math.abs(Number(mzValues[i]) - targetMz);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }
    if (bestDiff <= snapTolerance && !used.has(bestIdx)) {
      guides.push(Number(mzValues[bestIdx]));
      used.add(bestIdx);
      return true;
    }
    return false;
  };

  if (observedIons.length > 0) {
    observedIons.forEach((mz) => { snapToSpectrum(mz); });
    return guides;
  }

  const charges = Array.isArray(top.charge_states) ? top.charge_states : [];
  const mass = Number(top.mass || 0);
  if (!(mass > 0) || charges.length === 0) return [];

  const proton = 1.00784;
  charges.forEach((zRaw) => {
    const z = Number(zRaw);
    if (!(z > 0)) return;
    const theoMz = (mass + (z * proton)) / z;
    snapToSpectrum(theoMz);
  });

  return guides;
}

function renderDeconvResults(data) {
  const resultsDiv = document.getElementById('deconv-results');
  resultsDiv.classList.remove('hidden');

  const components = getDeconvDisplayComponents();

  // Mass spectrum plot with annotations from detected components
  if (data.spectrum) {
    const guideMzs = computeMassSpectrumGuideMzs(data.spectrum.mz, components);
    charts.plotMassSpectrum('deconv-spectrum-plot', data.spectrum.mz, data.spectrum.intensities, [], {
      guideMzs,
    });
  }

  // Deconvoluted masses stem plot (vertical lines like Streamlit)
  if (components.length > 0) {
    charts.plotDeconvMasses('deconv-mass-plot', components);
  } else {
    document.getElementById('deconv-mass-plot').innerHTML = '<p class="placeholder-msg">No masses deconvoluted</p>';
  }

  // Results table
  const tableContainer = document.getElementById('deconv-results-table-container');
  tableContainer.innerHTML = '';

  if (components.length > 0) {
    let html = `<div class="data-table-wrapper"><table class="data-table">
      <thead><tr>
        <th>#</th><th>Mass (Da)</th><th>Charges</th><th>Num Ions</th><th>R&sup2;</th><th>Intensity</th>
      </tr></thead><tbody>`;

    components.forEach((m, i) => {
      const chargeStr = m.charge_states ? m.charge_states.join(', ') : (m.ion_charges ? m.ion_charges.join(', ') : '-');
      html += `<tr class="deconv-row" data-idx="${i}" style="cursor:pointer;">
        <td>${i + 1}</td>
        <td>${m.mass.toFixed(1)}</td>
        <td style="font-family:var(--font);max-width:150px;overflow:hidden;text-overflow:ellipsis;">${chargeStr}</td>
        <td>${m.peaks_found || m.num_charges || '-'}</td>
        <td>${m.r2 != null ? m.r2.toFixed(4) : '-'}</td>
        <td>${m.intensity != null ? m.intensity.toExponential(2) : '-'}</td>
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
    charts.plotIonSelectionInteractive('deconv-ion-selection-plot', mz, intensities, components, {
      title: 'Ion Selection per Component',
    });
  } catch (err) {
    container.classList.remove('interactive-ion-selection');
    container.classList.remove('has-image');
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
    const blob = await response.blob();
    downloadBlob(blob, `${sanitizeFilename(sampleName)}_ion_selection.${format}`);
    toast(`Exported ${format.toUpperCase()} (ion selection)`, 'success');
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
  card.innerHTML = `<h4>Ion Detail: ${component.mass.toFixed(1)} Da</h4>
    <div id="ion-detail-plot" style="min-height:280px;"></div>`;
  container.appendChild(card);

  const charges = component.ion_charges || [];
  const mzs = component.ion_mzs || [];
  const intensities = component.ion_intensities || [];

  if (charges.length > 0) {
    charts.plotIonDetail('ion-detail-plot', component);
  }

  // Also show a small table of ions
  if (charges.length > 0) {
    const PROTON = 1.00784;
    let html = `<div class="data-table-wrapper" style="margin-top:10px;"><table class="data-table">
      <thead><tr><th>z</th><th>m/z Theoretical</th><th>m/z Observed</th><th>Intensity</th><th>&Delta; ppm</th></tr></thead><tbody>`;

    charges.forEach((z, i) => {
      const mzObs = mzs[i] || 0;
      const mzTheo = (component.mass + z * PROTON) / z;
      const int_ = intensities[i] || 0;
      const ppm = mzTheo > 0 ? (Math.abs(mzObs - mzTheo) / mzTheo * 1e6).toFixed(1) : '-';
      html += `<tr>
        <td>${z}</td>
        <td>${mzTheo.toFixed(4)}</td>
        <td>${mzObs.toFixed(4)}</td>
        <td>${int_.toExponential(2)}</td>
        <td>${ppm}</td>
      </tr>`;
    });

    html += '</tbody></table></div>';
    card.insertAdjacentHTML('beforeend', html);
  }
}

// ===== Batch Deconvolution Tab =====
function getBatchDeconvRunSignature() {
  if (!Array.isArray(state.selectedFiles) || state.selectedFiles.length < 2) return '';
  const fallbackStart = parseFloat(document.getElementById('deconv-start')?.value);
  const fallbackEnd = parseFloat(document.getElementById('deconv-end')?.value);
  const sampleSig = state.selectedFiles.map((f) => f.path).join('||');
  const startSig = Number.isFinite(fallbackStart) ? fallbackStart.toFixed(4) : 'na';
  const endSig = Number.isFinite(fallbackEnd) ? fallbackEnd.toFixed(4) : 'na';
  return `${sampleSig}|${startSig}|${endSig}`;
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

async function exportPlotById(plotId, filenameBase, format) {
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
      await exportPlotsAsPDF([div], filenameBase, scale);
    } else {
      const dims = getExportDimensions(div, scale);
      const imageDataUrl = await buildExportImage(div, format, dims.width, dims.height);
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
  return response.blob();
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
    const blob = await response.blob();
    const fileBase = `${sanitizeFilename(sample.name)}_batch_deconvoluted_masses`;
    downloadBlob(blob, `${fileBase}.${format}`);
    toast(`Exported ${format.toUpperCase()}`, 'success');
  } catch (err) {
    const fileBase = `${sanitizeFilename(sample.name)}_batch_deconvoluted_masses`;
    const didFallback = await fallbackBatchDeconvExport(plotId, fileBase, format, dpi);
    if (didFallback) {
      toast(`Exported ${format.toUpperCase()} (frontend fallback)`, 'success');
    } else {
      toast(`Export failed: ${err.message}`, 'error');
    }
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
        const data = await api.runDeconvolution({
          path: file.path,
          start_time: start,
          end_time: end,
        });
        const components = (data.components || []).slice().sort((a, b) => (b.intensity || 0) - (a.intensity || 0));
        results.push({
          name: file.name,
          path: file.path,
          start,
          end,
          status: 'ok',
          error: '',
          components,
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

  const samples = data.samples || [];
  const okCount = samples.filter(s => s.status === 'ok').length;
  const totalComponents = samples.reduce((acc, s) => acc + ((s.components || []).length), 0);
  summary.innerHTML = `
    <div class="metric"><span class="dot blue"></span> Samples: ${samples.length}</div>
    <div class="metric"><span class="dot green"></span> Successful: ${okCount}</div>
    <div class="metric"><span class="dot ${okCount === samples.length ? 'green' : 'red'}"></span> Failed: ${samples.length - okCount}</div>
    <div class="metric"><span class="dot blue"></span> Total Components: ${totalComponents}</div>
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

    const components = (sample.components || []).slice(0, topN);
    if (components.length === 0) {
      section.insertAdjacentHTML('beforeend', '<p class="placeholder-msg" style="padding:16px 10px;">No masses detected for this sample.</p>');
      samplesContainer.appendChild(section);
      return;
    }

    const plotId = `batch-deconv-sample-plot-${idx}`;
    const previewId = `batch-deconv-export-preview-${idx}`;
    section.insertAdjacentHTML('beforeend', `
      <div class="batch-deconv-sample-layout">
        <div class="batch-deconv-interactive">
          <div id="${plotId}" class="batch-deconv-interactive-plot"></div>
        </div>
        <div class="batch-deconv-preview-wrap">
          <div id="${previewId}" class="batch-deconv-preview">
            <p class="muted" style="padding:10px 0;">Rendering export preview...</p>
          </div>
        </div>
      </div>
    `);
    section.insertAdjacentHTML('beforeend', `
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">
        <button class="btn btn-sm" data-format="png">Download PNG</button>
        <button class="btn btn-sm" data-format="svg">Download SVG</button>
        <button class="btn btn-sm" data-format="pdf">Download PDF</button>
      </div>
    `);

    samplesContainer.appendChild(section);
    charts.plotDeconvMasses(plotId, components, { height: 320, hideGrid: true });
    renderBatchDeconvExportPreview(sample, components, previewId);

    section.querySelectorAll('button[data-format]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await exportBatchDeconvWebappStyle(sample, components, btn.dataset.format, plotId);
      });
    });
  });

  let html = `<div class="data-table-wrapper"><table class="data-table">
    <thead><tr>
      <th>Sample</th><th>Status</th><th>Window (min)</th><th>Components</th><th>Top Masses (Da)</th><th>Error</th>
    </tr></thead><tbody>`;

  samples.forEach((sample) => {
    const windowStr = `${Number.isFinite(sample.start) ? sample.start.toFixed(2) : '-'} - ${Number.isFinite(sample.end) ? sample.end.toFixed(2) : '-'}`;
    const topMasses = (sample.components || []).slice(0, topN).map(c => c.mass.toFixed(1)).join(', ') || '-';
    html += `<tr>
      <td>${escapeHtml(sample.name)}</td>
      <td>${sample.status}</td>
      <td>${windowStr}</td>
      <td>${(sample.components || []).length}</td>
      <td>${topMasses}</td>
      <td>${escapeHtml(sample.error || '')}</td>
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
  const deconvData = await api.runDeconvolution({
    path: samplePath,
    start_time: auto.start,
    end_time: auto.end,
  });

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
  return response.blob();
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
  syncProgressionAssignmentsToSelectedFiles();
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

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
