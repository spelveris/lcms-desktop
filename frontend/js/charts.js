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

const WEBAPP_LAYOUT = {
  paper_bgcolor: '#ffffff',
  plot_bgcolor: '#ffffff',
  font: { color: '#000000', family: 'Arial, Liberation Sans, DejaVu Sans, sans-serif', size: 9 },
  margin: { l: 60, r: 20, t: 40, b: 50 },
  xaxis: { gridcolor: 'rgba(0,0,0,0.3)', zeroline: false, color: '#000000', linecolor: '#000000', mirror: false, showline: true },
  yaxis: { gridcolor: 'rgba(0,0,0,0.3)', zeroline: false, color: '#000000', linecolor: '#000000', mirror: false, showline: true, exponentformat: 'e', showexponent: 'all' },
  legend: { bgcolor: 'rgba(0,0,0,0)', borderwidth: 0, font: { color: '#000000', size: 8 } },
  hoverlabel: { bgcolor: '#ffffff', bordercolor: '#999999', font: { color: '#000000', size: 9 } },
  modebar: { bgcolor: 'rgba(255,255,255,0.9)', color: '#444444', activecolor: '#1f77b4' },
};

const PLOT_CONFIG = { responsive: true, displaylogo: false, modeBarButtonsToRemove: ['lasso2d', 'select2d'] };

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
      showlegend: traces.length > 1, height: 300,
    });
    Plotly.newPlot(divId, traces, layout, PLOT_CONFIG);
  },

  plotTIC(divId, data, title) {
    const traces = [{
      x: data.times, y: data.intensities,
      type: 'scatter', mode: 'lines', name: 'TIC',
      line: { color: '#ff7f0e', width: getLineWidth() },
    }];
    const layout = mergeLayout({
      title: { text: title || 'Total Ion Chromatogram', font: { size: 14 } },
      xaxis: { title: getXAxisLabel() }, yaxis: { title: 'Intensity' },
      showlegend: false, height: 300,
    });
    Plotly.newPlot(divId, traces, layout, PLOT_CONFIG);
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

    const layout = mergeLayout({
      title: { text: options.title || 'Chromatogram', font: { size: 14 } },
      xaxis: { title: options.xLabel || getXAxisLabel() },
      yaxis: { title: options.yLabel || 'Intensity' },
      showlegend: false,
      height: options.height || 300,
      shapes,
      annotations,
    });

    Plotly.newPlot(divId, traces, layout, PLOT_CONFIG);
  },

  plotEIC(divId, eicTraces, title) {
    const targets = normalizeEicInput(eicTraces);
    const traces = targets.map((t, i) => {
      const mzValue = Number(t.target_mz ?? t.mz);
      const mzLabel = Number.isFinite(mzValue) ? mzValue.toFixed(2) : '?';
      return {
      x: t.times || [], y: t.intensities || [],
      type: 'scatter', mode: 'lines',
      name: `m/z ${mzLabel}`,
      line: { color: getColor(i), width: getLineWidth() },
      };
    });
    const layout = mergeLayout({
      title: { text: title || 'Extracted Ion Chromatogram', font: { size: 14 } },
      xaxis: { title: getXAxisLabel() }, yaxis: { title: 'Intensity' },
      showlegend: true, height: 300,
    });
    Plotly.newPlot(divId, traces, layout, PLOT_CONFIG);
  },

  plotEICWithPeaks(divId, data, options = {}) {
    const mzValue = Number(data.mz ?? data.target_mz);
    const mzLabel = Number.isFinite(mzValue) ? mzValue.toFixed(2) : '?';
    const traces = [{
      x: data.times, y: data.intensities,
      type: 'scatter', mode: 'lines',
      name: `m/z ${mzLabel}`,
      line: { color: options.color || '#1f77b4', width: getLineWidth() },
    }];
    if (data.peaks) {
      data.peaks.forEach((peak, i) => {
        if (peak.selected !== false && peak.start != null && peak.end != null) {
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
            name: `Peak ${i + 1} (${peak.area ? peak.area.toExponential(2) : '?'})`,
            showlegend: false,
            hoverinfo: 'skip',
          });
        }
      });
    }
    const layout = mergeLayout({
      title: { text: options.title || `EIC m/z ${mzLabel}`, font: { size: 14 } },
      xaxis: { title: getXAxisLabel() }, yaxis: { title: 'Intensity' },
      showlegend: true, height: 300,
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
    const layout = mergeLayout({
      title: { text: options.title || 'EIC Overlay', font: { size: 14 } },
      xaxis: { title: getXAxisLabel() },
      yaxis: { title: options.normalize ? 'Relative Intensity' : 'Intensity' },
      showlegend: true, height: 400,
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
    const layout = mergeLayout({
      title: { text: options.title || 'Time Progression', font: { size: 14 } },
      xaxis: { title: getXAxisLabel() }, yaxis: { title: options.yLabel || 'Intensity' },
      showlegend: true, height: 350,
    });
    Plotly.newPlot(divId, traces, layout, PLOT_CONFIG);
  },

  plotMassSpectrum(divId, mzValues, intensities, annotations, options = {}) {
    const traces = [{
      x: mzValues, y: intensities,
      type: 'scatter', mode: 'lines', name: 'Spectrum',
      line: { color: '#1f77b4', width: getLineWidth() },
    }];
    const plotAnnotations = (annotations || []).map(a => ({
      x: a.mz, y: a.intensity,
      text: a.label, showarrow: true, arrowhead: 2, arrowsize: 0.8,
      arrowcolor: '#000000', font: { size: 9, color: '#000000' }, ax: 0, ay: -30,
    }));
    const guideMzs = Array.isArray(options.guideMzs) ? options.guideMzs : [];
    const shapes = guideMzs.map((mz) => ({
      type: 'line',
      x0: mz,
      x1: mz,
      xref: 'x',
      y0: 0,
      y1: 1,
      yref: 'paper',
      line: {
        color: '#d62728',
        width: 1.1,
        dash: 'dash',
      },
    }));

    const layout = mergeLayout({
      title: { text: 'Mass Spectrum', font: { size: 14 } },
      xaxis: { title: 'm/z' }, yaxis: { title: 'Intensity' },
      showlegend: false, height: 400, annotations: plotAnnotations, shapes,
    });
    Plotly.newPlot(divId, traces, layout, PLOT_CONFIG);
  },

  plotMassSpectraOverlay(divId, spectra, options = {}) {
    const traces = (spectra || []).map((s, i) => ({
      x: s.mz || [],
      y: options.normalize ? normalizeArray(s.intensities || []) : (s.intensities || []),
      type: 'scatter',
      mode: 'lines',
      name: s.label || `Sample ${i + 1}`,
      line: { color: getColor(i), width: getLineWidth() },
    }));

    const layout = mergeLayout({
      title: { text: options.title || 'Summed Mass Spectra', font: { size: 14 } },
      xaxis: { title: 'm/z' },
      yaxis: { title: options.normalize ? 'Relative Intensity' : 'Intensity' },
      showlegend: true,
      height: 420,
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
    const stemColors = [
      '#2ca02c', '#1f77b4', '#ff7f0e', '#d62728', '#9467bd',
      '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf',
    ];

    components.forEach((c, i) => {
      const mKDa = c.mass / 1000;
      const relInt = normInt[i];
      const color = stemColors[i % stemColors.length];

      // Vertical line from 0 to intensity
      traces.push({
        x: [mKDa, mKDa], y: [0, relInt],
        type: 'scatter', mode: 'lines',
        line: { color, width: 2.5 },
        showlegend: false,
        hovertemplate: `Mass: ${c.mass.toFixed(1)} Da<br>Rel. Int: ${relInt.toFixed(1)}%<extra></extra>`,
      });

      // Label above each peak
      const labelText = c.mass >= 10000 ? c.mass.toFixed(1) : c.mass.toFixed(2);
      annotations.push({
        x: mKDa, y: relInt,
        text: labelText,
        showarrow: true, arrowhead: 0, arrowsize: 1, arrowwidth: 1,
        arrowcolor: color, ax: 0, ay: -25,
        font: { size: 10, color: '#000000' },
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
      },
      yaxis: {
        title: 'Relative Intensity (%)',
        range: [0, 110],
        showline: axisFrame,
        linecolor: axisLineColor,
        color: axisTickColor,
        mirror: false,
      },
      showlegend: false,
      height: Number.isFinite(options.height) ? options.height : 400,
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
    Plotly.newPlot(divId, traces, layout, PLOT_CONFIG);
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
        return `z=${z}<br>m/z obs: ${mzs[i] ? mzs[i].toFixed(2) : '?'}<br>m/z theo: ${theo.toFixed(2)}<br>Int: ${intensities[i] ? intensities[i].toFixed(0) : '?'}`;
      }),
    }];
    const layout = mergeLayout({
      title: { text: `Ion Detail: ${component.mass.toFixed(1)} Da`, font: { size: 14 } },
      xaxis: { title: 'Charge State (z)', dtick: 1 }, yaxis: { title: 'Intensity' },
      showlegend: false, height: 300,
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
    const colors = ['#2ca02c', '#1f77b4', '#ff7f0e', '#d62728', '#9467bd',
      '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'];

    const n = Math.max(1, Math.min(10, comps.length));
    const columns = n > 1 ? 2 : 1;
    const rows = Math.ceil(n / columns);
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
      const color = colors[i % colors.length];
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
        hovertemplate: 'm/z %{x:.2f}<br>Intensity %{y:.3e}<extra></extra>',
        showlegend: false,
      });

      const ionX = [];
      const ionY = [];
      const ionText = [];
      ionMzs.forEach((mzIon, k) => {
        const yIon = interpAt(mzPlot, intPlot, mzIon);
        traces.push({
          x: [mzIon, mzIon],
          y: [0, yIon],
          type: 'scatter',
          mode: 'lines',
          xaxis: xRef,
          yaxis: yRef,
          line: { color, width: 1.6 },
          hovertemplate: `m/z ${mzIon.toFixed(2)}<extra></extra>`,
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
          type: 'scatter',
          mode: 'markers+text',
          xaxis: xRef,
          yaxis: yRef,
          textposition: 'top center',
          textfont: { size: 8, color },
          marker: { size: 5, color },
          hovertemplate: '%{text}<br>m/z %{x:.2f}<extra></extra>',
          showlegend: false,
        });
      }

      const massVal = Number(comp.mass || 0);
      const massText = massVal >= 10000 ? massVal.toFixed(1) : massVal.toFixed(2);
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
        showgrid: true,
        showticklabels: row === rows - 1,
        title: row === rows - 1 ? 'm/z' : '',
        automargin: true,
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
        showgrid: true,
        showline: true,
        linecolor: '#000000',
        ticks: 'outside',
        range: [0, yMax],
        automargin: true,
      };
    }

    const layout = mergeLayout({
      title: { text: options.title || 'Ion Selection per Component', font: { size: 14 } },
      showlegend: false,
      height: Math.max(420, 250 * rows + 70),
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
