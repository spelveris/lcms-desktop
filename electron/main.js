/**
 * Electron main process for LC-MS Desktop App.
 *
 * 1. Spawns the Python FastAPI backend as a child process
 * 2. Waits for it to be ready
 * 3. Opens a BrowserWindow pointing at the frontend
 * 4. Kills the backend on quit
 */

const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { autoUpdater } = require("electron-updater");
const { fetchLatestRelease, isNewerVersion } = require("./update-checker");

const BACKEND_PORT = 8741;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RELEASES_URL = "https://github.com/spelveris/lcms-desktop/releases";

let mainWindow = null;
let splashWindow = null;
let backendProcess = null;
let isQuitting = false;
let backendReady = false;
let updateCheckTimer = null;
let packagedUpdaterConfigured = false;
let updateStatus = {
  state: "idle",
  available: false,
  currentVersion: "",
  latestVersion: "",
  releaseUrl: RELEASES_URL,
};

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
}

function sendUpdateStatus(status) {
  updateStatus = { ...updateStatus, ...status };
  BrowserWindow.getAllWindows().forEach((window) => {
    if (!window.isDestroyed()) {
      window.webContents.send("updates:status", updateStatus);
    }
  });
  return updateStatus;
}

function releaseUrlForVersion(version) {
  const normalized = String(version || "").trim().replace(/^v/i, "");
  return normalized ? `${RELEASES_URL}/tag/v${normalized}` : RELEASES_URL;
}

function configurePackagedUpdater() {
  if (!app.isPackaged || packagedUpdaterConfigured) return;
  packagedUpdaterConfigured = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = console;

  autoUpdater.on("checking-for-update", () => {
    sendUpdateStatus({
      state: "checking",
      available: false,
      currentVersion: String(app.getVersion() || ""),
    });
  });

  autoUpdater.on("update-available", (info) => {
    const latestVersion = String(info?.version || "");
    sendUpdateStatus({
      state: "available",
      available: true,
      installable: true,
      currentVersion: String(app.getVersion() || ""),
      latestVersion,
      releaseUrl: releaseUrlForVersion(latestVersion),
      progressPercent: 0,
      checkedAt: new Date().toISOString(),
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    const progressPercent = Math.max(0, Math.min(100, Math.round(Number(progress?.percent) || 0)));
    sendUpdateStatus({
      state: "downloading",
      available: true,
      installable: true,
      progressPercent,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    const latestVersion = String(info?.version || updateStatus.latestVersion || "");
    sendUpdateStatus({
      state: "ready",
      available: true,
      installable: true,
      latestVersion,
      releaseUrl: releaseUrlForVersion(latestVersion),
      progressPercent: 100,
    });
  });

  autoUpdater.on("update-not-available", (info) => {
    sendUpdateStatus({
      state: "current",
      available: false,
      installable: true,
      currentVersion: String(app.getVersion() || ""),
      latestVersion: String(info?.version || app.getVersion() || ""),
      progressPercent: 0,
      checkedAt: new Date().toISOString(),
    });
  });

  autoUpdater.on("error", (error) => {
    console.warn(`[updates] Automatic update failed: ${error.message}`);
    sendUpdateStatus({
      state: "offline",
      available: false,
      installable: true,
      currentVersion: String(app.getVersion() || ""),
      progressPercent: 0,
      checkedAt: new Date().toISOString(),
    });
  });
}

async function checkForUpdates() {
  const currentVersion = String(app.getVersion() || "");
  if (app.isPackaged) {
    configurePackagedUpdater();
    if (updateStatus.state === "downloading" || updateStatus.state === "ready" || updateStatus.state === "installing") {
      return updateStatus;
    }
    try {
      await autoUpdater.checkForUpdates();
      return updateStatus;
    } catch (error) {
      console.warn(`[updates] Could not check for automatic updates: ${error.message}`);
      return sendUpdateStatus({
        state: "offline",
        available: false,
        installable: true,
        currentVersion,
        progressPercent: 0,
        checkedAt: new Date().toISOString(),
      });
    }
  }

  try {
    const release = await fetchLatestRelease();
    const available = isNewerVersion(release.version, currentVersion);
    return sendUpdateStatus({
      state: available ? "available" : "current",
      available,
      currentVersion,
      latestVersion: release.version,
      releaseUrl: release.url || RELEASES_URL,
      installable: false,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.warn(`[updates] Could not check GitHub releases: ${error.message}`);
    return sendUpdateStatus({
      state: "offline",
      available: false,
      currentVersion,
      checkedAt: new Date().toISOString(),
    });
  }
}

function startUpdateChecks() {
  if (updateCheckTimer) return;
  void checkForUpdates();
  updateCheckTimer = setInterval(() => {
    void checkForUpdates();
  }, UPDATE_CHECK_INTERVAL_MS);
  updateCheckTimer.unref?.();
}

ipcMain.handle("updates:get-status", async () => {
  if (updateStatus.state === "idle") {
    return checkForUpdates();
  }
  return updateStatus;
});

ipcMain.handle("updates:open-release", async () => {
  const candidate = String(updateStatus.releaseUrl || RELEASES_URL);
  let releaseUrl = RELEASES_URL;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === "https:" && parsed.hostname === "github.com" && parsed.pathname.startsWith("/spelveris/lcms-desktop/releases")) {
      releaseUrl = parsed.toString();
    }
  } catch (_) {
    // Fall back to the fixed repository releases page.
  }
  await shell.openExternal(releaseUrl);
  return true;
});

ipcMain.handle("updates:perform-action", async () => {
  if (app.isPackaged && updateStatus.state === "ready") {
    sendUpdateStatus({ state: "installing", available: true, installable: true });
    isQuitting = true;
    stopBackend();
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return "installing";
  }

  if (!app.isPackaged && updateStatus.available) {
    const candidate = String(updateStatus.releaseUrl || RELEASES_URL);
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "https:" && parsed.hostname === "github.com" && parsed.pathname.startsWith("/spelveris/lcms-desktop/releases")) {
        await shell.openExternal(parsed.toString());
        return "opened-release";
      }
    } catch (_) {
      // Ignore invalid release URLs in development builds.
    }
  }

  return "unavailable";
});

// ---------------------------------------------------------------------------
// Backend lifecycle
// ---------------------------------------------------------------------------

function resolveBackendCommand() {
  if (app.isPackaged) {
    const backendDir = path.join(process.resourcesPath, "backend");
    const exeName = process.platform === "win32" ? "lcms-backend.exe" : "lcms-backend";
    const exePath = path.join(backendDir, exeName);

    if (fs.existsSync(exePath)) {
      return {
        cmd: exePath,
        args: [],
        cwd: backendDir,
      };
    }

    console.error(`[backend] Packaged backend not found at: ${exePath}`);
  }

  const appRoot = path.join(__dirname, "..");
  const serverPath = path.join(appRoot, "backend", "server.py");
  const localVenvPython = path.join(appRoot, ".venv", "bin", "python");
  const localVenvPythonWin = path.join(appRoot, ".venv", "Scripts", "python.exe");
  const backendVenvPython = path.join(appRoot, "backend", ".venv", "bin", "python");
  const backendVenvPythonWin = path.join(appRoot, "backend", ".venv", "Scripts", "python.exe");

  const pythonCmd = process.env.LCMS_PYTHON
    || (fs.existsSync(localVenvPython) ? localVenvPython
      : (fs.existsSync(localVenvPythonWin) ? localVenvPythonWin
        : (fs.existsSync(backendVenvPython) ? backendVenvPython
          : (fs.existsSync(backendVenvPythonWin) ? backendVenvPythonWin
            : (process.platform === "win32" ? "python" : "python3")))));

  return {
    cmd: pythonCmd,
    args: [serverPath],
    cwd: appRoot,
  };
}

function startBackend() {
  const backendCmd = resolveBackendCommand();
  const backendEnv = {
    ...process.env,
    LCMS_PORT: String(BACKEND_PORT),
    LCMS_APP_VERSION: String(app.getVersion()),
    LCMS_USER_DATA_DIR: app.getPath("userData"),
  };

  if (app.isPackaged) {
    const packagedNodeModules = path.join(process.resourcesPath, "app", "node_modules");
    if (fs.existsSync(packagedNodeModules)) {
      backendEnv.LCMS_NODE_MODULES = packagedNodeModules;
      backendEnv.NODE_PATH = backendEnv.NODE_PATH
        ? `${packagedNodeModules}${path.delimiter}${backendEnv.NODE_PATH}`
        : packagedNodeModules;
    }
    backendEnv.LCMS_NODE = process.execPath;
  }

  backendProcess = spawn(backendCmd.cmd, backendCmd.args, {
    cwd: backendCmd.cwd,
    env: backendEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  backendProcess.stdout.on("data", (data) => {
    console.log(`[backend] ${data.toString().trim()}`);
  });

  backendProcess.stderr.on("data", (data) => {
    console.error(`[backend] ${data.toString().trim()}`);
  });

  backendProcess.on("close", (code) => {
    console.log(`[backend] exited with code ${code}`);
    backendProcess = null;
  });
}

function stopBackend() {
  if (backendProcess) {
    backendProcess.kill("SIGTERM");
    backendProcess = null;
  }
}

/** Poll /api/health until the backend responds. */
function waitForBackend(retries = 120, interval = 500) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      attempts++;
      http
        .get(`${BACKEND_URL}/api/health`, (res) => {
          if (res.statusCode === 200) return resolve();
          if (attempts < retries) return setTimeout(check, interval);
          reject(new Error("Backend did not become healthy"));
        })
        .on("error", () => {
          if (attempts < retries) return setTimeout(check, interval);
          reject(new Error("Backend did not start"));
        });
    };
    check();
  });
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function getTrackedWindow(windowRef) {
  return windowRef && !windowRef.isDestroyed() ? windowRef : null;
}

function getMainWindow() {
  const trackedWindow = getTrackedWindow(mainWindow);
  if (trackedWindow) return trackedWindow;

  const existingWindow = BrowserWindow.getAllWindows().find(
    (candidate) => candidate !== splashWindow && !candidate.isDestroyed()
  );
  mainWindow = existingWindow || null;
  return mainWindow;
}

function revealWindow(windowRef) {
  const windowToReveal = getTrackedWindow(windowRef);
  if (!windowToReveal) return;

  app.focus();
  if (windowToReveal.isMinimized()) {
    windowToReveal.restore();
  }
  if (!windowToReveal.isVisible()) {
    windowToReveal.show();
  }
  windowToReveal.focus();
  if (typeof windowToReveal.moveTop === "function") {
    windowToReveal.moveTop();
  }
}

function closeSplashWindow() {
  const trackedSplash = getTrackedWindow(splashWindow);
  if (!trackedSplash) {
    splashWindow = null;
    return;
  }

  splashWindow = null;
  trackedSplash.close();
}

function createSplashWindow() {
  const trackedSplash = getTrackedWindow(splashWindow);
  if (trackedSplash) return trackedSplash;

  const splash = new BrowserWindow({
    width: 420,
    height: 280,
    minWidth: 420,
    minHeight: 280,
    maxWidth: 420,
    maxHeight: 280,
    show: false,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    backgroundColor: "#0f172a",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  splash.loadFile(path.join(__dirname, "splash.html"), {
    query: { appVersion: app.getVersion() },
  });

  splash.once("ready-to-show", () => {
    revealWindow(splash);
  });

  splash.on("closed", () => {
    if (splashWindow === splash) {
      splashWindow = null;
    }
  });

  splashWindow = splash;
  return splash;
}

function createWindow() {
  const existingWindow = getMainWindow();
  if (existingWindow) {
    revealWindow(existingWindow);
    return existingWindow;
  }

  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "CATrupole",
    show: false, // Hide until ready to prevent white flash
    backgroundColor: "#1e1e2e",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow = window;

  // Load the frontend HTML and pass app version into renderer.
  window.loadFile(path.join(__dirname, "..", "frontend", "index.html"), {
    query: { appVersion: app.getVersion() },
  });

  // Show window only after content is rendered
  window.once("ready-to-show", () => {
    closeSplashWindow();
    revealWindow(window);
  });

  window.on("close", (event) => {
    // On macOS, red close should hide the last window and keep the app running unless quitting explicitly.
    if (process.platform === "darwin" && !isQuitting) {
      event.preventDefault();
      window.hide();
      return;
    }
  });

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  return window;
}

function restoreOrCreateMainWindow() {
  const existingWindow = getMainWindow();
  if (existingWindow) {
    revealWindow(existingWindow);
    return existingWindow;
  }

  if (!backendReady) {
    const trackedSplash = getTrackedWindow(splashWindow);
    if (trackedSplash) revealWindow(trackedSplash);
    return null;
  }

  return createWindow();
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

if (gotSingleInstanceLock) {
  app.on("second-instance", () => {
    restoreOrCreateMainWindow();
  });

  app.whenReady().then(async () => {
    createSplashWindow();
    startBackend();

    try {
      await waitForBackend();
      backendReady = true;
    } catch (err) {
      closeSplashWindow();
      dialog.showErrorBox(
        "Backend Error",
        "Could not start the CATrupole backend.\nIf this is the first launch after an update, wait a moment and try opening the app again.\n\n" +
          err.message
      );
      app.quit();
      return;
    }

    createWindow();
    startUpdateChecks();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      stopBackend();
      app.quit();
    }
  });

  app.on("before-quit", () => {
    isQuitting = true;
    if (updateCheckTimer) {
      clearInterval(updateCheckTimer);
      updateCheckTimer = null;
    }
    closeSplashWindow();
    stopBackend();
  });

  app.on("activate", () => {
    restoreOrCreateMainWindow();
  });
}
