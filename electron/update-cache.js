const fs = require("node:fs/promises");
const path = require("node:path");

function stableVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value || ""));
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function installedPackage(fileName, currentVersion) {
  // Only filenames produced by CATrupole's macOS ZIP / Windows NSIS updater.
  // Do not accept paths, temporary/partial files, prereleases, or other apps.
  const match = /^CATrupole-(\d+\.\d+\.\d+)-(?:arm64|x64|universal)-mac\.zip(?:\.blockmap)?$/.exec(fileName)
    || /^CATrupole(?: Setup |\.Setup\.|-Setup-)(\d+\.\d+\.\d+)\.exe(?:\.blockmap)?$/.exec(fileName);
  const candidate = match && stableVersion(match[1]);
  const current = stableVersion(currentVersion);
  if (!candidate || !current) return false;
  for (let i = 0; i < 3; i += 1) {
    if (candidate[i] !== current[i]) return candidate[i] < current[i];
  }
  return true;
}

async function statIfPresent(file, io) {
  try { return await io.lstat(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function cleanupInstalledUpdateCache({ cacheDir, currentVersion, io = fs,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const removed = [];
  const failed = [];
  if (!stableVersion(currentVersion) || !path.isAbsolute(cacheDir)
      || path.basename(cacheDir) !== "catrupole-updater") {
    throw new Error("Unrecognized CATrupole update cache or installed version.");
  }
  const root = path.resolve(cacheDir);
  const rootStat = await statIfPresent(root, io);
  if (!rootStat) return { removed, failed };
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Update cache is not a regular directory.");

  // Never recurse, follow directory links, or empty a whole cache. The running
  // app has already opened successfully; newer/unfinished packages stay intact.
  async function removeFile(directory, name, directoryStat) {
    const file = path.join(directory, name);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        for (const [dir, original] of [[root, rootStat], [directory, directoryStat]]) {
          const current = await statIfPresent(dir, io);
          if (!current || !current.isDirectory() || current.isSymbolicLink()
              || current.dev !== original.dev || current.ino !== original.ino) {
            throw new Error("Update cache directory changed during cleanup.");
          }
        }
        const stat = await statIfPresent(file, io);
        if (!stat || !stat.isFile() || stat.isSymbolicLink()) return;
        await io.unlink(file);
        removed.push(file);
        return;
      } catch (error) {
        if (error.code === "ENOENT") return;
        // Windows may still have the installer open when the new app appears.
        if (["EBUSY", "EPERM", "EACCES"].includes(error.code) && attempt < 3) {
          await pause(1000);
          continue;
        }
        failed.push({ file, message: error.message });
        return;
      }
    }
  }

  // These are differential-download copies, not installers needed for retry.
  // Full downloads are enabled so these copies no longer need to be retained.
  for (const name of ["update.zip", "installer.exe", "current.blockmap"]) {
    await removeFile(root, name, rootStat);
  }

  const pending = path.join(root, "pending");
  const pendingStat = await statIfPresent(pending, io);
  if (!pendingStat || !pendingStat.isDirectory() || pendingStat.isSymbolicLink()) return { removed, failed };
  const names = await io.readdir(pending);
  for (const name of names) {
    if (installedPackage(name, currentVersion)) await removeFile(pending, name, pendingStat);
  }
  // Metadata belongs to a specific package. Keep it when a newer version is
  // waiting to install, or if an installer was locked and could not be removed.
  const infoPath = path.join(pending, "update-info.json");
  const infoStat = await statIfPresent(infoPath, io);
  if (infoStat?.isFile() && !infoStat.isSymbolicLink() && infoStat.size <= 65536) {
    let info;
    try { info = JSON.parse(await io.readFile(infoPath, "utf8")); }
    catch (_) { /* Unknown metadata is preserved rather than guessed at. */ }
    if (info && typeof info.fileName === "string" && installedPackage(info.fileName, currentVersion)
        && !(await statIfPresent(path.join(pending, info.fileName), io))) {
      await removeFile(pending, "current.blockmap", pendingStat);
      await removeFile(pending, "update-info.json", pendingStat);
    }
  }
  return { removed, failed };
}

function createStartupUpdateCleanup({ ready, updater, getVersion, logger = console,
  cleanup = cleanupInstalledUpdateCache }) {
  let task;
  return () => {
    if (!task) {
      task = (async () => {
        await ready;
        // Read the updater's configured path; don't guess Windows user folders.
        const helper = await updater.getOrCreateDownloadHelper();
        const result = await cleanup({ cacheDir: helper.cacheDir, currentVersion: getVersion() });
        if (result.removed.length) logger.info(`[updates] Removed ${result.removed.length} installed-update cache files.`);
        result.failed.forEach(item => logger.warn(`[updates] Cache cleanup will retry next launch: ${item.message}`));
        return result;
      })().catch(error => {
        // A cleanup failure must not prevent launching or downloading updates.
        logger.warn(`[updates] Cache cleanup skipped: ${error.message}`);
        return { removed: [], failed: [{ message: error.message }] };
      });
    }
    return task;
  };
}

module.exports = { installedPackage, cleanupInstalledUpdateCache, createStartupUpdateCleanup };
