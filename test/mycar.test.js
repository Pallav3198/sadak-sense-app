const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../web/shared/mycar.js");
const V = require("../web/shared/hinglish.js");

test("load lowers the car: more people, less clearance", () => {
  assert.equal(C.effectiveClearanceMm(C.CARS.aura, 1), 165);
  assert.equal(C.effectiveClearanceMm(C.CARS.aura, 5), 141);
});

test("breaker advice is gentler for a hard breaker and a low-sitting, full car", () => {
  const soft = { type: "breaker", severity: 0.9 }, hard = { type: "breaker", severity: 1.4 };
  assert.equal(C.check("venue", 1, soft).speed, 20);
  assert.equal(C.check("venue", 1, hard).speed, 15);
  assert.equal(C.check("aura", 5, soft).speed, 15);   // sits lower with five people
  assert.equal(C.check("aura", 5, hard).speed, 10);
  assert.match(C.line(C.check("aura", 5, hard), "Hinglish"), /5 logon ke saath aapki Aura neeche baithi hai: 10 tak/);
  assert.doesNotMatch(C.line(C.check("aura", 5, hard), "English"), /cm/, "no height claims");
});

test("water gets no car-specific depth verdict", () => {
  const v = C.check("aura", 4, { type: "water", devices: 5 });
  assert.equal(v.kind, "water");
  assert.doesNotMatch(C.line(v, "English"), /cm|safe for your/);
});

test("road wear flags a service check after enough hard hits", () => {
  assert.equal(C.wear([]).due, false);
  const hits = Array.from({ length: 50 }, () => ({ peakG: 0.9 }));
  assert.equal(C.wear(hits).due, true);
});

test("the driver can ask whether their car will make it", () => {
  assert.equal(V.intent("Meri gaadi nikal jayegi?").name, "ask_car");
  assert.equal(V.intent("Will my car make it through the underpass?").name, "ask_car");
  assert.equal(V.intent("Aage koi gaddha hai?").name, "ask_ahead");
  const r = V.reply("Meri gaadi nikal jayegi?", { carCheck: "Aapki Aura: 20 pe nikaliye." });
  assert.equal(r.reply, "Aapki Aura: 20 pe nikaliye.");
});
