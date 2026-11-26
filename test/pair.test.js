// Pairing (dashboard phone → car screen): codes, relay, only known message types, unknown codes refused.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../server/index");

test("car screen gets a code; the phone's messages reach it; bad codes and types are refused", async () => {
  const a = createApp({ dbFile: ":memory:", enableSim: false, seedFile: null });
  const s = a.app.listen(0), url = `http://127.0.0.1:${s.address().port}`;
  const post = (p, b) => fetch(url + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  try {
    const { code } = await post("/api/pair/new", {});
    assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.equal((await (await fetch(`${url}/api/pair/${code.toLowerCase()}`)).json()).ok, true, "codes are case-insensitive");
    const ctl = new AbortController(), got = [];
    const stream = fetch(`${url}/api/pair/${code}/stream`, { signal: ctl.signal }).then(async (r) => { const rd = r.body.getReader(); const dec = new TextDecoder(); let buf = ""; for (;;) { const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value); for (const m of buf.matchAll(/data: (.*)\n\n/g)) got.push(JSON.parse(m[1])); buf = buf.slice(buf.lastIndexOf("\n\n") + 2); } }).catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    assert.equal((await post(`/api/pair/${code}`, { type: "say", text: "Speed breaker in 110 metres", kind: "info" })).screens, 1);
    assert.equal((await post(`/api/pair/${code}`, { type: "eval", text: "x" })).status, 400);
    assert.equal((await post("/api/pair/ZZZZZZ", { type: "say", text: "x" })).status, 400);
    assert.equal((await fetch(`${url}/api/pair/ZZZZZZ/stream`)).status, 404);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(got[0].text, "Speed breaker in 110 metres");
    ctl.abort(); await stream;
  } finally { s.close(); a.close(); }
});
