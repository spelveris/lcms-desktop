const http = require('http');
const net = require('net');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForPortRelease(port, { timeoutMs = 15000, connect = net.createConnection } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    const occupied = await new Promise(resolve => {
      const socket = connect({ host: '127.0.0.1', port });
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(value);
      };
      socket.once('connect', () => finish(true));
      socket.once('error', error => finish(error.code !== 'ECONNREFUSED'));
      socket.setTimeout(500, () => finish(true));
    });
    if (!occupied) return;
    await pause(250);
  } while (Date.now() < deadline);
  throw new Error('The previous backend has not released its port.');
}

function readHealth(url, { get = http.get, timeoutMs = 2000 } = {}) {
  return new Promise(resolve => {
    let request, timer, settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request?.destroy();
      resolve(result);
    };
    timer = setTimeout(() => finish(null), timeoutMs);
    request = get(`${url}/api/health`, response => {
      if (response.statusCode !== 200) {
        response.resume();
        finish(null);
        return;
      }
      let body = '';
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 8192) finish(null);
      });
      response.once('error', () => finish(null));
      response.once('end', () => {
        try { finish(JSON.parse(body)); } catch (_) { finish(null); }
      });
    });
    request.once('error', () => finish(null));
  });
}

async function waitForBackend({ url, version, instanceId, isRunning,
  retries = 120, interval = 500, timeoutMs = 60000, health = readHealth }) {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (!isRunning()) throw new Error('The backend exited during startup.');
    const result = await health(url);
    if (isRunning() && result?.status === 'ok' && result.version === version
        && result.instance_id === instanceId) return;
    if (Date.now() >= deadline) break;
    if (attempt + 1 < retries) await pause(Math.min(interval, deadline - Date.now()));
  }
  throw new Error('The current backend did not become ready in time.');
}

function stopBackendProcess(child, { graceMs = 5000, killMs = 2000 } = {}) {
  if (!child || child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise(resolve => {
    let forceTimer, deadline;
    const finish = () => {
      clearTimeout(forceTimer);
      clearTimeout(deadline);
      child.removeListener('exit', finish);
      resolve();
    };
    child.once('exit', finish);
    forceTimer = setTimeout(() => {
      child.kill('SIGKILL');
      deadline = setTimeout(finish, killMs);
    }, graceMs);
    child.kill('SIGTERM');
  });
}

module.exports = { waitForPortRelease, readHealth, waitForBackend, stopBackendProcess };
