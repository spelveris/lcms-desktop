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
let backendProcess = null;

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
  const backendEnv = { ...process.env, LCMS_PORT: String(BACKEND_PORT) };

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
function waitForBackend(retries = 30, interval = 500) {
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "LC-MS Analysis",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Load the frontend HTML
  mainWindow.loadFile(path.join(__dirname, "..", "frontend", "index.html"));

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  startBackend();

  try {
    await waitForBackend();
  } catch (err) {
    dialog.showErrorBox(
      "Backend Error",
      "Could not start the Python backend.\nMake sure Python 3 and requirements are installed.\n\n" +
        err.message
    );
    app.quit();
    return;
  }

  createWindow();
});

app.on("window-all-closed", () => {
  stopBackend();
  app.quit();
});

app.on("before-quit", () => {
  stopBackend();
});
