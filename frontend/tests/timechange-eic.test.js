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
