/**
 * Chart rendering module using Plotly.js.
 * Provides chart configurations aligned with LC-MS webapp styling.
 * Exposed as global `charts` object.
 */

const COLOR_CYCLE = [
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728',
  '#9467bd', '#8c564b', '#e377c2', '#7f7f7f',
  '#bcbd22', '#17becf',
];

// Keep a component's identity consistent across all on-screen deconvolution plots.
const DECONV_COLORS = [
  '#2ca02c', '#1f77b4', '#ff7f0e', '#d62728', '#9467bd',
  '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf',
];
function getDeconvColor(index) { return DECONV_COLORS[index % DECONV_COLORS.length]; }

const WEBAPP_LAYOUT = {
  autosize: true,
  paper_bgcolor: '#ffffff',
  plot_bgcolor: '#ffffff',
  font: { color: '#000000', family: 'Arial, Liberation Sans, DejaVu Sans, sans-serif', size: 9 },
  margin: { l: 60, r: 20, t: 40, b: 50 },
  xaxis: { gridcolor: 'rgba(0,0,0,0.3)', zeroline: false, color: '#000000', linecolor: '#000000', mirror: false, showline: true, automargin: true },
  yaxis: { gridcolor: 'rgba(0,0,0,0.3)', zeroline: false, color: '#000000', linecolor: '#000000', mirror: false, showline: true, exponentformat: 'e', showexponent: 'all', automargin: true },
  legend: { bgcolor: 'rgba(0,0,0,0)', borderwidth: 0, font: { color: '#000000', size: 8 } },
  hoverlabel: { bgcolor: '#ffffff', bordercolor: '#999999', font: { color: '#000000', size: 9 } },
  modebar: { bgcolor: 'rgba(255,255,255,0.9)', color: '#444444', activecolor: '#1f77b4' },
};

const PLOT_CONFIG = { responsive: true, displaylogo: false, modeBarButtonsToRemove: ['lasso2d', 'select2d'] };

/** Read container height or use fallback. Plotly autosize can't read height before browser reflow. */
function getContainerHeight(divId, fallback) {
  const el = document.getElementById(divId);
  const fixedHeight = Number(el?.dataset?.fixedPlotHeight || 0);
  if (Number.isFinite(fixedHeight) && fixedHeight > 50) return Math.floor(fixedHeight);
  const layoutHeight = Number(el?.layout?.height || el?._fullLayout?.height || 0);
  if (Number.isFinite(layoutHeight) && layoutHeight > 50) return Math.floor(layoutHeight);
  return fallback;
}

function applyExplicitPlotHeight(divId, heightPx) {
  const el = document.getElementById(divId);
  const explicit = Number(heightPx);
  if (!el || !Number.isFinite(explicit) || explicit <= 0) return;
  el.style.height = `${explicit}px`;
  el.style.minHeight = `${explicit}px`;
  el.dataset.fixedPlotHeight = String(explicit);
}

function getColor(index) { return COLOR_CYCLE[index % COLOR_CYCLE.length]; }

function getLineWidth() {
  const s = document.getElementById('line-width');
  return s ? parseFloat(s.value) : 1.5;
}

function getXAxisLabel() {
  const i = document.getElementById('label-x-axis');
  return (i && i.value) || 'Time (min)';
}

function hexToRGBA(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function normalizeArray(arr) {
  if (!arr || arr.length === 0) return arr;
  const m = Math.max(...arr);
  return m === 0 ? arr : arr.map(v => v / m);
}

function downsamplePair(x, y, maxPoints = 8000) {
  if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length || x.length <= maxPoints) {
    return { x: x || [], y: y || [] };
  }
  const step = Math.max(1, Math.ceil(x.length / maxPoints));
  const xs = [];
  const ys = [];
  for (let i = 0; i < x.length; i += step) {
    xs.push(x[i]);
    ys.push(y[i]);
  }
  if (xs[xs.length - 1] !== x[x.length - 1]) {
    xs.push(x[x.length - 1]);
    ys.push(y[y.length - 1]);
  }
  return { x: xs, y: ys };
}

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function gaussianSmoothProfile(raw, sigmaBins) {
  const n = raw.length;
  const sigma = Number(sigmaBins);
  if (n === 0 || !Number.isFinite(sigma) || sigma <= 0) return raw;

  const radius = Math.max(1, Math.ceil(sigma * 4.0));
  const kernel = new Float64Array((radius * 2) + 1);
  let kernelSum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-0.5 * (i / sigma) ** 2);
    kernel[i + radius] = v;
    kernelSum += v;
  }
  if (kernelSum <= 0) return raw;
  for (let i = 0; i < kernel.length; i++) kernel[i] /= kernelSum;

  const smoothed = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const start = Math.max(0, i - radius);
    const end = Math.min(n - 1, i + radius);
    let total = 0;
    for (let j = start; j <= end; j++) {
      total += raw[j] * kernel[j - i + radius];
    }
    smoothed[i] = total;
  }
  return smoothed;
}

function buildDenseZeroChargeProfile(mzValues, intensityValues, options = {}) {
  const mzLength = mzValues && typeof mzValues.length === 'number' ? mzValues.length : 0;
  const intensityLength = intensityValues && typeof intensityValues.length === 'number' ? intensityValues.length : 0;
  const nInput = Math.min(mzLength, intensityLength);
  if (nInput <= 0) return { massKDa: [], relativeIntensity: [] };

  let massMin = finiteNumber(options.massMinDa, 1000.0);
  let massMax = finiteNumber(options.massMaxDa, 50000.0);
  if (massMax <= massMin) {
    massMin = 1000.0;
    massMax = 50000.0;
  }

  const mz = [];
  const intensities = [];
  for (let i = 0; i < nInput; i++) {
    const m = Number(mzValues[i]);
    const y = Number(intensityValues[i]);
    if (Number.isFinite(m) && Number.isFinite(y) && y > 0) {
      mz.push(m);
      intensities.push(y);
    }
  }
  if (mz.length === 0) return { massKDa: [], relativeIntensity: [] };

  const requestedBinDa = Math.max(0.01, finiteNumber(options.binDa, 0.1));
  const maxBins = Math.max(1000, Math.floor(finiteNumber(options.maxBins, 800000)));
  const binDa = Math.max(requestedBinDa, (massMax - massMin) / maxBins);
  const binCount = Math.max(1, Math.ceil((massMax - massMin) / binDa));
  const rawProfile = new Float64Array(binCount);

  const minCharge = Math.trunc(finiteNumber(options.minCharge, 1));
  const maxCharge = Math.trunc(finiteNumber(options.maxCharge, 50));
  const chargeLow = Math.max(1, Math.min(minCharge, maxCharge));
  const chargeHigh = Math.max(chargeLow, Math.max(minCharge, maxCharge));
  const protonMass = options.useMonoisotopic === true ? 1.007276 : 1.00784;

  for (let charge = chargeLow; charge <= chargeHigh; charge++) {
    const invCharge = 1 / charge;
    for (let i = 0; i < mz.length; i++) {
      const mass = (mz[i] - protonMass) * charge;
      if (mass < massMin || mass > massMax) continue;
      let binIndex = Math.floor((mass - massMin) / binDa);
      if (binIndex < 0) binIndex = 0;
      else if (binIndex >= binCount) binIndex = binCount - 1;
      rawProfile[binIndex] += intensities[i] * invCharge;
    }
  }

  const smoothSigmaDa = Math.max(0, finiteNumber(options.smoothSigmaDa, 2.0));
  const smoothed = gaussianSmoothProfile(rawProfile, binDa > 0 ? smoothSigmaDa / binDa : 0);
  let maxY = 0;
  for (let i = 0; i < smoothed.length; i++) {
    if (smoothed[i] > maxY) maxY = smoothed[i];
  }
  if (maxY <= 0) return { massKDa: [], relativeIntensity: [] };

  const massKDa = new Float64Array(binCount);
  const relativeIntensity = new Float64Array(binCount);
  const scale = 100 / maxY;
  for (let i = 0; i < binCount; i++) {
    massKDa[i] = (massMin + ((i + 0.5) * binDa)) / 1000.0;
    relativeIntensity[i] = smoothed[i] * scale;
  }
  return { massKDa, relativeIntensity };
}

function downsampleProfileEnvelope(xValues, yValues, maxPoints = 80000) {
  const n = xValues && typeof xValues.length === 'number' ? xValues.length : 0;
  if (n === 0 || n !== (yValues && yValues.length) || n <= maxPoints) {
    return { x: xValues || [], y: yValues || [] };
  }

  const bucketSize = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(maxPoints / 2))));
  const x = [];
  const y = [];
  let lastIndex = -1;

  const pushIndex = (idx) => {
    if (idx === lastIndex) return;
    x.push(xValues[idx]);
    y.push(yValues[idx]);
    lastIndex = idx;
  };

  pushIndex(0);
  for (let start = 0; start < n; start += bucketSize) {
    const end = Math.min(n, start + bucketSize);
    let minIdx = start;
    let maxIdx = start;
    for (let i = start + 1; i < end; i++) {
      if (yValues[i] < yValues[minIdx]) minIdx = i;
      if (yValues[i] > yValues[maxIdx]) maxIdx = i;
    }
    if (minIdx < maxIdx) {
      pushIndex(minIdx);
      pushIndex(maxIdx);
    } else {
      pushIndex(maxIdx);
      pushIndex(minIdx);
    }
  }
  pushIndex(n - 1);
  return { x, y };
}

// View-only focus: end just inside the nearest predicted wrong-charge copies.
// This predicts bands from the assigned ion ladder; it does not classify or
// remove signal, and unrelated components can still be present in the view.
function getDenseProfileFocusRange(component, fullRange = [1000, 50000]) {
  const mass = Number(component?.mass);
  if (!(mass > 0) || !Number.isFinite(mass)) return fullRange.slice();
  const charges = [...(component.charge_states || []), ...(component.ion_charges || [])]
    .map(Number).filter(z => Number.isInteger(z) && z > 0);
  let leftAlias = -Infinity, rightAlias = Infinity;
  for (const charge of new Set(charges)) {
    if (charge < 2) continue;
    // Use the measured/fitted ion centre when supplied. Otherwise predict it
    // from the component mass and assigned charge, never a hard-coded mass.
    const index = (component.ion_charges || []).findIndex(z => Number(z) === charge);
    const ionMz = index >= 0 ? Number(component.ion_mzs?.[index]) : NaN;
    const neutralPerCharge = Number.isFinite(ionMz) && ionMz > 1.00784 ? ionMz - 1.00784 : mass / charge;
    const lower = neutralPerCharge * (charge - 1), upper = neutralPerCharge * (charge + 1);
    if (lower < mass) leftAlias = Math.max(leftAlias, lower);
    if (upper > mass) rightAlias = Math.min(rightAlias, upper);
  }
  if (!Number.isFinite(leftAlias) || !Number.isFinite(rightAlias)) {
    const halfWidth = Math.max(25, mass * 0.02);
    return [Math.max(1, mass - halfWidth), mass + halfWidth];
  }
  const spread = Math.abs(finiteNumber(component.mass_std, 0));
  // A small guard before each predicted apex keeps its smoothed shoulders out
  // of view. The half-gap cap also handles unusually uncertain assignments.
  const guard = gap => Math.min(gap * 0.5, Math.max(12, gap * 0.05, spread * 4));
  return [Math.max(1, leftAlias + guard(mass - leftAlias)), rightAlias - guard(rightAlias - mass)];
}

function denseProfileVisibleMaximum(profile, rangeDa) {
  let maximum = 0;
  for (let i = 0; i < profile.massKDa.length; i++) {
    const mass = profile.massKDa[i] * 1000;
    if (mass >= rangeDa[0] && mass <= rangeDa[1]) maximum = Math.max(maximum, profile.relativeIntensity[i]);
  }
  return maximum;
}

function buildDenseProfileAnnotations(profile, rangeDa, options = {}) {
  const x = profile.massKDa || [], y = profile.relativeIntensity || [];
  if (x.length < 3 || x.length !== y.length || !(rangeDa[1] > rangeDa[0])) return [];
  const maximum = denseProfileVisibleMaximum(profile, rangeDa);
  if (!(maximum > 0)) return [];
  const width = Math.max(120, finiteNumber(options.width, 700));
  const height = Math.max(80, finiteNumber(options.height, 234));
  const yRange = options.yRange || [0, maximum * 1.3];
  const ySpan = yRange[1] - yRange[0];
  if (!(ySpan > 0)) return [];
  const binDa = (x[1] - x[0]) * 1000;
  const radius = Math.max(1, Math.ceil(8 / Math.max(0.01, binDa)));
  const candidates = [];
  for (let i = 1; i < x.length - 1; i++) {
    const mass = x[i] * 1000, intensity = y[i];
    if (mass < rangeDa[0] || mass > rangeDa[1] || intensity < maximum * 0.04 || intensity < yRange[0] || intensity > yRange[1]) continue;
    if (!(intensity > y[i - 1] && intensity >= y[i + 1])) continue;
    let left = intensity, right = intensity;
    for (let j = i - 1; j >= Math.max(0, i - radius); j--) {
      if (y[j] > intensity) break;
      left = Math.min(left, y[j]);
    }
    for (let j = i + 1; j <= Math.min(y.length - 1, i + radius); j++) {
      if (y[j] > intensity) break;
      right = Math.min(right, y[j]);
    }
    if (intensity - Math.max(left, right) < maximum * 0.02) continue;
    candidates.push({ mass, intensity, main: false });
  }
  const mainMass = Number(options.mainMass);
  const nearest = candidates.reduce((best, c) => !best || Math.abs(c.mass - mainMass) < Math.abs(best.mass - mainMass) ? c : best, null);
  if (nearest && Number.isFinite(mainMass) && Math.abs(nearest.mass - mainMass) <= Math.max(10, mainMass * 0.0005)) nearest.main = true;
  candidates.sort((a, b) => Number(b.main) - Number(a.main) || b.intensity - a.intensity);
  const annotations = [], occupied = [];
  const leadersCross = (a, b) => {
    const cross = (px, py, qx, qy, rx, ry) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
    const a1 = cross(a.px, a.py, a.cx, a.cy, b.px, b.py), a2 = cross(a.px, a.py, a.cx, a.cy, b.cx, b.cy);
    const b1 = cross(b.px, b.py, b.cx, b.cy, a.px, a.py), b2 = cross(b.px, b.py, b.cx, b.cy, a.cx, a.cy);
    return a1 * a2 < 0 && b1 * b2 < 0;
  };
  const leaderCrossesBox = (ax, ay, bx, by, box) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 3));
    for (let i = 1; i < steps; i++) {
      const px = ax + (bx - ax) * i / steps, py = ay + (by - ay) * i / steps;
      if (px > box.x0 - 2 && px < box.x1 + 2 && py > box.y0 - 2 && py < box.y1 + 2) return true;
    }
    return false;
  };
  const crossesCurve = box => {
    const firstMass = rangeDa[0] + box.x0 / width * (rangeDa[1] - rangeDa[0]);
    const lastMass = rangeDa[0] + box.x1 / width * (rangeDa[1] - rangeDa[0]);
    const start = Math.max(0, Math.floor((firstMass - x[0] * 1000) / binDa));
    const end = Math.min(x.length - 1, Math.ceil((lastMass - x[0] * 1000) / binDa));
    for (let i = start; i <= end; i++) {
      const curveY = (yRange[1] - y[i]) / ySpan * height;
      if (curveY >= box.y0 - 2 && curveY <= box.y1 + 2) return true;
    }
    return false;
  };
  for (const peak of candidates) {
    if (annotations.length >= 12) break;
    const label = `${peak.mass.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} Da`;
    const labelWidth = label.length * 5.6 + 8;
    const px = (peak.mass - rangeDa[0]) / (rangeDa[1] - rangeDa[0]) * width;
    const py = (yRange[1] - peak.intensity) / ySpan * height;
    let box = null;
    for (let lane = 0; lane < 5; lane++) {
      const cy = Math.max(8, py - 13 - lane * 18);
      for (const factor of [0, 0.65, -0.65, 1.3, -1.3, 1.95, -1.95]) {
        const shift = labelWidth * factor;
        const cx = Math.max(labelWidth / 2, Math.min(width - labelWidth / 2, px + shift));
        const candidate = { x0: cx - labelWidth / 2, x1: cx + labelWidth / 2, y0: cy - 7, y1: cy + 7, cx, cy, px, py };
        const collision = occupied.some(b =>
          (candidate.x0 < b.x1 + 4 && candidate.x1 > b.x0 - 4 && candidate.y0 < b.y1 + 3 && candidate.y1 > b.y0 - 3)
          || leaderCrossesBox(px, py, cx, cy, b) || leaderCrossesBox(b.px, b.py, b.cx, b.cy, candidate) || leadersCross(candidate, b));
        if (!collision && !crossesCurve(candidate)) { box = candidate; break; }
      }
      if (box) break;
    }
    if (!box) continue;
    occupied.push(box);
    annotations.push({
      x: peak.mass / 1000, y: peak.intensity,
      text: peak.main ? `<b>${label}</b>` : label,
      showarrow: true, arrowhead: 0, arrowwidth: 0.7, arrowcolor: '#777777',
      ax: box.cx - px, ay: box.cy - py, xanchor: 'center', yanchor: 'middle',
      font: { size: 10, color: peak.main ? '#215caf' : '#222222' },
      bgcolor: 'rgba(255,255,255,0.85)', borderpad: 1,
      hovertext: 'Profile peak position; a label is not a chemical identification.',
    });
  }
  return annotations;
}

function bindDenseProfileLabels(divId, profile, initialRangeDa, mainMass) {
  const plot = document.getElementById(divId);
  if (!plot?.on || !window.Plotly?.relayout) return;
  if (plot.__denseLabelHandler && plot.removeListener) plot.removeListener('plotly_relayout', plot.__denseLabelHandler);
  let busy = false;
  const apply = (event = {}) => {
    if (busy) return;
    const changesX = Object.keys(event).some(key => key.startsWith('xaxis.range') || key === 'xaxis.autorange');
    const changesY = Object.keys(event).some(key => key.startsWith('yaxis.range') || key === 'yaxis.autorange');
    if (Object.keys(event).length && !changesX && !changesY && !('width' in event) && !('height' in event)) return;
    const xr = event['xaxis.autorange'] ? initialRangeDa.map(v => v / 1000)
      : event['xaxis.range'] || [event['xaxis.range[0]'] ?? plot.layout?.xaxis?.range?.[0], event['xaxis.range[1]'] ?? plot.layout?.xaxis?.range?.[1]];
    const range = xr.every(Number.isFinite) ? xr.map(v => v * 1000) : initialRangeDa;
    const maximum = denseProfileVisibleMaximum(profile, range);
    const yr = (changesX && !changesY) || event['yaxis.autorange']
      ? [0, (maximum || 100) * 1.3]
      : event['yaxis.range'] || [event['yaxis.range[0]'] ?? plot.layout?.yaxis?.range?.[0] ?? 0, event['yaxis.range[1]'] ?? plot.layout?.yaxis?.range?.[1] ?? 130];
    const annotations = buildDenseProfileAnnotations(profile, range, {
      width: Math.max(120, (plot.clientWidth || 800) - 108), height: Math.max(80, (plot.clientHeight || 340) - 106), mainMass, yRange: yr,
    });
    busy = true;
    Promise.resolve(window.Plotly.relayout(plot, { annotations, 'xaxis.range': range.map(v => v / 1000), 'xaxis.autorange': false, 'yaxis.range': yr, 'yaxis.autorange': false }))
      .catch(() => {}).finally(() => { busy = false; });
  };
  plot.__denseLabelHandler = apply;
  plot.on('plotly_relayout', apply);
}

function clonePlotConfig(extra = {}) {
  const base = { ...PLOT_CONFIG };
  if (Array.isArray(PLOT_CONFIG.modeBarButtonsToRemove)) {
    base.modeBarButtonsToRemove = [...PLOT_CONFIG.modeBarButtonsToRemove];
  }
  return { ...base, ...extra };
}

function interpAt(xArr, yArr, x) {
  const n = xArr.length;
  if (n === 0) return 0;
  if (n === 1) return Number(yArr[0]) || 0;
  if (x <= xArr[0]) return Number(yArr[0]) || 0;
  if (x >= xArr[n - 1]) return Number(yArr[n - 1]) || 0;

  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xArr[mid] <= x) lo = mid;
    else hi = mid;
  }

  const x0 = Number(xArr[lo]) || 0;
  const x1 = Number(xArr[hi]) || x0;
  const y0 = Number(yArr[lo]) || 0;
  const y1 = Number(yArr[hi]) || y0;
  if (x1 === x0) return y0;
  const t = (x - x0) / (x1 - x0);
  return y0 + t * (y1 - y0);
}

function buildWindowTrace(times, intensities, start, end) {
  if (!Array.isArray(times) || !Array.isArray(intensities) || times.length !== intensities.length || times.length === 0) {
    return { x: [], y: [] };
  }
  const s = Number(start);
  const e = Number(end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) {
    return { x: [], y: [] };
  }

  const x = [];
  const y = [];
  const yStart = interpAt(times, intensities, s);
  x.push(s);
  y.push(yStart);

  for (let i = 0; i < times.length; i++) {
    const t = Number(times[i]);
    if (t > s && t < e) {
      x.push(t);
      y.push(Number(intensities[i]) || 0);
    }
  }

  const yEnd = interpAt(times, intensities, e);
  if (x.length === 1 || x[x.length - 1] !== e) {
    x.push(e);
    y.push(yEnd);
  }

  return { x, y };
}

function buildLinearWindowBaseline(times, intensities, start, end) {
  const win = buildWindowTrace(times, intensities, start, end);
  if (!Array.isArray(win.x) || win.x.length === 0) {
    return { x: [], y: [] };
  }
  const yStart = interpAt(times, intensities, start);
  const yEnd = interpAt(times, intensities, end);
  const span = Number(end) - Number(start);
  const y = win.x.map((xVal) => {
    if (!Number.isFinite(span) || Math.abs(span) < 1e-12) return yStart;
    const t = (Number(xVal) - Number(start)) / span;
    return yStart + ((yEnd - yStart) * t);
  });
  return { x: win.x, y };
}

function mergeLayout(partial = {}) {
  const merged = JSON.parse(JSON.stringify(WEBAPP_LAYOUT));
  if (partial.xaxis) { merged.xaxis = { ...merged.xaxis, ...partial.xaxis }; delete partial.xaxis; }
  if (partial.yaxis) { merged.yaxis = { ...merged.yaxis, ...partial.yaxis }; delete partial.yaxis; }
  if (partial.legend) { merged.legend = { ...merged.legend, ...partial.legend }; delete partial.legend; }
  if (partial.margin) { merged.margin = { ...merged.margin, ...partial.margin }; delete partial.margin; }
  if (partial.font) { merged.font = { ...merged.font, ...partial.font }; delete partial.font; }
  Object.assign(merged, partial);
  const showGrid = document.getElementById('show-grid');
  if (showGrid && !showGrid.checked) { merged.xaxis.showgrid = false; merged.yaxis.showgrid = false; }
  if (showGrid && showGrid.checked) { merged.xaxis.showgrid = true; merged.yaxis.showgrid = true; }
  return merged;
}

function normalizeUvInput(uvInput) {
  if (Array.isArray(uvInput)) {
    return uvInput;
  }
  if (uvInput && Array.isArray(uvInput.wavelengths)) {
    return uvInput.wavelengths;
  }
  return [];
}

function normalizeEicInput(eicInput) {
  if (Array.isArray(eicInput)) {
    return eicInput;
  }
  if (eicInput && Array.isArray(eicInput.targets)) {
    return eicInput.targets;
  }
  return [];
}

function getMassSpectrumViewRange(plotEl, mzValues, eventData = null) {
  const fallbackMin = Array.isArray(mzValues) && mzValues.length > 0 ? Number(mzValues[0]) : 0;
  const fallbackMax = Array.isArray(mzValues) && mzValues.length > 0 ? Number(mzValues[mzValues.length - 1]) : 1;
  if (eventData && typeof eventData === 'object') {
    if (eventData['xaxis.autorange']) {
      return [fallbackMin, fallbackMax > fallbackMin ? fallbackMax : fallbackMin + 1];
    }
    const eventMin = Number(eventData['xaxis.range[0]'] ?? eventData.xaxis?.range?.[0]);
    const eventMax = Number(eventData['xaxis.range[1]'] ?? eventData.xaxis?.range?.[1]);
    if (Number.isFinite(eventMin) && Number.isFinite(eventMax) && eventMax > eventMin) {
      return [eventMin, eventMax];
    }
  }
  const layoutRange = plotEl?.layout?.xaxis?.range;
  const x0 = Number(Array.isArray(layoutRange) ? layoutRange[0] : fallbackMin);
  const x1 = Number(Array.isArray(layoutRange) ? layoutRange[1] : fallbackMax);
  if (Number.isFinite(x0) && Number.isFinite(x1) && x1 > x0) return [x0, x1];
  return [fallbackMin, fallbackMax > fallbackMin ? fallbackMax : fallbackMin + 1];
}

function formatSpectrumMz(value, gridStep = null) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '?';
  // A declared 0.001 grid contains three decimal places, not raw centroid precision.
  // Suppress only multiplication noise on that known grid; never round raw values.
  if (gridStep === 0.001 && Math.abs(number - Math.round(number * 1000) / 1000) < 1e-9) return number.toFixed(3);
  return String(number);
}

function buildAdaptiveMassSpectrumAnnotations(mzValues, intensities, baseAnnotations = [], xRange = null, plotWidthPx = 800, gridStep = null) {
  if (!Array.isArray(mzValues) || !Array.isArray(intensities) || mzValues.length !== intensities.length || mzValues.length < 3) {
    return baseAnnotations;
  }

  const x0 = Number(Array.isArray(xRange) ? xRange[0] : mzValues[0]);
  const x1 = Number(Array.isArray(xRange) ? xRange[1] : mzValues[mzValues.length - 1]);
  if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 <= x0) return baseAnnotations;

  let visibleMax = 0;
  const candidates = [];
  for (let i = 1; i < mzValues.length - 1; i += 1) {
    const mz = Number(mzValues[i]);
    const y = Number(intensities[i]);
    if (!Number.isFinite(mz) || !Number.isFinite(y) || mz < x0 || mz > x1 || y <= 0) continue;
    if (y > visibleMax) visibleMax = y;
    const prev = Number(intensities[i - 1]) || 0;
    const next = Number(intensities[i + 1]) || 0;
    if (y >= prev && y >= next) {
      candidates.push({ mz, intensity: y });
    }
  }

  if (!(visibleMax > 0) || candidates.length === 0) return baseAnnotations;

  const span = x1 - x0;
  const minRelativeHeight = span > 500 ? 0.12 : span > 200 ? 0.08 : span > 80 ? 0.05 : 0.03;
  const minPixelSpacing = span > 500 ? 82 : span > 200 ? 62 : span > 80 ? 46 : 30;
  const maxLabels = Math.max(8, Math.min(48, Math.floor(Math.max(360, plotWidthPx) / minPixelSpacing)));
  const selectedPositions = (baseAnnotations || [])
    .filter(annotation => Number.isFinite(Number(annotation.x)) && Number(annotation.x) >= x0 && Number(annotation.x) <= x1)
    .map(annotation => ({px: ((Number(annotation.x) - x0) / span) * plotWidthPx, width: String(annotation.text || '').length * 5.5}));

  const adaptive = [];
  const sorted = candidates
    .filter((candidate) => candidate.intensity >= visibleMax * minRelativeHeight)
    .sort((a, b) => b.intensity - a.intensity);

  for (const candidate of sorted) {
    if (adaptive.length >= maxLabels) break;
    const px = ((candidate.mz - x0) / span) * plotWidthPx;
    const label = formatSpectrumMz(candidate.mz, gridStep), width = label.length * 5.5;
    if (selectedPositions.some(existing => Math.abs(existing.px - px) < Math.max(minPixelSpacing, (existing.width + width) / 2 + 8))) continue;
    selectedPositions.push({px,width});
    const lane = adaptive.length % 3;
    adaptive.push({
      x: candidate.mz,
      y: candidate.intensity,
      text: label,
      showarrow: false,
      xanchor: 'center',
      yanchor: 'bottom',
      yshift: 6 + (lane * 10),
      font: { size: 9, color: '#000000' },
    });
  }

  return [...baseAnnotations, ...adaptive];
}

function bindAdaptiveMassSpectrumLabels(divId, mzValues, intensities, baseAnnotations = [], gridStep = null) {
  const plot = document.getElementById(divId);
  if (!plot || typeof plot.on !== 'function' || !window.Plotly || typeof window.Plotly.relayout !== 'function') return;

  const applyAdaptiveAnnotations = (eventData = null) => {
    if (plot.__adaptiveMassSpectrumBusy) return;
    const xRange = getMassSpectrumViewRange(plot, mzValues, eventData);
    const plotWidth = Math.max(320, Math.floor(plot.clientWidth || plot.offsetWidth || 800));
    const annotations = buildAdaptiveMassSpectrumAnnotations(mzValues, intensities, baseAnnotations, xRange, plotWidth, gridStep);
    plot.__adaptiveMassSpectrumBusy = true;
    Promise.resolve(window.Plotly.relayout(plot, { annotations }))
      .catch(() => {})
      .finally(() => {
        plot.__adaptiveMassSpectrumBusy = false;
      });
  };

  const scheduleAdaptiveAnnotations = (eventData = null, delayMs = 0) => {
    if (plot.__adaptiveMassSpectrumTimer) {
      clearTimeout(plot.__adaptiveMassSpectrumTimer);
    }
    plot.__adaptiveMassSpectrumTimer = setTimeout(() => {
      plot.__adaptiveMassSpectrumTimer = null;
      applyAdaptiveAnnotations(eventData);
    }, delayMs);
  };

  if (typeof plot.removeAllListeners === 'function') {
    plot.removeAllListeners('plotly_relayout');
    plot.removeAllListeners('plotly_doubleclick');
  }

  plot.on('plotly_relayout', (eventData) => {
    if (plot.__adaptiveMassSpectrumBusy || !eventData) return;
    if (
      'xaxis.range[0]' in eventData ||
      'xaxis.range[1]' in eventData ||
      'xaxis.autorange' in eventData
    ) {
      scheduleAdaptiveAnnotations(eventData, 0);
    }
  });

  plot.on('plotly_doubleclick', () => {
    // Plotly can finish its autorange reset after the immediate relayout event.
    // Re-read the settled layout shortly after double-click completes.
    scheduleAdaptiveAnnotations(null, 40);
  });

  scheduleAdaptiveAnnotations(null, 0);
}

// ---- Chart functions ----

const charts = {
  getColor,

  plotUV(divId, uvTraces, title) {
    const wavelengths = normalizeUvInput(uvTraces);
    const traces = wavelengths.map((wl, i) => {
      const wlValue = Number(wl.nm ?? wl.wavelength);
      const wlLabel = Number.isFinite(wlValue) ? `${wlValue} nm` : `UV ${i + 1}`;
      return {
      x: wl.times || [], y: wl.intensities || [],
      type: 'scatter', mode: 'lines',
      name: wlLabel,
      line: { color: getColor(i), width: getLineWidth() },
      };
    });
    const layout = mergeLayout({
      title: { text: title || 'UV Chromatogram', font: { size: 14 } },
      xaxis: { title: getXAxisLabel() }, yaxis: { title: 'Absorbance (mAU)' },
      showlegend: traces.length > 1, height: getContainerHeight(divId, 300),
    });
    Plotly.newPlot(divId, traces, layout, PLOT_CONFIG);
  },

  plotTIC(divId, times, intensities, title, color, options = {}) {
    const traces = [{
      x: times, y: intensities,
      type: 'scatter', mode: 'lines', name: 'TIC',
      line: { color: color || '#ff7f0e', width: getLineWidth() },
    }];
    const shapes = [];
    const annotations = [];
    const xaxis = { title: getXAxisLabel() };
    if (Array.isArray(options.xRange) && options.xRange.length === 2) {
      const x0 = Number(options.xRange[0]);
      const x1 = Number(options.xRange[1]);
      if (Number.isFinite(x0) && Number.isFinite(x1) && x1 > x0) {
        xaxis.range = [x0, x1];
      }
    } else if (options.startAtZero === true) {
      let xMax = Number.NEGATIVE_INFINITY;
      (times || []).forEach((tv) => {
        const v = Number(tv);
        if (Number.isFinite(v) && v > xMax) xMax = v;
      });
      if (Number.isFinite(xMax) && xMax > 0) xaxis.range = [0, xMax];
    }
    if (Number.isFinite(options.start) && Number.isFinite(options.end) && options.end > options.start) {
      shapes.push({
        type: 'rect',
        xref: 'x',
        yref: 'paper',
        x0: options.start,
        x1: options.end,
        y0: 0,
        y1: 1,
        fillcolor: options.windowColor || 'rgba(255, 215, 0, 0.25)',
        line: { width: 0 },
        layer: 'below',
      });
      if (options.showWindowAnnotation !== false) {
        annotations.push({
          x: (options.start + options.end) / 2,
          y: 1.02,
          xref: 'x',
          yref: 'paper',
          text: `Window: ${options.start.toFixed(2)}-${options.end.toFixed(2)} min`,
          showarrow: false,
          font: { size: 10, color: '#000000' },
        });
      }
    }
    const layout = mergeLayout({
      title: { text: title || 'Total Ion Chromatogram', font: { size: 14 } },
      xaxis: {
        ...xaxis,
        fixedrange: options.fixedRange === true,
      },
      yaxis: { title: options.yLabel || 'Intensity', fixedrange: options.fixedRange === true },
      showlegend: false,
      height: Number.isFinite(Number(options.heightPx)) && Number(options.heightPx) > 0
        ? Number(options.heightPx)
        : getContainerHeight(divId, 300),
      margin: options.margin || { l: 60, r: 24, t: 40, b: 72 },
      dragmode: options.dragmode || 'zoom',
      selectdirection: options.selectdirection,
      shapes,
      annotations,
    });
    applyExplicitPlotHeight(divId, layout.height);
    Plotly.newPlot(divId, traces, layout, clonePlotConfig(options.plotConfig));
  },

  plotChromatogramWithWindow(divId, times, intensities, options = {}) {
    const traceColor = options.color || '#1f77b4';
    const traces = [{
      x: times || [],
      y: intensities || [],
      type: 'scatter',
      mode: 'lines',
      name: options.label || 'Signal',
      line: { color: traceColor, width: getLineWidth() },
    }];

    const shapes = [];
    const annotations = [];
    if (Number.isFinite(options.start) && Number.isFinite(options.end) && options.end > options.start) {
      shapes.push({
        type: 'rect',
        xref: 'x',
        yref: 'paper',
        x0: options.start,
        x1: options.end,
        y0: 0,
        y1: 1,
        fillcolor: options.windowColor || 'rgba(255, 255, 0, 0.25)',
        line: { width: 0 },
        layer: 'below',
      });
      if (options.showWindowAnnotation !== false) {
        annotations.push({
          x: (options.start + options.end) / 2,
          y: 1.02,
          xref: 'x',
          yref: 'paper',
          text: `Window: ${options.start.toFixed(2)}-${options.end.toFixed(2)} min`,
          showarrow: false,
          font: { size: 10, color: '#000000' },
        });
      }
    }

    const compact = options.compact === true;
    const xaxis = {
      title: compact ? '' : (options.xLabel || getXAxisLabel()),
      showticklabels: !compact,
      fixedrange: compact,
    };
    if (options.startAtZero === true) {
      let xMax = Number.NEGATIVE_INFINITY;
      (times || []).forEach((tv) => {
        const v = Number(tv);
        if (Number.isFinite(v) && v > xMax) xMax = v;
      });
      if (Number.isFinite(xMax) && xMax > 0) {
        xaxis.range = [0, xMax];
      } else {
        xaxis.range = [0, 1];
      }
    }
    const yaxis = {
      title: compact ? '' : (options.yLabel || 'Intensity'),
      showticklabels: !compact,
      fixedrange: compact,
    };

    const layout = mergeLayout({
      title: { text: options.title || 'Chromatogram', font: { size: 14 } },
      xaxis,
      yaxis,
      showlegend: false,
      height: getContainerHeight(divId, 320),
      margin: options.margin || (compact ? { l: 8, r: 8, t: 28, b: 8 } : { l: 60, r: 24, t: 40, b: 72 }),
      shapes,
      annotations,
      dragmode: options.dragmode || 'zoom',
      selectdirection: options.selectdirection,
    });

    Plotly.newPlot(divId, traces, layout, clonePlotConfig(options.plotConfig));
  },

  plotEIC(divId, eicTraces, title, options = {}) {
    const targets = normalizeEicInput(eicTraces);
    const colorIndexStartRaw = Number(options.colorIndexStart);
    const colorIndexStart = Number.isFinite(colorIndexStartRaw) ? colorIndexStartRaw : 0;
    const traces = targets.map((t, i) => {
      const mzValue = Number(t.target_mz ?? t.mz);
      const mzLabel = Number.isFinite(mzValue) ? mzValue.toFixed(2) : '?';
      const traceColor = t.color || options.traceColor || getColor(colorIndexStart + i);
      return {
      x: t.times || [], y: t.intensities || [],
      type: 'scatter', mode: 'lines',
      name: `m/z ${mzLabel}`,
      line: { color: traceColor, width: getLineWidth() },
      };
    });

    const xaxis = { title: getXAxisLabel() };
    if (Array.isArray(options.xRange) && options.xRange.length === 2) {
      const x0 = Number(options.xRange[0]);
      const x1 = Number(options.xRange[1]);
      if (Number.isFinite(x0) && Number.isFinite(x1) && x1 > x0) {
        xaxis.range = [x0, x1];
      }
    } else if (options.startAtZero === true) {
      let xMax = Number.NEGATIVE_INFINITY;
      targets.forEach((t) => {
        (t.times || []).forEach((tv) => {
          const v = Number(tv);
          if (Number.isFinite(v) && v > xMax) xMax = v;
        });
      });
      if (Number.isFinite(xMax) && xMax > 0) xaxis.range = [0, xMax];
    }

    const showLegend = typeof options.showLegend === 'boolean'
      ? options.showLegend
      : traces.length > 1;
    const layout = mergeLayout({
      title: {
        text: title || 'Extracted Ion Chromatogram',
        font: {
          size: 14,
          color: options.titleColor || '#000000',
        },
      },
      xaxis, yaxis: { title: 'Intensity' },
      showlegend: showLegend,
      legend: showLegend ? {
        x: 0.995,
        xanchor: 'right',
        y: 0.995,
        yanchor: 'top',
        bgcolor: 'rgba(255,255,255,0.8)',
      } : undefined,
      height: getContainerHeight(divId, 300),
      margin: { r: showLegend ? 34 : 24 },
    });
    Plotly.newPlot(divId, traces, layout, PLOT_CONFIG);
  },

  plotEICWithPeaks(divId, data, options = {}) {
    const mzValue = Number(data.mz ?? data.target_mz);
    const defaultSeriesLabel = Number.isFinite(mzValue) ? `m/z ${mzValue.toFixed(2)}` : 'Signal';
    const defaultTitle = Number.isFinite(mzValue) ? `EIC m/z ${mzValue.toFixed(2)}` : 'Chromatogram';
    const seriesLabel = options.seriesLabel || data.label || defaultSeriesLabel;
    const baselineMode = options.baselineMode || data.baselineMode || null;
    const traces = [{
      x: data.times, y: data.intensities,
      type: 'scatter', mode: 'lines',
      name: seriesLabel,
      line: { color: options.color || '#1f77b4', width: getLineWidth() },
    }];
    if (data.peaks) {
      data.peaks.forEach((peak, i) => {
        if (peak.selected !== false && peak.start != null && peak.end != null) {
          const itemLabel = options.areaItemLabel || (baselineMode === 'linear-endpoints' ? 'Area' : 'Peak');
          const areaLabel = Number.isFinite(Number(peak.area)) ? Number(peak.area).toExponential(2) : '?';
          if (baselineMode === 'linear-endpoints') {
            const baseline = buildLinearWindowBaseline(data.times, data.intensities, peak.start, peak.end);
            const win = buildWindowTrace(data.times, data.intensities, peak.start, peak.end);
            if (win.x.length < 2 || baseline.x.length !== win.x.length) return;
            const fillY = win.y.map((y, idx) => Math.max(Number(y) || 0, Number(baseline.y[idx]) || 0));
            traces.push({
              x: baseline.x,
              y: baseline.y,
              type: 'scatter',
              mode: 'lines',
              line: { color: getColor(i + 1), width: 1, dash: 'dot' },
              name: `${itemLabel} ${i + 1} baseline`,
              showlegend: false,
              hoverinfo: 'skip',
            });
            traces.push({
              x: win.x,
              y: fillY,
              type: 'scatter',
              mode: 'lines',
              fill: 'tonexty',
              fillcolor: hexToRGBA(getColor(i + 1), 0.3),
              line: { color: getColor(i + 1), width: 1.2 },
              name: `${itemLabel} ${i + 1} (${areaLabel})`,
              showlegend: false,
              hoverinfo: 'skip',
            });
          } else {
            // Create filled region between exact start/end boundaries so adjacent
            // touching peaks render without visual gaps.
            const win = buildWindowTrace(data.times, data.intensities, peak.start, peak.end);
            if (win.x.length < 2) return;
            traces.push({
              x: win.x, y: win.y,
              type: 'scatter',
              mode: 'none',
              fill: 'tozeroy',
              fillcolor: hexToRGBA(getColor(i + 1), 0.3),
              line: { width: 0 },
              name: `${itemLabel} ${i + 1} (${areaLabel})`,
              showlegend: false,
              hoverinfo: 'skip',
            });
          }
        }
      });
    }
    const showLegend = traces.length > 1;
    const layout = mergeLayout({
      title: { text: options.title || data.title || defaultTitle, font: { size: 14 } },
      xaxis: { title: getXAxisLabel() },
      yaxis: { title: options.yLabel || data.yLabel || 'Intensity' },
      showlegend: showLegend,
      legend: showLegend ? {
        x: 0.995,
        xanchor: 'right',
        y: 0.995,
        yanchor: 'top',
        bgcolor: 'rgba(255,255,255,0.8)',
      } : undefined,
      height: getContainerHeight(divId, 300),
      margin: { r: showLegend ? 34 : 24 },
      dragmode: options.dragmode || 'zoom',
      selectdirection: options.selectdirection,
    });
    Plotly.newPlot(divId, traces, layout, PLOT_CONFIG);
  },

  plotEICOverlay(divId, targets, options = {}) {
    const normalizedTargets = normalizeEicInput(targets);
    const traces = [];
    normalizedTargets.forEach((t, i) => {
      const mzValue = Number(t.mz ?? t.target_mz);
      const mzLabel = Number.isFinite(mzValue) ? mzValue.toFixed(2) : '?';
      traces.push({
        x: t.times,
        y: options.normalize ? normalizeArray(t.intensities) : t.intensities,
        type: 'scatter', mode: 'lines',
        name: `m/z ${mzLabel}`,
        line: { color: getColor(i), width: getLineWidth() },
      });
    });
    const showLegend = traces.length > 1;
    const layout = mergeLayout({
      title: { text: options.title || 'EIC Overlay', font: { size: 14 } },
      xaxis: { title: getXAxisLabel() },
      yaxis: { title: options.normalize ? 'Relative Intensity' : 'Intensity' },
      showlegend: showLegend,
      legend: showLegend ? {
        x: 0.995,
        xanchor: 'right',
        y: 0.995,
        yanchor: 'top',
        bgcolor: 'rgba(255,255,255,0.8)',
      } : undefined,
      height: getContainerHeight(divId, 350),
      margin: { r: showLegend ? 34 : 24 },
    });
    Plotly.newPlot(divId, traces, layout, PLOT_CONFIG);
  },

  plotProgression(divId, samples, colors, options = {}) {
    const roleColorMap = {
      initial: colors.initial || '#808080',
      mid: colors.mid || '#215CAF',
      final: colors.final || '#d62728',
    };
    const traces = samples.map(s => ({
      x: s.times, y: s.intensities,
      type: 'scatter', mode: 'lines',
      name: s.label,
      line: { color: s.color || roleColorMap[s.role] || '#999', width: getLineWidth() },
    }));

    const xaxis = { title: getXAxisLabel() };
    if (Array.isArray(options.xRange) && options.xRange.length === 2) {
      const x0 = Number(options.xRange[0]);
      const x1 = Number(options.xRange[1]);
      if (Number.isFinite(x0) && Number.isFinite(x1) && x1 > x0) {
        xaxis.range = [x0, x1];
      }
    }

    const layout = mergeLayout({
      title: { text: options.title || 'Time Progression', font: { size: 14 } },
      xaxis, yaxis: { title: options.yLabel || 'Intensity' },
      legend: {
        x: 0.995,
        xanchor: 'right',
        y: 0.995,
        yanchor: 'top',
        bgcolor: 'rgba(255,255,255,0.8)',
      },
      showlegend: true,
      margin: { r: 28 },
      height: getContainerHeight(divId, 350),
    });
    Plotly.newPlot(divId, traces, layout, PLOT_CONFIG);
  },

  plotUptakeAssayOverlay(divId, samples, options = {}) {
    const traces = (samples || []).map((sample, index) => ({
      x: sample.times || [],
      y: sample.intensities || [],
      type: 'scatter',
      mode: 'lines',
      name: sample.label || `Sample ${index + 1}`,
      line: { color: sample.color || getColor(index), width: getLineWidth() },
    }));

    const shapes = [];
    const start = Number(options.start);
    const end = Number(options.end);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      shapes.push({
        type: 'rect',
        xref: 'x',
        yref: 'paper',
        x0: start,
        x1: end,
        y0: 0,
        y1: 1,
        fillcolor: 'rgba(33, 92, 175, 0.10)',
        line: { width: 0 },
      });
      [start, end].forEach((xPos) => {
        shapes.push({
          type: 'line',
          xref: 'x',
          yref: 'paper',
          x0: xPos,
          x1: xPos,
          y0: 0,
          y1: 1,
          line: { color: '#215CAF', width: 1.2, dash: 'dash' },
        });
      });
    }

    const layout = mergeLayout({
      title: { text: options.title || 'Uptake Assay EIC Overlay', font: { size: 14 } },
      xaxis: { title: options.xLabel || getXAxisLabel() },
      yaxis: { title: options.yLabel || 'Intensity' },
      showlegend: traces.length > 1,
      legend: traces.length > 1 ? {
        x: 0.995,
        xanchor: 'right',
        y: 0.995,
        yanchor: 'top',
        bgcolor: 'rgba(255,255,255,0.8)',
      } : undefined,
      height: getContainerHeight(divId, 320),
      margin: { r: traces.length > 1 ? 34 : 24 },
      shapes,
    });
    Plotly.newPlot(divId, traces, layout, PLOT_CONFIG);
  },

  plotCalibrationCurve(divId, points, fit, options = {}) {
    const usablePoints = Array.isArray(points) ? points.filter((point) =>
      Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y))
    ) : [];
    const traces = [];

    if (usablePoints.length > 0) {
      const errorArray = usablePoints.map((point) => {
        const value = Number(point?.y_sd);
        return Number.isFinite(value) && value > 0 ? value : 0;
      });
      const hasErrorBars = errorArray.some((value) => value > 0);
      traces.push({
        x: usablePoints.map((point) => Number(point.x)),
        y: usablePoints.map((point) => Number(point.y)),
        text: usablePoints.map((point) => point.label || ''),
        hovertext: usablePoints.map((point) => {
          const replicateCount = Number(point?.replicate_count) || 1;
          const sdValue = Number(point?.y_sd);
          const samples = Array.isArray(point?.sample_names) ? point.sample_names.filter(Boolean).join(', ') : '';
          const lines = [
            `<b>${point.label || ''}</b>`,
            `Concentration: ${Number(point.x)}`,
            `Mean area: ${Number(point.y).toExponential(4)}`,
          ];
          if (replicateCount > 1) {
            lines.push(`SD: ${Number.isFinite(sdValue) ? sdValue.toExponential(4) : '0.0000e+0'}`);
            lines.push(`Replicates: ${replicateCount}`);
          }
          if (samples) {
            lines.push(`Samples: ${samples}`);
          }
          return lines.join('<br>');
        }),
        hovertemplate: '%{hovertext}<extra></extra>',
        type: 'scatter',
        mode: 'markers',
        marker: {
          color: '#1f77b4',
          line: { color: '#0d4f8a', width: 1 },
          size: 8,
        },
        error_y: hasErrorBars ? {
          type: 'data',
          array: errorArray,
          visible: true,
          color: '#0d4f8a',
          thickness: 1.2,
          width: 4,
        } : undefined,
        showlegend: false,
      });
    }

    const slope = Number(fit?.slope);
    const intercept = Number(fit?.intercept);
    const rSquared = Number(fit?.rSquared ?? fit?.r_squared);
    if (usablePoints.length >= 2 && Number.isFinite(slope) && Number.isFinite(intercept)) {
      const xVals = usablePoints.map((point) => Number(point.x));
      const xMin = Math.min(...xVals);
      const xMax = Math.max(...xVals);
      traces.push({
        x: [xMin, xMax],
        y: [slope * xMin + intercept, slope * xMax + intercept],
        type: 'scatter',
        mode: 'lines',
        line: { color: '#1f77b4', width: 2 },
        hoverinfo: 'skip',
        showlegend: false,
      });
    }

    const annotations = [];
    if (Number.isFinite(slope) && Number.isFinite(intercept) && Number.isFinite(rSquared)) {
      annotations.push({
        xref: 'paper',
        yref: 'paper',
        x: 0.04,
        y: 0.96,
        xanchor: 'left',
        yanchor: 'top',
        align: 'left',
        showarrow: false,
        font: { size: 11, color: '#000000' },
        text: `<b>y = ${slope.toFixed(1)}x ${intercept >= 0 ? '+' : '-'} ${Math.abs(intercept).toFixed(1)}<br>R² = ${rSquared.toFixed(4)}</b>`,
      });
    }

    const layout = mergeLayout({
      title: { text: options.title || 'Uptake Assay Calibration Curve', font: { size: 14 } },
      xaxis: { title: options.xLabel || 'Concentration (μM)' },
      yaxis: { title: options.yLabel || 'Integrated Area' },
      showlegend: false,
      height: getContainerHeight(divId, 320),
      margin: { l: 72, r: 24, t: 40, b: 76 },
      annotations,
    });
    Plotly.newPlot(divId, traces, layout, PLOT_CONFIG);
  },

  plotUptakeAssayBarChart(divId, points, options = {}) {
    const usablePoints = Array.isArray(points) ? points.filter((point) =>
      point && String(point.label || '').trim() && Number.isFinite(Number(point?.y))
    ) : [];
    const plotEl = document.getElementById(divId);

    if (usablePoints.length === 0) {
      const layout = mergeLayout({
        title: { text: options.title || 'Uptake Assay Concentrations', font: { size: 14 } },
        xaxis: { visible: false },
        yaxis: { visible: false },
        height: getContainerHeight(divId, 320),
        margin: { l: 72, r: 24, t: 40, b: 76 },
        annotations: [{
          xref: 'paper',
          yref: 'paper',
          x: 0.5,
          y: 0.5,
          showarrow: false,
          text: options.emptyText || 'Add assay sample rows to calculate intracellular concentrations',
          font: { size: 12, color: '#555555' },
        }],
      });
      Plotly.newPlot(divId, [], layout, PLOT_CONFIG);
      return;
    }

    const labels = usablePoints.map((point) => String(point.label || '').trim());
    const longestLabel = labels.reduce((max, label) => Math.max(max, label.length), 0);
    const tickAngle = usablePoints.length >= 4 || longestLabel > 14 ? 45 : 0;
    const tickFontSize = longestLabel > 20 ? 8 : longestLabel > 14 ? 9 : 10;
    const bottomMargin = tickAngle !== 0 ? 122 : 76;
    const barWidth = 0.09;
    const interBarGap = 0.0135;
    const spacing = barWidth + interBarGap;
    const slotWidthPx = 65;
    const axisPaddingPx = 14;
    const baseWidth = Math.max(Number(plotEl?.clientWidth) || 0, 520);
    const minimumChartWidth = (Math.max(usablePoints.length, 4) * slotWidthPx) + axisPaddingPx + 96;
    const extraWidth = Math.max(0, longestLabel - 14) * 8;
    const targetWidth = Math.max(baseWidth, minimumChartWidth + extraWidth);

    const xPositions = usablePoints.map((_, index) => index * spacing);
    const errorArray = usablePoints.map((point) => {
      const value = Number(point?.y_sd);
      return Number.isFinite(value) && value > 0 ? value : 0;
    });
    const hasErrorBars = errorArray.some((value) => value > 0);
    const trace = {
      x: xPositions,
      y: usablePoints.map((point) => Number(point.y)),
      type: 'bar',
      width: barWidth,
      marker: {
        color: '#1f77b4',
        line: { color: '#0d4f8a', width: 1 },
      },
      error_y: hasErrorBars ? {
        type: 'data',
        array: errorArray,
        visible: true,
        color: '#0d4f8a',
        thickness: 1.2,
        width: 4,
      } : undefined,
      hovertext: usablePoints.map((point) => {
        const lines = [
          `<b>${point.label || ''}</b>`,
          `Mean concentration: ${Number(point.y).toFixed(2)} μM`,
        ];
        const replicateCount = Number(point?.replicate_count) || 1;
        if (replicateCount > 1) {
          const sdValue = Number(point?.y_sd);
          lines.push(`SD: ${Number.isFinite(sdValue) ? sdValue.toFixed(2) : '0.00'} μM`);
          lines.push(`Replicates: ${replicateCount}`);
        }
        const sampleNames = Array.isArray(point?.sample_names) ? point.sample_names.filter(Boolean) : [];
        if (sampleNames.length > 0) {
          lines.push(`Samples: ${sampleNames.join(', ')}`);
        }
        return lines.join('<br>');
      }),
      hovertemplate: '%{hovertext}<extra></extra>',
      showlegend: false,
    };

    const layout = mergeLayout({
      title: { text: options.title || 'Uptake Assay Concentrations', font: { size: 14 } },
      xaxis: {
        title: options.xLabel || 'Sample Name',
        tickmode: 'array',
        tickvals: xPositions,
        ticktext: labels,
        tickangle: tickAngle,
        tickfont: { size: tickFontSize },
        automargin: true,
        range: [
          -(barWidth / 2) - interBarGap,
          (xPositions[xPositions.length - 1] || 0) + (barWidth / 2) + interBarGap,
        ],
      },
      yaxis: { title: options.yLabel || 'Calculated Concentration (μM)' },
      showlegend: false,
      height: getContainerHeight(divId, 320),
      width: targetWidth,
      autosize: false,
      bargap: 0,
      margin: { l: 72, r: 24, t: 40, b: bottomMargin },
    });
    Plotly.newPlot(divId, [trace], layout, PLOT_CONFIG);
  },

  plotMassSpectrum(divId, mzValues, intensities, annotations, options = {}) {
    const traces = [{
      x: mzValues, y: intensities,
      type: 'scatter', mode: 'lines', name: options.primaryLabel || 'Spectrum',
      line: { color: options.primaryColor || '#1f77b4', width: getLineWidth() },
      text: mzValues.map(value => formatSpectrumMz(value, options.mzGridStep)),
      hovertemplate: 'm/z %{text}<br>Intensity %{y}<extra>%{fullData.name}</extra>',
    }];
    (Array.isArray(options.overlaySpectra) ? options.overlaySpectra : []).forEach((overlay) => {
      if (!overlay || !Array.isArray(overlay.mz) || !Array.isArray(overlay.intensities) || overlay.mz.length === 0) return;
      traces.unshift({
        x: overlay.mz,
        y: overlay.intensities,
        type: 'scatter',
        mode: 'lines',
        name: overlay.label || 'Overlay',
        text: overlay.mz.map(value => formatSpectrumMz(value, options.mzGridStep)),
        hovertemplate: 'm/z %{text}<br>Intensity %{y}<extra>%{fullData.name}</extra>',
        opacity: Number.isFinite(Number(overlay.opacity)) ? Number(overlay.opacity) : 0.35,
        line: {
          color: overlay.color || '#999999',
          width: Number.isFinite(Number(overlay.width)) ? Number(overlay.width) : Math.max(1, getLineWidth() - 0.2),
          dash: overlay.dash || 'solid',
        },
      });
    });
    if(options.centroidSticks){
      for(const trace of traces){
        const x=[],y=[],text=[];
        trace.x.forEach((mz,i)=>{x.push(mz,mz,null);y.push(0,trace.y[i],null);text.push(String(mz),String(mz),'');});
        Object.assign(trace,{x,y,text});
      }
    }
    const plotAnnotations = (annotations || []).map(a => ({
      x: a.mz, y: a.intensity,
      text: a.label, showarrow: true, arrowhead: 2, arrowsize: 0.8,
      arrowcolor: '#000000', font: { size: 9, color: '#000000' }, ax: 0, ay: -30,
    }));
    const guideMzs = Array.isArray(options.guideMzs) ? options.guideMzs : [];
    const shapes = guideMzs.map((guide) => ({
      type: 'line',
      x0: typeof guide === 'number' ? guide : guide.mz,
      x1: typeof guide === 'number' ? guide : guide.mz,
      xref: 'x',
      y0: 0,
      y1: 1,
      yref: 'paper',
      line: {
        color: typeof guide === 'number' ? '#d62728' : getDeconvColor(guide.componentIndex),
        width: 1.1,
        dash: 'dash',
      },
    }));

    const explicitHeight = Number(options.heightPx);
    const plotHeight = Number.isFinite(explicitHeight) && explicitHeight > 0
      ? explicitHeight
      : getContainerHeight(divId, 380);

    const xaxis = { title: 'm/z', automargin: true };
    if (Array.isArray(options.xRange) && options.xRange.length === 2) {
      const x0 = Number(options.xRange[0]);
      const x1 = Number(options.xRange[1]);
      if (Number.isFinite(x0) && Number.isFinite(x1) && x1 > x0) {
        xaxis.range = [x0, x1];
      }
    }

    const layout = mergeLayout({
      title: { text: options.title || 'Mass Spectrum', font: { size: 14 } },
      xaxis,
      yaxis: { title: 'Intensity', automargin: true },
      showlegend: traces.length > 1,
      height: plotHeight,
      margin: { l: 64, r: 44, t: 40, b: divId === 'deconv-spectrum-plot' ? 66 : 96 },
      annotations: plotAnnotations,
      shapes,
    });
    applyExplicitPlotHeight(divId, plotHeight);
    Plotly.newPlot(divId, traces, layout, PLOT_CONFIG).then(() => {
      bindAdaptiveMassSpectrumLabels(divId, mzValues, intensities, plotAnnotations, options.mzGridStep);
    });
  },

  plotMassSpectraOverlay(divId, spectra, options = {}) {
    const traces = (spectra || []).map((s, i) => ({
      x: s.mz || [],
      y: options.normalize ? normalizeArray(s.intensities || []) : (s.intensities || []),
      type: 'scatter',
      mode: 'lines',
      name: s.label || `Sample ${i + 1}`,
      line: {
        color: s.color || getColor(i),
        width: s.width || getLineWidth(),
        dash: s.dash || 'solid',
      },
      showlegend: s.showLegend !== false,
      hoverinfo: s.hoverInfo || undefined,
    }));

    const layout = mergeLayout({
      title: { text: options.title || 'Summed Mass Spectra', font: { size: 14 } },
      xaxis: { title: options.xTitle || 'm/z' },
      yaxis: { title: options.yTitle || (options.normalize ? 'Relative Intensity' : 'Intensity') },
      showlegend: true, height: getContainerHeight(divId, 350),
    });

    Plotly.newPlot(divId, traces, layout, PLOT_CONFIG);
  },

  plotDeconvMasses(divId, components, options = {}) {
    // components: [{mass, intensity, ...}] - render as vertical-line stem plot like Streamlit
    // Normalize to relative intensity (0-100%)
    const maxInt = Math.max(...components.map(c => c.intensity));
    const normInt = components.map(c => maxInt > 0 ? (c.intensity / maxInt) * 100 : 0);
    const massesKDa = components.map(c => c.mass / 1000);

    // Get mass axis range from settings or auto
    const massMinEl = document.getElementById('mass-axis-min');
    const massMaxEl = document.getElementById('mass-axis-max');
    let xMin = massMinEl && massMinEl.value ? parseFloat(massMinEl.value) / 1000 : 1.0;
    let xMax = massMaxEl && massMaxEl.value ? parseFloat(massMaxEl.value) / 1000 : 50.0;
    if (xMax <= xMin) { xMin = 1.0; xMax = 50.0; }

    // One trace per component for vertical lines with individual colors + labels
    const traces = [];
    const annotations = [];

    components.forEach((c, i) => {
      const mKDa = c.mass / 1000;
      const relInt = normInt[i];
      const color = getDeconvColor(i);

      // Vertical line from 0 to intensity
      traces.push({
        x: [mKDa, mKDa], y: [0, relInt],
        type: 'scatter', mode: 'lines',
        line: { color, width: 2.5 },
        showlegend: false,
        hovertemplate: `Mass: ${c.isotope_aware?String(c.mass):c.mass.toFixed(1)} Da<br>Rel. Int: ${relInt.toFixed(1)}%<extra></extra>`,
      });

      // Label above each peak
      const labelText = c.isotope_aware ? c.mass.toFixed(6) : c.mass >= 10000 ? c.mass.toFixed(1) : c.mass.toFixed(2);
      annotations.push({
        x: mKDa, y: relInt,
        text: labelText,
        showarrow: true, arrowhead: 0, arrowsize: 1, arrowwidth: 1,
        arrowcolor: color, ax: 0, ay: -25,
        font: { size: 10, color },
      });
    });

    const hideGrid = options.hideGrid === true;
    const axisFrame = options.axisFrame !== false && !hideGrid;
    const axisLineColor = axisFrame ? '#000000' : 'rgba(0,0,0,0)';
    const axisTickColor = axisFrame ? '#000000' : '#555555';
    const layout = mergeLayout({
      title: { text: 'Deconvoluted Masses', font: { size: 14 } },
      xaxis: {
        title: 'Mass (kDa)',
        range: [xMin, xMax],
        showline: axisFrame,
        linecolor: axisLineColor,
        color: axisTickColor,
        mirror: false,
        automargin: true,
      },
      yaxis: {
        title: 'Relative Intensity (%)',
        range: [0, 110],
        showline: axisFrame,
        linecolor: axisLineColor,
        color: axisTickColor,
        mirror: false,
        automargin: true,
      },
      showlegend: false,
      height: getContainerHeight(divId, 380),
      margin: { l: 64, r: 44, t: 40, b: 66 },
      annotations,
    });
    if (hideGrid) {
      layout.xaxis = {
        ...(layout.xaxis || {}),
        showgrid: false,
        showline: true,
        linecolor: '#000000',
        ticks: 'outside',
        mirror: false,
        zeroline: false,
        color: '#000000',
      };
      layout.yaxis = {
        ...(layout.yaxis || {}),
        showgrid: false,
        showline: true,
        linecolor: '#000000',
        ticks: 'outside',
        mirror: false,
        zeroline: false,
        color: '#000000',
      };
    }
    Plotly.newPlot(divId, traces, layout, PLOT_CONFIG).then(() => {
      const plot = document.getElementById(divId);
      if (!plot?.on || typeof options.onSelect !== 'function') return;
      if (plot.__deconvSelectHandler && plot.removeListener) plot.removeListener('plotly_click', plot.__deconvSelectHandler);
      const handler = event => {
        const index = event?.points?.[0]?.curveNumber;
        if (Number.isInteger(index) && index >= 0 && index < components.length) options.onSelect(index);
      };
      plot.__deconvSelectHandler = handler;
      plot.on('plotly_click', handler);
    });
  },

  plotDenseDeconvolutedMassProfile(divId, spectrum, options = {}) {
    if(Array.isArray(spectrum?.isotope_profile)){
      const peaks=spectrum.isotope_profile,style=options.style||{},x=[],y=[],text=[];
      const maximum=Math.max(0,...peaks.map(p=>p.intensity));
      for(const p of peaks){
        x.push(p.mass,p.mass,null);y.push(0,maximum>0?p.intensity/maximum*100:0,null);
        const label=`Derived mass ${p.mass} Da<br>Measured m/z ${p.mz}<br>z=${p.charge} · scan ${p.scan_id}`;
        text.push(label,label,'');
      }
      const height=getContainerHeight(divId,Number(options.height)||340);
      applyExplicitPlotHeight(divId,height);
      Plotly.newPlot(divId,[{x,y,text,type:'scatter',mode:'lines',line:{color:'#000000',width:.8},hovertemplate:'%{text}<br>%{y:.2f}%<extra></extra>'}],mergeLayout({
        title:{text:style.deconv_show_title===false?'':'Measured isotopes',font:{size:14}},
        xaxis:{title:'Neutral isotope mass (Da)',range:[finiteNumber(style.deconv_x_min_da,1000),finiteNumber(style.deconv_x_max_da,50000)],automargin:true,showgrid:false},
        yaxis:{title:'Relative intensity (%)',range:[0,105],automargin:true,showgrid:false},showlegend:false,height,
        margin:{l:64,r:44,t:40,b:66},
        annotations:peaks.length?[]:[{xref:'paper',yref:'paper',x:.5,y:.5,text:'No supported isotope envelopes',showarrow:false}],
      }),PLOT_CONFIG);
      return;
    }
    const style = options.style || {};
    let massMinDa = finiteNumber(style.deconv_x_min_da ?? options.massMinDa, 1000.0);
    let massMaxDa = finiteNumber(style.deconv_x_max_da ?? options.massMaxDa, 50000.0);
    if (massMaxDa <= massMinDa) {
      massMinDa = 1000.0;
      massMaxDa = 50000.0;
    }
    const profile = buildDenseZeroChargeProfile(
      spectrum?.mz || [],
      spectrum?.intensities || [],
      {
        massMinDa,
        massMaxDa,
        minCharge: style.deconv_profile_min_charge ?? options.minCharge,
        maxCharge: style.deconv_profile_max_charge ?? options.maxCharge,
        useMonoisotopic: style.deconv_profile_use_monoisotopic === true,
        binDa: style.deconv_profile_bin_da ?? options.binDa,
        smoothSigmaDa: style.deconv_profile_smooth_sigma_da ?? options.smoothSigmaDa,
      },
    );

    const plotHeight = getContainerHeight(divId, Number(options.height) || 340);
    const requestedView = [Number(style.deconv_profile_view_min_da), Number(style.deconv_profile_view_max_da)];
    const viewRangeDa = requestedView.every(Number.isFinite) && requestedView[1] > requestedView[0] ? requestedView : [massMinDa, massMaxDa];
    const visibleMax = denseProfileVisibleMaximum(profile, viewRangeDa);
    const yRange = [0, (visibleMax || 100) * 1.3];
    const showTitle = style.deconv_show_title !== false;
    const layout = mergeLayout({
      title: { text: showTitle ? (options.title || 'Deconvoluted Masses') : '', font: { size: 14 } },
      xaxis: {
        title: 'Mass (kDa)',
        range: viewRangeDa.map(v => v / 1000),
        showgrid: false,
        showline: true,
        linecolor: '#000000',
        ticks: 'outside',
        mirror: false,
        zeroline: false,
        color: '#000000',
        automargin: true,
      },
      yaxis: {
        title: 'Relative Intensity (%)',
        range: yRange,
        showgrid: false,
        showline: true,
        linecolor: '#000000',
        ticks: 'outside',
        mirror: false,
        zeroline: false,
        color: '#000000',
        automargin: true,
      },
      showlegend: false,
      height: plotHeight,
      margin: { l: 64, r: 44, t: showTitle ? 40 : 18, b: 66 },
      dragmode: 'zoom',
      annotations: buildDenseProfileAnnotations(profile, viewRangeDa, {
        mainMass: style.deconv_profile_selected_mass,
        width: Math.max(120, (document.getElementById(divId)?.clientWidth || 800) - 108), height: plotHeight - 106, yRange,
      }),
    });
    layout.xaxis.showgrid = false;
    layout.yaxis.showgrid = false;
    applyExplicitPlotHeight(divId, plotHeight);

    if (!profile.massKDa.length || !profile.relativeIntensity.length) {
      layout.annotations = [{
        xref: 'paper',
        yref: 'paper',
        x: 0.5,
        y: 0.5,
        showarrow: false,
        text: 'No masses detected',
        font: { size: 12, color: '#555555' },
      }];
      Plotly.newPlot(divId, [], layout, PLOT_CONFIG);
      return;
    }

    const displayed = downsampleProfileEnvelope(profile.massKDa, profile.relativeIntensity, 80000);
    const trace = {
      x: displayed.x,
      y: displayed.y,
      type: displayed.x.length > 40000 ? 'scattergl' : 'scatter',
      mode: 'lines',
      line: {
        color: '#000000',
        width: Math.max(0.5, finiteNumber(style.line_width, getLineWidth())),
      },
      customdata: Array.from(displayed.x, mass => mass * 1000),
      hovertemplate: 'Mass: %{customdata:.1f} Da<br>Relative Intensity: %{y:.2f}%<extra></extra>',
      showlegend: false,
    };

    Plotly.newPlot(divId, [trace], layout, PLOT_CONFIG).then(() => {
      bindDenseProfileLabels(divId, profile, viewRangeDa, style.deconv_profile_selected_mass);
    });
  },

  plotIonDetail(divId, component) {
    // component: {mass, ion_charges: [], ion_mzs: [], ion_intensities: []}
    const charges = component.ion_charges || [];
    const intensities = component.ion_intensities || [];
    const mzs = component.ion_mzs || [];
    const PROTON = 1.00784;

    const traces = [{
      x: charges, y: intensities,
      type: 'bar', marker: { color: '#215CAF' }, name: 'Observed',
      hovertemplate: charges.map((z, i) => {
        const theo = (component.mass + z * PROTON) / z;
        return `z=${z}<br>m/z obs: ${mzs[i] ? formatSpectrumMz(mzs[i]) : '?'}<br>m/z theo: ${formatSpectrumMz(theo)}<br>Int: ${intensities[i] ? intensities[i].toFixed(0) : '?'}`;
      }),
    }];
    const layout = mergeLayout({
      title: { text: `Ion Detail: ${component.mass.toFixed(1)} Da`, font: { size: 14 } },
      xaxis: { title: 'Charge State (z)', dtick: 1 }, yaxis: { title: 'Intensity' },
      showlegend: false, height: getContainerHeight(divId, 300),
    });
    Plotly.newPlot(divId, traces, layout, PLOT_CONFIG);
  },

  plotIonSelectionInteractive(divId, mzValues, intensities, components, options = {}) {
    const mz = Array.isArray(mzValues) ? mzValues.map(v => Number(v)).filter(v => Number.isFinite(v)) : [];
    const ints = Array.isArray(intensities) ? intensities.map(v => Number(v)).filter(v => Number.isFinite(v)) : [];
    const comps = Array.isArray(components) ? components : [];

    if (mz.length === 0 || ints.length === 0 || comps.length === 0 || mz.length !== ints.length) {
      const el = document.getElementById(divId);
      if (el) {
        el.innerHTML = '<p class="placeholder-msg">No ion selection data available.</p>';
      }
      return;
    }

    const { x: mzPlot, y: intPlot } = downsamplePair(mz, ints, 8000);

    const n = Math.max(1, Math.min(10, comps.length));
    const columns = n > 1 ? 2 : 1;
    const rows = Math.ceil(n / columns);
    const explicitHeight = Math.max(400, 350 * rows + 70);
    const hGap = columns > 1 ? 0.16 : 0;
    const vGap = rows > 1 ? 0.07 : 0;
    const colWidth = (1 - (columns - 1) * hGap) / columns;
    const rowHeight = (1 - (rows - 1) * vGap) / rows;
    const traces = [];
    const annotations = [];
    const topIntensity = Number(comps[0]?.intensity || 0);
    const xMin = mzPlot[0];
    const xMax = mzPlot[mzPlot.length - 1];
    const layoutOverrides = {};
    const yMax = Math.max(1, ...intPlot) * 1.15;

    for (let i = 0; i < n; i++) {
      const comp = comps[i];
      const axisIdx = i + 1;
      const xRef = axisIdx === 1 ? 'x' : `x${axisIdx}`;
      const yRef = axisIdx === 1 ? 'y' : `y${axisIdx}`;
      const xAxisName = axisIdx === 1 ? 'xaxis' : `xaxis${axisIdx}`;
      const yAxisName = axisIdx === 1 ? 'yaxis' : `yaxis${axisIdx}`;
      const row = Math.floor(i / columns);
      const col = i % columns;
      const domainLeft = col * (colWidth + hGap);
      const domainRight = domainLeft + colWidth;
      const domainTop = 1 - row * (rowHeight + vGap);
      const domainBottom = domainTop - rowHeight;
      const color = getDeconvColor(i);
      const ionMzs = (comp.ion_mzs || []).map(v => Number(v)).filter(v => Number.isFinite(v));
      const ionCharges = (comp.ion_charges || []).map(v => Number(v)).filter(v => Number.isFinite(v));

      traces.push({
        x: mzPlot,
        y: intPlot,
        type: 'scatter',
        mode: 'lines',
        xaxis: xRef,
        yaxis: yRef,
        line: { color: '#cfcfcf', width: 0.8 },
        text: mzPlot.map(value => formatSpectrumMz(value, options.mzGridStep)),
        hovertemplate: 'm/z %{text}<br>Intensity %{y:.3e}<extra></extra>',
        showlegend: false,
      });
      if(comp.isotope_aware){
        const base=traces[traces.length-1],x=[],y=[],text=[];
        mzPlot.forEach((value,k)=>{x.push(value,value,null);y.push(0,intPlot[k],null);text.push(String(value),String(value),'');});
        Object.assign(base,{x,y,text});
        for(const env of comp.envelopes||[]){
          const ex=[],ey=[],et=[];
          for(const [value,intensity] of env.envelope){ex.push(value,value,null);ey.push(0,intensity,null);et.push(`m/z ${value} · z=${env.charge} · scan ${env.scan_id}`,`m/z ${value} · z=${env.charge} · scan ${env.scan_id}`,'');}
          traces.push({x:ex,y:ey,text:et,type:'scatter',mode:'lines',xaxis:xRef,yaxis:yRef,line:{color,width:1},hovertemplate:'%{text}<br>%{y}<extra></extra>',showlegend:false});
        }
      }

      const ionX = [];
      const ionY = [];
      const ionText = [];
      ionMzs.forEach((mzIon, k) => {
        const yIon = comp.isotope_aware ? Math.max(0,...(comp.envelopes||[]).flatMap(e=>e.envelope.filter(p=>p[0]===mzIon).map(p=>p[1]))) : interpAt(mzPlot, intPlot, mzIon);
        traces.push({
          x: [mzIon, mzIon],
          y: [0, yIon],
          type: 'scatter',
          mode: 'lines',
          xaxis: xRef,
          yaxis: yRef,
          line: { color, width: 1.6 },
          hovertemplate: `m/z ${formatSpectrumMz(mzIon)}<extra></extra>`,
          showlegend: false,
        });
        ionX.push(mzIon);
        ionY.push(yIon);
        const z = ionCharges[k];
        ionText.push(Number.isFinite(z) ? `z=${z}` : '');
      });

      if (ionX.length > 0) {
        traces.push({
          x: ionX,
          y: ionY,
          text: ionText,
          customdata: ionX.map(value => formatSpectrumMz(value)),
          type: 'scatter',
          mode: 'text',
          xaxis: xRef,
          yaxis: yRef,
          textposition: 'top center',
          textfont: { size: 8, color },
          hovertemplate: '%{text}<br>m/z %{customdata}<extra></extra>',
          showlegend: false,
        });
      }

      const massVal = Number(comp.mass || 0);
      const massText = comp.isotope_aware ? massVal.toFixed(6) : massVal >= 10000 ? massVal.toFixed(1) : massVal.toFixed(2);
      const chargeStates = Array.isArray(comp.charge_states) ? comp.charge_states.filter(Number.isFinite) : [];
      const chargeText = chargeStates.length > 1
        ? `z=${Math.min(...chargeStates)}-${Math.max(...chargeStates)}`
        : (chargeStates.length === 1 ? `z=${chargeStates[0]}` : '');
      const relPct = topIntensity > 0 ? (Number(comp.intensity || 0) / topIntensity) * 100 : 0;

      annotations.push({
        xref: 'paper',
        yref: 'paper',
        x: domainLeft + 0.005,
        y: domainTop - 0.01,
        xanchor: 'left',
        yanchor: 'top',
        text: `${massText} Da (${chargeText}${chargeText ? ', ' : ''}${relPct.toFixed(0)}%)`,
        showarrow: false,
        font: { size: 9, color, family: 'Arial, Liberation Sans, DejaVu Sans, sans-serif' },
      });

      const xCfg = {
        domain: [domainLeft, domainRight],
        anchor: yRef,
        range: [xMin, xMax],
        showgrid: false,
        gridcolor: 'rgba(0,0,0,0)',
        zeroline: false,
        showticklabels: true,
        title: row === rows - 1 ? 'm/z' : '',
        automargin: true,
        showline: true,
        linecolor: '#000000',
        color: '#000000',
        mirror: false,
        ticks: 'outside',
      };
      layoutOverrides[xAxisName] = xCfg;
      layoutOverrides[yAxisName] = {
        domain: [domainBottom, domainTop],
        anchor: xRef,
        title: 'Intensity',
        side: 'left',
        showticklabels: true,
        exponentformat: 'e',
        showexponent: 'all',
        showgrid: false,
        gridcolor: 'rgba(0,0,0,0)',
        zeroline: false,
        showline: true,
        linecolor: '#000000',
        color: '#000000',
        mirror: false,
        ticks: 'outside',
        range: [0, yMax],
        automargin: true,
      };
    }

    const layout = mergeLayout({
      title: { text: options.title || 'Ion Selection per Component', font: { size: 14 } },
      showlegend: false,
      height: explicitHeight,
      margin: { l: 62, r: 70, t: 40, b: 45 },
      annotations,
      ...layoutOverrides,
    });

    Plotly.newPlot(divId, traces, layout, PLOT_CONFIG);
  },

  clearPlot(divId) {
    const el = document.getElementById(divId);
    if (el) Plotly.purge(el);
  },
};
