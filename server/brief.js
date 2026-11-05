// Morning road brief: confirmed hazards on the driver's usual route, in their language.
// Uses the Claude API for natural phrasing when ANTHROPIC_API_KEY is set; otherwise templates.
const NAMES = {
  English: { breaker: ["speed breaker", "speed breakers"], pothole: ["pothole", "potholes"] },
  Hinglish: { breaker: ["speed breaker", "speed breakers"], pothole: ["gaddha", "gaddhe"] },
  Hindi: { breaker: ["स्पीड ब्रेकर", "स्पीड ब्रेकर"], pothole: ["गड्ढा", "गड्ढे"] },
};

function template(hz, lang, routeName) {
  const br = hz.filter((h) => h.type === "breaker").length, ph = hz.filter((h) => h.type === "pothole").length;
  const water = hz.find((h) => h.type === "water");
  const n = NAMES[lang] || NAMES.English, w = (k, c) => n[k][c === 1 ? 0 : 1];
  if (lang === "Hindi") return `सुप्रभात। ${routeName || "आपके रूट"} पर ${br} ${w("breaker", br)} और ${ph} ${w("pothole", ph)} की पुष्टि हुई है। मैं हर एक से पहले बताऊँगा।` + (water ? " अंडरपास में पानी भरा है, दूसरा रास्ता लें।" : "");
  if (lang === "Hinglish") return `Good morning! ${routeName || "Aapke route"} pe ${br} ${w("breaker", br)} aur ${ph} ${w("pothole", ph)} confirmed hain. Main har ek se pehle bataunga.` + (water ? " Underpass mein paani bhara hai, doosra raasta lijiye." : "");
  if (!hz.length) return `Good morning. No confirmed hazards on ${routeName || "your route"} right now.`;
  return `Good morning. ${routeName || "Your route"} has ${br} ${w("breaker", br)} and ${ph} ${w("pothole", ph)} confirmed by other cars; I'll call each one out before you reach it.` + (water ? " The underpass is waterlogged, so take the alternative road." : "");
}

async function brief(hz, lang = "English", routeName = "") {
  const key = process.env.ANTHROPIC_API_KEY;
  if (key) {
    try {
      const data = hz.map((h) => ({ type: h.type, confirmedByCars: h.devices, severity: h.severity }));
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: process.env.BRIEF_MODEL || "claude-haiku-5-5", max_tokens: 160,
          messages: [{ role: "user", content: `You are an in-car assistant in India. Write a spoken morning road brief (max 40 words) in ${lang}${lang === "Hinglish" ? " (Roman script)" : ""} for the route "${routeName}". Use ONLY these confirmed hazards, listed in driving order: ${JSON.stringify(data)}. If there is water, advise an alternative road. No lists, no emojis.` }],
        }),
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) { const j = await res.json(); const text = j.content?.[0]?.text?.trim(); if (text) return { text, source: "llm" }; }
    } catch (e) { /* fall through to template */ }
  }
  return { text: template(hz, lang, routeName), source: "template" };
}

module.exports = { brief, template };
