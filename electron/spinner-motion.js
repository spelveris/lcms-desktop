/* A clockwise, gravity-inspired orbit with a slow, collision-free bottom queue. */
(function (root) {
  "use strict";
  const count = 7;
  const radius = 27;
  const diameter = 6;
  const period = 2400;
  // Positive speeds preserve dot order. Smooth interpolation avoids a jerk at
  // each transition; the short slowdown before the bottom gives a queue effect.
  const speedStops = [
    [0, 0.7], [0.16, 2.2], [0.24, 3.8], [0.29, 3.8],
    [0.33, 0.55], [0.58, 0.55], [0.69, 1.5], [0.79, 1.8],
    [0.90, 1.0], [1, 0.7],
  ];
  const total = speedStops.slice(1).reduce((sum, stop, i) =>
    sum + (stop[0] - speedStops[i][0]) * (stop[1] + speedStops[i][1]) / 2, 0);
  const minimumAngularSpeed = 360 * Math.min(...speedStops.map(stop => stop[1])) / total;

  function angle(phase) {
    const p = ((phase % 1) + 1) % 1;
    let area = 0;
    for (let i = 1; i < speedStops.length; i += 1) {
      const [start, a] = speedStops[i - 1];
      const [end, b] = speedStops[i];
      const width = end - start;
      const u = Math.min(1, Math.max(0, (p - start) / width));
      // Integral of a + (b-a) * smoothstep(u).
      area += width * (a * u + (b - a) * (u ** 3 - u ** 4 / 2));
      if (p <= end) break;
    }
    return 360 * area / total;
  }

  function positions(elapsed, reducedMotion = false) {
    return Array.from({ length: count }, (_, i) => {
      const degrees = reducedMotion ? i * 360 / count : angle(elapsed / period + i / count);
      const radians = degrees * Math.PI / 180;
      return { degrees, x: radius * Math.sin(radians), y: -radius * Math.cos(radians) };
    });
  }

  const api = { count, radius, diameter, period, minimumAngularSpeed, angle, positions };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CATrupoleSpinner = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
