const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

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
});

test("packaged app downloads updates and installs them on quit", () => {
  const main = read("electron/main.js");
  const preload = read("electron/preload.js");
  assert.match(main, /autoUpdater\.autoDownload = true/);
  assert.match(main, /autoUpdater\.autoInstallOnAppQuit = true/);
  assert.match(main, /autoUpdater\.quitAndInstall\(true, true\)/);
  assert.match(preload, /performAction/);
});
