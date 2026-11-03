const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');

function fixture() {
  const elements = new Map();
  const requests = [];
  const exports = [], downloads = [];
  for (const [id, value] of Object.entries({
    'uptake-assay-mz': '424.19', 'uptake-assay-mz-window': '0',
    'uptake-assay-mz-window-value': '', 'uptake-assay-polarity': 'positive',
    'uptake-assay-start': '0', 'uptake-assay-end': '1',
    'eic-smoothing': '5', 'mz-window': '1.7',
  })) {
    elements.set(id, { value, textContent: '', handlers: {}, attributes: {},
      addEventListener(event, callback) { this.handlers[event] = callback; },
      setAttribute(key, value) { this.attributes[key] = value; },
    });
  }
  const context = vm.createContext({ console, setTimeout, clearTimeout, Blob, downloads,
    localStorage: { getItem() { return null; } }, window: {},
    document: { addEventListener() {}, getElementById: id => elements.get(id) || null },
    fetch: async (url, options = {}) => {
      const request = new URL(url);
      if (request.pathname === '/api/export-uptake-assay-cc') {
        exports.push(JSON.parse(options.body));
        return {ok:true,headers:{get:()=>null},blob:async()=>Buffer.from('PDF fixture')};
      }
      requests.push(request);
      const data = request.pathname === '/api/eic'
        ? { times: [0, .5, 1], intensities: [0, 4, 0] }
        : request.pathname === '/api/peak-area' ? { area: 2 }
          : request.pathname === '/api/peaks' ? { peaks: [{ start_time: .3, end_time: .7, area: 2 }] }
            : assert.fail(`Unexpected request: ${url}`);
      return { ok: true, headers: { get: () => 'application/json' }, json: async () => data };
    },
  });
  const run = source => vm.runInContext(source, context);
  run(fs.readFileSync(path.join(root, 'js/api.js'), 'utf8'));
  run(fs.readFileSync(path.join(root, 'js/app.js'), 'utf8'));
  run(`showLoading = () => {}; hideLoading = () => {}; toast = () => {};
    downloadBlob=(blob,name)=>downloads.push({blob,name});
    renderUptakeAssayData = () => {};
    state.selectedFiles = [{path:'/control1.D',name:'control1.D'},
      {path:'/control2.D',name:'control2.D'},{path:'/assay.D',name:'assay.D'}];
    state.uptakeAssayEntries = {'/control1.D': {role:'calibration',concentration:'0'},
      '/control2.D': {role:'calibration',concentration:'10'}, '/assay.D': {role:'sample'}};
    initUptakeAssayCC();`);
  return { elements, requests, run, exports, downloads };
}

test('uptake m/z window has all eleven choices and defaults independently of Single Sample', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /id="uptake-assay-mz-window" min="0" max="1" value="0" step="0.1"/);
  const { run, elements } = fixture();
  assert.equal(run('getUptakeAssaySettings().mzWindow'), 0);
  assert.equal(elements.get('uptake-assay-mz-window-value').textContent, 'Exact');
  elements.get('mz-window').value = '.2';
  assert.equal(run('getUptakeAssaySettings().mzWindow'), 0);
});

test('uptake PDF and session JSON retain the generated window after slider edits', async () => {
  const {run,elements,exports,downloads} = fixture();
  await run('runUptakeAssayCC()');
  elements.get('uptake-assay-mz-window').value='1';
  await run('exportUptakeAssayCCPdf()');
  assert.equal(exports.length,1);
  assert.equal(exports[0].eic_settings.mz_window,0);
  assert.equal(exports[0].eic_settings.target_mz,424.19);
  assert.equal(exports[0].eic_settings.smoothing,5);
  await run('exportSessionJSON()');
  const session=JSON.parse(await downloads.at(-1).blob.text());
  assert.equal(session.analyses.uptake_assay.mzWindow,0);
  assert.equal(session.analyses.uptake_assay.assignments['/control1.D'].role,'calibration');
});

test('every window, including zero, reaches EICs, calibration/sample areas and Auto Window unchanged', async () => {
  for (let step = 0; step <= 10; step += 1) {
    const width = step / 10;
    const { run, elements, requests } = fixture();
    const slider = elements.get('uptake-assay-mz-window');
    slider.value = String(width);
    slider.handlers.input();
    assert.equal(elements.get('uptake-assay-mz-window-value').textContent,
      width === 0 ? 'Exact' : `±${width.toFixed(1)} Da`);
    assert.equal(run('getUptakeAssaySettings().mzWindow'), width);
    await run('runUptakeAssayCC()');
    assert.equal(run('state.uptakeAssayData.mzWindow'), width);
    assert.equal(run('state.uptakeAssayData.samples.length'), 3);
    await run('autoDetectUptakeAssayWindow()');
    assert.equal(requests.length, 7);
    assert.equal(requests.filter(r => r.pathname === '/api/eic').length, 3);
    assert.equal(requests.filter(r => r.pathname === '/api/peak-area').length, 3);
    for (const request of requests) {
      const key = request.pathname === '/api/eic' ? 'window' : 'mz_window';
      assert.equal(request.searchParams.get(key), String(width), request.href);
      assert.equal(request.searchParams.get('mz'), '424.19');
    }
    assert.equal(elements.get('uptake-assay-start').value, '0.300');
    assert.equal(elements.get('uptake-assay-end').value, '0.700');
    assert.equal(elements.get('mz-window').value, '1.7');
  }
});
