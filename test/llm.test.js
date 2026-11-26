// Free speech (spec 14.7): Sarvam LLM with tools, never inventing hazards, falling back to the rule brain.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../server/index");
const { createLLM, hazardSafe } = require("../server/llm");

// A scripted fake of Sarvam's chat completions: each call returns the next step.
function fakeModel(steps, log = []) {
  let i = 0;
  return async (url, init) => {
    const body = JSON.parse(init.body); log.push(body);
    assert.equal(init.headers["api-subscription-key"], "sk-test-1234567890");
    const step = steps[Math.min(i++, steps.length - 1)];
    if (step === "fail") throw new Error("network down");
    const message = typeof step === "string" ? { role: "assistant", content: step } : { role: "assistant", content: null, tool_calls: step.map((name, k) => ({ id: "call-" + k, type: "function", function: { name, arguments: "{}" } })) };
    return { ok: true, json: async () => ({ choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }] }) };
  };
}
const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
async function boot(steps, log) {
  const llm = createLLM({ key: "sk-test-1234567890", fetchImpl: fakeModel(steps, log) });
  const a = createApp({ dbFile: ":memory:", enableSim: false, seedFile: null, llm });
  const s = a.app.listen(0), url = `http://127.0.0.1:${s.address().port}`;
  // a confirmed pothole about 180 m east of the driver
  for (const d of ["ph-aaaa1", "ph-bbbb2", "ph-cccc3"]) await post(url + "/api/events", [{ device: d, lat: 28.5450, lon: 77.1946, heading: 90, speed: 25, peak_g: 1, type: "pothole" }]);
  return { ...a, s, url, at: { lat: 28.5450, lon: 77.19275, heading: 90 } };
}

test("Tamil question: the model reads the hazard tool and answers in Tamil", async () => {
  const log = [];
  const x = await boot([["hazards_ahead"], "ஆம், 180 மீட்டரில் பள்ளம் உள்ளது. 3 கார்கள் உறுதி செய்தன."], log);
  try {
    const r = await post(x.url + "/api/ask", { text: "முன்னால் பள்ளம் இருக்கா?", ...x.at, device: "ph-me0001" });
    assert.equal(r.brain, "llm"); assert.equal(r.voice, "Tamil"); assert.deepEqual(r.tools, ["hazards_ahead"]);
    const toolMsg = log[1].messages.find((m) => m.role === "tool");
    assert.match(toolMsg.content, /"type":"pothole"/); assert.equal(log[0].model, "sarvam-105b");
  } finally { x.s.close(); x.close(); }
});

test("a hazard the tool did not return is never spoken: the rule brain answers instead", async () => {
  const x = await boot(["Yes, there is a big pothole in 50 metres and waterlogging after it."]);
  try {
    const r = await post(x.url + "/api/ask", { text: "anything I should know about the road?", ...x.at, device: "ph-me0001" });
    assert.equal(r.brain, "rules");
  } finally { x.s.close(); x.close(); }
});

test("network failure falls back to the offline rule brain; yes/no and reports stay with rules", async () => {
  const x = await boot(["fail"]);
  try {
    const r = await post(x.url + "/api/ask", { text: "Aage koi gaddha hai?", ...x.at, device: "ph-me0001" });
    assert.equal(r.brain, "rules"); assert.equal(r.intent, "ask_ahead"); assert.match(r.reply, /gaddha/);
    const rep = await post(x.url + "/api/ask", { text: "Yahan bada gaddha hai", ...x.at, device: "ph-me0001" });
    assert.equal(rep.brain, "rules"); assert.equal(rep.result.ok, true);
  } finally { x.s.close(); x.close(); }
});

test("messages tool is for the owner only", async () => {
  const log = [];
  const x = await boot([["my_messages"], "I can't read messages until you sign in."], log);
  try {
    await post(x.url + "/api/ask", { text: "koi naya message aaya?", ...x.at, device: "ph-me0001" });
    assert.match(log[1].messages.find((m) => m.role === "tool").content, /not signed in as the owner/);
  } finally { x.s.close(); x.close(); }
});

test("hazard guard rules", () => {
  assert.equal(hazardSafe("The road is clear.", []), true);
  assert.equal(hazardSafe("Pothole in 80 metres.", []), false);
  assert.equal(hazardSafe("Pothole in 80 metres.", [{ name: "hazards_ahead", result: { hazards: [{}] } }]), true);
  assert.equal(hazardSafe("No potholes ahead.", [{ name: "hazards_ahead", result: { hazards: [] } }]), true);
  assert.equal(hazardSafe("गड्ढा 80 मीटर पर है", [{ name: "hazards_ahead", result: { hazards: [] } }]), false);
});
