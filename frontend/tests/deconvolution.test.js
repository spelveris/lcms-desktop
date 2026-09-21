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

test('intact metadata enables an explicit option but keeps the previous calculation as default',()=>{
 const {run,elements}=fixture();
 elements.set('deconv-isotope-workflow',{});elements.set('expert-params',{});
 elements.set('deconv-method-wrap',{});elements.set('deconv-intact-method',{dataset:{},value:'envelope'});
 const before=JSON.stringify(run("getCurrentDeconvolutionParameters('old.sirslt')"));
 run("state.loadedSamples['qtof.sirslt']={isotope_aware_intact:true};syncDeconvMwAlgorithmDefault('qtof.sirslt')");
 assert.equal(elements.get('deconv-method-wrap').hidden,false);
 assert.equal(elements.get('deconv-isotope-workflow').hidden,true);assert.equal(elements.get('expert-params').hidden,false);
 assert.equal(JSON.stringify(run("getCurrentDeconvolutionParameters('qtof.sirslt')")),before);
 elements.get('deconv-intact-method').value='isotope';run("syncDeconvMwAlgorithmDefault('qtof.sirslt')");
 const q=run("getCurrentDeconvolutionParameters('qtof.sirslt')");assert.equal(q.min_charge,2);assert.equal(q.fwhm,0);assert.equal(q.intact_method,'isotope');
 assert.equal(elements.get('expert-params').hidden,true);
 assert.equal(run("getCurrentDeconvolutionParameters('other.sirslt').intact_method"),'envelope');
 run("syncDeconvMwAlgorithmDefault('old.sirslt')");assert.equal(elements.get('expert-params').hidden,false);
 assert.equal(JSON.stringify(run("getCurrentDeconvolutionParameters('old.sirslt')")),before);
});

test('raw inspection does not replace the summed calculation spectrum or round measured values',()=>{
 const {run,elements,context}=fixture();
 context.data={workflow:{id:'qtof-envelope'},spectrum:{mz:[500.123],intensities:[30]},measured_spectrum:{mz:[500.123456789,500.123456799],intensities:[10,20]}};
 elements.set('deconv-spectrum-view',{value:'summed'});
 assert.equal(run('getDisplayedDeconvSpectrum(data)'),context.data.spectrum);
 elements.get('deconv-spectrum-view').value='measured';
 assert.equal(run('getDisplayedDeconvSpectrum(data)'),context.data.measured_spectrum);
 assert.equal(context.data.spectrum.mz[0],500.123);
 assert.equal(run('getDisplayedDeconvSpectrum(data).mz[1]'),500.123456799);
 context.data.workflow.id='qtof-isotope-aware';assert.equal(run('getDisplayedDeconvSpectrum(data)'),context.data.spectrum);
});

test('an older analysis response cannot overwrite a newly selected intact method',async()=>{
 const {run,elements,context}=fixture();
 for(const [id,value] of [['deconv-sample-select','sample'],['deconv-start','1'],['deconv-end','2']])elements.set(id,{value});
 elements.set('expert-mode-toggle',{checked:false});
 const pending=[];context.api={runDeconvolution:()=>new Promise(resolve=>pending.push(resolve))};
 context.rendered=[];
 run('buildActiveDeconvolutionRequest=()=>({start_time:1,end_time:2});setDeconvolutionBusy=()=>{};showLoading=()=>{};hideLoading=()=>{};toast=()=>{};renderReportSummary=()=>{};renderDeconvResults=data=>rendered.push(data.id)');
 const first=run('runDeconvolution()'), second=run('runDeconvolution()');
 pending[1]({id:'new',components:[]});await second;
 pending[0]({id:'old',components:[]});await first;
 assert.deepEqual(context.rendered,['new']);assert.equal(run('state.deconvResults.id'),'new');
});

test('isotope profile bypasses projection and preserves measured and derived decimals',()=>{
 const {run,context,plots}=fixture();context.spectrum={mz:[500.123456789],intensities:[100],isotope_profile:[{mass:3992.929442579032,mz:500.123456789,intensity:100,charge:8,scan_id:4}]};
 run('charts.plotDenseDeconvolutedMassProfile("isotopes",spectrum,{style:{deconv_x_min_da:3990,deconv_x_max_da:4000}})');
 const plot=plots.get('isotopes');assert.deepEqual(JSON.parse(JSON.stringify(plot.data[0].x)),[3992.929442579032,3992.929442579032,null]);
 assert.match(plot.data[0].text[0],/500.123456789/);assert.match(plot.layout.xaxis.title,/Neutral isotope mass/);
 run('charts.plotMassSpectrum("raw",spectrum.mz,spectrum.intensities,[],{centroidSticks:true})');
 assert.deepEqual(JSON.parse(JSON.stringify(plots.get('raw').data[0].x)),[500.123456789,500.123456789,null]);
 assert.equal(context.spectrum.mz.length,1);
});

test('mass spectrum labels retain all supplied decimals through zoom and full hover text, without changing data',()=>{
 const {run,context,plots}=fixture();context.mz=[900,955.467601234567,980,1001.12345678,1100];context.intensities=[0,100,0,80,0];
 for(const range of ['[900,1100]','[950,960]']){
  const labels=run(`buildAdaptiveMassSpectrumAnnotations(mz,intensities,[],${range},900)`);
  assert.equal(labels[0].text,'955.467601234567');assert.equal(labels[0].x,context.mz[1]);
 }
 run('charts.plotMassSpectrum("spectrum",mz,intensities,[])');
 const trace=plots.get('spectrum').data[0];assert.equal(trace.text[1],'955.467601234567');
 assert.match(trace.hovertemplate,/%\{text\}/);assert.equal(trace.x,context.mz);assert.equal(trace.y,context.intensities);
 assert.equal(run('formatSpectrumMz(955.4670000000001,0.001)'),'955.467');
 assert.equal(run('formatSpectrumMz(955.467601234567,0.001)'),'955.467601234567');
 assert.equal(run('formatSpectrumMz(955,0.001)'),'955.000');
 const labels=run('buildAdaptiveMassSpectrumAnnotations([955.466,955.4670000000001,955.468],[0,100,0],[],null,900,0.001)');
 assert.equal(labels[0].text,'955.467');
});

test('long m/z peak labels reserve their text width instead of colliding',()=>{
 const {run}=fixture();const labels=run('buildAdaptiveMassSpectrumAnnotations([900,955.123456789012,956,958.123456789012,970],[0,100,0,90,0],[],[950,970],400)');
 assert.equal(labels.length,1);assert.equal(labels[0].text,'955.123456789012');
});

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

test('sidebar/window resize includes the peptide spectrum and preserves its canvas height',()=>{
  const {run,context,elements}=fixture();const sizes=[];
  context.setTimeout=callback=>callback();
  context.window.Plotly={relayout:(el,size)=>sizes.push(size),Plots:{resize(){}}};
  const plot={classList:{contains:()=>true},dataset:{fixedPlotHeight:'430'},clientWidth:900,clientHeight:430,style:{}};
  elements.set('peptide-spectrum-plot',plot);
  run('schedulePlotlyResize()');
  assert.equal(sizes.length,3);assert.ok(sizes.every(size=>size.width===900&&size.height===430));
  sizes.length=0;plot.clientWidth=480;run('schedulePlotlyResize()');
  assert.equal(sizes.length,3);assert.ok(sizes.every(size=>size.width===480&&size.height===430));
  assert.equal(plot.style.height,'430px');
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
