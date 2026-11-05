const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../web/shared/mail.js");

const config = { serviceId: "s", templateId: "t", publicKey: "k" };
const memory = () => { const m = {}; return { getItem: (k) => m[k] ?? null, setItem: (k, v) => { m[k] = v; } }; };
const mail = { to: " home@example.com ", subject: "Trip update", message: "10 minute late" };

test("with no keys the app stays in demo mode and sends nothing", async () => {
  let called = 0;
  assert.deepEqual(await M.send(mail, { config: {}, store: memory(), fetch: async () => { called++; } }), { ok: false, why: "off" });
  assert.equal(called, 0);
});

test("sends the trip update to the home address", async () => {
  let url, body;
  const r = await M.send(mail, { config, store: memory(), fetch: async (u, o) => { url = u; body = JSON.parse(o.body); return { ok: true }; } });
  assert.deepEqual(r, { ok: true });
  assert.match(url, /api\.emailjs\.com/);
  assert.equal(body.service_id, "s"); assert.equal(body.user_id, "k");
  assert.deepEqual(body.template_params, { to_email: "home@example.com", subject: "Trip update", message: "10 minute late" });
});

test("a bad address is refused before anything is sent", async () => {
  for (const to of ["", "home", "home@x", "a b@c.com"]) assert.equal((await M.send({ ...mail, to }, { config, store: memory(), fetch: async () => assert.fail() })).why, "address");
});

test("failures are reported, never thrown", async () => {
  assert.equal((await M.send(mail, { config, store: memory(), fetch: async () => ({ ok: false }) })).why, "failed");
  assert.equal((await M.send(mail, { config, store: memory(), fetch: async () => { throw new Error("offline"); } })).why, "failed");
});

test("one browser is limited per day", async () => {
  const store = memory(), fetch = async () => ({ ok: true });
  for (let i = 0; i < M.DAILY_LIMIT; i++) assert.equal((await M.send(mail, { config, store, fetch })).ok, true);
  assert.equal((await M.send(mail, { config, store, fetch })).why, "limit");
});
