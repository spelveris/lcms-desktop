const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');

function fixture() {
  const elements = new Map();
  const plots = new Map();
  const context = vm.createContext({
    console, setTimeout, clearTimeout,
    localStorage: { getItem() { return null; } },
    document: { addEventListener() {}, getElementById(id) { return elements.get(id) || null; } },
    window: {},
    Plotly: { newPlot(id, data, layout) { plots.set(id, { data, layout }); return { then() {} }; } },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'js/charts.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'js/app.js'), 'utf8'), context);
  return { context, elements, plots, run: (code) => vm.runInContext(code, context) };
}

test('guides retain component identity, deduplicate per mass, and exclude out-of-range ions', () => {
  const { run } = fixture();
  const guides = run(`computeMassSpectrumGuideMzs([100, 1000], [
    {mass: 1000, ion_mzs: [200, 200, 50, 1100, NaN]},
    {mass: 2000, ion_mzs: [200, 500]},
    {mass: 1800, charge_states: [2, 3, 0]}
  ])`);
  assert.deepEqual(JSON.parse(JSON.stringify(guides)), [
    { mz: 200, componentIndex: 0, mass: 1000 },
    { mz: 200, componentIndex: 1, mass: 2000 },
    { mz: 500, componentIndex: 1, mass: 2000 },
    { mz: 901.00784, componentIndex: 2, mass: 1800 },
    { mz: 601.00784, componentIndex: 2, mass: 1800 },
  ]);
  assert.equal(run('computeMassSpectrumGuideMzs([], []).length'), 0);
});

test('m/z dashed guides, mass stems, labels and ion selection share the same colours', () => {
  const { run, plots } = fixture();
  run(`
    const comps = [
      {mass: 10000, intensity: 100, ion_mzs: [200], ion_charges: [50]},
      {mass: 15000, intensity: 70, ion_mzs: [300], ion_charges: [50]},
      {mass: 20000, intensity: 50, ion_mzs: [400], ion_charges: [50]}
    ];
    const mz = [100,200,300,400,500];
    const intensities = [0,100,70,50,0];
    charts.plotMassSpectrum('spectrum', mz, intensities, [], { guideMzs: computeMassSpectrumGuideMzs(mz, comps) });
    charts.plotDeconvMasses('masses', comps);
    charts.plotIonSelectionInteractive('ions', mz, intensities, comps);
  `);
  const guides = plots.get('spectrum').layout.shapes;
  const masses = plots.get('masses');
  const ions = plots.get('ions').data.filter((trace) => trace.line?.width === 1.6);
  assert.equal(new Set(guides.map((guide) => guide.line.color)).size, 3);
  guides.forEach((guide, i) => {
    assert.equal(guide.line.dash, 'dash');
    assert.equal(guide.line.color, masses.data[i].line.color);
    assert.equal(guide.line.color, masses.layout.annotations[i].font.color);
    assert.equal(guide.line.color, ions[i].line.color);
  });
});

test('both second-row plots keep equal heights independently of wrapped download controls', () => {
  const { run, elements } = fixture();
  for (const id of ['deconv-spectrum-plot', 'deconv-mass-plot']) elements.set(id, { style: {}, dataset: {} });
  run('syncDeconvBottomLayout()');
  for (const element of elements.values()) {
    assert.equal(element.style.height, '400px');
    assert.equal(element.dataset.fixedPlotHeight, '400');
  }
});

test('existing download controls and all export formats are preserved', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const section = html.slice(html.indexOf('id="deconv-results"'), html.indexOf('<!-- Tab: Batch Deconvolution -->'));
  assert.equal((section.match(/id="btn-export-deconv-spectrum-pdf"/g) || []).length, 1);
  const formats = [...section.matchAll(/btn-export-deconv-masses" data-format="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(formats.sort(), ['pdf', 'pdf-dense', 'pdf-side-by-side', 'pdf-wide', 'png', 'svg']);
  assert.equal((section.match(/btn-export-ion-selection"/g) || []).length, 3);
});

test('mass-spectrum PDF payload remains clean, with no screen-only guides or colours', async () => {
  const { run, context, elements } = fixture();
  elements.set('export-dpi', { value: '300' });
  let payload, filename;
  context.api = { exportDeconvolutionSpectrum: async (value) => { payload = JSON.parse(JSON.stringify(value)); return {}; } };
  context.captureDownload = (_blob, name) => { filename = name; };
  run(`
    state.deconvSamplePath = '/samples/test.D';
    state.deconvResults = { spectrum: { mz: [100, 200], intensities: [10, 20] } };
    showLoading = hideLoading = toast = () => {};
    buildCurrentDeconvStyle = () => ({ fig_width: 8 });
    backendResponseToBlob = async () => 'blob';
    downloadBlob = captureDownload;
  `);
  await run('exportDeconvSpectrumPdf()');
  assert.deepEqual(payload, { sample_name: 'test.D', spectrum: { mz: [100, 200], intensities: [10, 20] }, title: 'Mass Spectrum', format: 'pdf', dpi: 300, style: { fig_width: 8 } });
  assert.equal(filename, 'test_mass_spectrum.pdf');
});

test('UV defaults select recorded QTOF 214 nm and preserve the legacy 194 nm default',()=>{
  const {run}=fixture();
  assert.deepEqual(JSON.parse(JSON.stringify(run('uvWavelengthChoices({qtof:{uv_wavelengths:[278,214]}},[])'))),
    [{value:214,checked:true},{value:278,checked:false}]);
  assert.equal(run('preferredUvWavelength({uv_wavelengths:[194,280]},[])'),194);
  assert.equal(run('preferredUvWavelength({uv_wavelengths:[278,214]},[194])'),214);
  assert.equal(run('preferredUvWavelength({uv_wavelengths:[214,278]},[194,278])'),278);
  assert.equal(run('preferredUvWavelength({uv_wavelengths:[214,278]},[280])'),278);
  assert.equal(run('preferredUvWavelength({uv_wavelengths:[]},[194])'),undefined);
});

test('refreshing UV choices preserves user selections, including deliberately unchecked channels',()=>{
  const {run}=fixture();
  assert.equal(run('uvWavelengthChoices({sample:{uv_wavelengths:[214,278]}},[{value:"214",checked:false},{value:"278",checked:true}])[1].checked'),true);
  assert.equal(run('uvWavelengthChoices({sample:{uv_wavelengths:[214,278]}},[{value:"214",checked:false},{value:"278",checked:false}]).some(option=>option.checked)'),false);
  const mixed=JSON.parse(JSON.stringify(run('uvWavelengthChoices({legacy:{uv_wavelengths:[194,280]},qtof:{uv_wavelengths:[214,278]}},[{value:"194",checked:true},{value:"280",checked:false}])')));
  assert.deepEqual(mixed.filter(option=>option.checked).map(option=>option.value),[194,214]);
});

test('UV area calculation chooses a recorded channel for the selected sample',()=>{
  const {run}=fixture();
  run('state.loadedSamples={qtof:{uv_wavelengths:[278,214]}};getSelectedWavelengths=()=>[194];');
  assert.equal(run('getAreaCalculationWavelength("qtof")'),214);
  assert.ok(Number.isNaN(run('getAreaCalculationWavelength("missing")')));
});

test('UV Time Change uses a shared recorded wavelength rather than another instruments default',async()=>{
  const {run}=fixture();
  run('state.selectedFiles=[{path:"a"},{path:"b"}];state.loadedSamples={a:{uv_wavelengths:[214,278]},b:{uv_wavelengths:[214,278]}};getSelectedWavelengths=()=>[194];');
  assert.equal(await run('resolveTimeChangeUvWavelength()'),214);
  run('state.loadedSamples.b.uv_wavelengths=[194,280]');
  assert.ok(Number.isNaN(await run('resolveTimeChangeUvWavelength()')));
});

test('Deconvolution requests QTOF UV instead of an unavailable wavelength from another instrument',async()=>{
  const {run,context,elements}=fixture();
  for(const [id,value] of [['deconv-start','0'],['deconv-end','5'],['uv-smoothing','0']])elements.set(id,{value});
  elements.set('deconv-uv-plot',{});elements.set('deconv-tic-plot',{});
  let requested;
  context.api={getUVChromatogram:async(path,wavelength)=>{requested=wavelength;return{times:[0,1],intensities:[1,2]};},getTIC:async()=>({times:[],intensities:[]})};
  run(`state.loadedSamples={qtof:{uv_wavelengths:[214,278]}};getSelectedWavelengths=()=>[194];
    getSelectedDeconvBackgroundPath=()=>'';setDeconvEmptyState=()=>{};
    charts.plotChromatogramWithWindow=()=>{};bindDeconvWindowDragSelection=()=>{};schedulePlotlyResize=()=>{};`);
  await run('refreshDeconvWindowContext("qtof")');
  assert.equal(requested,214);
});
