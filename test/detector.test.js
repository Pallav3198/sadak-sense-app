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
