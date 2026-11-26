const test = require("node:test");
const assert = require("node:assert/strict");
const { createDetector, synth } = require("../web/shared/detector.js");

function run(features, opts = {}) {
  const events = [];
  const det = createDetector({ onEvent: (e) => events.push(e) });
  const speed = opts.speed ?? 30 / 3.6;
  for (const s of synth(features, { speed, durationMs: 4000, ...opts })) det.push(s.t, s.ax, s.ay, s.az, speed, s.rot);
  return events;
}

test("speed breaker at 30 km/h is classified by its axle pair", () => {
  const ev = run([{ type: "breaker", t: 1500 }]);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, "breaker");
});

test("speed breaker at 15 km/h (wider axle gap) is still a breaker", () => {
  const ev = run([{ type: "breaker", t: 1200 }], { speed: 15 / 3.6 });
  assert.deepEqual(ev.map((e) => e.type), ["breaker"]);
});

test("pothole gives a single sharp dip", () => {
  const ev = run([{ type: "pothole", t: 1500 }]);
  assert.deepEqual(ev.map((e) => e.type), ["pothole"]);
});

test("normal road noise produces no events", () => {
  for (let seed = 1; seed < 20; seed++) assert.equal(run([], { seed }).length, 0, `seed ${seed}`);
});

test("phone being handled is ignored", () => {
  assert.equal(run([{ type: "handling", t: 1500 }]).length, 0);
});

test("nothing is reported below walking-pace speeds (parking lots)", () => {
  assert.equal(run([{ type: "breaker", t: 1500 }], { speed: 5 / 3.6 }).length, 0);
});

test("14.3 shape: a breaker lifts the car first, a pothole drops it first; the evidence is reported", () => {
  const { createDetector, synth } = require("../web/shared/detector.js");
  const run = (features) => { const out = []; const d = createDetector({ onEvent: (e) => out.push(e) }); for (const s of synth(features)) d.push(s.t, s.ax, s.ay, s.az, 30 / 3.6, s.rot); return out; };
  const b = run([{ type: "breaker", t: 1500 }]); assert.equal(b[0].type, "breaker"); assert.equal(b[0].first, "up"); assert.equal(b[0].pair, true);
  const p = run([{ type: "pothole", t: 1500 }]); assert.equal(p[0].type, "pothole"); assert.equal(p[0].first, "down");
});

test("14.3 fleet decision: both directions and permanence point to a breaker; one lane and down-first to a pothole", () => {
  const { decideType } = require("../server/engine.js");
  const now = Date.now();
  const oneWayDown = [0, 1, 2].map(() => ({ type: "pothole", first: "down", pair: 0, heading: 90 }));
  assert.equal(decideType(oneWayDown, now, now).type, "pothole");
  // jolts misread as potholes, but felt from both directions: it spans the road
  const bothWays = [{ type: "pothole", heading: 90 }, { type: "pothole", heading: 270 }, { type: "breaker", heading: 92 }];
  const r = decideType(bothWays, now, now); assert.equal(r.type, "breaker"); assert.ok(r.reasons.some((x) => /both directions/.test(x)));
  const old = decideType([{ type: "pothole" }, { type: "breaker" }, { type: "breaker" }], now - 70 * 864e5, now);
  assert.ok(old.reasons.some((x) => /permanent/.test(x)));
});
