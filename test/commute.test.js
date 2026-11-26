// Commute awareness and defaults (spec 14.5).
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../web/shared/commute.js");

// IST helpers: build a timestamp for a given IST weekday/time in a known week (Mon 23 Nov 2026).
const ist = (y, m, d, h, min = 0) => Date.UTC(y, m - 1, d, h, min) - 5.5 * 3600e3;
const MON_9 = ist(2026, 11, 23, 9), MON_20 = ist(2026, 11, 23, 20), SAT_10 = ist(2026, 11, 28, 10);
const work = { source: "teams", from: "Prof. Rao" }, personal = { source: "gmail", from: "Amma", fromAddr: "amma@gmail.com" };

test("defaults when onboarding is skipped: weekday mornings work on; evenings and weekends personal only", () => {
  const p = C.profile(null);
  assert.equal(C.holds(work, p, MON_9), false);
  assert.equal(C.holds(work, p, MON_20), true);
  assert.equal(C.holds(work, p, SAT_10), true);
  assert.equal(C.holds(personal, p, MON_20), false);
});

test("evening preference and work domains from onboarding", () => {
  const p = C.profile({ evening: "yes", workDomains: ["iitd.ac.in"] });
  assert.equal(C.holds(work, p, MON_20), false);
  assert.equal(C.category({ source: "gmail", fromAddr: "hod@iitd.ac.in" }, p), "work");
});

test("voice override for today: 'Aaj shaam bhi office messages batana' and the opposite", () => {
  const on = C.override("Aaj shaam bhi office messages batana", MON_20);
  assert.deepEqual(on, { date: "2026-11-23", work: "on" });
  assert.equal(C.holds(work, C.profile({ override: on }), MON_20), false);
  const off = C.override("aaj office messages mat batana", MON_9);
  assert.equal(off.work, "off"); assert.equal(C.holds(work, C.profile({ override: off }), MON_9), true);
  assert.equal(C.override("aage koi gaddha hai?", MON_9), null);
  // tomorrow the override no longer applies
  assert.equal(C.holds(work, C.profile({ override: on }), ist(2026, 11, 24, 20)), true);
});

test("learns home, office and usual arrival from a week of trips", () => {
  const home = { lat: 28.6000, lon: 77.2000 }, office = { lat: 28.5450, lon: 77.1926 };
  const trips = [];
  for (let d = 23; d <= 27; d++) {
    trips.push({ start: { ...home, ts: ist(2026, 11, d, 9, 0) }, end: { ...office, ts: ist(2026, 11, d, 9, 40) } });
    trips.push({ start: { ...office, ts: ist(2026, 11, d, 18, 30) }, end: { ...home, ts: ist(2026, 11, d, 19, 15) } });
  }
  const L = C.learn(trips);
  assert.ok(L); assert.equal(L.arrive, "09:40"); assert.ok(Math.abs(L.office.lat - office.lat) < 0.001);
  assert.equal(C.learn(trips.slice(0, 4)), null, "not before about a week");
});

test("reminder every few days only while the office time is unknown", () => {
  assert.equal(C.remind(C.profile(null), MON_9), true);
  assert.equal(C.remind(C.profile({ lastReminder: MON_9 }), MON_9 + 864e5), false);
  assert.equal(C.remind(C.profile({ officeTime: "09:30" }), MON_9), false);
});
