const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const S = require("../web/shared/voice.js");
const V = require("../web/shared/hinglish.js");
const C = require("../web/shared/mycar.js");
const { template } = require("../server/brief.js");

const v = (name, lang) => ({ name, lang });
const EDGE = [v("Microsoft David - English (United States)", "en-US"), v("Microsoft स्वरा Online (Natural) - Hindi (India)", "hi-IN"), v("Microsoft मधुर Online (Natural) - Hindi (India)", "hi-IN"), v("Microsoft Neerja Online (Natural) - English (India)", "en-IN"), v("Microsoft Kalpana - Hindi (India)", "hi-IN")];
const CHROME = [v("Google US English", "en-US"), v("Google हिन्दी", "hi-IN")];
const ANDROID = [v("hi-in-x-hia-local", "hi_IN"), v("en-in-x-ena-local", "en_IN")];

test("picks the natural Indian voice, not the old desktop one", () => {
  assert.match(S.plan("Haan", "Hinglish", EDGE).voice.name, /स्वरा/);
  assert.match(S.plan("Pothole ahead", "English", EDGE).voice.name, /Neerja/);
  assert.equal(S.plan("Haan", "Hindi", CHROME).voice.name, "Google हिन्दी");
  assert.equal(S.plan("Haan", "Hindi", ANDROID).voice.name, "hi-in-x-hia-local");
});

test("English in desktop Chrome keeps an Indian accent", () => {
  const p = S.plan("Pothole ahead", "English", CHROME);
  assert.equal(p.voice.name, "Google हिन्दी"); assert.equal(p.code, "hi-IN"); assert.equal(p.text, "Pothole ahead");
});

test("a voice the driver chose wins", () => {
  assert.match(S.plan("Haan", "Hindi", EDGE, "Microsoft मधुर Online (Natural) - Hindi (India)").voice.name, /मधुर/);
});

test("Hinglish is respelled for a Hindi voice", () => {
  assert.equal(S.hinglishForSpeech("190 metre mein gaddha hai."), "190 मीटर में गड्ढा है।");
  assert.equal(S.plan("Aage koi gaddha hai?", "Hinglish", CHROME).text, "आगे कोई गड्ढा है?");
});

test("with no Hindi voice, Hinglish stays Roman on an English voice", () => {
  const p = S.plan("Aage gaddha hai", "Hinglish", [v("Microsoft Zira", "en-US"), v("Veena", "en-IN")]);
  assert.equal(p.text, "Aage gaddha hai"); assert.equal(p.voice.name, "Veena");
  assert.equal(S.plan("Aage", "Hinglish", []).voice, null);
});

test("long replies are split into sentences", () => {
  assert.deepEqual(S.chunks("पहला वाक्य। दूसरा वाक्य? तीसरा"), ["पहला वाक्य।", "दूसरा वाक्य?", "तीसरा"]);
});

test("every Hinglish word the app says is in the word list", () => {
  const ctx = { ahead: [{ type: "pothole", dist: 190, devices: 46 }, { type: "breaker", dist: 400, devices: 9 }], water: { dist: 300, devices: 5 }, brief: { breakers: 2, potholes: 3, water: true }, pending: { type: "pothole" } };
  const lines = ["Aage koi gaddha hai?", "Underpass mein paani hai kya?", "Aaj ka road brief do", "Yahan bada gaddha hai", "Yahan paani bhara hai", "haan", "nahi", "madad"].map((q) => V.reply(q, { ...ctx, prefer: "Hinglish" }).reply);
  lines.push(V.reply("Aage koi gaddha hai?", { prefer: "Hinglish" }).reply, V.reply("Underpass mein paani hai kya?", { prefer: "Hinglish" }).reply, V.askAfterJolt("pothole", "Hinglish"));
  for (const h of [{ type: "breaker", severity: 1.4 }, { type: "breaker", severity: 0.9 }, { type: "pothole", severity: 1.5 }, { type: "pothole", severity: 1 }, { type: "water" }])
    for (const [car, n] of [["aura", 5], ["venue", 1]]) lines.push(C.line(C.check(car, n, h), "Hinglish"));
  lines.push(template([{ type: "breaker" }, { type: "pothole" }, { type: "water" }], "Hinglish", ""));
  // Hinglish literals in the driver app: the middle argument of T3(...) and the Hinglish: keys.
  const src = fs.readFileSync(path.join(__dirname, "../web/drive/drive.js"), "utf8");
  for (const m of src.matchAll(/T3\(\s*[`"].*?[`"],\s*[`"](.*?)[`"],\s*[`"]/gs)) lines.push(m[1].replace(/\$\{[^}]*\}/g, " "));
  for (const m of src.matchAll(/Hinglish: (?:\(d\) => \[)?[`"](.*?)[`"]/g)) lines.push(m[1].replace(/\$\{[^}]*\}/g, " "));
  assert.ok(lines.length > 30);
  const missing = new Set();
  for (const l of lines) for (const w of S.hinglishForSpeech(l).match(/[A-Za-z]+/g) || []) missing.add(w);
  assert.deepEqual([...missing].filter((w) => !["Aura", "Venue", "Hyundai"].includes(w)), []);
});
