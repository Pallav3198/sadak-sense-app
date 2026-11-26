// Sarvam AI voice for Sadak Sense: Indian-language speech in, speech out, translation in between.
// The API key stays on this server (env SARVAM_API_KEY); browsers only talk to our /api/voice routes.
// Docs: https://docs.sarvam.ai (auth header "api-subscription-key").
const BASE = "https://api.sarvam.ai";

// The 8 languages the driver can pick. Hinglish is spoken by the Hindi voice (code-mixed text is supported).
const LANGS = {
  English: "en-IN", Hinglish: "hi-IN", Hindi: "hi-IN", Tamil: "ta-IN", Telugu: "te-IN",
  Malayalam: "ml-IN", Kannada: "kn-IN", Bengali: "bn-IN",
};
// Our app writes its lines in English, Hinglish or Hindi; these languages need translation first.
const TRANSLATED = new Set(["Tamil", "Telugu", "Malayalam", "Kannada", "Bengali"]);

function createSarvam({ key = process.env.SARVAM_API_KEY, fetchImpl = globalThis.fetch, speaker = process.env.SARVAM_SPEAKER || "priya" } = {}) {
  const on = typeof key === "string" && key.length > 10;
  const cache = new Map(); // text+lang -> { text, audio }; keeps repeated alerts free and instant
  const remember = (k, v) => { cache.set(k, v); if (cache.size > 400) cache.delete(cache.keys().next().value); return v; };

  async function call(path, init, ms = 12000) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetchImpl(BASE + path, { ...init, headers: { "api-subscription-key": key, ...(init.headers || {}) }, signal: ctl.signal });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { const e = new Error(body?.error?.message || `Sarvam ${r.status}`); e.status = r.status; throw e; }
      return body;
    } finally { clearTimeout(t); }
  }

  async function translate(text, from, to) {
    if (from === to) return text;
    const r = await call("/translate", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: text.slice(0, 1000), source_language_code: from, target_language_code: to, model: "mayura:v1", mode: "modern-colloquial" }) });
    return r.translated_text || text;
  }

  // English/Hinglish/Hindi line in, spoken audio (base64 WAV) in the chosen language out.
  async function say(text, lang = "English", writtenIn = "English") {
    if (!on) throw Object.assign(new Error("voice off"), { status: 503 });
    const code = LANGS[lang] || "en-IN";
    const k = `${lang}|${text}`;
    if (cache.has(k)) return cache.get(k);
    const spoken = TRANSLATED.has(lang) ? await translate(text, LANGS[writtenIn] || "en-IN", code) : text;
    const r = await call("/text-to-speech", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: spoken.slice(0, 2500), language_code: code, model: "bulbul:v3", speaker, pace: 1.05 }) });
    return remember(k, { text: spoken, audio: r.audios?.[0] || null, format: "wav" });
  }

  // Driver's speech (any of the languages, auto-detected) -> their words + an English version for our intent parser.
  async function listen(buf, mime = "audio/webm") {
    if (!on) throw Object.assign(new Error("voice off"), { status: 503 });
    const form = new FormData();
    form.append("file", new Blob([buf], { type: mime }), "speech." + (mime.split("/")[1] || "webm").split(";")[0]);
    form.append("model", "saaras:v3"); form.append("language_code", "unknown");
    const r = await call("/speech-to-text", { method: "POST", body: form }, 20000);
    const said = (r.transcript || "").trim(), code = r.language_code || "unknown";
    let english = said;
    // Our own parser already understands English, Hindi and Hinglish; other languages go through English.
    if (said && code !== "en-IN" && code !== "hi-IN") { try { english = await translate(said, code === "unknown" ? "auto" : code, "en-IN"); } catch { english = said; } }
    const lang = Object.keys(LANGS).find((k) => LANGS[k] === code && k !== "Hinglish") || "English";
    return { said, english, language_code: code, lang };
  }

  return { on, say, listen, translate, LANGS };
}

module.exports = { createSarvam, LANGS, TRANSLATED };
