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
    // Prefer the same interpreter configured by actions/setup-python.
    candidates.push("python", "py");
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
  const requirementsPath = path.join(repoRoot, "requirements.txt");

  const args = [];
  const pyPrefix = [];
  if (python === "py") {
    pyPrefix.push("-3");
  }
  args.push(...pyPrefix);

  const pyVersion = spawnSync(python, [...pyPrefix, "--version"], { encoding: "utf8" });
  if (pyVersion.status === 0) {
    const versionText = (pyVersion.stdout || pyVersion.stderr || "").trim();
    console.log(`Using Python interpreter: ${python} (${versionText})`);
  } else {
    console.log(`Using Python interpreter: ${python}`);
  }

  // Ensure backend runtime dependencies exist in the *same* interpreter that runs PyInstaller.
  const depsCheck = spawnSync(
    python,
    [...pyPrefix, "-c", "import fastapi, uvicorn, numpy, scipy, matplotlib, pandas"],
    { stdio: "ignore" }
  );
  if (depsCheck.status !== 0) {
    if (!fs.existsSync(requirementsPath)) {
      console.error(`Missing requirements file: ${requirementsPath}`);
      process.exit(1);
    }
    console.log("Installing backend Python dependencies into selected interpreter...");
    const depsInstall = spawnSync(
      python,
      [...pyPrefix, "-m", "pip", "install", "-r", requirementsPath],
      { stdio: "inherit" }
    );
    if (depsInstall.status !== 0) {
      console.error("Failed to install backend Python dependencies.");
      process.exit(depsInstall.status || 1);
    }
  }

  const depsRecheck = spawnSync(
    python,
    [...pyPrefix, "-c", "import fastapi, uvicorn, numpy, scipy, matplotlib, pandas"],
    { stdio: "ignore" }
  );
  if (depsRecheck.status !== 0) {
    console.error("Required Python backend modules are still missing in selected interpreter.");
    process.exit(1);
  }

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
    "--hidden-import",
    "uvicorn",
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
