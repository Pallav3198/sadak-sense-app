// Personalisation (spec 14.9).
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../web/shared/personal.js");
const C = require("../web/shared/mycar.js");

test("9.1 commute memory: only what changed since last time", () => {
  const a = { id: 1, type: "pothole", lat: 28.55, lon: 77.2 }, b = { id: 2, type: "breaker", lat: 28.56, lon: 77.21 };
  const first = P.routeDiff(null, [a, b]); assert.equal(first.first, true);
  const same = P.routeDiff(first.snapshot, [a, b]); assert.deepEqual([same.added.length, same.removed.length], [0, 0]);
  const c = { id: 3, type: "pothole", lat: 28.57, lon: 77.22 };
  const changed = P.routeDiff(first.snapshot, [b, c]);
  assert.deepEqual(changed.added.map((x) => x.id), [3]); assert.deepEqual(changed.removed.map((x) => x.id), [1]);
});

test("9.2 elders or kids on board: gentler advice", () => {
  C.setProfile({ gentle: false, adjust: 0 }); const normal = C.check("creta", 2, { type: "breaker", severity: 1 }).speed;
  C.setProfile({ gentle: true }); const gentle = C.check("creta", 2, { type: "breaker", severity: 1 });
  assert.equal(gentle.speed, normal - 5); assert.match(C.line(gentle, "English"), /extra gentle/);
  C.setProfile({ gentle: false, adjust: 0 });
});

test("9.3 comfort profile learns from this driver's breaker crossings", () => {
  assert.equal(P.comfort([{ speed: 30, peakG: 1 }]).style, "learning");
  const fast = P.comfort(Array.from({ length: 8 }, () => ({ speed: 32, peakG: 1.0, advised: 20 })));
  assert.equal(fast.style, "fast"); assert.equal(fast.adjust, -5);
  const soft = P.comfort(Array.from({ length: 8 }, () => ({ speed: 15, peakG: 0.4, advised: 20 })));
  assert.equal(soft.style, "gentle"); assert.equal(soft.quiet, true);
});

test("9.4 focus before important meetings and quiet hours", () => {
  const now = Date.UTC(2026, 10, 27, 8, 0); // 1:30 pm IST
  const f = P.focus({ events: [{ title: "Client pitch", start: now + 20 * 60e3, attendees: [] }], now });
  assert.equal(f.on, true); assert.equal(f.title, "Client pitch");
  assert.equal(P.focus({ events: [{ title: "Lunch", start: now + 20 * 60e3, attendees: [] }], now }).on, false);
  assert.equal(P.focus({ quiet: { from: "13:00", to: "14:00" }, now }).reason, "quiet hours");
  assert.equal(P.focus({ quiet: { from: "22:00", to: "07:00" }, now }).on, false);
});

test("9.5 monsoon warning only when rain is coming and this route has flooded before", () => {
  const route = [[28.6, 77.2], [28.62, 77.22]], water = [{ lat: 28.6005, lon: 77.2005, lastHitTs: 1 }];
  const w = P.monsoon({ env: { rainProbNext2h: 70 }, route, waterHistory: water, carClearanceMm: 165 });
  assert.ok(w); assert.equal(w.lowCar, true); assert.equal(w.leaveEarlyMin, 20);
  assert.equal(P.monsoon({ env: { rainProbNext2h: 10 }, route, waterHistory: water }), null);
  assert.equal(P.monsoon({ env: { rainProbNext2h: 90 }, route, waterHistory: [{ lat: 28.7, lon: 77.4 }] }), null);
});

test("9.7 road-wear cost forecast with stated assumptions", () => {
  const r = P.wearCost([{ type: "pothole", severity: 1 }, { type: "pothole", severity: 1 }, { type: "breaker", severity: 1.4 }]);
  assert.equal(r.perTrip, 3.56); assert.equal(r.perYear, 1700); assert.match(r.assumptions, /480 trips/);
  assert.equal(P.wearCost([]).perYear, 0);
});
