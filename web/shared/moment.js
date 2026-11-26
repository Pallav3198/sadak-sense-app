// Sadak Sense driving moment (spec 14.4): is this a safe moment to tell the driver something, and how much?
// Pure logic on speed/heading samples plus the server's signal state. Shared by the phone and the tests.
//
// Moments:  clear  = moving steadily (15+ km/h, little speed change, no turn), no hazard ahead
//           busy   = moving otherwise (turning, braking, hazard ahead): say nothing
//           red    = stopped at a traffic signal after a clean approach; secondsLeft estimated
//           jam    = stopped in traffic (creeping, no signal, or stop-start)
//           parked = stopped 2+ minutes away from a signal, not in a jam
// Delivery tiers: red > 40 s or parked → full message with reply / short call; red 15–40 s → one-line
// summaries; red < 15 s → nothing; jam → hold and batch (VIP / urgent one-liners only while fully stopped);
// clear → one-line summaries; busy → nothing.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SadakMoment = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const FRONT_M = 25;
  const hdiff = (a, b) => { const d = Math.abs((((a - b) % 360) + 540) % 360 - 180); return d; };
  const hav = (a, b, c, d) => { const R = 6371000, r = Math.PI / 180, x = Math.sin(((c - a) * r) / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
  const sd = (a) => { if (a.length < 2) return 0; const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); };

  function createMoment() {
    let samples = [];
    function sample(s) { samples.push(s); const cut = s.ts - 180e3; while (samples.length && samples[0].ts < cut) samples.shift(); }

    // Runs of "stopped" (< 3 km/h for 2+ s) in a time window.
    function stopRuns(from, to) {
      const runs = []; let cur = null;
      for (const s of samples) {
        if (s.ts < from || s.ts > to) continue;
        if (s.kmh < 3) { if (!cur) cur = { start: s.ts, end: s.ts }; else cur.end = s.ts; }
        else if (cur) { if (cur.end - cur.start >= 2000) runs.push(cur); cur = null; }
      }
      if (cur && cur.end - cur.start >= 2000) runs.push(cur);
      return runs;
    }

    function state({ now = samples.length ? samples[samples.length - 1].ts : Date.now(), signal = null, hazardAhead = false } = {}) {
      if (!samples.length) return { kind: "busy", why: "no data" };
      const last = samples[samples.length - 1];
      const recent = samples.filter((s) => now - s.ts <= 3500);
      const stopped = recent.length >= 2 && recent.every((s) => s.kmh < 3) && now - recent[0].ts >= 2500;
      if (!stopped) {
        const w = samples.filter((s) => now - s.ts <= 20e3), w10 = samples.filter((s) => now - s.ts <= 10e3 && s.heading != null);
        const turning = w10.length > 1 && w10.some((s) => hdiff(s.heading, w10[w10.length - 1].heading) > 25);
        const steady = last.kmh >= 15 && sd(w.map((s) => s.kmh)) < 7;
        if (steady && !turning && !hazardAhead) return { kind: "clear", why: "steady speed, straight, no hazard ahead" };
        return { kind: "busy", why: hazardAhead ? "hazard ahead" : turning ? "turning" : last.kmh < 15 ? "slow traffic" : "speed changing" };
      }
      // When did this stop start?
      let i = samples.length - 1; while (i > 0 && samples[i - 1].kmh < 3) i--;
      const stopStart = samples[i].ts, waited = (now - stopStart) / 1000;
      const before = samples.filter((s) => s.ts < stopStart && stopStart - s.ts <= 30e3);
      const cleanApproach = before.some((s) => s.kmh >= 15);
      const priorStops = stopRuns(stopStart - 120e3, stopStart - 1).length;
      const creeping = !cleanApproach || priorStops >= 2;
      if (signal && signal.signal) {
        const ref = signal.stopLine || signal.signal;
        const dist = last.lat != null ? hav(last.lat, last.lon, ref.lat, ref.lon) : signal.signal.distanceM;
        const front = dist <= FRONT_M;
        // Fleet pattern: at a working signal cars stop and then all start together. If recent cars at this
        // approach mostly creep off one by one (< 30% together), treat the queue as a jam unless we're at the front.
        const fleetSaysJam = signal.releasedTogether != null && signal.releasedTogether < 0.3;
        if (front || (!creeping && !fleetSaysJam)) {
          const phaseStart = Math.min(stopStart, signal.phaseStart || Infinity);
          const left = Math.max(0, Math.round(signal.redS - (now - phaseStart) / 1000));
          return { kind: "red", secondsLeft: left, redS: signal.redS, learned: !!signal.learned, front, stopStart, signalId: signal.signal.id, why: front ? "front of the queue at a signal" : "in the queue at a signal" };
        }
        return { kind: "jam", stopStart, why: "creeping in a queue at a signal", signalId: signal.signal.id };
      }
      if (!creeping && waited >= 120) return { kind: "parked", stopStart, why: "stopped 2+ minutes, not in traffic" };
      return { kind: "jam", stopStart, why: creeping ? "stop-start traffic" : "stopped, no signal here" };
    }

    // What may be delivered right now: "full" | "line" | "vip-line" | "none".
    function tier(st) {
      if (st.kind === "parked") return "full";
      if (st.kind === "red") return st.secondsLeft > 40 ? "full" : st.secondsLeft >= 15 ? "line" : "none";
      if (st.kind === "clear") return "line";
      if (st.kind === "jam") return "vip-line";
      return "none";
    }
    return { sample, state, tier, get samples() { return samples; }, reset() { samples = []; } };
  }

  const URGENT = /\b(urgent|asap|immediately|emergency|important|right away|turant|jaldi)\b|जल्दी|तुरंत|ज़रूरी|जरूरी/i;
  function isUrgent(item) { return URGENT.test(`${item.subject || ""} ${item.snippet || ""}`); }
  function isVip(item, vips = []) {
    const f = `${item.from || ""} ${item.fromAddr || ""}`.toLowerCase();
    return vips.some((v) => v && f.includes(String(v).toLowerCase().trim()));
  }
  return { createMoment, isUrgent, isVip, FRONT_M };
});
