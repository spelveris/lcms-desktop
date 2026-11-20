const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture({ renderPlots = false } = {}) {
  const nodes = new Map(), requests = [], exports = [], downloads = [], plots = [], messages = [];
  for (const [id, value] of Object.entries({
    'timechange-eic-mz':'247.1', 'timechange-eic-polarity':'positive',
    'timechange-eic-window-number':'.5', 'timechange-eic-window':'.5',
    'mz-window-number':'3', 'mz-window':'1', 'eic-smoothing':'1', 'uv-smoothing':'0',
    'btn-run-time-change-ms':'', 'timechange-normalize':'', 'export-dpi':'300',
    'timechange-overlap-downloads':'', 'timechange-offset-downloads':'', 'timechange-overlap-pdf-label':'',
    'timechange-overlap-jpg-label':'', 'timechange-overlap-csv-label':'',
    'btn-export-timechange-overlap-pdf':'', 'btn-export-timechange-ms-pdf':'',
    'btn-export-timechange-overlap-jpg':'', 'btn-export-timechange-overlap-csv':'',
    'btn-export-timechange-offset-jpg':'', 'btn-export-timechange-offset-csv':'',
    'btn-export-timechange-tic-pdf':'', 'btn-export-timechange-eic-pdf':'', 'btn-export-timechange-uv-pdf':'',
    'btn-export-timechange-eic-names-pdf':'',
    'timechange-ms-plot':'', 'timechange-ms-offset-plot':'', 'timechange-ms-table-container':'',
    'timechange-axis-error':'', 'btn-timechange-reset-axes':'',
    'timechange-ms-y-min':'', 'timechange-ms-y-max':'',
    'timechange-tic-y-min':'', 'timechange-tic-y-max':'',
    'timechange-eic-y-min':'', 'timechange-eic-y-max':'',
    'timechange-uv-y-min':'', 'timechange-uv-y-max':'',
  })) nodes.set(id, {value, handlers:{}, addEventListener(name, handler) { this.handlers[name] = handler; }});
  const context = vm.createContext({console, setTimeout, clearTimeout, Blob,
    localStorage:{getItem:()=>null}, window:{},
    document:{addEventListener(){}, querySelectorAll:()=>[], getElementById:id=>nodes.get(id)||null},
    fetch:async (url, options={}) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/eic') {
        requests.push(parsed);
        const width = Number(parsed.searchParams.get('window'));
        return {ok:true, headers:{get:()=> 'application/json'},
          json:async()=>({times:[0,.5,1],intensities:[width,10+width,width]})};
      }
      if (parsed.pathname === '/api/uv-chromatogram') {
        requests.push(parsed);
        const wavelength = Number(parsed.searchParams.get('wavelength'));
        return {ok:true, headers:{get:()=> 'application/json'},
          json:async()=>({times:[0,.5,1],intensities:[1,wavelength,1],wavelength})};
      }
      assert.equal(parsed.pathname,'/api/export-time-change');
      exports.push(JSON.parse(options.body));
      return {ok:true,headers:{get:()=>null},blob:async()=>Buffer.from('PDF fixture')};
    }, downloads, messages,
    Plotly: {
      newPlot(id, traces, layout) {
        const plot = { id, traces, layout, _fullLayout: { yaxis: { range: layout.yaxis.range || [-2, 45] } } };
        plots.push(plot);
        return Promise.resolve(plot);
      },
      relayout(plot, updates) {
        plot.layout.yaxis.range = updates['yaxis.range'];
        plot.layout.yaxis.autorange = updates['yaxis.autorange'];
        return Promise.resolve(plot);
      },
    },
  });
  const run = source => vm.runInContext(source, context);
  for (const file of ['api.js','charts.js','app.js']) run(fs.readFileSync(path.join(__dirname,'../js',file),'utf8'));
  run(`const renderGeneratedTimeChangeMS=renderTimeChangeMS;
    showLoading=()=>{};hideLoading=()=>{};toast=(...args)=>messages.push(args);escapeHtml=value=>String(value);
    renderTimeChangeMS=()=>{};renderReportSummary=()=>{};
    buildCurrentDeconvStyle=()=>({fig_width:6,line_width:.8});
    downloadBlob=(blob,name)=>downloads.push({blob,name});
    state.selectedFiles=[{path:'/first.D',name:'first.D'},{path:'/second.D',name:'second.D'}];
    initTimeChangeMS();`);
  if (renderPlots) run('renderTimeChangeMS=renderGeneratedTimeChangeMS;setTimeChangeEmptyState=()=>{};');
  return {nodes,requests,exports,downloads,plots,messages,run,context};
}

test('Time Change has an independent window and retains zero and manually entered larger values', async () => {
  for (const width of [0,.1,1,2.5]) {
    const {nodes,requests,exports,run} = fixture();
    const number = nodes.get('timechange-eic-window-number');
    number.value=String(width); number.handlers.input();
    assert.equal(Number(nodes.get('timechange-eic-window').value),Math.min(width,1));
    assert.equal(await run('runTimeChangeMS("eic")'),true);
    assert.equal(run('state.timeChangeMSData.mzWindow'),width);
    await run('exportTimeChangeEICPdf()');
    assert.equal(requests.length,2); // Matching PDF uses the existing generated traces.
    assert.ok(requests.every(r=>Number(r.searchParams.get('window'))===width));
    assert.equal(exports[0].eic_settings.mz_window,width);
    assert.deepEqual(exports[0].traces[0].intensities,[width,10+width,width]);
    assert.equal(nodes.get('mz-window-number').value,'3');
  }
});

test('the Time Change UV choice controls extraction and stays with the generated exports', async () => {
  const {requests,exports,run} = fixture();
  run(`state.loadedSamples={
    '/first.D':{uv_wavelengths:[214,278]}, '/second.D':{uv_wavelengths:[214,278]}};
    getSelectedWavelengths=()=>[194];
    state.timeChangeUvWavelength=278;`);
  assert.equal(await run('runTimeChangeMS("uv")'), true);
  assert.ok(requests.every(request => request.searchParams.get('wavelength') === '278'));
  assert.equal(run('state.timeChangeMSData.wavelength'), 278);
  run('state.timeChangeUvWavelength=214');
  for (const format of ['jpg', 'csv']) {
    await run(`exportTimeChangeOffset("${format}", {view:"overlap"})`);
    assert.equal(exports.at(-1).style.uv_wavelength_nm, 278);
    assert.deepEqual(exports.at(-1).traces[0].intensities, [1,278,1]);
  }
  await run('exportTimeChangeUVPdf()');
  assert.equal(exports.at(-1).format, 'pdf');
  assert.equal(exports.at(-1).style.uv_wavelength_nm, 214);
  assert.deepEqual(exports.at(-1).traces[0].intensities, [1,214,1]);
  assert.equal(requests.length, 4);
  run('state.loadedSamples["/second.D"].uv_wavelengths=[194]');
  assert.equal(await run('runTimeChangeMS("uv")'), false);
  assert.equal(requests.length, 4);
});

test('PDF EIC regenerates when its local window changes; PNG and SVG retain the current plotted data', async () => {
  const {nodes,requests,exports,run,downloads} = fixture();
  await run('runTimeChangeMS("eic")');
  nodes.get('timechange-eic-window-number').value='0';
  await run('exportTimeChangeEICPdf()');
  assert.equal(requests.length,4);
  assert.equal(exports[0].eic_settings.mz_window,0);
  assert.deepEqual(exports[0].traces[0].intensities,[0,10,0]);
  nodes.get('timechange-eic-window-number').value='1';
  await run('exportTimeChangeOffset("png")');
  await run('exportTimeChangeOffset("svg")');
  assert.equal(requests.length,4);
  assert.deepEqual(exports.map(e=>e.format),['pdf','png','svg']);
  assert.ok(exports.every(e=>e.eic_settings.mz_window===0));
  await run('exportSessionJSON()');
  const session=JSON.parse(await downloads.at(-1).blob.text());
  assert.equal(session.analyses.time_change.mzWindow,0);
  assert.deepEqual(session.analyses.time_change.spectra[0].intensities,[0,10,0]);
});

test('graph downloads stay hidden until usable data exist and follow the displayed signal kind', () => {
  const {nodes,run}=fixture();
  const kinds=['ms','tic','eic','uv'];
  for(const row of ['timechange-overlap-downloads','timechange-offset-downloads'])assert.equal(nodes.get(row).hidden,true);
  for(const kind of kinds){
    const data={kind,spectra:[{name:'sample',mz:[100,200],times:[0,1],intensities:[10,20]}]};
    run(`syncTimeChangeDownloads(${JSON.stringify(data)})`);
    for(const row of ['timechange-overlap-downloads','timechange-offset-downloads'])assert.equal(nodes.get(row).hidden,false);
    for(const signal of kinds)assert.equal(nodes.get(`btn-export-timechange-${signal}-pdf`).hidden,signal!==kind);
    assert.equal(nodes.get('btn-export-timechange-eic-names-pdf').hidden, kind !== 'eic');
    for (const format of ['pdf', 'jpg', 'csv']) {
      assert.match(nodes.get(`timechange-overlap-${format}-label`).textContent, new RegExp(`overlay ${format.toUpperCase()}$`));
    }
    const label = kind === 'ms' ? 'Summed mass' : kind.toUpperCase();
    for (const format of ['jpg', 'csv']) {
      assert.equal(nodes.get(`btn-export-timechange-offset-${format}`).textContent, `Diagonal ${label} ${format.toUpperCase()}`);
    }
  }
  run('syncTimeChangeDownloads({kind:"tic",spectra:[{status:"error",times:[],intensities:[]}]})');
  assert.equal(nodes.get('timechange-overlap-downloads').hidden,true);
  assert.equal(nodes.get('timechange-offset-downloads').hidden,true);
  run('syncTimeChangeDownloads()');
  assert.equal(nodes.get('btn-export-timechange-eic-names-pdf').hidden, true);
  for(const kind of kinds)assert.equal(nodes.get(`btn-export-timechange-${kind}-pdf`).hidden,true);
});

test('the named diagonal EIC PDF keeps experiment names, extraction settings and manual axes', async () => {
  const {nodes, requests, exports, run} = fixture();
  assert.equal(nodes.get('btn-export-timechange-eic-names-pdf').hidden, true);
  await run('runTimeChangeMS("eic")');
  const originalButton = nodes.get('btn-export-timechange-eic-pdf');
  originalButton.style = {};
  originalButton.getBoundingClientRect = () => ({width:139,height:25});
  const newButton = nodes.get('btn-export-timechange-eic-names-pdf');
  newButton.style = {};
  run('syncTimeChangeDownloads(state.timeChangeMSData)');
  assert.deepEqual(newButton.style, {width:'139px',height:'25px',justifyContent:'center'});
  assert.deepEqual(originalButton.style, {});
  nodes.get('timechange-eic-y-min').value = '-5';
  nodes.get('timechange-eic-y-max').value = '200';
  await nodes.get('btn-export-timechange-eic-names-pdf').handlers.click();
  await nodes.get('btn-export-timechange-eic-pdf').handlers.click();
  assert.equal(requests.length, 2);
  assert.equal(exports.length, 2);
  const [named, standard] = exports;
  assert.equal(named.format, 'pdf');
  assert.equal(named.style.trace_labels, true);
  assert.equal(standard.style.trace_labels, undefined);
  assert.equal(named.filename_base, `${standard.filename_base}_with_names`);
  assert.equal(named.style.y_min, -5);
  assert.equal(named.style.y_max, 200);
  assert.deepEqual(named.traces, standard.traces);
  assert.deepEqual(named.traces.map(trace => trace.label), ['first.D','second.D']);
  assert.deepEqual(named.eic_settings, standard.eic_settings);
  assert.equal(named.style.offset_angle_degrees, 45);
  assert.equal(named.style.offset_guide, true);
  nodes.get('timechange-eic-window-number').value = '0';
  await nodes.get('btn-export-timechange-eic-names-pdf').handlers.click();
  assert.equal(requests.length, 4);
  assert.equal(exports.at(-1).style.trace_labels, true);
  assert.equal(exports.at(-1).eic_settings.mz_window, 0);
});

test('overlay and diagonal downloads use the loaded traces and their own graph settings',async()=>{
  for(const kind of ['ms','tic','eic','uv']){
    const {nodes,requests,exports,run}=fixture();
    const data={kind,wavelength:194,targetMz:247.1,ionMode:'positive',mzWindow:.5,smoothing:1,
      spectra:[{name:'first',mz:[100,200],times:[0,1],intensities:[10,20]},
        {name:'second',mz:[100,200],times:[0,1],intensities:[30,40]}]};
    run(`state.timeChangeMSData=${JSON.stringify(data)}`);
    for (const format of ['pdf', 'jpg', 'csv']) {
      await nodes.get(`btn-export-timechange-overlap-${format}`).handlers.click();
    }
    await run('exportTimeChangeOffset("pdf")');
    for (const format of ['jpg', 'csv']) {
      await nodes.get(`btn-export-timechange-offset-${format}`).handlers.click();
    }
    assert.equal(requests.length,0);
    assert.deepEqual(exports.map(payload => payload.format), ['pdf', 'jpg', 'csv', 'pdf', 'jpg', 'csv']);
    const [overlap,overlapJpg,overlapCsv,diagonal,diagonalJpg,diagonalCsv]=exports;
    for (const payload of [overlapJpg, overlapCsv]) {
      assert.deepEqual(payload, { ...overlap, format: payload.format });
    }
    for (const payload of [diagonalJpg, diagonalCsv]) {
      assert.deepEqual(payload, { ...diagonal, format: payload.format });
    }
    assert.deepEqual(overlap.traces,diagonal.traces);
    assert.deepEqual(overlap.traces[0].intensities,[10,20]);
    assert.equal(overlap.style.x_offset_step,0);assert.equal(overlap.style.y_offset_step,0);
    assert.equal(overlap.style.offset_guide,false);assert.equal(overlap.style.offset_angle_degrees,null);
    assert.match(overlap.style.title,/Overlap$/);assert.doesNotMatch(overlap.style.y_label,/\+ offset/);
    assert.match(overlap.filename_base,/_overlap$/);
    assert.equal(diagonal.style.x_offset_step,kind==='ms'?67.5:.3375);
    assert.equal(diagonal.style.y_offset_step,13.5);assert.equal(diagonal.style.offset_guide,true);
    assert.equal(diagonal.style.offset_angle_degrees,45);
    for(const payload of exports){assert.equal(payload.style.fig_width,6);assert.equal(payload.style.x_axis_width_multiplier,2);}
    assert.equal(overlap.eic_settings?.mz_window,kind==='eic'?.5:undefined);
  }
});

test('per-kind Y limits update both views and all PDF/JPG buttons without loading traces again', async () => {
  for (const kind of ['ms', 'tic', 'eic', 'uv']) {
    const {nodes, exports, requests, plots, run} = fixture({renderPlots:true});
    run(`state.timeChangeMSData=${JSON.stringify({kind, wavelength:214,
      targetMz:247.1, mzWindow:.5, smoothing:1, ionMode:'positive', spectra:[
        {name:'first', mz:[100,200], times:[0,1], intensities:[10,20]},
        {name:'second', mz:[100,200], times:[0,1], intensities:[30,40]},
      ]})}`);
    nodes.get(`timechange-${kind}-y-min`).value = '-10';
    const upper = nodes.get(`timechange-${kind}-y-max`);
    upper.value = '25';
    upper.handlers.change();
    assert.equal(nodes.get('timechange-axis-error').hidden, true);
    assert.equal(plots.length, 2);
    for (const plot of plots) {
      assert.deepEqual(Array.from(plot.layout.yaxis.range), [-10,25]);
      assert.equal(plot.layout.yaxis.autorange, false);
    }
    for (const format of ['pdf','jpg']) {
      await nodes.get(`btn-export-timechange-overlap-${format}`).handlers.click();
      await run(`exportTimeChangeOffset('${format}')`);
    }
    assert.equal(requests.length, 0);
    assert.equal(exports.length, 4);
    for (const payload of exports) {
      assert.equal(payload.style.y_min, -10);
      assert.equal(payload.style.y_max, 25);
      assert.deepEqual(payload.traces[1].intensities, [30,40]);
    }
    // Another signal retains its own automatic limits.
    assert.equal(run(`getTimeChangeAxisLimits('${kind === 'uv' ? 'ms' : 'uv'}').yMax`), null);
  }
});

test('Default clears all bounds and restores automatic axes in view and export', async () => {
  const {nodes, plots, exports, run} = fixture({renderPlots:true});
  await run('runTimeChangeMS("eic")');
  for (const kind of ['ms','tic','eic','uv']) {
    nodes.get(`timechange-${kind}-y-min`).value = '0';
    nodes.get(`timechange-${kind}-y-max`).value = '5';
  }
  nodes.get('timechange-eic-y-max').handlers.change();
  assert.deepEqual(Array.from(plots.at(-1).layout.yaxis.range), [0,5]);
  nodes.get('btn-timechange-reset-axes').handlers.click();
  for (const kind of ['ms','tic','eic','uv']) {
    assert.equal(nodes.get(`timechange-${kind}-y-min`).value, '');
    assert.equal(nodes.get(`timechange-${kind}-y-max`).value, '');
  }
  assert.equal(plots.at(-1).layout.yaxis.range, undefined);
  assert.equal(nodes.get('timechange-axis-error').hidden, true);
  await run('exportTimeChangeOffset("pdf")');
  assert.equal(exports[0].style.y_min, null);
  assert.equal(exports[0].style.y_max, null);
});

test('invalid Y limits show validation and prevent misleading graph downloads', async () => {
  const {nodes, plots, exports, run} = fixture({renderPlots:true});
  await run('runTimeChangeMS("eic")');
  for (const [minimum, maximum] of [['10','5'], ['5','5'], ['','Infinity'], ['NaN','20']]) {
    const before = plots.length;
    nodes.get('timechange-eic-y-min').value = minimum;
    nodes.get('timechange-eic-y-max').value = maximum;
    nodes.get('timechange-eic-y-max').handlers.change();
    assert.equal(nodes.get('timechange-axis-error').hidden, false);
    assert.equal(plots.length, before);
    await run('exportTimeChangeOffset("jpg")');
    assert.equal(exports.length, 0);
  }
  await run('exportTimeChangeOffset("csv")');
  assert.equal(exports.length, 1);
  assert.deepEqual(exports[0].traces[0].intensities, [.5,10.5,.5]);
  nodes.get('btn-timechange-reset-axes').handlers.click();
  await run('exportTimeChangeOffset("jpg")');
  assert.equal(exports.length, 2);
});

test('normalized overlay, diagonal and downloads use the same percent scale', async () => {
  const {nodes, plots, exports, run} = fixture({renderPlots:true});
  nodes.get('timechange-normalize').checked = true;
  nodes.get('timechange-eic-y-min').value = '0';
  nodes.get('timechange-eic-y-max').value = '150';
  await run('runTimeChangeMS("eic")');
  const [overlay, diagonal] = plots;
  assert.equal(Math.max(...overlay.traces[0].y), 100);
  assert.ok(diagonal.traces.some(trace => Math.max(...trace.y) === 100));
  for (const plot of plots) assert.deepEqual(Array.from(plot.layout.yaxis.range), [0,150]);
  await run('exportTimeChangeOffset("pdf", {view:"overlap"})');
  assert.equal(exports[0].style.normalize, true);
  assert.equal(exports[0].style.y_max, 150);
});

test('one-sided limits remain ordered even outside the automatic data extent', async () => {
  for (const [bound, value, expected] of [['min',0,[0,45]], ['min',100,[100,147]],
    ['max',20,[-2,20]], ['max',-100,[-147,-100]]]) {
    const {nodes, plots, run} = fixture({renderPlots:true});
    nodes.get(`timechange-eic-y-${bound}`).value = String(value);
    await run('runTimeChangeMS("eic")');
    for (const plot of plots) assert.deepEqual(Array.from(plot.layout.yaxis.range), expected);
  }
});

test('normalized negative UV stays negative in both views and retains raw export values', async () => {
  const {nodes, plots, exports, run} = fixture({renderPlots:true});
  nodes.get('timechange-normalize').checked = true;
  run(`state.timeChangeMSData={kind:'uv', wavelength:214, spectra:[
    {name:'negative', times:[0,1], intensities:[-4,-2]},
    {name:'positive', times:[0,1], intensities:[5,10]},
  ]};renderTimeChangeMS(state.timeChangeMSData);`);
  assert.deepEqual(Array.from(plots[0].traces[0].y), [-4,-2]);
  assert.deepEqual(Array.from(plots[1].traces.find(trace => trace.name === 'negative').y), [-4,-2]);
  await run('exportTimeChangeOffset("pdf", {view:"overlap"})');
  assert.equal(exports[0].style.normalize, true);
  assert.deepEqual(exports[0].traces[0].intensities, [-4,-2]);
});

test('a delayed one-sided axis update cannot override a newer automatic render', async () => {
  const {context, run} = fixture();
  const pending = [], applied = [];
  context.Plotly.newPlot = (id, traces, layout) => new Promise(resolve => pending.push({
    resolve, plot:{id, traces, layout, _fullLayout:{yaxis:{range:[-2,45]}}},
  }));
  context.Plotly.relayout = (plot, settings) => applied.push(settings);
  const first = run('charts.plotMassSpectraOverlay("timechange-ms-plot", [], {yMax:10})');
  const latest = run('charts.plotMassSpectraOverlay("timechange-ms-plot", [], {})');
  pending[1].resolve(pending[1].plot);
  await latest;
  pending[0].resolve(pending[0].plot);
  await first;
  assert.equal(applied.length, 0);
});
