const fs = require("fs");
const os = require("os");
const path = require("path");

const LOG_DIR = path.join(os.homedir(), "Library", "Logs", "CATrupole");
const RELAUNCH_ARG = "--catrupole-relaunch=";

function cleanRelaunchEnvironment(environment = process.env) {
  const env = { ...environment };
  // The update helper runs as Node. LaunchServices passes its environment to
  // the reopened app, so retaining this flag makes Electron exit without a UI.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  return env;
}

function relaunchTokens(argv) {
  return (argv || []).filter((arg) => typeof arg === "string" && arg.startsWith(RELAUNCH_ARG))
    .map((arg) => arg.slice(RELAUNCH_ARG.length))
    .filter((token) => /^[a-f0-9]{32}$/.test(token));
}

function receiptPath(token, logDir = LOG_DIR) {
  if (!/^[a-f0-9]{32}$/.test(token)) throw new Error("Invalid relaunch token.");
  return path.join(logDir, `relaunch-${token}.ready`);
}

function acknowledgeRelaunch(tokens, version, logDir = LOG_DIR) {
  for (const token of tokens) {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(receiptPath(token, logDir), JSON.stringify({ version, pid: process.pid }), { mode: 0o600 });
    } catch (error) {
      console.warn("Could not acknowledge updater relaunch:", error.message);
    }
  }
}

module.exports = { LOG_DIR, RELAUNCH_ARG, cleanRelaunchEnvironment, relaunchTokens, receiptPath, acknowledgeRelaunch };
