// Near-miss zones (spec 14.8): hard braking detection, clustering by place and hour, warnings at the right time.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createBrake } = require("../web/shared/brake.js");
const { Engine, nearMissNow } = require("../server/engine");
const { openDb } = require("../server/db");

test("hard braking is detected from GPS speed; normal braking and weak GPS are ignored", () => {
  const out = []; const b = createBrake({ onBrake: (e) => out.push(e) });
  // 40 km/h → 15 km/h in 2 s (≈3.5 m/s²): hard
  [40, 40, 28, 15].forEach((v, i) => b.push(1000 * i, v / 3.6, 8));
  assert.equal(out.length, 1); assert.equal(out[0].fromKmh, 40);
  const calm = []; const c = createBrake({ onBrake: (e) => calm.push(e) });
  [40, 38, 35, 32, 29, 26].forEach((v, i) => c.push(1000 * i, v / 3.6, 8)); // ~0.8 m/s²
  assert.equal(calm.length, 0);
  const weak = []; const w = createBrake({ onBrake: (e) => weak.push(e) });
  [40, 40, 28, 15].forEach((v, i) => w.push(1000 * i, v / 3.6, 60));
  assert.equal(weak.length, 0);
});

test("3 different cars braking hard at the same spot and hour make a near-miss zone with peak hours", () => {
  const e = new Engine(openDb(":memory:"));
  const at7pm = (day) => Date.UTC(2026, 10, 20 + day, 13, 30); // 7 pm IST
  ["ph-n1aaaa", "ph-n2bbbb", "ph-n3cccc", "ph-n4dddd"].forEach((d, i) => e.ingest({ device: d, lat: 28.55, lon: 77.2, heading: 0, speed: 40, peak_g: 0.4, type: "brake", ts: at7pm(i) }));
  const z = e.list({ states: ["confirmed"] }).find((h) => h.family === "nearmiss");
  assert.ok(z); assert.equal(z.type, "nearmiss"); assert.equal(z.devices, 4);
  assert.deepEqual(z.hours.peak, [19]);
  assert.equal(nearMissNow(z, Date.UTC(2026, 10, 27, 13, 50)), true, "7:20 pm: warn");
  assert.equal(nearMissNow(z, Date.UTC(2026, 10, 27, 4, 0)), false, "9:30 am: quiet");
  // near-miss zones never count as potholes or on route briefs
  assert.equal(e.alongRoute([[28.549, 77.2], [28.551, 77.2]]).length, 0);
  // and they fade after 30 days without hard braking
  e.sweep(at7pm(3) + 31 * 864e5);
  assert.equal(e.hazard(z.id).state, "cleared");
});
