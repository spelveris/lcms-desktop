const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const shared = '/Volumes/lab/Group/LC-MS Agilent data';
const personal = { name: 'JHu', path: `${shared}/JHu` };
const dated = `${personal.path}/20261026`;
const volumeData = { volumes: [
  { name: 'lab', path: '/Volumes/lab' },
  { name: 'LC-MS Agilent data', path: shared, pinned: true },
], personal_folder: personal };

function fixture() {
  const nodes = new Map();
  class Element {
    constructor() {
      this.children = [];
      this.listeners = {};
      this.attributes = {};
      this.classList = { add: name => { this.className += ` ${name}`; } };
    }
    set innerHTML(_) { this.children = []; }
    appendChild(child) { this.children.push(child); }
    addEventListener(event, callback) { this.listeners[event] = callback; }
    setAttribute(name, value) { this.attributes[name] = value; }
  }
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  const browsed = [];
  const api = { getVolumes: async () => volumeData };
  const context = vm.createContext({ api, browsed,
    localStorage: { getItem: key => key === 'lcms-custom-mounts' ? JSON.stringify([dated, personal.path]) : null },
    document: { getElementById: element, createElement: () => new Element(), addEventListener() {} },
  });
  const run = code => vm.runInContext(code, context);
  run(fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8'));
  run('browseTo = path => browsed.push(path)');
  return { api, browsed, element, run };
}

test('the File Browser pins only the shared and personal folders and shows saved paths under Volumes', async () => {
  const { browsed, element, run } = fixture();
  run('initFileBrowser()');
  await run('loadVolumes()');
  const shortcuts = element('mount-buttons');
  const extras = element('volume-shortcuts');
  assert.deepEqual(shortcuts.children.map(button => button.textContent), ['LC-MS Agilent data', 'JHu']);
  assert.match(shortcuts.children[0].className, /mount-btn-pinned/);
  assert.match(shortcuts.children[1].className, /mount-btn-personal/);
  assert.equal(extras.hidden, true);
  shortcuts.children[1].listeners.click();
  assert.deepEqual(browsed, [personal.path]);

  const volumes = element('btn-volumes');
  volumes.listeners.click();
  assert.equal(volumes.attributes['aria-expanded'], 'true');
  assert.equal(extras.hidden, false);
  assert.deepEqual(extras.children.map(button => button.textContent), ['lab', '20261026']);
  volumes.listeners.click();
  assert.equal(volumes.attributes['aria-expanded'], 'false');
  assert.equal(extras.hidden, true);
});

test('a fresh unmatched account result removes the personal shortcut even if an older request resolves later', async () => {
  const { api, element, run } = fixture();
  await run('loadVolumes()');
  let resolveOldRequest;
  api.getVolumes = () => new Promise(resolve => { resolveOldRequest = resolve; });
  const oldRequest = run('loadVolumes()');
  api.getVolumes = async () => ({ ...volumeData, personal_folder: null });
  await run('loadVolumes()');
  resolveOldRequest(volumeData);
  await oldRequest;
  assert.deepEqual(element('mount-buttons').children.map(button => button.textContent), ['LC-MS Agilent data']);
});
