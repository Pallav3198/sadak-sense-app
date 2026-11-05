// Sadak Sense on-board jolt detector. Runs on a phone (DeviceMotion) or a car ECU.
// Input: raw acceleration including gravity (m/s^2) + vehicle speed (m/s) + rotation rate.
// Output: events { type: 'breaker' | 'pothole', peakG, t } via onEvent.
//
// Method:
// 1. Track gravity with a slow low-pass filter; vertical acceleration = projection on gravity.
// 2. High-pass (subtract a 1 s moving mean) so slopes and braking don't trigger.
// 3. A peak is |a_v| above max(minG, k * rolling noise).
// 4. Axle-pair test: a second peak arriving wheelbase / speed later (±35%) means both axles
//    crossed the same feature across the road -> speed breaker. A single sharp peak -> pothole.
// 5. Suppress while the phone is being handled (high rotation rate) or below 8 km/h.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SadakDetector = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const G = 9.80665;

  function createDetector(opts = {}) {
    const cfg = Object.assign({ wheelbase: 2.6, minG: 0.28, k: 5, minSpeed: 8 / 3.6, handlingDps: 120, sampleHz: 60 }, opts);
    let gx = 0, gy = 0, gz = G, init = false;
    const hpWin = [], noise = []; let hpSum = 0;
    let pending = null, refractoryUntil = 0, handlingUntil = 0;
    const onEvent = opts.onEvent || (() => {});
    const trace = [];

    function push(t, ax, ay, az, speed, rotDps) {
      if (!init) { gx = ax; gy = ay; gz = az; init = true; }
      const a = 0.02; gx += a * (ax - gx); gy += a * (ay - gy); gz += a * (az - gz);
      const gn = Math.hypot(gx, gy, gz) || G;
      const vert = (ax * gx + ay * gy + az * gz) / gn - gn;
      hpWin.push(vert); hpSum += vert;
      if (hpWin.length > cfg.sampleHz) hpSum -= hpWin.shift();
      const v = (vert - hpSum / hpWin.length) / G; // in g
      noise.push(Math.abs(v)); if (noise.length > cfg.sampleHz * 3) noise.shift();
      const sorted = [...noise].sort((p, q) => p - q);
      const sigma = sorted[Math.floor(sorted.length * 0.5)] || 0.02;
      const thr = Math.max(cfg.minG, cfg.k * sigma);
      trace.push({ t, v, thr }); if (trace.length > 600) trace.shift();

      if (rotDps > cfg.handlingDps) handlingUntil = t + 2000;
      const active = speed >= cfg.minSpeed && t >= handlingUntil;

      // close pending single peak if its pair window expired
      if (pending && t > pending.windowEnd) { emit("pothole", pending.peak, pending.t, speed); pending = null; }

      if (!active || t < refractoryUntil) return v;
      if (Math.abs(v) >= thr) {
        refractoryUntil = t + 120; // ms, ignore ringing of the same impact
        const expected = (cfg.wheelbase / Math.max(speed, 1)) * 1000;
        if (pending && t >= pending.t + expected * 0.65 && t <= pending.t + expected * 1.35) {
          const ratio = Math.abs(v) / pending.peak;
          if (ratio > 0.35 && ratio < 2.8) { emit("breaker", Math.max(pending.peak, Math.abs(v)), pending.t, speed); pending = null; return v; }
        }
        if (!pending) pending = { t, peak: Math.abs(v), windowEnd: t + expected * 1.35 + 60 };
        else pending.peak = Math.max(pending.peak, Math.abs(v));
      }
      return v;
    }

    function emit(type, peak, t, speed) { onEvent({ type, peakG: Math.round(peak * 100) / 100, t, speed }); }
    return { push, trace, cfg };
  }

  // Synthetic sensor stream for demos and tests: road noise + optional features.
  function synth(features, { speed = 30 / 3.6, durationMs = 3000, hz = 60, wheelbase = 2.6, noiseG = 0.03, seed = 1 } = {}) {
    let s = seed; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const out = [];
    const gap = (wheelbase / speed) * 1000;
    for (let i = 0; i < (durationMs * hz) / 1000; i++) {
      const t = (i * 1000) / hz;
      let v = (rnd() - 0.5) * 2 * noiseG + 0.02 * Math.sin(t / 180);
      for (const f of features) {
        const pulse = (t0, amp) => { const d = (t - t0) / 35; return amp * Math.exp(-d * d) * Math.cos(d * 1.6); };
        if (f.type === "breaker") v += pulse(f.t, f.amp || 0.8) + pulse(f.t + gap, (f.amp || 0.8) * 0.85);
        if (f.type === "pothole") v += pulse(f.t, -(f.amp || 1.0)) + pulse(f.t + gap, -(f.amp || 1.0) * 0.18);
        if (f.type === "handling") v += t > f.t && t < f.t + 800 ? (rnd() - 0.5) * 2.5 : 0;
      }
      out.push({ t, ax: 0.3, ay: 0.2, az: G * (1 + v), rot: features.some((f) => f.type === "handling" && t > f.t && t < f.t + 800) ? 300 : 3 });
    }
    return out;
  }

  return { createDetector, synth, G };
});
