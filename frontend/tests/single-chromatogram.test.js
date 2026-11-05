const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const nodes = new Map(), requests = [], downloads = [], messages = [];
  class Element {
    constructor(tag = 'div') {
      this.tag = tag; this.children = []; this.dataset = {}; this.style = {};
      this.listeners = {}; this.attributes = {}; this.value = ''; this.checked = false;
      this.className = ''; this.disabled = false;
    }
    set innerHTML(value) { this.html = value; this.children = []; }
    get innerHTML() { return this.html || ''; }
    appendChild(child) { this.children.push(child); if (child.id) nodes.set(child.id, child); return child; }
    addEventListener(event, callback) { this.listeners[event] = callback; }
    setAttribute(name, value) { this.attributes[name] = value; }
  }
  for (const id of ['single-sample-select', 'single-metrics', 'single-uv-plots', 'single-tic-plot',
    'single-eic-plots', 'fig-width', 'line-width', 'show-grid', 'mass-axis-min', 'mass-axis-max', 'export-dpi',
    'deconv-start','deconv-end','deconv-uv-plot','deconv-tic-plot','deconv-uv-downloads','deconv-tic-downloads','uv-smoothing']) {
    nodes.set(id, new Element());
  }
  nodes.get('single-sample-select').value = '/data/first.sirslt';
  nodes.get('fig-width').value = '6'; nodes.get('line-width').value = '.8';
  const response = () => ({headers: {get: () => null}, blob: async () => Buffer.from('export')});
  const context = vm.createContext({console, setTimeout, clearTimeout,
    localStorage: {getItem: () => null}, window: {},
    document: {getElementById: id => nodes.get(id) || null,
      createElement: tag => new Element(tag), addEventListener() {}, querySelectorAll: () => []},
    api: {exportSingleChromatogram: async payload => { requests.push(JSON.parse(JSON.stringify(payload))); return response(); }},
    Plotly: {}, requests, downloads, messages,
  });
  for (const file of ['charts.js', 'app.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../js', file), 'utf8'), context);
  const run = code => vm.runInContext(code, context);
  run(`setSingleEmptyState=()=>{};schedulePlotlyResize=()=>{};renderSingleInteractiveTicPlot=()=>{};
    renderSingleSummedSpectrumPlaceholder=()=>{};charts.plotUV=()=>{};
    showLoading=()=>{};hideLoading=()=>{};toast=(...args)=>messages.push(args);
    downloadBlob=(blob,name)=>downloads.push({blob,name});
    state.loadedSamples['/data/first.sirslt']={name:'first.sirslt',has_ms_neg:true};`);
  return {nodes, context, run, requests, downloads, response, messages};
}

test('Deconvolution downloads export each complete displayed trace with its saved selection and standard axis size',async()=>{
  for(const background of [false,true]){
    const {nodes,context,run,requests,downloads}=fixture();
    nodes.get('deconv-start').value='.05';nodes.get('deconv-end').value='.2';nodes.get('uv-smoothing').value='1';
    context.api.getUVChromatogram=async()=>uv[0];context.api.getTIC=async()=>({times:tic.times,intensities:tic.intensities});
    context.api.runBackgroundSubtraction=async()=>({uv:{wavelengths:uv},tic:{times:tic.times,intensities:tic.intensities}});
    run(`state.loadedSamples['/data/first.sirslt'].uv_wavelengths=[278];
      getSelectedWavelengths=()=>[278];getSelectedDeconvBackgroundPath=()=>${background?'"/background.sirslt"':'""'};
      setDeconvEmptyState=()=>{};charts.plotChromatogramWithWindow=()=>{};bindDeconvWindowDragSelection=()=>{};`);
    await run('refreshDeconvWindowContext("/data/first.sirslt")');
    nodes.get('deconv-start').value='9';nodes.get('single-sample-select').value='/data/other.sirslt';
    for(const kind of ['uv','tic']){
      const host=nodes.get(`deconv-${kind}-downloads`);assert.equal(host.hidden,false);
      const buttons=host.children[0].children;assert.equal(buttons.length,3);
      assert.match(buttons[0].innerHTML, /<svg class="chromatogram-download-icon"[^>]*aria-hidden="true"[^>]*>.*<span>Download PDF<\/span>/);
      assert.match(buttons[1].innerHTML, /<svg class="chromatogram-download-icon"[^>]*aria-hidden="true"[^>]*>.*<span>Download JPG<\/span>/);
      assert.equal(buttons[2].textContent, 'Download CSV');
      for(const button of buttons)await button.listeners.click();
    }
    assert.deepEqual(requests.map(r=>r.format),['pdf','jpg','csv','pdf','jpg','csv']);
    for(const r of requests){
      assert.equal(r.style.x_axis_width_multiplier,1);
      assert.deepEqual(r.style.selection_window,{start:.05,end:.2});
      assert.equal(r.sample_name,'first');assert.match(r.filename_base,/_deconv_/);
      assert.equal(r.background_subtracted===true,background);
      assert.deepEqual(r.traces[0].times,r.kind==='uv'?uv[0].times:tic.times);
      assert.deepEqual(r.traces[0].intensities,r.kind==='uv'?uv[0].intensities:tic.intensities);
    }
    assert.equal(downloads.length,6);
    run('clearDeconvContextDownloads()');
    assert.equal(nodes.get('deconv-uv-downloads').hidden,true);assert.equal(nodes.get('deconv-uv-downloads').children.length,0);
  }
});

test('an earlier chromatogram load cannot replace the new graph downloads, and missing channels hide their buttons',async()=>{
  const {nodes,context,run,requests}=fixture();const pending=[];
  nodes.get('deconv-start').value='.05';nodes.get('deconv-end').value='.2';
  context.api.getUVChromatogram=()=>new Promise(resolve=>pending.push(resolve));
  context.api.getTIC=async()=>({times:[],intensities:[]});
  run(`state.loadedSamples['/data/first.sirslt'].uv_wavelengths=[278];
    getSelectedWavelengths=()=>[278];getSelectedDeconvBackgroundPath=()=>'';
    setDeconvEmptyState=()=>{};charts.plotChromatogramWithWindow=()=>{};bindDeconvWindowDragSelection=()=>{};`);
  const first=run('refreshDeconvWindowContext("/data/first.sirslt")');
  nodes.get('deconv-start').value='.1';
  const second=run('refreshDeconvWindowContext("/data/first.sirslt")');
  pending[1]({...uv[0],intensities:[7,8,9]});await second;
  pending[0](uv[0]);await first;
  const host=nodes.get('deconv-uv-downloads');assert.equal(host.children.length,1);
  await host.children[0].children[2].listeners.click();
  assert.deepEqual(requests[0].traces[0].intensities,[7,8,9]);
  assert.deepEqual(requests[0].style.selection_window,{start:.1,end:.2});
  assert.equal(nodes.get('deconv-tic-downloads').hidden,true);
});

const uv = [{nm: 278, wavelength: 278, times: [0, .1234567890123, 1], intensities: [-.01, 2.3456789012345, .1]}];
const tic = {times: [0, .1, .2], intensities: [3, 4, 5], has_dual_polarity: true,
  times_pos: [0, .1, .2], intensities_pos: [3, 4, 5], times_neg: [.02, .14], intensities_neg: [7, 9]};

function windowControls(nodes) {
  for (const id of ['mz-window', 'mz-window-number']) {
    nodes.set(id, { value: '.5', listeners: {},
      addEventListener(event, callback) { this.listeners[event] = callback; } });
  }
  return { slider: nodes.get('mz-window'), number: nodes.get('mz-window-number') };
}

test('Single Sample EIC slider covers zero to one while the numeric field accepts larger windows', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.match(html, /id="mz-window" min="0" max="1" value="0.5" step="0.1"/);
  assert.doesNotMatch(html.match(/<input[^>]+id="mz-window-number"[^>]*>/)[0], /\bmax=/);
  const {run, nodes} = fixture();
  const {slider, number} = windowControls(nodes);
  run('initMzWindowControls()');
  for (let step = 0; step <= 10; step += 1) {
    slider.value = String(step / 10); slider.listeners.input();
    assert.equal(Number(number.value), step / 10);
    assert.equal(run('getMzWindow()'), step / 10);
  }
  number.value = '2.5'; number.listeners.input();
  assert.equal(Number(slider.value), 1);
  assert.equal(run('getMzWindow()'), 2.5);
  slider.value = '.3'; slider.listeners.input();
  assert.equal(run('getMzWindow()'), .3);
});

test('zero and manually entered EIC windows reach Single Sample analysis and PDF exports unchanged', async () => {
  for (const width of [0, 2.5]) {
    const {context, run, nodes, requests, response} = fixture();
    const {number} = windowControls(nodes); number.value = String(width);
    nodes.set('uv-smoothing', {value:'1'}); nodes.set('eic-smoothing', {value:'1'});
    context.document.querySelector = () => ({value:'positive'});
    context.api.getSingleSampleData = async payload => { requests.push(payload); return {}; };
    context.api.exportSingleSample = async payload => { requests.push(payload); return response(); };
    run(`getSelectedWavelengths=()=>[];renderSingleSample=()=>{};
      renderReportSummary=()=>{};getReportSettingsPayload=()=>({});`);
    await run('loadSingleSample()');
    // Edits after generation must not silently change the exported EIC.
    number.value = width === 0 ? '1' : '0';
    nodes.get('single-sample-select').value = '/data/other.sirslt';
    nodes.get('eic-smoothing').value = '9';
    await run('exportSingle("pdf")');
    await run('exportSingleCombinedEic("pdf")');
    assert.equal(requests.length, 3);
    assert.equal(requests[0].mzWindow, width);
    assert.equal(requests[1].mz_window, width);
    assert.equal(requests[2].mz_window, width);
    assert.equal(requests[1].path, '/data/first.sirslt');
    assert.equal(requests[2].path, '/data/first.sirslt');
    assert.equal(requests[1].settings.eic_smoothing, 1);
  }
});

test('UV and each TIC have their own downloads directly beneath the corresponding graph', () => {
  const {context, run, nodes} = fixture(); context.data = {uv: {wavelengths: uv}, tic};
  run('renderSingleSample(data)');
  const uvChildren = nodes.get('single-uv-plots').children;
  assert.equal(uvChildren[0].id, 'uv-plot-0');
  assert.equal(uvChildren[1].dataset.plotId, 'uv-plot-0');
  assert.deepEqual(uvChildren[1].children.map(b => b.textContent), ['Download CSV', 'Download PDF', 'Download PNG']);
  const ticChildren = nodes.get('single-tic-plot').children;
  assert.equal(ticChildren[0].id, 'single-tic-pos-plot');
  assert.equal(ticChildren[1].dataset.plotId, 'single-tic-pos-plot');
  assert.equal(ticChildren[2].id, 'single-spectrum-pos-plot');
  assert.equal(ticChildren[3].id, 'single-tic-neg-plot');
  assert.equal(ticChildren[4].dataset.plotId, 'single-tic-neg-plot');
  assert.equal(ticChildren[5].id, 'single-spectrum-neg-plot');
});

test('positive and negative buttons export only their own full arrays and matching labels', async () => {
  const {context, run, nodes, requests, downloads} = fixture(); context.data = {uv: {wavelengths: uv}, tic};
  run('renderSingleSample(data)');
  await nodes.get('single-tic-plot').children[1].children[0].listeners.click();
  await nodes.get('single-tic-plot').children[4].children[1].listeners.click();
  assert.equal(requests[0].format, 'csv'); assert.equal(requests[0].polarity, 'positive');
  assert.deepEqual(requests[0].traces[0].times, tic.times_pos);
  assert.deepEqual(requests[0].traces[0].intensities, tic.intensities_pos);
  assert.equal(requests[1].format, 'pdf'); assert.equal(requests[1].polarity, 'negative');
  assert.deepEqual(requests[1].traces[0].times, tic.times_neg);
  assert.deepEqual(requests[1].traces[0].intensities, tic.intensities_neg);
  assert.equal(requests[1].style.fig_width, 6); assert.equal(requests[1].style.line_width, .8);
  assert.equal(downloads.length, 2);
  assert.match(downloads[0].name, /first_tic_positive.csv$/);
  assert.match(downloads[1].name, /first_tic_negative.pdf$/);
});

test('combined and individual UV downloads preserve every wavelength and its independent time axis', async () => {
  const {context, run, nodes, requests} = fixture();
  const wavelengths = [...uv, {nm: 214, times: [.2, .7], intensities: [4, 5]}, {nm: 254, times: [.3], intensities: [6]}];
  context.data = {uv: {wavelengths}}; run('renderSingleSample(data)');
  const children = nodes.get('single-uv-plots').children;
  assert.equal(children.length, 8);
  await children[1].children[0].listeners.click();
  assert.equal(requests[0].traces.length, 3);
  assert.deepEqual(requests[0].traces[1].times, [.2, .7]);
  assert.deepEqual(requests[0].traces[0].intensities, uv[0].intensities);
  await children[5].children[2].listeners.click();
  assert.equal(requests[1].format, 'png'); assert.equal(requests[1].traces.length, 1);
  assert.equal(requests[1].traces[0].nm, 214);
});

test('an existing plot downloads its loaded sample even if the selection has changed', async () => {
  const {context, run, nodes, requests, downloads} = fixture();
  context.data = {uv: {wavelengths: uv}}; run('renderSingleSample(data)');
  nodes.get('single-sample-select').value = '/data/second.sirslt';
  run('state.singleSampleData={uv:{wavelengths:[]}}');
  await nodes.get('single-uv-plots').children[1].children[0].listeners.click();
  assert.equal(requests[0].sample_name, 'first');
  assert.deepEqual(requests[0].traces[0].times, uv[0].times);
  assert.match(downloads[0].name, /^first_uv_278nm.csv$/);
});

test('duplicate clicks are ignored during export and an error restores all buttons', async () => {
  const {context, run, nodes, requests, messages} = fixture();
  let reject;
  const pending = new Promise((_, fail) => { reject = fail; });
  context.api.exportSingleChromatogram = data => { requests.push(data); return pending; };
  context.data = {uv: {wavelengths: uv}}; run('renderSingleSample(data)');
  const row = nodes.get('single-uv-plots').children[1];
  const first = row.children[0].listeners.click();
  await row.children[1].listeners.click();
  assert.equal(requests.length, 1); assert.ok(row.children.every(b => b.disabled));
  reject(new Error('temporary failure')); await first;
  assert.ok(row.children.every(b => !b.disabled));
  assert.match(messages[0][0], /temporary failure/);
});

test('a negative-only run is labeled accurately and clearing the plots removes downloads', async () => {
  const {context, run, nodes, requests} = fixture();
  context.data = {tic: {times: [.3, .5], intensities: [6, 7], polarity: 'negative'}};
  run('renderSingleSample(data)');
  await nodes.get('single-tic-plot').children[1].children[0].listeners.click();
  assert.equal(requests[0].polarity, 'negative');
  run('resetSingleSampleView()');
  assert.equal(nodes.get('single-tic-plot').children.length, 0);
  assert.equal(nodes.get('single-uv-plots').children.length, 0);
});
