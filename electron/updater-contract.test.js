const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { assertInstallRequest, normalizeVersion } = require("./mac-update-helper");

const root = path.join(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

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
  assert.match(macHelper, /"\/usr\/bin\/open"/);
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
  assert.match(splash, /@keyframes orbit/);
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
