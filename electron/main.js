/**
 * Electron main process for LC-MS Desktop App.
 *
 * 1. Spawns the Python FastAPI backend as a child process
 * 2. Waits for it to be ready
 * 3. Opens a BrowserWindow pointing at the frontend
 * 4. Kills the backend on quit
 */

const { app, BrowserWindow, dialog } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");

const BACKEND_PORT = 8741;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;

let mainWindow = null;
let splashWindow = null;
let backendProcess = null;
let isQuitting = false;
let backendReady = false;

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
}

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
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      stopBackend();
      app.quit();
    }
  });

  app.on("before-quit", () => {
    isQuitting = true;
    closeSplashWindow();
    stopBackend();
  });

  app.on("activate", () => {
    restoreOrCreateMainWindow();
  });
}
