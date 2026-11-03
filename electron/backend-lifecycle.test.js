const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readHealth, waitForBackend, stopBackendProcess, waitForPortRelease } = require('./backend-lifecycle');

test('startup accepts only this launch and version, never an old backend on the same port', async () => {
  const replies = [
    { status: 'ok', version: '0.2.66', instance_id: 'old' },
    { status: 'ok', version: '0.2.67', instance_id: 'old' },
    { status: 'ok', version: '0.2.67', instance_id: 'new' },
  ];
  let calls = 0;
  await waitForBackend({ url: 'unused', version: '0.2.67', instanceId: 'new',
    isRunning: () => true, interval: 0, health: async () => replies[calls++] });
  assert.equal(calls, 3);
});

test('stale responses cannot confirm startup, and an exited backend fails promptly', async () => {
  const config = { url: 'unused', version: '0.2.67', instanceId: 'new', retries: 2,
    interval: 0, isRunning: () => true,
    health: async () => ({ status: 'ok', version: '0.2.66' }) };
  await assert.rejects(waitForBackend(config), /did not become ready/);
  await assert.rejects(waitForBackend({ ...config, isRunning: () => false }), /exited/);
});

test('an unresponsive health connection times out and releases its socket', async () => {
  const request = new EventEmitter();
  let destroyed = false;
  request.destroy = () => { destroyed = true; };
  assert.equal(await readHealth('unused', { timeoutMs: 10, get: () => request }), null);
  assert.equal(destroyed, true);
});

test('health checks consume and validate the response body', async () => {
  for (const body of ['invalid JSON', '{"status":"ok","version":"0.2.67","instance_id":"new"}']) {
    const result = await readHealth('unused', { get(_url, callback) {
      const request = new EventEmitter();
      request.destroy = () => {};
      setImmediate(() => {
        const response = new EventEmitter(); response.statusCode = 200;
        callback(response); response.emit('data', body); response.emit('end');
      });
      return request;
    } });
    assert.deepEqual(result, body.startsWith('{') ? JSON.parse(body) : null);
  }
});

function childProcess({ exitOnTerm = true } = {}) {
  const child = new EventEmitter(); child.exitCode = null; child.signalCode = null;
  child.signals = [];
  child.kill = signal => {
    child.signals.push(signal);
    if (signal === 'SIGKILL' || exitOnTerm) setImmediate(() => {
      child.signalCode = signal; child.emit('exit', null, signal);
    });
  };
  return child;
}

test('shutdown waits for the owned backend to exit before returning', async () => {
  const child = childProcess();
  const pending = stopBackendProcess(child);
  assert.equal(child.signalCode, null);
  await pending;
  assert.equal(child.signalCode, 'SIGTERM');
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('a backend ignoring graceful shutdown is stopped without killing unrelated processes', async () => {
  const child = childProcess({ exitOnTerm: false });
  await stopBackendProcess(child, { graceMs: 5 });
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
});

test('startup waits for the old backend port and never kills its owner', async () => {
  let attempts = 0;
  await waitForPortRelease(8741, { connect() {
    const socket = new EventEmitter(); socket.destroy = () => {}; socket.setTimeout = () => {};
    setImmediate(() => attempts++ === 0 ? socket.emit('connect') : socket.emit('error', { code: 'ECONNREFUSED' }));
    return socket;
  } });
  assert.equal(attempts, 2);
});
