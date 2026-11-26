// Context co-pilot (spec 14.6): knowledge graph, context lines, vague replies, ETA line, meeting rescue.
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildGraph, contextFor, nextCall } = require("../server/knowledge");
const { composeRules, etaLine } = require("../server/copilot");
const { createApp } = require("../server/index");

const NOW = Date.UTC(2026, 10, 27, 7, 0); // 12:30 pm IST
const events = [
  { id: "e1", title: "Design review", location: "DLF Cyber Hub, Gurugram", start: NOW + 60 * 60e3, attendees: [{ email: "riya@x.com", name: "Riya Sharma" }, { email: "amit@x.com", name: "Amit" }], organizer: "riya@x.com" },
  { id: "e2", title: "Weekly sync", location: "", online: true, joinUrl: "https://meet.example/abc", start: NOW + 10 * 60e3, attendees: [{ email: "rao@x.com", name: "Prof. Rao" }], organizer: "rao@x.com" },
];
const item = { source: "gmail", id: "m3", threadId: "t1", from: "Riya Sharma", fromAddr: "riya@x.com", subject: "Review time", snippet: "Can we start ten minutes later?", ts: NOW };
const history = { "thread:t1": [{ id: "m1", from: "Riya Sharma", fromAddr: "riya@x.com", subject: "Review time", snippet: "Slides for the design review attached", ts: NOW - 3600e3 }] };

test("graph links people, threads, meetings and places; the message refers to the meeting", () => {
  const g = buildGraph({ events, items: [item], history, now: NOW });
  const kinds = new Set(g.nodes.map((n) => n.kind));
  for (const k of ["person", "thread", "meeting", "place"]) assert.ok(kinds.has(k), k);
  assert.ok(g.edges.some((e) => e.from === "thread:t1" && e.to === "meeting:e1" && e.rel === "about"));
  const c = contextFor(item, g, { history, now: NOW, trip: { destination: "DLF Cyber Hub", minutes_left: 12 } });
  assert.equal(c.refersTo.title, "Design review");
  assert.match(c.context, /^Riya again about Design review, the meeting you're driving to at .*; you're 12 min away\.$/);
  const plain = contextFor(item, g, { history, now: NOW });
  assert.match(plain.context, /^Riya again about Design review at /);
});

test("a message unrelated to any meeting gets no invented link", () => {
  const other = { source: "teams", id: "x9", chatId: "c9", from: "Neha", subject: "Group chat", snippet: "Lunch?", ts: NOW };
  const g = buildGraph({ events, items: [other], now: NOW });
  assert.equal(contextFor(other, g, { now: NOW }).refersTo, null);
});

test("vague spoken replies become proper messages; nothing invented", () => {
  assert.equal(composeRules("haan bol do pahunch raha hoon", { refersTo: { kind: "meeting", title: "Design review" } }), "Yes, that works. I'm on my way to Design review.");
  assert.equal(composeRules("thoda late ho jaunga"), "I'm running a little late.");
  assert.equal(composeRules("baad mein call karta hoon"), "I'll call you back once I've parked.");
  assert.equal(composeRules("send me the deck"), "Send me the deck.");
});

test("automatic ETA line with the live trip and a road event", () => {
  assert.match(etaLine({ car: "bayon", trip: { destination: "office", minutes_left: 25, flooded: true }, now: NOW }), /^Sent from my Hyundai Bayon: reaching office by .*, flooded underpass on the way\.$/);
  assert.match(etaLine({ car: "creta", trip: { destination: "Cyber Hub", minutes_left: 10, hazards_on_route: 2 }, now: NOW }), /2 road hazards on the way/);
  assert.equal(etaLine({ car: "creta", trip: null }), "Sent from my Hyundai Creta while driving.");
});

test("meeting rescue: the online call starting soon", () => {
  assert.equal(nextCall(events, NOW).title, "Weekly sync");
  assert.equal(nextCall(events, NOW + 3 * 3600e3), null);
});

test("compose endpoint: demo items work without accounts; real items need the owner", async () => {
  const a = createApp({ dbFile: ":memory:", enableSim: false, seedFile: null });
  const s = a.app.listen(0), url = `http://127.0.0.1:${s.address().port}`;
  const post = (body) => fetch(url + "/api/copilot/compose", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const r = await (await post({ demo: true, item: { from: "Riya", subject: "Review", refersTo: { kind: "meeting", title: "Design review" } }, said: "haan pahunch raha hoon", car: "creta", trip: { destination: "Cyber Hub", minutes_left: 12 } })).json();
    assert.equal(r.text, "Yes, that works. I'm on my way to Design review.");
    assert.match(r.full, /\n\nSent from my Hyundai Creta: reaching Cyber Hub by /);
    assert.equal((await post({ item: {}, said: "hi" })).status, 401);
  } finally { s.close(); a.close(); }
});
