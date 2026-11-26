// Real-world pieces: Sarvam voice proxy, complaint and city-report emails, real-drive export and replay.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createApp } = require("../server/index");
const { createSarvam } = require("../server/sarvam");
const { createMailer, complaint } = require("../server/report");

const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const start = (opts) => { const a = createApp({ dbFile: ":memory:", enableSim: false, seedFile: null, ...opts }); const s = a.app.listen(0); return { ...a, s, url: `http://127.0.0.1:${s.address().port}` }; };
const three = async (url, lat = 28.5459, lon = 77.1926, src) => { for (const d of ["ph-aaaaaa", "ph-bbbbbb", "ph-cccccc"]) await post(url + "/api/events", [{ device: d, lat, lon, heading: 90, speed: 25, peak_g: 1.1, type: "pothole", source: src }]); };

test("Sarvam: translates for Tamil, speaks, caches; listens and returns English for the parser", async () => {
  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.headers["api-subscription-key"], "test-key-1234567890");
    if (url.endsWith("/translate")) { const b = JSON.parse(init.body); return { ok: true, json: async () => ({ translated_text: b.target_language_code === "en-IN" ? "Any pothole ahead?" : "முன்னால் பள்ளம்" }) }; }
    if (url.endsWith("/text-to-speech")) { const b = JSON.parse(init.body); assert.equal(b.language_code, "ta-IN"); return { ok: true, json: async () => ({ audios: ["UklGRg=="] }) }; }
    if (url.endsWith("/speech-to-text")) return { ok: true, json: async () => ({ transcript: "முன்னால் பள்ளம் இருக்கா?", language_code: "ta-IN" }) };
    throw new Error("unexpected " + url);
  };
  const v = createSarvam({ key: "test-key-1234567890", fetchImpl: fake });
  const a = await v.say("Pothole ahead in 200 metres.", "Tamil");
  assert.equal(a.text, "முன்னால் பள்ளம்"); assert.equal(a.audio, "UklGRg==");
  await v.say("Pothole ahead in 200 metres.", "Tamil");
  assert.equal(calls.filter((c) => c.url.endsWith("/text-to-speech")).length, 1, "second line served from cache");
  const l = await v.listen(Buffer.from("fake"), "audio/webm");
  assert.equal(l.lang, "Tamil"); assert.equal(l.english, "Any pothole ahead?");
  await assert.rejects(createSarvam({ key: "" }).say("x"), /voice off/);
});

test("complaint: only confirmed hazards, needs consent, real email once a week", async () => {
  const sent = [];
  const mailer = createMailer({ key: "re_test", to: "pilot-inbox@example.com", fetchImpl: async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ id: "msg_1" }) }; } });
  const x = start({ mailer });
  try {
    await post(x.url + "/api/events", [{ device: "ph-aaaaaa", lat: 28.5459, lon: 77.1926, heading: 90, speed: 25, peak_g: 1.1, type: "pothole" }]);
    let { hazards } = await (await fetch(x.url + "/api/hazards")).json();
    assert.equal((await post(x.url + "/api/report", { hazardId: hazards[0].id, consent: true })).status, 409, "candidate is not reported");
    await three(x.url);
    ({ hazards } = await (await fetch(x.url + "/api/hazards?real=1")).json());
    const id = hazards[0].id;
    assert.equal((await post(x.url + "/api/report", { hazardId: id })).status, 400, "no consent, no report");
    const r = await (await post(x.url + "/api/report", { hazardId: id, consent: true })).json();
    assert.equal(r.status, "sent"); assert.match(r.ref, /^SS-\d+-\d{8}$/);
    assert.deepEqual(sent[0].to, ["pilot-inbox@example.com"]); assert.match(sent[0].subject, /Pothole .* confirmed by 3 vehicles/);
    assert.equal((await (await post(x.url + "/api/report", { hazardId: id, consent: true })).json()).status, "already");
    assert.equal(sent.length, 1, "one email per hazard per week");
    const city = await (await post(x.url + "/api/city-report/send", { real: true })).json();
    assert.equal(city.status, "sent"); assert.equal(city.count, 1);
    assert.match(await (await fetch(x.url + "/api/city-report?real=1")).text(), /Weekly road hazard report/);
  } finally { x.s.close(); x.close(); }
});

test("without email keys the complaint is prepared, not claimed as sent", async () => {
  const x = start({ mailer: createMailer({ key: "", to: "" }) });
  try {
    await three(x.url);
    const { hazards } = await (await fetch(x.url + "/api/hazards")).json();
    assert.equal((await (await post(x.url + "/api/report", { hazardId: hazards[0].id, consent: true })).json()).status, "prepared");
  } finally { x.s.close(); x.close(); }
});

test("real drives: simulated fleet is excluded, export replays into a fresh server", async () => {
  const x = start();
  let dump;
  try {
    await three(x.url, 28.6, 77.2, "sim");
    await three(x.url);
    const real = await (await fetch(x.url + "/api/hazards?real=1")).json();
    assert.equal(real.hazards.length, 1); assert.equal(real.hazards[0].realDevices, 3);
    dump = await (await fetch(x.url + "/api/export")).json();
    assert.equal(dump.events.length, 3);
  } finally { x.s.close(); x.close(); }
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ss-")), "seed.json"); fs.writeFileSync(f, JSON.stringify(dump));
  const y = start({ seedFile: f });
  try {
    const s = await (await fetch(y.url + "/api/real/summary")).json();
    assert.equal(s.seeded, 3); assert.equal(s.confirmed, 1); assert.equal(s.phones, 3);
  } finally { y.s.close(); y.close(); }
});

test("complaint text carries evidence and a map link", () => {
  const c = complaint({ id: 7, type: "pothole", lat: 28.5, lon: 77.2, heading: 90, severity: 1.2, devices: 4, events: 6, createdTs: 0, lastHitTs: 0 }, Date.UTC(2026, 10, 27));
  assert.equal(c.ref, "SS-7-20261127"); assert.match(c.text, /felt independently by 4 different vehicles/); assert.match(c.text, /openstreetmap\.org/);
});

test("own-car memory: one car stays one car at a spot across days; 3 different cars confirm", async () => {
  const { Engine } = require("../server/engine");
  const { openDb } = require("../server/db");
  const e = new Engine(openDb(":memory:"));
  const base = { lat: 28.6, lon: 77.2, heading: 90, speed: 25, peak_g: 1, type: "pothole" };
  // same car (same spot tag) on 3 days, each day with a new daily ID
  for (const [i, d] of ["ph-day1aa", "ph-day2bb", "ph-day3cc"].entries()) e.ingest({ ...base, device: d, car: "aaaaaaaaaaaaaaaa", ts: Date.now() + i * 864e5 / 4 });
  let h = e.list({ states: ["candidate", "confirmed"] })[0];
  assert.equal(h.state, "candidate"); assert.equal(h.devices, 1, "one car, however many days");
  e.ingest({ ...base, device: "ph-other1", car: "bbbbbbbbbbbbbbbb", ts: Date.now() });
  e.ingest({ ...base, device: "ph-other2", car: "cccccccccccccccc", ts: Date.now() });
  h = e.list({ states: ["candidate", "confirmed"] })[0];
  assert.equal(h.state, "confirmed"); assert.equal(h.devices, 3);
  // help-improve-the-map label: "none" counts as a smooth pass, a type is a vote
  assert.equal(e.label({ device: "ph-x1", lat: 28.6, lon: 77.2, label: "none" }).ok, true);
  assert.equal(e.hazard(h.id).cleanStreak, 1);
  assert.equal(e.label({ device: "ph-x1", lat: 28.6, lon: 77.2, label: "maybe" }).ok, false);
});
