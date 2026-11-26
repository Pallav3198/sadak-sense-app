// Free-speech understanding (spec 14.7): Sarvam's LLM (sarvam-105b, chat completions, OpenAI-style tools)
// on the server, so the key never reaches the page. Tools give it live facts; a guard throws away any
// answer that mentions a hazard the hazard tool did not return; any failure falls back to the rule brain.
const URL_ = "https://api.sarvam.ai/v1/chat/completions";

function createLLM({ key = process.env.SARVAM_API_KEY, fetchImpl = globalThis.fetch, model = process.env.SARVAM_LLM_MODEL || "sarvam-105b", timeoutMs = 9000 } = {}) {
  const on = typeof key === "string" && key.length > 10;
  async function call(body) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(URL_, { method: "POST", headers: { "api-subscription-key": key, "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(b?.error?.message || `Sarvam LLM ${r.status}`), { status: r.status });
      return b;
    } finally { clearTimeout(t); }
  }
  // Runs the tool loop: the model may call tools (handlers run here, on our data) up to `steps` times.
  async function run({ system, messages, tools = [], handlers = {}, steps = 3, json = false, maxTokens = 500 }) {
    if (!on) throw Object.assign(new Error("llm off"), { status: 503 });
    const msgs = [{ role: "system", content: system }, ...messages], used = [];
    for (let i = 0; i <= steps; i++) {
      const body = { model, messages: msgs, temperature: 0.3, max_tokens: maxTokens, reasoning_effort: null };
      if (tools.length && i < steps) { body.tools = tools; body.tool_choice = "auto"; }
      if (json) body.response_format = { type: "json_object" };
      const r = await call(body), m = r.choices?.[0]?.message || {};
      if (m.tool_calls?.length) {
        msgs.push({ role: "assistant", content: m.content || null, tool_calls: m.tool_calls });
        for (const tc of m.tool_calls) {
          let args = {}; try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
          const h = handlers[tc.function.name];
          const result = h ? await Promise.resolve(h(args)).catch((e) => ({ error: e.message })) : { error: "unknown tool" };
          used.push({ name: tc.function.name, args, result });
          msgs.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 6000) });
        }
        continue;
      }
      return { content: (m.content || "").trim(), used };
    }
    throw new Error("too many tool steps");
  }
  return { on, run, model };
}

// Words for road hazards in every supported language: an answer that uses them must be backed by the hazard tool.
const HAZARD_WORDS = /(pothole|speed ?breaker|breaker|bump|waterlog|flood|crater|gaddh|gadd?a|khadd|paani bhar|गड्ढ|ब्रेकर|जलभराव|पानी भर|பள்ளம்|வேகத்தடை|வெள்ளம்|గుంత|బ్రేకర్|వరద|കുഴി|ഹമ്പ്|വെള്ളക്കെട്ട്|ಗುಂಡಿ|ಹಂಪ್|ಪ್ರವಾಹ|গর্ত|ব্রেকার|জলমগ্ন)/i;
const NUMBER_DIST = /\d+\s*(m\b|metre|meter|मीटर|மீட்டர்|మీటర్|മീറ്റർ|ಮೀಟರ್|মিটার)/i;
// true = the answer may state hazards (they came from the tool); false = it invented one, use the rule brain.
function hazardSafe(answer, used) {
  if (!HAZARD_WORDS.test(answer)) return true;
  const calls = used.filter((u) => u.name === "hazards_ahead");
  if (!calls.length) return false;
  const found = calls.some((c) => (c.result?.hazards || []).length || c.result?.water);
  return found || !NUMBER_DIST.test(answer);
}

module.exports = { createLLM, hazardSafe, HAZARD_WORDS };
