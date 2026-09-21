/* Measured QTOF spectra only: no predicted fragments or inferred parent scans. */
const qtofViewer = { path: '', polarity: 'positive', scans: null, generation: 0 };

function qtofSyncSamples(files, metadata) {
  const eligible = files.filter(file => metadata[file.path]?.qtof?.is_protein_digest === true);
  peptideSyncSamples(eligible);
  const select = document.getElementById('qtof-sample-select');
  const previous = select.value;
  select.replaceChildren();
  eligible.forEach(file => {
    const option = document.createElement('option');
    option.value = file.path; option.textContent = file.name; select.appendChild(option);
  });
  if (eligible.some(file => file.path === previous)) select.value = previous;
  if (qtofViewer.path && !eligible.some(file => file.path === qtofViewer.path)) qtofReset();
  const tab = document.querySelector('[data-tab="tab-qtof"]');
  tab.classList.toggle('hidden', !eligible.length);
  if (!eligible.length && tab.classList.contains('active')) document.querySelector('[data-tab="tab-single"]').click();
}

function qtofNearestSurvey(scans, time) {
  if (!Number.isFinite(time) || !scans.length) return null;
  return scans.reduce((best, scan) => Math.abs(scan.time - time) < Math.abs(best.time - time) ? scan : best);
}

function qtofAcquiredPrecursors(scans, parentId) {
  return scans.filter(scan => scan.parent_scan_id === parentId);
}

function qtofStickTrace(spectrum) {
  const x = [], y = [];
  spectrum.mz.forEach((mz, i) => { x.push(mz, mz, null); y.push(0, spectrum.intensities[i], null); });
  return { x, y, type: 'scatter', mode: 'lines', line: { color: '#555', width: 1 },
    name: 'Measured centroids', hovertemplate: 'm/z %{x:.5f}<br>Intensity %{y:.3f}<extra></extra>' };
}

async function qtofDraw(id, spectrum, precursors = []) {
  const traces = [qtofStickTrace(spectrum)];
  if (precursors.length) {
    const height = spectrum.intensities.reduce((max, value) => Math.max(max, value), 1) * 1.07;
    traces.push({ x: precursors.map(p => p.precursor_mz), y: precursors.map(() => height),
      customdata: precursors.map(p => p.scan_id), type: 'scatter', mode: 'markers',
      marker: { color: '#1f77b4', size: 10, symbol: 'diamond' }, name: 'Acquired MS/MS precursor',
      hovertemplate: 'Acquired precursor %{x:.5f}<br>Click for MS/MS scan %{customdata}<extra></extra>' });
  }
  await Plotly.react(id, traces, { ...WEBAPP_LAYOUT, height: 330,
    title: { text: `Measured MS${spectrum.ms_level === 2 ? '/MS' : '1'} · scan ${spectrum.scan_id} · ${spectrum.time.toFixed(4)} min`, font: { size: 13 } },
    showlegend: false, xaxis: { ...WEBAPP_LAYOUT.xaxis, title: 'm/z', showgrid: false },
    yaxis: { ...WEBAPP_LAYOUT.yaxis, title: 'Intensity', rangemode: 'tozero', showgrid: false },
  }, PLOT_CONFIG);
}

function qtofClearPlot(id) {
  const node = document.getElementById(id);
  Plotly.purge(node);
  node.replaceChildren();
}

function qtofReset() {
  qtofViewer.generation += 1;
  qtofViewer.path = '';
  qtofViewer.scans = null;
  for (const id of ['qtof-survey-select', 'qtof-fragment-select']) {
    const select = document.getElementById(id);
    select.replaceChildren(); select.disabled = true;
  }
  document.getElementById('btn-qtof-time').disabled = true;
  document.getElementById('qtof-time').value = '';
  document.getElementById('qtof-fragment-status').textContent = 'No MS/MS scan selected.';
  qtofClearPlot('qtof-ms1-plot'); qtofClearPlot('qtof-ms2-plot');
}

function qtofOptions(id, scans, label) {
  const select = document.getElementById(id);
  select.replaceChildren();
  const blank = document.createElement('option');
  blank.value = ''; blank.textContent = '-- Select an acquired scan --'; select.appendChild(blank);
  scans.forEach(scan => {
    const option = document.createElement('option');
    option.value = String(scan.scan_id); option.textContent = label(scan); select.appendChild(option);
  });
  select.disabled = !scans.length;
}

async function qtofShowSurvey(scanId) {
  if (!qtofViewer.scans || !Number.isInteger(scanId)) return;
  const generation = ++qtofViewer.generation;
  qtofClearPlot('qtof-ms1-plot'); qtofClearPlot('qtof-ms2-plot');
  document.getElementById('qtof-fragment-select').value = '';
  document.getElementById('qtof-fragment-status').textContent = 'Loading MS1 scan…';
  try {
    const spectrum = await api.getQtofSpectrum(qtofViewer.path, scanId, qtofViewer.polarity);
    if (generation !== qtofViewer.generation) return;
    const precursors = qtofAcquiredPrecursors(qtofViewer.scans.ms2, scanId);
    document.getElementById('qtof-survey-select').value = String(scanId);
    document.getElementById('qtof-time').value = spectrum.time.toFixed(4);
    document.getElementById('qtof-fragment-status').textContent = precursors.length
      ? `${precursors.length} acquired MS/MS scan(s) linked to this MS1 scan. Click a blue diamond.`
      : 'No MS/MS acquired from this MS1 scan. Choose another scan or use the acquired MS/MS list.';
    await qtofDraw('qtof-ms1-plot', spectrum, precursors);
    if (generation !== qtofViewer.generation) return;
    document.getElementById('qtof-ms1-plot').on('plotly_click', event => {
      const id = event.points?.[0]?.customdata;
      if (Number.isInteger(id)) qtofShowFragment(id);
    });
  } catch (error) {
    if (generation === qtofViewer.generation) document.getElementById('qtof-fragment-status').textContent = error.message;
  }
}

async function qtofShowFragment(scanId) {
  const meta = qtofViewer.scans?.ms2.find(scan => scan.scan_id === scanId);
  if (!meta) return;
  // Changing a fragment also shows its recorded parent, never a nearest guess.
  if (meta.parent_scan_id !== null && document.getElementById('qtof-survey-select').value !== String(meta.parent_scan_id)) {
    const before = qtofViewer.generation;
    await qtofShowSurvey(meta.parent_scan_id);
    if (qtofViewer.generation !== before + 1) return;
  }
  const generation = ++qtofViewer.generation;
  qtofClearPlot('qtof-ms2-plot');
  document.getElementById('qtof-fragment-status').textContent = 'Loading measured MS/MS scan…';
  if (meta.parent_scan_id === null) {
    qtofClearPlot('qtof-ms1-plot');
    document.getElementById('qtof-survey-select').value = '';
    document.getElementById('qtof-time').value = '';
  }
  try {
    const spectrum = await api.getQtofSpectrum(qtofViewer.path, scanId, qtofViewer.polarity);
    if (generation !== qtofViewer.generation) return;
    document.getElementById('qtof-fragment-select').value = String(scanId);
    document.getElementById('qtof-fragment-status').textContent =
      `Measured MS/MS · precursor ${meta.precursor_mz.toFixed(5)} m/z · ${meta.time.toFixed(4)} min · collision energy ${meta.collision_energy.toFixed(2)} eV` +
      (meta.parent_scan_id === null ? ' · No recorded MS1 parent is available.' : '') +
      (!spectrum.mz.length ? ' · This acquired scan contains no centroid peaks.' : '');
    await qtofDraw('qtof-ms2-plot', spectrum);
  } catch (error) {
    if (generation === qtofViewer.generation) document.getElementById('qtof-fragment-status').textContent = error.message;
  }
}

async function qtofOpen() {
  qtofReset();
  const path = document.getElementById('qtof-sample-select').value;
  const status = document.getElementById('qtof-status');
  if (!path) { status.textContent = 'Select a QTOF sample first.'; return; }
  const generation = qtofViewer.generation;
  const polarity = document.getElementById('qtof-polarity').value;
  status.textContent = 'Reading acquired QTOF scans…';
  try {
    const scans = await api.getQtofScans(path, polarity);
    if (generation !== qtofViewer.generation) return;
    Object.assign(qtofViewer, { path, polarity, scans });
    qtofOptions('qtof-survey-select', scans.ms1, s => `${s.time.toFixed(4)} min · MS1 #${s.scan_id}`);
    qtofOptions('qtof-fragment-select', scans.ms2, s => `${s.precursor_mz.toFixed(5)} m/z · ${s.time.toFixed(4)} min · #${s.scan_id}`);
    document.getElementById('btn-qtof-time').disabled = !scans.ms1.length;
    status.textContent = `${scans.instrument} · ${scans.ms1.length} MS1 scans · ${scans.ms2.length} measured MS/MS scans (${polarity}).` +
      (!scans.ms2.length ? ' No MS/MS was acquired in this channel.' : '');
    const firstFragment = scans.ms2.find(s => s.parent_scan_id !== null);
    const firstId = firstFragment?.parent_scan_id ?? scans.ms1[0]?.scan_id;
    if (firstId !== undefined) await qtofShowSurvey(firstId);
  } catch (error) {
    if (generation === qtofViewer.generation) status.textContent = error.message;
  }
}

function initQtofViewer() {
  document.getElementById('btn-load-qtof').addEventListener('click', qtofOpen);
  for (const id of ['qtof-sample-select', 'qtof-polarity']) {
    document.getElementById(id).addEventListener('change', () => {
      qtofReset(); document.getElementById('qtof-status').textContent = 'Click Open spectra to load this selection.';
    });
  }
  document.getElementById('qtof-survey-select').addEventListener('change', event => {
    if (event.target.value) qtofShowSurvey(Number(event.target.value));
  });
  document.getElementById('qtof-fragment-select').addEventListener('change', event => {
    if (event.target.value) qtofShowFragment(Number(event.target.value));
  });
  document.getElementById('btn-qtof-time').addEventListener('click', () => {
    const time = document.getElementById('qtof-time').value;
    const scan = time !== '' && qtofNearestSurvey(qtofViewer.scans?.ms1 || [], Number(time));
    if (scan) qtofShowSurvey(scan.scan_id);
  });
}
