// Drive-aware notifications, server side (spec 14.4): signals, learned red length, current phase, jams.
const test = require("node:test");
const assert = require("node:assert/strict");
const { openDb } = require("../server/db");
const { createSignals, DEFAULT_RED_S } = require("../server/signals");

const SIG = { lat: 28.5450, lon: 77.1900 };
const fakeOsm = async () => ({ ok: true, json: async () => ({ elements: [{ id: 101, lat: SIG.lat, lon: SIG.lon }] }) });
// a point 15 m before the signal, driving east (heading 90)
const at = { lat: SIG.lat, lon: SIG.lon - 15 / 98000, heading: 90 };

test("cold start: an OpenStreetMap signal with the cautious default red", async () => {
  const s = createSignals({ db: openDb(":memory:"), fetchImpl: fakeOsm });
  const st = await s.state(at);
  assert.equal(st.signal.id, "osm:101"); assert.equal(st.signal.source, "OpenStreetMap");
  assert.equal(st.learned, false); assert.equal(st.redS, DEFAULT_RED_S);
});

test("red length is learned from cars at the front of the queue; phase comes from cars stopped now", async () => {
  const s = createSignals({ db: openDb(":memory:"), fetchImpl: fakeOsm });
  const t0 = Date.now() - 3600e3;
  // front-of-queue waits: cars arrive at random moments of a 90 s red
  [88, 40, 75, 90, 61, 20, 85, 52].forEach((w, i) => s.stopEnd({ key: "k" + i, device: "ph-a" + i, signalId: "osm:101", heading: 90, lat: at.lat, lon: at.lon, start: t0 + i * 120e3, end: t0 + i * 120e3 + w * 1000, front: true, kind: "signal" }));
  let st = await s.state(at);
  assert.equal(st.learned, true); assert.ok(st.redS >= 85 && st.redS <= 90, `red ${st.redS}`);
  assert.ok(st.stopLine, "stop line learned");
  const now = Date.now();
  s.stopStart({ key: "live1", device: "ph-b1", signalId: "osm:101", heading: 90, lat: at.lat, lon: at.lon, start: now - 30e3 });
  s.stopStart({ key: "live2", device: "ph-b2", signalId: "osm:101", heading: 90, lat: at.lat, lon: at.lon, start: now - 12e3 });
  st = await s.state({ ...at, now });
  assert.equal(st.carsStopped, 2); assert.equal(st.phaseStart, now - 30e3, "phase starts with the first car that stopped");
  // a car on the cross street (heading 0) is a different approach: default red there
  assert.equal((await s.state({ lat: SIG.lat - 15 / 111000, lon: SIG.lon, heading: 0 })).learned, false);
});

test("jam stops are not learned; repeated signal-like stops where OSM has none become a fleet-learned signal", async () => {
  const s = createSignals({ db: openDb(":memory:"), fetchImpl: async () => ({ ok: true, json: async () => ({ elements: [] }) }) });
  const p = { lat: 28.6, lon: 77.25, heading: 180 };
  assert.equal(s.stopEnd({ key: "j", device: "ph-j", signalId: null, ...p, start: 1, end: 20000, front: false, kind: "jam" }).ok, false);
  for (let i = 0; i < 5; i++) assert.equal(s.stopEnd({ key: "s" + i, device: "ph-s" + i, signalId: null, ...p, start: 1000 + i, end: 50000 + i, front: true, kind: "signal" }).ok, true);
  const near = await s.near(p.lat, p.lon);
  assert.equal(near.length, 1); assert.equal(near[0].source, "fleet");
});

test("OpenStreetMap outage: no crash, no signal", async () => {
  const s = createSignals({ db: openDb(":memory:"), fetchImpl: async () => { throw new Error("down"); } });
  assert.deepEqual((await s.state(at)).signal, null);
});
