// Drive-aware moments and delivery tiers (spec 14.4).
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../web/shared/moment.js");

const T0 = 1_700_000_000_000;
function feed(m, plan) { let t = T0; for (const [secs, kmh, heading = 90] of plan) for (let i = 0; i < secs; i++) { m.sample({ ts: t, kmh, heading, lat: 28.5450, lon: 77.1898 }); t += 1000; } return t - 1000; }
const signal = (over = {}) => ({ signal: { id: "osm:1", lat: 28.5450, lon: 77.1900, distanceM: 20 }, redS: 90, learned: true, phaseStart: null, ...over });

test("clear road: steady speed, straight, no hazard → one-line summaries", () => {
  const m = M.createMoment(); const now = feed(m, [[25, 42]]);
  const st = m.state({ now }); assert.equal(st.kind, "clear"); assert.equal(m.tier(st), "line");
  assert.equal(m.state({ now, hazardAhead: true }).kind, "busy");
});

test("turning or braking is busy → nothing", () => {
  const m = M.createMoment(); let now = feed(m, [[15, 40, 90], [5, 38, 160]]);
  assert.equal(m.state({ now }).kind, "busy");
  const m2 = M.createMoment(); now = feed(m2, [[10, 50], [10, 12]]);
  assert.equal(m2.tier(m2.state({ now })), "none");
});

test("red light after a clean approach: tiers follow the time left", () => {
  const m = M.createMoment(); const now = feed(m, [[20, 35], [5, 0]]);
  let st = m.state({ now, signal: signal() });
  assert.equal(st.kind, "red"); assert.equal(st.front, true);
  assert.ok(st.secondsLeft > 40); assert.equal(m.tier(st), "full");
  // fleet says the red began 70 s ago (another Hyundai stopped first): 90 - 70 = 20 s left → one-liners
  st = m.state({ now, signal: signal({ phaseStart: now - 70e3 }) }); assert.equal(st.secondsLeft, 20); assert.equal(m.tier(st), "line");
  st = m.state({ now, signal: signal({ phaseStart: now - 80e3 }) }); assert.equal(m.tier(st), "none");
});

test("traffic jam: stop-start creeping with no signal → hold; VIP one-liners only", () => {
  const m = M.createMoment(); const now = feed(m, [[5, 8], [4, 0], [5, 9], [4, 0], [5, 7], [6, 0]]);
  const st = m.state({ now }); assert.equal(st.kind, "jam"); assert.equal(m.tier(st), "vip-line");
});

test("parked: stopped 2+ minutes after a clean approach, no signal → full", () => {
  const m = M.createMoment(); const now = feed(m, [[20, 30], [125, 0]]);
  const st = m.state({ now }); assert.equal(st.kind, "parked"); assert.equal(m.tier(st), "full");
});

test("urgent and VIP detection", () => {
  assert.equal(M.isUrgent({ subject: "URGENT: sign today" }), true);
  assert.equal(M.isUrgent({ snippet: "please reply jaldi" }), true);
  assert.equal(M.isUrgent({ subject: "Lunch?" }), false);
  assert.equal(M.isVip({ from: "Riya Sharma", fromAddr: "riya@x.com" }, ["riya@x.com"]), true);
  assert.equal(M.isVip({ from: "Bob" }, ["riya@x.com"]), false);
});
