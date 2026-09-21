const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { assertInstallRequest, normalizeVersion } = require("./mac-update-helper");

const root = path.join(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

function indicatorFixture({ initial = { state: "current" }, check = async () => ({ state: "current" }) } = {}) {
  const nodes = new Map();
  for (const id of ["update-controls", "update-refresh-button", "update-available-badge", "update-status-label", "update-available-version"]) {
    const classes = new Set();
    nodes.set(id, { hidden: true, disabled: false, textContent: "", handlers: {}, attributes: {},
      addEventListener(name, handler) { this.handlers[name] = handler; },
      setAttribute(name, value) { this.attributes[name] = value; },
      classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) },
    });
  }
  let emit;
  const context = vm.createContext({ console, setTimeout, clearTimeout,
    localStorage: { getItem() { return null; } },
    document: { addEventListener() {}, getElementById: id => nodes.get(id) || null },
    window: { catrupoleUpdates: {
      getStatus: () => Promise.resolve(initial), checkForUpdates: check,
      onStatus(callback) { emit = callback; },
      performAction() { throw new Error("Refresh must never install or restart"); },
    } },
  });
  vm.runInContext(read("frontend/js/app.js"), context);
  vm.runInContext("initUpdateIndicator()", context);
  return { nodes, emit: status => emit(status), refresh: nodes.get("update-refresh-button"),
    badge: nodes.get("update-available-badge"), label: nodes.get("update-status-label") };
}

function checkFixture() {
  let checks = 0;
  const gate = deferred();
  const context = vm.createContext({ console: { warn() {} },
    app: { isPackaged: true, getVersion: () => "0.2.55" },
    updateStatus: { state: "current", available: false },
    configurePackagedUpdater() {}, cleanupStartupUpdates: () => gate.promise,
    autoUpdater: { async checkForUpdates() { checks += 1; } },
  });
  context.sendUpdateStatus = status => (context.updateStatus = { ...context.updateStatus, ...status });
  const main = read("electron/main.js");
  vm.runInContext("let updateCheckPromise = null;\n" + main.slice(main.indexOf("function checkForUpdates()"), main.indexOf("function startUpdateChecks()")), context);
  return { context, gate, checks: () => checks, run: () => vm.runInContext("checkForUpdates()", context) };
}

test("refresh bridge requests a fresh check rather than cached status or installation", async () => {
  let exposed, invoked;
  vm.runInNewContext(read("electron/preload.js"), { require: name => {
    assert.equal(name, "electron");
    return { contextBridge: { exposeInMainWorld(_name, api) { exposed = api; } },
      ipcRenderer: { invoke: async channel => { invoked = channel; return { state: "current" }; } } };
  } });
  assert.equal((await exposed.checkForUpdates()).state, "current");
  assert.equal(invoked, "updates:check-now");
  assert.match(read("electron/main.js"), /ipcMain\.handle\("updates:check-now", \(\) => checkForUpdates\(\)\)/);
});

test("refresh is a compact accessible sibling of the updater status", async () => {
  const html = read("frontend/index.html"), css = read("frontend/css/style.css");
  assert.match(html, /id="update-controls"[\s\S]*?id="update-available-badge"[\s\S]*?<\/button>\s*<button id="update-refresh-button"/);
  assert.match(html, /aria-label="Check for updates now"/);
  assert.match(css, /\.update-refresh-button \{[^}]*width: 24px;[^}]*height: 24px;/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /\.update-refresh-button:focus-visible/);
  const f = indicatorFixture(); await settle();
  assert.equal(f.refresh.hidden, false);
  assert.equal(f.refresh.disabled, false);
  assert.equal(f.badge.classList.contains("is-current"), true);
  assert.equal(f.nodes.get("update-controls").hidden, false);
});

test("manual refresh checks immediately, spins, and ignores repeated clicks", async () => {
  const gate = deferred(); let calls = 0;
  const f = indicatorFixture({ check: () => { calls += 1; return gate.promise; } });
  await settle();
  const pending = f.refresh.handlers.click();
  await f.refresh.handlers.click();
  assert.equal(calls, 1);
  assert.equal(f.label.textContent, "Checking for updates…");
  assert.equal(f.refresh.disabled, true);
  assert.equal(f.refresh.attributes["aria-busy"], "true");
  assert.equal(f.refresh.classList.contains("is-checking"), true);
  gate.resolve({ state: "current", available: false }); await pending;
  assert.equal(f.refresh.disabled, false);
  assert.equal(f.refresh.attributes["aria-busy"], "false");
  assert.equal(f.label.textContent, "You are up to date!");
});

test("a failed manual check turns grey and can be retried", async () => {
  let fail = true;
  const f = indicatorFixture({ check: async () => { if (fail) throw new Error("Offline"); return { state: "current" }; } });
  await settle(); await f.refresh.handlers.click();
  assert.equal(f.badge.classList.contains("is-offline"), true);
  assert.equal(f.refresh.disabled, false);
  assert.equal(f.refresh.attributes["aria-busy"], "false");
  fail = false; await f.refresh.handlers.click();
  assert.equal(f.badge.classList.contains("is-current"), true);
});

test("refresh never interrupts preparation, download, ready-to-install or installation states", async () => {
  let calls = 0;
  const f = indicatorFixture({ check: async () => { calls += 1; } }); await settle();
  for (const state of ["checking", "available", "downloading", "ready", "installing"]) {
    f.emit({ state, available: state !== "checking", installable: true });
    assert.equal(f.refresh.disabled, true, state);
    await f.refresh.handlers.click();
  }
  assert.equal(calls, 0);
  f.emit({ state: "offline", available: false });
  assert.equal(f.refresh.disabled, false);
});

test("stale cached status and manual replies cannot replace newer download events", async () => {
  const initial = deferred(), check = deferred();
  const f = indicatorFixture({ initial: initial.promise, check: () => check.promise });
  const pending = f.refresh.handlers.click();
  f.emit({ state: "downloading", available: true, progressPercent: 42, latestVersion: "0.2.56" });
  initial.resolve({ state: "current" }); check.resolve({ state: "current" });
  await pending; await settle();
  assert.equal(f.label.textContent, "Downloading update 42%");
  assert.equal(f.refresh.disabled, true);
  assert.equal(f.refresh.attributes["aria-busy"], "false");
});

test("main process deduplicates manual and automatic checks across startup cleanup", async () => {
  const f = checkFixture();
  const first = f.run(), second = f.run();
  assert.equal(first, second);
  await settle(); assert.equal(f.checks(), 0);
  f.gate.resolve(); await first;
  assert.equal(f.checks(), 1);
  await f.run(); assert.equal(f.checks(), 2);
});

test("main process preserves downloaded and in-progress updates when asked to refresh", async () => {
  const f = checkFixture(); f.gate.resolve();
  for (const state of ["available", "downloading", "ready", "installing"]) {
    f.context.updateStatus = { state, available: true };
    assert.equal((await f.run()).state, state);
  }
  assert.equal(f.checks(), 0);
});

test("a main-process check error is retryable", async () => {
  const f = checkFixture(); f.gate.resolve();
  f.context.autoUpdater.checkForUpdates = async () => { throw new Error("Offline"); };
  assert.equal((await f.run()).state, "offline");
  f.context.autoUpdater.checkForUpdates = async () => { f.context.updateStatus = { state: "current" }; };
  assert.equal((await f.run()).state, "current");
});

test("desktop package declares the GitHub automatic updater", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.match(pkg.dependencies["electron-updater"], /^\^6\./);
  assert.deepEqual(pkg.build.publish, [{
    provider: "github",
    owner: "spelveris",
    repo: "lcms-desktop",
  }]);
  assert.ok(pkg.build.mac.target.includes("zip"));
  assert.ok(pkg.build.win.target.includes("nsis"));
});

test("release workflow publishes every update feed asset", () => {
  const workflow = read(".github/workflows/build-desktop.yml");
  assert.match(workflow, /release\/\*\.blockmap/);
  assert.match(workflow, /release-assets\/\*-mac\.zip/);
  assert.match(workflow, /release-assets\/\*\.blockmap/);
  assert.match(workflow, /release-assets\/latest\*\.yml/);
  assert.match(workflow, /used automatically by CATrupole's built-in updater/);
});

test("packaged app downloads updates and installs them internally", () => {
  const main = read("electron/main.js");
  const macHelper = read("electron/mac-update-helper.js");
  const preload = read("electron/preload.js");
  assert.match(main, /autoUpdater\.autoDownload = true/);
  assert.match(main, /autoUpdater\.autoInstallOnAppQuit = process\.platform !== "darwin"/);
  assert.match(main, /autoUpdater\.quitAndInstall\(true, true\)/);
  assert.match(main, /launchMacUpdateHelper\(\)/);
  assert.match(macHelper, /CFBundleIdentifier/);
  assert.match(macHelper, /CFBundleShortVersionString/);
  assert.match(macHelper, /"\/usr\/bin\/codesign"/);
  assert.match(macHelper, /"\/usr\/bin\/ditto"/);
  assert.match(macHelper, /\/usr\/bin\/open -n/);
  assert.match(macHelper, /spawnProcess\("\/bin\/sh"/);
  assert.match(macHelper, /kill -0 "\$helper_pid"/);
  assert.doesNotMatch(macHelper, /pgrep -x CATrupole/);
  assert.match(macHelper, /env: cleanRelaunchEnvironment\(\)/);
  assert.match(main, /mainWindowReady = true;\s+confirmRelaunchIfReady\(\)/);
  assert.match(macHelper, /relaunch scheduled/);
  assert.match(preload, /performAction/);
});

test("startup screen uses a fixed circular chasing-dot loader", () => {
  const main = read("electron/main.js");
  const splash = read("electron/splash.html");
  const bubbles = splash.match(/class="spinner-bubble"/g) || [];
  assert.equal(bubbles.length, 7);
  assert.match(main, /height:\s*308/);
  assert.match(main, /minHeight:\s*308/);
  assert.match(main, /maxHeight:\s*308/);
  assert.match(splash, /aspect-ratio:\s*1 \/ 1/);
  assert.match(splash, /flex:\s*0 0 72px/);
  assert.match(splash, /src="spinner-motion.js"/);
  assert.match(splash, /prefers-reduced-motion/);
  assert.doesNotMatch(splash, /border-top-color/);
});

test("macOS replacement helper accepts only a CATrupole app, ZIP, and valid version", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "catrupole-updater-test-"));
  const zipPath = path.join(fixtureRoot, "CATrupole-0.2.45-arm64-mac.zip");
  const appPath = path.join(fixtureRoot, "CATrupole.app");
  fs.writeFileSync(zipPath, "fixture");
  fs.mkdirSync(appPath);

  try {
    assert.equal(normalizeVersion("v0.2.45"), "0.2.45");
    assert.deepEqual(assertInstallRequest(zipPath, appPath, "v0.2.45"), {
      zipPath,
      appPath,
      expectedVersion: "0.2.45",
    });
    assert.throws(() => assertInstallRequest(zipPath, appPath, "next"), /invalid version/);
    assert.throws(() => assertInstallRequest(zipPath, path.join(fixtureRoot, "Other.app"), "0.2.45"));
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
