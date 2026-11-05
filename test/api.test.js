const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../server/index");

test("API end to end: three phones confirm a breaker, brief mentions it", async () => {
  const { app, close } = createApp({ dbFile: ":memory:", enableSim: false });
  const server = app.listen(0); const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const routes = await (await fetch(url + "/api/routes")).json();
    const [lat, lon] = routes["iit-hauzkhas"].coords[20];
    for (const d of ["phone-aaaa1", "phone-bbbb2", "phone-cccc3"]) {
      const r = await fetch(url + "/api/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device: d, lat, lon, heading: 95, speed: 28, peak_g: 0.8, type: "breaker" }) });
      assert.equal(r.status, 201);
    }
    const { hazards } = await (await fetch(url + "/api/hazards")).json();
    assert.equal(hazards.length, 1); assert.equal(hazards[0].state, "confirmed");
    const b = await (await fetch(url + "/api/brief", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ routeId: "iit-hauzkhas", lang: "English" }) })).json();
    assert.match(b.text, /1 speed breaker/);
    const a = await (await fetch(url + "/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Aage koi speed breaker hai?", lat: routes["iit-hauzkhas"].coords[10][0], lon: routes["iit-hauzkhas"].coords[10][1], device: "phone-dddd4" }) })).json();
    assert.equal(a.lang, "Hinglish"); assert.equal(a.intent, "ask_ahead");
    const rep = await (await fetch(url + "/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Yahan bada gaddha hai", lat: lat + 0.002, lon, heading: 90, device: "phone-eeee5" }) })).json();
    assert.equal(rep.result.ok, true);
    const bad = await fetch(url + "/api/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device: "x" }) });
    assert.equal(bad.status, 207);
  } finally { server.close(); close(); }
});
