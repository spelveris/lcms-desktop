const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cleanRelaunchEnvironment, relaunchTokens, receiptPath, acknowledgeRelaunch } = require('./mac-relaunch');
const { RELAUNCH_SCRIPT, scheduleRelaunchAfterHelperExit } = require('./mac-update-helper');

test('GUI relaunch removes Node mode without mutating the helper environment', () => {
  const input = { ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect', NODE_PATH: '/old/bundle', PATH: '/usr/bin', LANG: 'en_US.UTF-8' };
  assert.deepEqual(cleanRelaunchEnvironment(input), { PATH: '/usr/bin', LANG: 'en_US.UTF-8' });
  assert.equal(input.ELECTRON_RUN_AS_NODE, '1');
});

test('relaunch scheduling uses a clean environment and stable working directory', () => {
  let invocation;
  let unreferenced = false;
  scheduleRelaunchAfterHelperExit('/Applications/CATrupole.app', '0.2.67', (...args) => {
    invocation = args;
    return { pid: 123, unref() { unreferenced = true; } };
  });
  assert.equal(invocation[0], '/bin/sh');
  assert.equal(invocation[2].cwd, os.homedir());
  assert.equal(invocation[2].env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(invocation[2].detached, true);
  assert.equal(invocation[1].at(-1), '0.2.67');
  assert.ok(unreferenced);
});

test('main-window receipts accept only generated tokens, never arbitrary paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catrupole-receipt-'));
  const token = 'a'.repeat(32);
  try {
    assert.deepEqual(relaunchTokens(['app', `--catrupole-relaunch=${token}`, '--catrupole-relaunch=../../outside', '--catrupole-relaunch=']), [token]);
    assert.throws(() => receiptPath('../outside', root), /Invalid/);
    acknowledgeRelaunch([token], '0.2.50', root);
    assert.deepEqual(JSON.parse(fs.readFileSync(receiptPath(token, root))), { version: '0.2.50', pid: process.pid });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const mode of ['direct', 'fallback', 'stale', 'missing']) {
  test(`detached relaunch validates the new window: ${mode}`, { skip: process.platform === 'win32' }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catrupole-relaunch-'));
    const receipt = path.join(root, 'receipt');
    const logfile = path.join(root, 'log');
    const opener = path.join(root, 'open-fixture');
    const appPath = path.join(root, 'CATrupole.app');
    const executable = path.join(appPath, 'Contents/MacOS/CATrupole');
    const plutil = path.join(root, 'plutil-fixture');
    try {
      fs.mkdirSync(path.dirname(executable), { recursive: true });
      const receiptScript = version => `printf '%s' '{"version":"${version}","pid":123}' > "$TEST_RECEIPT"\n`;
      fs.writeFileSync(executable, '#!/bin/sh\n[ -z "$ELECTRON_RUN_AS_NODE" ] || exit 20\n[ "$1" = "$TEST_TOKEN_ARG" ] || exit 21\n' +
        (mode === 'missing' ? '' : receiptScript(mode === 'direct' ? '0.2.67' : '0.2.66')), { mode: 0o700 });
      fs.writeFileSync(opener, '#!/bin/sh\n[ "$1" = "-n" ] || exit 21\n[ "$3" = "--args" ] || exit 22\n' +
        (mode === 'missing' ? '' : receiptScript(mode === 'stale' ? '0.2.66' : '0.2.67')), { mode: 0o700 });
      fs.writeFileSync(plutil, '#!/bin/sh\nexec "$TEST_NODE" -e \'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).version)\' "$6"\n', { mode: 0o700 });
      // Only replace OS launch/wait calls; run the real receipt/retry logic.
      const script = 'kill() { return 1; }\n' + RELAUNCH_SCRIPT.replace('/usr/bin/open', `"${opener}"`)
        .replace('/usr/bin/plutil', `"${plutil}"`).replace('/bin/sleep 1', '/bin/sleep 0.005')
        .replaceAll('/bin/sleep 2', ':').replace('/bin/sleep 0.25', ':');
      const tokenArg = '--catrupole-relaunch=' + 'a'.repeat(32);
      const result = spawnSync('/bin/sh', ['-c', script, 'test-relauncher', '123', appPath, receipt, tokenArg, logfile, '0.2.67'], {
        env: cleanRelaunchEnvironment({ ...process.env, ELECTRON_RUN_AS_NODE: '1',
          TEST_RECEIPT: receipt, TEST_TOKEN_ARG: tokenArg, TEST_NODE: process.execPath }),
        encoding: 'utf8', timeout: 10000,
      });
      const ready = mode === 'direct' || mode === 'fallback';
      assert.equal(result.status, ready ? 0 : 1, result.stderr);
      const log = fs.readFileSync(logfile, 'utf8');
      assert.equal((log.match(/Reopening CATrupole/g) || []).length, mode === 'direct' ? 1 : mode === 'fallback' ? 2 : 3);
      assert.match(log, ready ? /main window reopened successfully/ : /Open CATrupole manually/);
      if (mode === 'stale' || mode === 'fallback') assert.match(log, /unexpected version/);
      assert.equal(fs.existsSync(receipt), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
