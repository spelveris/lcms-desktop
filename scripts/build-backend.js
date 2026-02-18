#!/usr/bin/env node

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
process.chdir(repoRoot);

function resolvePythonCommand() {
  const candidates = [];

  if (process.env.LCMS_PYTHON && process.env.LCMS_PYTHON.trim()) {
    candidates.push(process.env.LCMS_PYTHON.trim());
  }

  if (process.env.LCMS_PYTHON_BOOTSTRAP && process.env.LCMS_PYTHON_BOOTSTRAP.trim()) {
    candidates.push(process.env.LCMS_PYTHON_BOOTSTRAP.trim());
  }

  const localVenvUnix = path.join(repoRoot, ".venv", "bin", "python");
  const localVenvWin = path.join(repoRoot, ".venv", "Scripts", "python.exe");
  const backendVenvUnix = path.join(repoRoot, "backend", ".venv", "bin", "python");
  const backendVenvWin = path.join(repoRoot, "backend", ".venv", "Scripts", "python.exe");

  [localVenvUnix, localVenvWin, backendVenvUnix, backendVenvWin].forEach((cmd) => {
    if (fs.existsSync(cmd)) {
      candidates.push(cmd);
    }
  });

  if (process.platform === "win32") {
    candidates.push("py", "python");
  } else {
    candidates.push("python3", "python");
  }

  for (const candidate of candidates) {
    const versionCheckArgs = candidate === "py" ? ["-3", "--version"] : ["--version"];
    const check = spawnSync(candidate, versionCheckArgs, { stdio: "ignore" });
    if (check.status === 0) {
      return candidate;
    }
  }

  throw new Error("No usable Python interpreter found.");
}

function run() {
  const python = resolvePythonCommand();
  const dataSep = process.platform === "win32" ? ";" : ":";
  const lcmsAppPath = path.join(repoRoot, "backend", "lcms_app");
  const serverPath = path.join(repoRoot, "backend", "server.py");

  const args = [];
  const pyPrefix = [];
  if (python === "py") {
    pyPrefix.push("-3");
  }
  args.push(...pyPrefix);

  const pyInstallerCheck = spawnSync(
    python,
    [...pyPrefix, "-m", "PyInstaller", "--version"],
    { stdio: "ignore" }
  );
  if (pyInstallerCheck.status !== 0) {
    console.log("PyInstaller not found. Installing it in the selected Python environment...");
    const install = spawnSync(
      python,
      [...pyPrefix, "-m", "pip", "install", "pyinstaller"],
      { stdio: "inherit" }
    );
    if (install.status !== 0) {
      console.error("Failed to install PyInstaller.");
      process.exit(install.status || 1);
    }
  }

  args.push(
    "-m",
    "PyInstaller",
    "--noconfirm",
    "--clean",
    "--onedir",
    "--name",
    "lcms-backend",
    "--distpath",
    path.join("dist", "backend"),
    "--workpath",
    path.join("build", "pyinstaller"),
    "--specpath",
    path.join("build", "pyinstaller"),
    "--paths",
    lcmsAppPath,
    "--add-data",
    `${lcmsAppPath}${dataSep}lcms_app`,
    serverPath
  );

  console.log(`Building backend with ${python} ...`);

  const result = spawnSync(python, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
    },
  });

  if (result.status !== 0) {
    console.error("Backend build failed. Ensure PyInstaller is installed in the selected Python env.");
    process.exit(result.status || 1);
  }

  const exeName = process.platform === "win32" ? "lcms-backend.exe" : "lcms-backend";
  const exePath = path.join(repoRoot, "dist", "backend", "lcms-backend", exeName);

  if (!fs.existsSync(exePath)) {
    console.error(`Backend build finished but executable not found: ${exePath}`);
    process.exit(1);
  }

  console.log(`Backend build complete: ${exePath}`);
}

run();
