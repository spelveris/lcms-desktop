const test = require("node:test");
const assert = require("node:assert/strict");
const { count, radius, diameter, period, minimumAngularSpeed, angle, positions } = require("./spinner-motion");

test("dots stay on a true circle and never touch, including the cycle boundary", () => {
  let minimumGap = Infinity;
  for (let t = 0; t <= period; t += 0.5) {
    const points = positions(t);
    assert.equal(points.length, count);
    points.forEach((p, i) => {
      assert.ok(Math.abs(Math.hypot(p.x, p.y) - radius) < 1e-10);
      for (const q of points.slice(i + 1)) minimumGap = Math.min(minimumGap, Math.hypot(p.x - q.x, p.y - q.y));
    });
  }
  assert.ok(minimumGap > diameter + 1, `minimum center distance: ${minimumGap}`);
  // A continuous lower bound, not just a sampled collision check.
  assert.ok(2 * radius * Math.sin((minimumAngularSpeed / count) * Math.PI / 360) > diameter + 1);
});

test("splash dot geometry matches the non-overlap model", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const splash = fs.readFileSync(path.join(__dirname, "splash.html"), "utf8");
  const css = splash.match(/\.spinner-bubble\s*\{([^}]+)\}/)[1];
  assert.match(css, new RegExp(`width: ${diameter}px`));
  assert.match(css, new RegExp(`height: ${diameter}px`));
  assert.match(css, new RegExp(`translateY\\(-${radius}px\\)`));
  assert.equal((splash.match(/class="spinner-bubble"/g) || []).length, count);
});

test("motion accelerates on the right, queues at the bottom, and slows climbing", () => {
  const speed = p => (angle(p + 0.00001) - angle(p)) / 0.00001;
  assert.ok(speed(0.24) > speed(0.10) * 2);
  assert.ok(speed(0.45) < speed(0.24) / 5);
  assert.ok(angle(0.45) > 160 && angle(0.45) < 215);
  assert.ok(speed(0.95) < speed(0.80));
  assert.ok(angle(0.99999) > 359.99);
  assert.equal(angle(1), 0);
});

test("reduced motion has evenly spaced, stationary dots", () => {
  assert.deepEqual(positions(0, true), positions(9999, true));
  assert.equal(positions(0, true)[1].degrees, 360 / count);
});
