// Hard-braking detector for near-miss zones (spec 14.8). Runs on the phone from GPS speed; in the car it
// would read brake pressure and ABS/ESC activation instead. Pure logic, shared with the tests.
// A hard brake: speed falls by 12+ km/h within 2.5 s from 20+ km/h, average deceleration 3 m/s² or more
// (about 0.3 g; normal city braking is 1–2 m/s²), with usable GPS. One event per 10 s.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SadakBrake = factory();
})(typeof self !== "undefined" ? self : this, function () {
  function createBrake({ onBrake = () => {}, minStartKmh = 20, minDropKmh = 12, windowMs = 2500, minDecel = 3.0, maxAccM = 25, gapMs = 10000 } = {}) {
    const s = []; let last = -Infinity;
    function push(ts, speedMps, accM = null) {
      if (accM != null && accM > maxAccM) return;
      s.push({ ts, v: speedMps * 3.6 });
      while (s.length && ts - s[0].ts > windowMs) s.shift();
      if (ts - last < gapMs || s.length < 2) return;
      const peak = s.reduce((a, b) => (b.v > a.v ? b : a));
      const now = s[s.length - 1], drop = peak.v - now.v, dt = (now.ts - peak.ts) / 1000;
      if (peak.v >= minStartKmh && drop >= minDropKmh && dt > 0) {
        const decel = drop / 3.6 / dt;
        if (decel >= minDecel) { last = ts; onBrake({ ts, fromKmh: Math.round(peak.v), toKmh: Math.round(now.v), decel: Math.round(decel * 10) / 10 }); }
      }
    }
    return { push };
  }
  return { createBrake };
});
