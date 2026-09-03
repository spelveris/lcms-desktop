const test = require("node:test");
const assert = require("node:assert/strict");

const { isNewerVersion, versionParts } = require("./update-checker");

test("parses release tags with or without a v prefix", () => {
  assert.deepEqual(versionParts("v0.2.41"), [0, 2, 41]);
  assert.deepEqual(versionParts("1.0.0"), [1, 0, 0]);
});

test("detects a newer patch, minor, or major release", () => {
  assert.equal(isNewerVersion("0.2.41", "0.2.40"), true);
  assert.equal(isNewerVersion("0.3.0", "0.2.99"), true);
  assert.equal(isNewerVersion("1.0.0", "0.9.9"), true);
});

test("does not flag equal, older, or invalid versions", () => {
  assert.equal(isNewerVersion("v0.2.40", "0.2.40"), false);
  assert.equal(isNewerVersion("0.2.39", "0.2.40"), false);
  assert.equal(isNewerVersion("latest", "0.2.40"), false);
});
