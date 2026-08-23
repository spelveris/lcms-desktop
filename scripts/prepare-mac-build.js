#!/usr/bin/env node

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

/**
 * Electron Builder loads iconv-corefoundation while creating macOS disk images.
 * On managed Macs, Gatekeeper can reject its unsigned native helper before the
 * regular afterPack app-signing hook has a chance to run. Sign only that known
 * npm dependency before starting Electron Builder.
 */
if (process.platform !== "darwin") {
  console.log("[prepare-mac-build] Non-macOS host; nothing to sign.");
  process.exit(0);
}

const nativeHelper = path.join(
  __dirname,
  "..",
  "node_modules",
  "iconv-corefoundation",
  "lib",
  "native.node"
);

if (!fs.existsSync(nativeHelper)) {
  console.log(`[prepare-mac-build] Native DMG helper not installed: ${nativeHelper}`);
  process.exit(0);
}

try {
  execFileSync("codesign", ["--verify", "--strict", nativeHelper], { stdio: "ignore" });
  console.log(`[prepare-mac-build] Native DMG helper is already signed: ${nativeHelper}`);
} catch (_error) {
  console.log(`[prepare-mac-build] Applying ad-hoc signature: ${nativeHelper}`);
  execFileSync("codesign", ["--force", "--sign", "-", nativeHelper], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--strict", "--verbose=2", nativeHelper], { stdio: "inherit" });
}
