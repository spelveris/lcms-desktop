// CI-only integration test: launch the packaged helper in Electron's Node mode,
// let it exit, and require confirmation from the actual rendered app window.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

async function main() {
  if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('This GUI smoke test is restricted to the isolated macOS CI runner.');
  }
  const appPath = path.resolve('smoke/macos/CATrupole.app');
  const executable = path.join(appPath, 'Contents/MacOS/CATrupole');
  const helper = path.join(appPath, 'Contents/Resources/app/electron/mac-update-helper.js');
  const expectedVersion = require('../package.json').version;
  const logFile = path.join(os.homedir(), 'Library/Logs/CATrupole/updater.log');
  const before = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').length : 0;
  const child = spawn(executable, ['-e', `require(${JSON.stringify(helper)}).scheduleRelaunchAfterHelperExit(${JSON.stringify(appPath)})`], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit',
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Helper exited ${code}`)));
  });
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(before) : '';
    const match = log.match(/main window reopened successfully: (\{[^\n]+\})/);
    if (match) {
      const receipt = JSON.parse(match[1]);
      if (receipt.version !== expectedVersion || !Number.isSafeInteger(receipt.pid) || receipt.pid <= 1) {
        throw new Error(`Unexpected app receipt: ${match[1]}`);
      }
      console.log(`Confirmed packaged CATrupole ${receipt.version} automatically reopened its main window.`);
      // Only terminate the test application whose window just acknowledged us.
      process.kill(receipt.pid, 'SIGTERM');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (fs.existsSync(logFile)) console.error(fs.readFileSync(logFile, 'utf8').slice(before));
  throw new Error('The packaged app did not confirm a visible main window after relaunch.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
