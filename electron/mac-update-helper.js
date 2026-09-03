const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const PRODUCT_APP_NAME = "CATrupole.app";
const PRODUCT_BUNDLE_ID = "com.catrupole.desktop";
const LOG_DIR = path.join(os.homedir(), "Library", "Logs", "CATrupole");
const LOG_FILE = path.join(LOG_DIR, "updater.log");

function log(message) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch (_) {
    // Updating must not fail merely because diagnostic logging is unavailable.
  }
}

function normalizeVersion(version) {
  return String(version || "").trim().replace(/^v/i, "");
}

function assertInstallRequest(zipPath, appPath, expectedVersion) {
  const resolvedZip = path.resolve(String(zipPath || ""));
  const resolvedApp = path.resolve(String(appPath || ""));
  const version = normalizeVersion(expectedVersion);

  if (path.extname(resolvedZip).toLowerCase() !== ".zip") {
    throw new Error("The downloaded macOS update is not a ZIP archive.");
  }
  if (!fs.statSync(resolvedZip).isFile()) {
    throw new Error("The downloaded macOS update file is missing.");
  }
  if (path.basename(resolvedApp) !== PRODUCT_APP_NAME || !fs.statSync(resolvedApp).isDirectory()) {
    throw new Error("CATrupole is not running from an installable application bundle.");
  }
  if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version)) {
    throw new Error("The downloaded update has an invalid version.");
  }

  return { zipPath: resolvedZip, appPath: resolvedApp, expectedVersion: version };
}

function runChecked(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(`${path.basename(command)} failed${detail ? `: ${detail}` : ""}`);
  }
  return String(result.stdout || "").trim();
}

function readBundleValue(appPath, key) {
  return runChecked("/usr/bin/plutil", [
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    path.join(appPath, "Contents", "Info.plist"),
  ]);
}

function waitForParentToExit(parentPid, timeoutMs = 60000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      try {
        process.kill(parentPid, 0);
      } catch (error) {
        if (error && error.code === "ESRCH") {
          resolve();
          return;
        }
        reject(error);
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error("CATrupole did not close in time for the update."));
        return;
      }
      setTimeout(check, 250);
    };
    check();
  });
}

function validateStagedApp(stagedAppPath, expectedVersion) {
  if (!fs.existsSync(stagedAppPath) || !fs.statSync(stagedAppPath).isDirectory()) {
    throw new Error("The update archive does not contain CATrupole.app.");
  }

  const bundleId = readBundleValue(stagedAppPath, "CFBundleIdentifier");
  const version = normalizeVersion(readBundleValue(stagedAppPath, "CFBundleShortVersionString"));
  if (bundleId !== PRODUCT_BUNDLE_ID) {
    throw new Error(`Unexpected application identifier: ${bundleId}`);
  }
  if (version !== normalizeVersion(expectedVersion)) {
    throw new Error(`Expected CATrupole ${expectedVersion}, but the archive contains ${version}.`);
  }

  runChecked("/usr/bin/codesign", ["--verify", "--deep", "--strict", stagedAppPath]);
}

function restorePreviousApp(appPath, backupPath, stagingRoot) {
  try {
    if (fs.existsSync(appPath)) {
      const failedPath = path.join(stagingRoot, `${PRODUCT_APP_NAME}.failed`);
      fs.renameSync(appPath, failedPath);
    }
    if (fs.existsSync(backupPath)) fs.renameSync(backupPath, appPath);
  } catch (error) {
    log(`Rollback failed: ${error.message}`);
  }
}

async function installUpdate(parentPid, zipPath, appPath, expectedVersion) {
  const request = assertInstallRequest(zipPath, appPath, expectedVersion);
  await waitForParentToExit(parentPid);

  const installParent = path.dirname(request.appPath);
  const stagingRoot = fs.mkdtempSync(path.join(installParent, ".catrupole-update-"));
  const stagedAppPath = path.join(stagingRoot, PRODUCT_APP_NAME);
  const backupPath = path.join(installParent, `.CATrupole.previous-${process.pid}.app`);
  let previousAppMoved = false;

  try {
    log(`Preparing CATrupole ${request.expectedVersion}.`);
    runChecked("/usr/bin/ditto", ["-x", "-k", request.zipPath, stagingRoot]);
    validateStagedApp(stagedAppPath, request.expectedVersion);

    fs.renameSync(request.appPath, backupPath);
    previousAppMoved = true;
    fs.renameSync(stagedAppPath, request.appPath);

    const openResult = spawnSync("/usr/bin/open", ["-n", request.appPath], { encoding: "utf8" });
    if (openResult.error || openResult.status !== 0) {
      throw openResult.error || new Error(String(openResult.stderr || "Could not reopen CATrupole.").trim());
    }

    fs.rmSync(backupPath, { recursive: true, force: true });
    previousAppMoved = false;
    log(`Installed CATrupole ${request.expectedVersion} successfully.`);
  } catch (error) {
    log(`Update failed: ${error.message}`);
    if (previousAppMoved) restorePreviousApp(request.appPath, backupPath, stagingRoot);
    try {
      spawnSync("/usr/bin/open", ["-n", request.appPath], { encoding: "utf8" });
    } catch (_) {
      // The updater log preserves the original failure for support.
    }
    throw error;
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

async function main() {
  const parentPid = Number(process.argv[2]);
  if (process.platform !== "darwin" || !Number.isSafeInteger(parentPid) || parentPid <= 1) {
    throw new Error("Invalid CATrupole macOS updater invocation.");
  }
  await installUpdate(parentPid, process.argv[3], process.argv[4], process.argv[5]);
}

if (require.main === module) {
  main().catch((error) => {
    log(`Fatal updater error: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertInstallRequest,
  normalizeVersion,
  validateStagedApp,
};
