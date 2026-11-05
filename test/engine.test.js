const test = require("node:test");
const assert = require("node:assert/strict");
const { openDb } = require("../server/db");
const { Engine, CFG } = require("../server/engine");
const { offset } = require("../server/geo");

const P = [28.5457, 77.1926]; // near IIT Delhi main gate
const T0 = Date.UTC(2026, 9, 31, 2, 30);
const ev = (device, o = {}) => ({ device, lat: P[0], lon: P[1], heading: 90, speed: 30, peak_g: 0.9, type: "breaker", ts: T0, ...o });
const fresh = () => new Engine(openDb(":memory:"));

test("one car is never enough: same car three times stays a candidate", () => {
  const e = fresh();
  for (let i = 0; i < 3; i++) e.ingest(ev("car-aaaaaa", { ts: T0 + i * 60e3 }));
  assert.equal(e.list()[0].state, "candidate");
});

test("three different cars within 20 m confirm the hazard", () => {
  const e = fresh();
  const pts = [offset(...P, 4, 0), offset(...P, 7, 180), offset(...P, 5, 90)];
  pts.forEach(([la, lo], i) => e.ingest(ev(`car-${i}xxxxx`, { lat: la, lon: lo, ts: T0 + i * 1e3 })));
  const hz = e.list();
  assert.equal(hz.length, 1);
  assert.equal(hz[0].state, "confirmed");
  assert.equal(hz[0].devices, 3);
});

test("events 60 m apart form separate hazards", () => {
  const e = fresh();
  e.ingest(ev("car-a00000"));
  const [la, lo] = offset(...P, 60, 0);
  e.ingest(ev("car-b00000", { lat: la, lon: lo }));
  assert.equal(e.list().length, 2);
});

test("a pothole in the opposite carriageway is a different hazard", () => {
  const e = fresh();
  e.ingest(ev("car-a00000", { type: "pothole", heading: 90 }));
  e.ingest(ev("car-b00000", { type: "pothole", heading: 270 }));
  assert.equal(e.list().length, 2);
});

test("8 clean passes after confirmation remove a repaired hazard", () => {
  const e = fresh();
  ["c1", "c2", "c3"].forEach((d) => e.ingest(ev(d + "xxxxx")));
  const id = e.list()[0].id;
  for (let i = 0; i < CFG.clearAfterCleanPasses - 1; i++) e.pass(id, `p${i}xxxxx`, T0 + 1e6 + i);
  assert.equal(e.hazard(id).state, "confirmed");
  e.pass(id, "plastxxxx", T0 + 2e6);
  assert.equal(e.hazard(id).state, "cleared");
});

test("a new jolt resets the clean-pass streak", () => {
  const e = fresh();
  ["c1", "c2", "c3"].forEach((d) => e.ingest(ev(d + "xxxxx")));
  const id = e.list()[0].id;
  for (let i = 0; i < 6; i++) e.pass(id, `p${i}xxxxx`, T0 + 1e6 + i);
  e.ingest(ev("c4xxxxx", { ts: T0 + 2e6 }));
  assert.equal(e.hazard(id).cleanStreak, 0);
  assert.equal(e.hazard(id).state, "confirmed");
});

test("a one-off false alarm is rejected when other cars feel nothing", () => {
  const e = fresh();
  e.ingest(ev("solo00000"));
  const id = e.list()[0].id;
  for (let i = 0; i < CFG.rejectCandidateAfter; i++) e.pass(id, `p${i}xxxxx`, T0 + 1e5 + i);
  assert.equal(e.hazard(id).state, "rejected");
});

test("waterlogging: three crawling cars in 30 minutes confirm, then it recedes after 2 h of silence", () => {
  const e = fresh();
  ["w1", "w2", "w3"].forEach((d, i) => e.ingest(ev(d + "xxxxx", { type: "crawl", speed: 4, rain: true, ts: T0 + i * 5 * 60e3 })));
  const h = e.list()[0];
  assert.equal(h.type, "water");
  assert.equal(h.state, "confirmed");
  e.sweep(T0 + 10 * 60e3 + CFG.waterDecayMs + 1);
  assert.equal(e.hazard(h.id).state, "cleared");
});

test("severity is normalised for speed", () => {
  const e = fresh();
  e.ingest(ev("s1xxxxx", { peak_g: 1.2, speed: 60 }));
  assert.ok(Math.abs(e.list()[0].severity - 0.6) < 1e-9);
});

test("invalid events are refused", () => {
  const e = fresh();
  assert.equal(e.ingest({ device: "x", lat: 999 }).ok, false);
});
