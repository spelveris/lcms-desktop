const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { installedPackage, cleanupInstalledUpdateCache, createStartupUpdateCleanup } = require("./update-cache");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "catrupole-cache-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cacheDir = path.join(root, "catrupole-updater");
  await fs.mkdir(path.join(cacheDir, "pending"), { recursive: true });
  return { root, cacheDir, write: (name, data = "fixture") => fs.writeFile(path.join(cacheDir, name), data) };
}
const exists = async file => fs.access(file).then(() => true, () => false);
const mac = "CATrupole-0.2.53-arm64-mac.zip";
const next = "CATrupole-0.2.54-arm64-mac.zip";

test("recognizes only installed CATrupole updater packages using numeric versions", () => {
  for (const name of [mac, `${mac}.blockmap`, "CATrupole-0.2.9-x64-mac.zip",
    "CATrupole Setup 0.2.53.exe", "CATrupole-Setup-0.2.53.exe", "CATrupole.Setup.0.2.53.exe"])
    assert.equal(installedPackage(name, "0.2.53"), true, name);
  for (const name of [next, "CATrupole-0.2.100-arm64-mac.zip", "temp-" + mac,
    "../" + mac, "sub/" + mac, "sub\\" + mac, "Other-0.2.53-arm64-mac.zip",
    "CATrupole-0.2.53-beta-arm64-mac.zip", "CATrupole-0.2.53-arm64.dmg"])
    assert.equal(installedPackage(name, "0.2.53"), false, name);
  assert.equal(installedPackage(mac, "0.2.53-beta"), false);
});

test("removes installed macOS download, metadata and duplicate; leaves user files intact", async t => {
  const f = await fixture(t);
  for (const name of ["update.zip", "current.blockmap", `pending/${mac}`, `pending/${mac}.blockmap`, "pending/current.blockmap"])
    await f.write(name);
  await f.write("pending/update-info.json", JSON.stringify({ fileName: mac }));
  await f.write("notes.txt", "user cache note");
  await fs.writeFile(path.join(f.root, mac), "manually downloaded installer");
  const result = await cleanupInstalledUpdateCache({ cacheDir: f.cacheDir, currentVersion: "0.2.53" });
  assert.equal(result.removed.length, 6);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(await fs.readdir(path.join(f.cacheDir, "pending")), []);
  assert.equal(await fs.readFile(path.join(f.root, mac), "utf8"), "manually downloaded installer");
  assert.equal(await fs.readFile(path.join(f.cacheDir, "notes.txt"), "utf8"), "user cache note");
  assert.deepEqual(await cleanupInstalledUpdateCache({ cacheDir: f.cacheDir, currentVersion: "0.2.53" }), { removed: [], failed: [] });
});

test("cleans older packages without deleting a newer pending or unfinished update", async t => {
  const f = await fixture(t);
  for (const name of [mac, next, `temp-${next}`, "current.blockmap"])
    await f.write(`pending/${name}`);
  const metadata = JSON.stringify({ fileName: next });
  await f.write("pending/update-info.json", metadata);
  const result = await cleanupInstalledUpdateCache({ cacheDir: f.cacheDir, currentVersion: "0.2.53" });
  assert.deepEqual(result.removed, [path.join(f.cacheDir, "pending", mac)]);
  for (const name of [next, `temp-${next}`, "current.blockmap", "update-info.json"])
    assert.equal(await exists(path.join(f.cacheDir, "pending", name)), true);
});

test("failed installation keeps the newer downloaded package for retry", async t => {
  const f = await fixture(t);
  await f.write(`pending/${mac}`);
  await f.write("pending/update-info.json", JSON.stringify({ fileName: mac }));
  const result = await cleanupInstalledUpdateCache({ cacheDir: f.cacheDir, currentVersion: "0.2.52" });
  assert.deepEqual(result.removed, []);
  assert.equal(await exists(path.join(f.cacheDir, "pending", mac)), true);
});

test("first cleanup-enabled launch removes downloads left by multiple older versions", async t => {
  const f = await fixture(t);
  const oldFiles = ["CATrupole-0.2.43-arm64-mac.zip", "CATrupole-0.2.51-arm64-mac.zip",
    "CATrupole.Setup.0.2.45.exe", "CATrupole-Setup-0.2.52.exe"];
  for (const name of oldFiles) await f.write(`pending/${name}`);
  await f.write("pending/update-info.json", JSON.stringify({ fileName: oldFiles[3] }));
  await f.write("update.zip");
  await f.write("installer.exe");
  const result = await cleanupInstalledUpdateCache({ cacheDir: f.cacheDir, currentVersion: "0.2.53" });
  assert.equal(result.removed.length, 7);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(await fs.readdir(path.join(f.cacheDir, "pending")), []);
});

test("Windows removes cached installers, retrying a briefly locked EXE", async t => {
  const f = await fixture(t);
  const name = "CATrupole-Setup-0.2.53.exe";
  await f.write(`pending/${name}`);
  await f.write("installer.exe");
  await f.write("pending/update-info.json", JSON.stringify({ fileName: name }));
  let tries = 0, pauses = 0;
  const io = { ...fs, unlink: async file => {
    if (path.basename(file) === name && ++tries < 3) throw Object.assign(new Error("Installer still closing"), { code: "EBUSY" });
    return fs.unlink(file);
  } };
  const result = await cleanupInstalledUpdateCache({ cacheDir: f.cacheDir, currentVersion: "0.2.53", io, pause: async () => { pauses += 1; } });
  assert.equal(tries, 3);
  assert.equal(pauses, 2);
  assert.equal(result.removed.length, 3);
  assert.deepEqual(result.failed, []);
});

test("permanently locked installer and its metadata survive and retry next launch", async t => {
  const f = await fixture(t);
  await f.write(`pending/${mac}`);
  await f.write("pending/update-info.json", JSON.stringify({ fileName: mac }));
  const io = { ...fs, unlink: async () => { throw Object.assign(new Error("Locked"), { code: "EPERM" }); } };
  const result = await cleanupInstalledUpdateCache({ cacheDir: f.cacheDir, currentVersion: "0.2.53", io, pause: async () => {} });
  assert.equal(result.failed.length, 1);
  assert.deepEqual(result.removed, []);
  assert.equal(await exists(path.join(f.cacheDir, "pending/update-info.json")), true);
  const retry = await cleanupInstalledUpdateCache({ cacheDir: f.cacheDir, currentVersion: "0.2.53" });
  assert.equal(retry.removed.length, 2);
});

test("malformed or path-traversing metadata cannot delete unrelated files", async t => {
  const f = await fixture(t);
  await f.write("notes.txt");
  await f.write("pending/update-info.json", JSON.stringify({ fileName: "../notes.txt" }));
  assert.deepEqual((await cleanupInstalledUpdateCache({ cacheDir: f.cacheDir, currentVersion: "0.2.53" })).removed, []);
  await f.write("pending/update-info.json", "not valid JSON");
  assert.deepEqual((await cleanupInstalledUpdateCache({ cacheDir: f.cacheDir, currentVersion: "0.2.53" })).removed, []);
  await assert.rejects(cleanupInstalledUpdateCache({ cacheDir: f.root, currentVersion: "0.2.53" }), /Unrecognized/);
});

test("never follows a pending-directory link or deletes linked package targets", async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, mac), "keep");
  await fs.rmdir(path.join(f.cacheDir, "pending"));
  await fs.symlink(outside, path.join(f.cacheDir, "pending"), "junction");
  assert.deepEqual((await cleanupInstalledUpdateCache({ cacheDir: f.cacheDir, currentVersion: "0.2.53" })).removed, []);
  assert.equal(await fs.readFile(path.join(outside, mac), "utf8"), "keep");
});

test("rejects a cache-directory link", async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside");
  await fs.rename(f.cacheDir, outside);
  await fs.symlink(outside, f.cacheDir, "junction");
  await assert.rejects(cleanupInstalledUpdateCache({ cacheDir: f.cacheDir, currentVersion: "0.2.53" }), /regular directory/);
});

test("startup cleanup runs once only after successful opening, before update checks", async () => {
  let ready, finish, cleanups = 0, helpers = 0;
  const run = createStartupUpdateCleanup({
    ready: new Promise(resolve => { ready = resolve; }),
    updater: { getOrCreateDownloadHelper: async () => { helpers += 1; return { cacheDir: "/fixture/catrupole-updater" }; } },
    getVersion: () => "0.2.53",
    cleanup: async () => { cleanups += 1; await new Promise(resolve => { finish = resolve; }); return { removed: [], failed: [] }; },
  });
  const first = run();
  assert.equal(run(), first);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(helpers, 0);
  ready();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cleanups, 1);
  let checked = false;
  const check = run().then(() => { checked = true; });
  assert.equal(checked, false);
  finish();
  await check;
  assert.equal(checked, true);
  assert.equal(cleanups, 1);
});

test("cleanup errors do not block subsequent update checks", async () => {
  const warnings = [];
  const run = createStartupUpdateCleanup({ ready: Promise.resolve(),
    updater: { getOrCreateDownloadHelper: async () => { throw new Error("Read denied"); } },
    getVersion: () => "0.2.53", logger: { warn: msg => warnings.push(msg) },
  });
  const result = await run();
  assert.equal(result.failed.length, 1);
  assert.equal(warnings.length, 1);
});

test("main process gates checks on cleanup and disables retained differential copies", async () => {
  const main = await fs.readFile(path.join(__dirname, "main.js"), "utf8");
  assert.match(main, /autoUpdater\.disableDifferentialDownload = true/);
  assert.match(main, /await cleanupStartupUpdates\(\);[\s\S]+await autoUpdater\.checkForUpdates\(\)/);
  const confirmation = main.slice(main.indexOf("function confirmRelaunchIfReady()"), main.indexOf("function createWindow()"));
  assert.match(confirmation, /!backendReady \|\| !mainWindowReady \|\| !window \|\| !window\.isVisible\(\)/);
  assert.match(confirmation, /confirmSuccessfulStartup\(\)/);
});
