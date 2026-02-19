#!/usr/bin/env node

const { execFileSync } = require("child_process");
const path = require("path");

/**
 * Electron-builder hook.
 * For unsigned macOS builds (no Developer ID cert configured), force an ad-hoc
 * deep bundle signature so the output app is structurally valid for Gatekeeper
 * checks and doesn't trip the "app is damaged" path.
 */
exports.default = async function afterPack(context) {
  if (!context || context.electronPlatformName !== "darwin") {
    return;
  }

  const hasDeveloperSigning = Boolean(
    process.env.CSC_LINK ||
    process.env.CSC_NAME ||
    process.env.CSC_KEY_PASSWORD ||
    process.env.APPLE_ID ||
    process.env.APPLE_API_KEY ||
    process.env.APPLE_API_KEY_ID ||
    process.env.APPLE_TEAM_ID
  );

  if (hasDeveloperSigning) {
    return;
  }

  const productFilename = context.packager?.appInfo?.productFilename;
  const appOutDir = context.appOutDir;
  if (!productFilename || !appOutDir) {
    return;
  }

  const appPath = path.join(appOutDir, `${productFilename}.app`);
  console.log(`[afterPack] Applying ad-hoc deep signature: ${appPath}`);

  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], { stdio: "inherit" });
};
