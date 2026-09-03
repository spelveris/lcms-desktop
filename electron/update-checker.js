const https = require("https");

const LATEST_RELEASE_API = "https://api.github.com/repos/spelveris/lcms-desktop/releases/latest";

function versionParts(value) {
  const match = String(value || "").trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function isNewerVersion(candidate, current) {
  const next = versionParts(candidate);
  const installed = versionParts(current);
  if (!next || !installed) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== installed[index]) return next[index] > installed[index];
  }
  return false;
}

function fetchLatestRelease({ timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(LATEST_RELEASE_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "CATrupole-Desktop",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) {
          request.destroy(new Error("GitHub response was unexpectedly large"));
        }
      });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`GitHub returned HTTP ${response.statusCode}`));
          return;
        }
        try {
          const data = JSON.parse(body);
          const version = String(data.tag_name || "").replace(/^v/i, "");
          if (!versionParts(version)) throw new Error("Latest release has no valid version tag");
          resolve({
            version,
            url: String(data.html_url || ""),
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("GitHub update check timed out"));
    });
    request.on("error", reject);
  });
}

module.exports = {
  fetchLatestRelease,
  isNewerVersion,
  versionParts,
};
