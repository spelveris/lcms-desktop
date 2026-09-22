const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/protein-databases.js'), 'utf8');

function snapshot(installed = false) {
  return { directory: '/user/CATrupole/databases', selected_preset: 'hek293', spectrum_search_available: false,
    presets: [{ id: 'hek293', label: 'HEK293 → Human', database_id: 'human', group: 'Human cell lines' },
      { id: 'hela', label: 'HeLa → Human', database_id: 'human', group: 'Human cell lines' },
      { id: 'yeast', label: 'Yeast', database_id: 'yeast', group: 'Other organisms' }],
    databases: [{ id: 'human', label: 'Human', installed, estimated_download_mb: 8,
      saved: installed ? { protein_count: 20652, bytes: 13735313, uniprot_release: '2026_03' } : null },
      { id: 'yeast', label: 'Yeast', installed: false, estimated_download_mb: 2 }], job: null };
}

function fixture() {
  class Element {
    constructor() { this.children = []; this.listeners = {}; this.attributes = {}; this.value = ''; this.disabled = false; }
    appendChild(child) { this.children.push(child); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; if (name === 'value') this.value = undefined; }
  }
  const nodes = new Map();
  const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); }, createElement() { return new Element(); } };
  const timers = [];
  const ctx = vm.createContext({ document, console, api: {}, setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {} });
  vm.runInContext(source, ctx);
  return { ctx, nodes, timers, run: code => vm.runInContext(code, ctx), set(value) { ctx.nextSnapshot = value; vm.runInContext('proteinDatabaseView.snapshot = nextSnapshot; renderProteinDatabases();', ctx); } };
}

test('cell-line choices use species ID and installed status without duplicate downloads', () => {
  const f = fixture(); f.set(snapshot(true));
  assert.equal(f.run('proteinDatabaseSelection(proteinDatabaseView.snapshot).id'), 'human');
  assert.equal(f.nodes.get('protein-database-download').disabled, true);
  assert.equal(f.nodes.get('protein-database-download').textContent, 'Downloaded');
  const humanOptions = f.nodes.get('protein-database-select').children[1].children;
  assert.equal(humanOptions.length, 2);
  assert.ok(humanOptions.every(option => option.textContent.endsWith('Downloaded')));
  assert.match(f.nodes.get('protein-database-status').textContent, /20,652.*2026_03.*Available offline/);
});

test('missing database shows size and download action, progress shows real bytes', () => {
  const f = fixture(); f.set(snapshot());
  assert.equal(f.nodes.get('protein-database-download').disabled, false);
  assert.match(f.nodes.get('protein-database-status').textContent, /8 MB/);
  const downloading = snapshot(); downloading.job = { database_id: 'human', state: 'downloading', total_bytes: 8000000, downloaded_bytes: 2000000 };
  f.set(downloading);
  assert.equal(f.nodes.get('protein-database-select').disabled, true);
  assert.equal(f.nodes.get('protein-database-download').disabled, true);
  assert.equal(f.nodes.get('protein-database-cancel').hidden, false);
  assert.equal(f.nodes.get('protein-database-progress').value, 2000000);
  assert.match(f.nodes.get('protein-database-status').textContent, /2.0 MB \/ 8.0 MB/);
  downloading.job.state = 'verifying'; f.set(downloading);
  assert.equal(f.nodes.get('protein-database-progress').value, undefined);
  assert.match(f.nodes.get('protein-database-status').textContent, /Verifying/);
});

test('failure and cancellation are retryable and never described as installed', () => {
  const f = fixture(); const value = snapshot();
  value.job = { database_id: 'human', state: 'failed', error: '<html>not a FASTA</html>' }; f.set(value);
  assert.match(f.nodes.get('protein-database-status').textContent, /Download failed.*not a FASTA/);
  assert.equal(f.nodes.get('protein-database-download').disabled, false);
  assert.equal(f.nodes.get('protein-database-progress').hidden, true);
  value.job.state = 'cancelled'; f.set(value);
  assert.match(f.nodes.get('protein-database-status').textContent, /No incomplete database/);
  value.databases[0].saved = { invalid: true, error: 'checksum' }; f.set(value);
  assert.equal(f.nodes.get('protein-database-download').disabled, true);
  assert.match(f.nodes.get('protein-database-status').textContent, /needs attention/);
});

test('initialization only reads status; installed databases do not trigger timers or network downloads', async () => {
  const f = fixture(); let reads = 0; let downloads = 0;
  f.ctx.api = { async proteinDatabases() { reads++; return snapshot(true); }, async downloadProteinDatabase() { downloads++; } };
  f.run('initProteinDatabases(); initProteinDatabases();');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1); assert.equal(downloads, 0); assert.equal(f.timers.length, 0);
  assert.equal(f.nodes.get('protein-database-folder').disabled, true);
  assert.equal(f.nodes.get('protein-database-select').disabled, false);
});

test('uncertain download POST is followed by status read before any retry', async () => {
  const f = fixture(); f.set(snapshot()); const calls = [];
  const running = snapshot(); running.job = { database_id: 'human', state: 'downloading', downloaded_bytes: 1, total_bytes: 5 };
  f.ctx.api = { async proteinDatabases() { calls.push('status'); return running; },
    async downloadProteinDatabase() { calls.push('download'); throw new Error('Connection interrupted'); } };
  await f.run("proteinDatabaseRequest(() => api.downloadProteinDatabase('human'))");
  assert.deepEqual(calls, ['download', 'status']);
  assert.equal(f.nodes.get('protein-database-download').disabled, true);
  assert.equal(f.timers.length, 1);
});

test('unreachable backend offers status retry, never blindly repeats a download', async () => {
  const f = fixture(); f.set(snapshot());
  f.ctx.api = { async proteinDatabases() { throw new Error('Unavailable'); } };
  await f.run('proteinDatabaseRequest(() => api.proteinDatabases())');
  assert.equal(f.nodes.get('protein-database-download').textContent, 'Retry connection');
  assert.equal(f.nodes.get('protein-database-download').disabled, false);
  assert.equal(f.nodes.get('protein-database-select').disabled, true);
  assert.match(f.nodes.get('protein-database-status').textContent, /Saved databases are not removed/);
});

test('API uses allowlisted IDs only and UI never puts a whole database into the mapper', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const api = fs.readFileSync(path.join(__dirname, '../js/api.js'), 'utf8');
  assert.match(html, /id="protein-database-select"/);
  assert.match(html, /automatic spectrum-to-database identification is not included yet/);
  assert.match(api, /encodeURIComponent\(databaseId\)/);
  assert.doesNotMatch(source, /peptide-fasta|analyzePeptides|fetch\(/);
});

test('Electron folder action uses stable userData, not renderer paths or versioned app resources', async () => {
  const main = fs.readFileSync(path.join(__dirname, '../../electron/main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '../../electron/preload.js'), 'utf8');
  const action = main.match(/ipcMain\.handle\("databases:open-folder", async \(\) => \{[\s\S]*?\n\}\);/)[0];
  const calls = []; let handler;
  const userData = path.resolve('CATrupole user data');
  vm.runInNewContext(action, { ipcMain: { handle(_name, fn) { handler = fn; } }, path,
    app: { getPath(name) { assert.equal(name, 'userData'); return userData; } },
    fs: { promises: { async mkdir(directory) { calls.push(directory); } } },
    shell: { async openPath(directory) { calls.push(directory); return ''; } } });
  await handler({ path: '/untrusted/path' });
  assert.deepEqual(calls, [path.join(userData, 'databases'), path.join(userData, 'databases')]);
  assert.match(preload, /openFolder: \(\) => ipcRenderer.invoke\("databases:open-folder"\)/);
  assert.match(main, /LCMS_USER_DATA_DIR: app.getPath\("userData"\)/);
});
