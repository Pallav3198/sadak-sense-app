// Personal co-pilot: owner-only sign-in, sealed cookies, real-map leave-by, inbox at stops, confirmed sends.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../server/index");
const { createAccounts } = require("../server/accounts");
const { createMaps } = require("../server/maps");
const { leaveBy, nextTrip, isStopped, lateMessage } = require("../server/copilot");
const { seal, open } = require("../server/secure");

const env = { SESSION_SECRET: "s".repeat(40), OWNER_EMAIL: "Owner@Example.com", GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsec", MS_CLIENT_ID: "mid", MS_CLIENT_SECRET: "msec", NODE_ENV: "test" };
const NOW = Date.now(), MEET = NOW + 90 * 60e3;

function fakeWorld(log) {
  const ok = (b) => ({ ok: true, status: 200, json: async () => b });
  return async (url, init = {}) => {
    const u = String(url); log.push({ u, init });
    if (u.startsWith("https://oauth2.googleapis.com/token")) return ok({ access_token: "g-at", refresh_token: "g-rt", expires_in: 3600 });
    if (u.startsWith("https://openidconnect.googleapis.com")) return ok({ email: log.who || "owner@example.com", email_verified: true });
    if (u.includes("/calendar/v3/")) return ok({ items: [{ id: "e1", summary: "Design review", location: "Cyber Hub, Gurugram", start: { dateTime: new Date(MEET).toISOString() }, attendees: [{ email: "riya@example.com", displayName: "Riya" }, { email: "owner@example.com", self: true }] }] });
    if (u.includes("/gmail/v1/users/me/messages?")) return ok({ messages: [{ id: "m1" }] });
    if (u.includes("/gmail/v1/users/me/messages/m1")) return ok({ id: "m1", threadId: "t1", internalDate: String(NOW - 60e3), snippet: "Can we move the review &amp; the demo?", payload: { headers: [{ name: "From", value: "Riya Sharma <riya@example.com>" }, { name: "Subject", value: "Review time" }, { name: "Message-ID", value: "<abc@mail>" }] } });
    if (u.includes("/messages/send")) return ok({ id: "sent1" });
    if (u.includes("login.microsoftonline.com") && u.endsWith("/token")) return ok({ access_token: "m-at", refresh_token: "m-rt2", expires_in: 3600 });
    if (u.endsWith("/v1.0/me")) return ok({ id: "me-1", mail: "pallav@college.example", displayName: "Pallav" });
    if (u.includes("/me/chats")) return ok({ value: [{ id: "c1", chatType: "oneOnOne", viewpoint: { lastMessageReadDateTime: new Date(NOW - 3600e3).toISOString() }, lastMessagePreview: { id: "x1", createdDateTime: new Date(NOW - 120e3).toISOString(), from: { user: { id: "u2", displayName: "Prof. Rao" } }, body: { content: "<p>Are you coming?</p>" } } }, { id: "c2", lastMessagePreview: { id: "x2", createdDateTime: new Date(NOW - 60e3).toISOString(), from: { user: { id: "me-1", displayName: "Pallav" } }, body: { content: "mine" } } }] });
    if (u.includes("/me/calendarView")) return ok({ value: [] });
    if (u.includes("/chats/c1/messages")) return ok({ id: "tm1" });
    if (u.includes("api.tomtom.com/search")) return ok({ results: [{ poi: { name: "DLF Cyber Hub" }, address: { freeformAddress: "Gurugram, Haryana" }, position: { lat: 28.495, lon: 77.089 } }] });
    if (u.includes("api.tomtom.com/routing")) return ok({ routes: [{ summary: { lengthInMeters: 21000, travelTimeInSeconds: 3000, trafficDelayInSeconds: 600, arrivalTime: new Date(NOW + 3000e3).toISOString() }, legs: [{ points: [{ latitude: 28.5459, longitude: 77.1926 }, { latitude: 28.52, longitude: 77.14 }, { latitude: 28.495, longitude: 77.089 }] }] }] });
    throw new Error("unexpected " + u);
  };
}

function boot() {
  const log = [], f = fakeWorld(log);
  const a = createApp({ dbFile: ":memory:", enableSim: false, seedFile: null, env, accounts: createAccounts({ env, fetchImpl: f }), maps: createMaps({ key: "tomtom-test-key", fetchImpl: f }) });
  const s = a.app.listen(0), url = `http://127.0.0.1:${s.address().port}`;
  const jar = {};
  const take = (r) => { for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(";"); const i = kv.indexOf("="); const k = kv.slice(0, i), v = kv.slice(i + 1); if (v) jar[k] = v; else delete jar[k]; } return r; };
  const hdr = () => ({ cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ") });
  const get = async (p) => take(await fetch(url + p, { headers: hdr(), redirect: "manual" }));
  const post = async (p, b) => take(await fetch(url + p, { method: "POST", headers: { ...hdr(), "content-type": "application/json" }, body: JSON.stringify(b), redirect: "manual" }));
  return { ...a, s, url, jar, get, post, log };
}
async function signIn(x, provider = "google") {
  const go = await x.get(`/auth/${provider}`); assert.equal(go.status, 302);
  const state = new URL(go.headers.get("location")).searchParams.get("state");
  return x.get(`/auth/${provider}/callback?code=c0de&state=${state}`);
}

test("only the owner's Google account unlocks the personal side", async () => {
  const x = boot();
  try {
    assert.equal((await x.post("/api/copilot/next", { lat: 28.5, lon: 77.2 })).status, 401);
    x.log.who = "stranger@example.com";
    assert.match((await signIn(x)).headers.get("location"), /signin=not-owner/);
    assert.equal(x.jar.ss_owner, undefined);
    x.log.who = null;
    assert.match((await signIn(x)).headers.get("location"), /signin=google/);
    const me = await (await x.get("/api/me")).json();
    assert.equal(me.owner, true); assert.equal(me.google, true);
    assert.equal(open(decodeURIComponent(x.jar.ss_g), env.SESSION_SECRET).r, "g-rt", "refresh token sealed in the phone's cookie");
    assert.equal(open(decodeURIComponent(x.jar.ss_g), "wrong-secret-wrong-secret-wrong-secret"), null);
    const bad = await x.get("/auth/google/callback?code=x&state=forged"); assert.match(bad.headers.get("location"), /signin=failed/);
  } finally { x.s.close(); x.close(); }
});

test("leave-by from the real calendar, live-traffic route and confirmed hazards on it", async () => {
  const x = boot();
  try {
    await signIn(x);
    for (const d of ["ph-a11111", "ph-b22222", "ph-c33333"]) await x.post("/api/events", [{ device: d, lat: 28.52, lon: 77.14, heading: 230, speed: 25, peak_g: 1, type: "breaker" }]);
    const r = await (await x.post("/api/copilot/next", { lat: 28.5459, lon: 77.1926 })).json();
    assert.equal(r.event.title, "Design review"); assert.equal(r.place.name, "DLF Cyber Hub");
    assert.equal(r.hazards.length, 1);
    assert.equal(r.plan.parts[0].min, 50, "50 min drive with traffic");
    assert.equal(r.plan.leave, MEET - r.plan.totalMin * 60e3);
    assert.equal(r.draft, null, "not late yet");
    assert.ok(x.log.some((l) => l.u.includes("traffic=true")), "route asked for live traffic");
  } finally { x.s.close(); x.close(); }
});

test("inbox merges Gmail and Teams, skips own messages; sends only after confirmation; Teams token rotates", async () => {
  const x = boot();
  try {
    await signIn(x); await signIn(x, "microsoft");
    const before = x.jar.ss_m;
    // Force a refresh by sealing a different refresh token in the cookie.
    x.jar.ss_m = encodeURIComponent(seal({ r: "m-old", uid: "me-1", email: "p@c", exp: Date.now() + 864e5 }, env.SESSION_SECRET));
    const inbox = await (await x.get("/api/copilot/inbox")).json();
    assert.deepEqual(inbox.items.map((i) => i.source).sort(), ["gmail", "teams"]);
    const t = inbox.items.find((i) => i.source === "teams"); assert.equal(t.from, "Prof. Rao"); assert.equal(t.snippet, "Are you coming?");
    assert.equal(inbox.items.find((i) => i.source === "gmail").snippet, "Can we move the review & the demo?");
    assert.equal(open(decodeURIComponent(x.jar.ss_m), env.SESSION_SECRET).r, "m-rt2", "rotated token saved back");
    assert.ok(before);
    assert.equal((await x.post("/api/copilot/send", { source: "teams", chatId: "c1", body: "Yes, 10 min" })).status, 400, "no confirmation, no send");
    assert.equal((await (await x.post("/api/copilot/send", { source: "teams", chatId: "c1", body: "Yes, 10 min", confirmed: true })).json()).sent, true);
    const g = await (await x.post("/api/copilot/send", { source: "gmail", to: ["riya@example.com"], subject: "Review time", inReplyTo: "<abc@mail>", threadId: "t1", body: "Running late", confirmed: true })).json();
    assert.equal(g.sent, true);
    const sent = x.log.find((l) => l.u.includes("/messages/send")); const raw = Buffer.from(JSON.parse(sent.init.body).raw, "base64url").toString();
    assert.match(raw, /In-Reply-To: <abc@mail>/); assert.match(raw, /To: riya@example.com/);
  } finally { x.s.close(); x.close(); }
});

test("co-pilot rules: next trip, stopped detection, honest late message", () => {
  const ev = [{ title: "Online", location: "", online: true, start: NOW + 60e3 }, { title: "Lab", location: "IIT Delhi", start: NOW + 3600e3 }];
  assert.equal(nextTrip(ev, NOW).title, "Lab");
  const moving = [0, 2, 4, 6, 8].map((s) => ({ ts: NOW - 8000 + s * 1000, kmh: 20 }));
  const stopped = [0, 2, 4, 6, 8].map((s) => ({ ts: NOW - 8000 + s * 1000, kmh: 0.5 }));
  assert.equal(isStopped(moving, NOW), false); assert.equal(isStopped(stopped, NOW), true);
  const p = leaveBy({ event: { start: NOW + 20 * 60e3 }, route: { durationS: 1800 }, raining: true, now: NOW });
  assert.ok(p.late > 0); assert.deepEqual(p.parts.map((x) => x.what), ["drive with live traffic", "rain (roads 15% slower)", "parking and walking in"]);
  assert.match(lateMessage({ event: { title: "Lab", start: NOW }, arrival: NOW + 12 * 60e3 }).short, /12 min late/);
});
