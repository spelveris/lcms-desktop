const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const nodes = new Map(), requests = [], exports = [], downloads = [];
  for (const [id, value] of Object.entries({
    'timechange-eic-mz':'247.1', 'timechange-eic-polarity':'positive',
    'timechange-eic-window-number':'.5', 'timechange-eic-window':'.5',
    'mz-window-number':'3', 'mz-window':'1', 'eic-smoothing':'1',
    'btn-run-time-change-ms':'', 'timechange-normalize':'', 'export-dpi':'300',
    'timechange-overlap-downloads':'', 'timechange-offset-downloads':'', 'timechange-overlap-pdf-label':'',
    'timechange-overlap-jpg-label':'', 'timechange-overlap-csv-label':'',
    'btn-export-timechange-overlap-pdf':'', 'btn-export-timechange-ms-pdf':'',
    'btn-export-timechange-overlap-jpg':'', 'btn-export-timechange-overlap-csv':'',
    'btn-export-timechange-offset-jpg':'', 'btn-export-timechange-offset-csv':'',
    'btn-export-timechange-tic-pdf':'', 'btn-export-timechange-eic-pdf':'', 'btn-export-timechange-uv-pdf':'',
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
      assert.equal(parsed.pathname,'/api/export-time-change');
      exports.push(JSON.parse(options.body));
      return {ok:true,headers:{get:()=>null},blob:async()=>Buffer.from('PDF fixture')};
    }, downloads,
  });
  const run = source => vm.runInContext(source, context);
  for (const file of ['api.js','app.js']) run(fs.readFileSync(path.join(__dirname,'../js',file),'utf8'));
  run(`showLoading=()=>{};hideLoading=()=>{};toast=()=>{};
    renderTimeChangeMS=()=>{};renderReportSummary=()=>{};
    buildCurrentDeconvStyle=()=>({fig_width:6,line_width:.8});
    downloadBlob=(blob,name)=>downloads.push({blob,name});
    state.selectedFiles=[{path:'/first.D',name:'first.D'},{path:'/second.D',name:'second.D'}];
    initTimeChangeMS();`);
  return {nodes,requests,exports,downloads,run};
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
  for(const kind of kinds)assert.equal(nodes.get(`btn-export-timechange-${kind}-pdf`).hidden,true);
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
