const test = require("node:test");
const assert = require("node:assert/strict");
const V = require("../web/shared/hinglish.js");

test("detects the driver's language", () => {
  assert.equal(V.detectLang("Aage koi gaddha hai?"), "Hinglish");
  assert.equal(V.detectLang("Meri gaadi nikal jayegi?"), "Hinglish");
  assert.equal(V.detectLang("Is there a pothole ahead?"), "English");
  assert.equal(V.detectLang("आगे कोई गड्ढा है?"), "Hindi");
});

test("understands Hinglish questions and reports", () => {
  assert.equal(V.intent("Aage koi gaddha hai?").name, "ask_ahead");
  assert.equal(V.intent("Underpass mein paani hai kya?").name, "ask_water");
  assert.equal(V.intent("Yahan bada gaddha hai").name, "report");
  assert.equal(V.intent("Yahan speed breaker hai").type, "breaker");
  assert.equal(V.intent("Aaj ka road brief do").name, "brief");
  assert.equal(V.intent("haan").name, "yes");
  assert.equal(V.intent("nahi").name, "no");
  assert.equal(V.intent("यहाँ गड्ढा है").name, "report");
});

test("replies in the same language with live data", () => {
  const r = V.reply("Aage koi gaddha hai?", { ahead: [{ type: "pothole", dist: 184, devices: 7 }] });
  assert.equal(r.lang, "Hinglish");
  assert.match(r.reply, /180 metre mein gaddha hai, 7 gaadiyon/);
  const e = V.reply("Is the underpass flooded?", { water: { dist: 300, devices: 5 } });
  assert.match(e.reply, /waterlogging 300 metres ahead/);
});

test("a 'no' after a jolt question vetoes the report", () => {
  const r = V.reply("nahi", { pending: { type: "pothole" } });
  assert.deepEqual(r.action, { confirm: false });
  assert.equal(r.lang, "Hinglish");
});
