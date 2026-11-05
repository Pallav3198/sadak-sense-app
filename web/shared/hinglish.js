// Sadak Sense voice dialogue: understands English, Hindi (Devanagari) and Hinglish (Roman Hindi
// mixed with English), and replies in the language the driver used. Rule-based so it works
// offline in the car; an LLM can rephrase replies when connected.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SadakVoice = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const HINGLISH_WORDS = /\b(hai|hain|kya|koi|aage|aagey|gaddha|gadda|gaddhe|khadda|paani|pani|bhara|bhar|haan|han|ha|nahi|nahin|na|yahan|idhar|wahan|bada|badi|batao|bataiye|bolo|do|dijiye|kitne|kitna|raasta|rasta|sadak|mein|me|pe|par|ka|ki|ke|tha|thi|theek|thik|ji|bhai|aaj|abhi|mat|chalo|dekho|jhatka|madad|shukriya|boliye|poochho|batana|meri|gaadi|gadi|nikal|jayegi)\b/i;
  const DEV = /[ऀ-ॿ]/;

  function detectLang(text) {
    if (DEV.test(text)) return "Hindi";
    const words = text.toLowerCase().match(/[a-z]+/g) || [];
    const hits = words.filter((w) => HINGLISH_WORDS.test(w)).length;
    return hits >= 1 && hits / Math.max(1, words.length) >= 0.15 ? "Hinglish" : "English";
  }

  const has = (t, re) => re.test(t);
  function intent(raw) {
    const t = raw.toLowerCase().normalize("NFC");
    const yes = /^\s*(haan|han|ha|ji|ji haan|yes|yeah|yep|sahi|bilkul|हाँ|हां|जी)(?=$|[\s?.!,।])/;
    const no = /^\s*(nahi|nahin|na|no|nope|galat|नहीं|ना)(?=$|[\s?.!,।])/;
    if (has(t, yes) && t.split(/\s+/).length <= 3) return { name: "yes" };
    if (has(t, no) && t.split(/\s+/).length <= 3) return { name: "no" };
    // "Will my car make it?": answered from the car's own clearance, load and wading limit.
    if (has(t, /(meri (gaadi|gadi|car)|my car|nikal (jayegi|jaayegi|jaegi|payegi|paayegi)|neeche lag|scrape|clearance|मेरी गाड़ी|मेरी कार|निकल (जाएगी|पाएगी))/)) return { name: "ask_car" };
    const pothole = /(gaddh|gadd?a|khadd|pothole|crater|गड्ढ|गढ्ढ)/, breaker = /(speed ?breaker|breaker|bump|hump|ब्रेकर)/, water = /(paani|pani|water|flood|bhar(a|aa)|jal ?bhar|underpass|पानी|जलभराव|अंडरपास|बाढ़)/;
    const here = /(yahan|yaha|idhar|here|abhi|यहाँ|यहां|इधर)/;
    const question = /(\?|kya|koi|kahan|kitne|kitna|is there|any|what|where|how many|क्या|कोई|कितने)/;
    const report = /(hai|hain|mila|laga|there is|there's|found|report|है)/;
    if (has(t, /(brief|route|aaj ka|today|raasta|rasta|सारांश|आज|ब्रीफ|रूट)/) && !has(t, here)) return { name: "brief" };
    if (has(t, water) && has(t, here) && !has(t, question)) return { name: "report", type: "crawl" };
    if (has(t, water)) return { name: "ask_water" };
    if ((has(t, pothole) || has(t, breaker)) && has(t, here) && has(t, report) && !has(t, /(\?|kya|koi|क्या|कोई)/)) return { name: "report", type: has(t, breaker) ? "breaker" : "pothole" };
    if (has(t, /(aage|aagey|ahead|next|आगे|clear|saaf|साफ)/) || has(t, pothole) || has(t, breaker)) return { name: "ask_ahead", type: has(t, breaker) ? "breaker" : has(t, pothole) ? "pothole" : null };
    if (has(t, /(help|madad|kya kar sakte|what can you|मदद)/)) return { name: "help" };
    return { name: "unknown" };
  }

  const N = {
    English: { breaker: ["speed breaker", "speed breakers"], pothole: ["pothole", "potholes"], water: ["waterlogging", "waterlogging"] },
    Hinglish: { breaker: ["speed breaker", "speed breakers"], pothole: ["gaddha", "gaddhe"], water: ["paani bhara", "paani bhara"] },
    Hindi: { breaker: ["स्पीड ब्रेकर", "स्पीड ब्रेकर"], pothole: ["गड्ढा", "गड्ढे"], water: ["जलभराव", "जलभराव"] },
  };
  const word = (lang, type, n) => N[lang][type][n === 1 ? 0 : 1];
  const m = (d) => Math.max(10, Math.round(d / 10) * 10);

  // ctx: { ahead: [{type, dist, devices}], water: {dist}|null, brief: {breakers, potholes, water}, pending: {type}|null }
  function reply(text, ctx = {}) {
    let lang = detectLang(text);
    // Speech engines often write spoken Hinglish in Devanagari; keep the driver's chosen register.
    if (ctx.prefer === "Hinglish" && lang === "Hindi") lang = "Hinglish";
    if (ctx.prefer === "English" && lang !== "English" && !/[\u0900-\u097F]/.test(text)) lang = lang;
    const it = intent(text), L = lang;
    const say = (en, hl, hi) => ({ English: en, Hinglish: hl, Hindi: hi }[L]);
    let out, action = null;
    switch (it.name) {
      case "ask_ahead": {
        const list = (ctx.ahead || []).filter((h) => !it.type || h.type === it.type);
        if (!list.length) out = say("The road ahead is clear for the next kilometre. No confirmed hazards.", "Aage ek kilometre tak raasta saaf hai. Koi confirmed hazard nahi.", "आगे एक किलोमीटर तक रास्ता साफ़ है। कोई पुष्ट ख़तरा नहीं।");
        else {
          const h = list[0], rest = list.length - 1;
          out = say(`Yes. A ${word(L, h.type, 1)} in ${m(h.dist)} metres, felt by ${h.devices} cars.${rest ? ` ${rest} more after that.` : ""} I'll warn you before each one.`,
            `Haan. ${m(h.dist)} metre mein ${word(L, h.type, 1)} hai, ${h.devices} gaadiyon ne confirm kiya.${rest ? ` Uske baad ${rest} aur.` : ""} Main pehle bata dunga.`,
            `हाँ। ${m(h.dist)} मीटर पर ${word(L, h.type, 1)} है, ${h.devices} गाड़ियों ने पुष्टि की।${rest ? ` उसके बाद ${rest} और।` : ""} मैं पहले बता दूँगा।`);
        }
        break;
      }
      case "ask_water":
        out = ctx.water ? say(`Yes, waterlogging ${m(ctx.water.dist)} metres ahead; ${ctx.water.devices} cars crawled through it in the last 30 minutes. Take another road if you can.`,
          `Haan, ${m(ctx.water.dist)} metre aage paani bhara hai. Pichhle 30 minute mein ${ctx.water.devices} gaadiyan wahan atkin. Ho sake toh doosra raasta lijiye.`,
          `हाँ, ${m(ctx.water.dist)} मीटर आगे जलभराव है। पिछले 30 मिनट में ${ctx.water.devices} गाड़ियाँ वहाँ अटकीं। हो सके तो दूसरा रास्ता लें।`)
          : say("No waterlogging reported on your road right now.", "Abhi aapke raaste pe kahin paani bhara nahi hai.", "अभी आपके रास्ते पर कहीं जलभराव नहीं है।");
        break;
      case "brief": {
        const b = ctx.brief || { breakers: 0, potholes: 0, water: false };
        out = say(`Your route has ${b.breakers} ${word(L, "breaker", b.breakers)} and ${b.potholes} ${word(L, "pothole", b.potholes)} confirmed.${b.water ? " The underpass is waterlogged, take the alternative." : ""}`,
          `Aapke route pe ${b.breakers} ${word(L, "breaker", b.breakers)} aur ${b.potholes} ${word(L, "pothole", b.potholes)} confirmed hain.${b.water ? " Underpass mein paani bhara hai, doosra raasta lijiye." : ""}`,
          `आपके रूट पर ${b.breakers} ${word(L, "breaker", b.breakers)} और ${b.potholes} ${word(L, "pothole", b.potholes)} की पुष्टि हुई है।${b.water ? " अंडरपास में पानी भरा है, दूसरा रास्ता लें।" : ""}`);
        break;
      }
      case "ask_car":
        // ctx.carCheck: the "Fits my car" line for the next hazard, already in the driver's language
        out = ctx.carCheck || say("Nothing ahead that your car needs to worry about.", "Aage aapki gaadi ke liye kuch khatarnaak nahi hai.", "आगे आपकी गाड़ी के लिए कुछ ख़तरनाक नहीं है।");
        break;
      case "report":
        action = { report: it.type };
        out = it.type === "crawl" ? say("Thanks, I've reported waterlogging here. Other drivers will be warned once more cars confirm it.", "Shukriya, yahan paani bhara hone ki report bhej di. Aur gaadiyan confirm karengi toh sabko bataya jayega.", "धन्यवाद, यहाँ जलभराव की रिपोर्ट भेज दी। और गाड़ियाँ पुष्टि करेंगी तो सबको बताया जाएगा।")
          : say(`Thanks, I've marked a ${word(L, it.type, 1)} here. It will be shown to others once 3 cars agree.`, `Shukriya, yahan ${word(L, it.type, 1)} mark kar diya. 3 gaadiyan confirm karengi toh sabko dikhega.`, `धन्यवाद, यहाँ ${word(L, it.type, 1)} दर्ज कर दिया। 3 गाड़ियाँ पुष्टि करेंगी तो सबको दिखेगा।`);
        break;
      case "yes":
        action = ctx.pending ? { confirm: true } : null;
        out = ctx.pending ? say(`Thanks, ${word(L, ctx.pending.type, 1)} confirmed.`, `Shukriya, ${word(L, ctx.pending.type, 1)} confirm ho gaya.`, `धन्यवाद, ${word(L, ctx.pending.type, 1)} की पुष्टि हो गई।`) : say("Okay.", "Theek hai.", "ठीक है।");
        break;
      case "no":
        action = ctx.pending ? { confirm: false } : null;
        out = ctx.pending ? say("Got it, I won't report that jolt.", "Theek hai, wo jhatka report nahi karunga.", "ठीक है, वह झटका रिपोर्ट नहीं करूँगा।") : say("Okay.", "Theek hai.", "ठीक है।");
        break;
      case "help":
        out = say("Ask me what's ahead, whether the underpass is flooded, whether your car will make it, or for today's road brief. Say 'pothole here' to report one.", "Mujhse poochhiye aage kya hai, underpass mein paani hai kya, meri gaadi nikal jayegi kya, ya aaj ka road brief. Report ke liye boliye 'yahan gaddha hai'.", "मुझसे पूछिए आगे क्या है, अंडरपास में पानी है क्या, मेरी गाड़ी निकल जाएगी क्या, या आज का रोड ब्रीफ़। रिपोर्ट के लिए बोलिए 'यहाँ गड्ढा है'।");
        break;
      default:
        out = say("Sorry, I didn't get that. You can ask what's ahead or report a pothole.", "Maaf kijiye, samajh nahi aaya. Aap pooch sakte hain aage kya hai, ya gaddha report kar sakte hain.", "माफ़ कीजिए, समझ नहीं आया। आप पूछ सकते हैं आगे क्या है, या गड्ढा रिपोर्ट कर सकते हैं।");
    }
    return { lang, intent: it.name, reply: out, action };
  }

  function askAfterJolt(type, lang) {
    return { English: `Was that a ${word("English", type, 1)}? Say yes or no.`, Hinglish: `Abhi jo jhatka laga, kya wo ${word("Hinglish", type, 1)} tha? Haan ya na boliye.`, Hindi: `अभी जो झटका लगा, क्या वह ${word("Hindi", type, 1)} था? हाँ या ना बोलिए।` }[lang];
  }

  return { detectLang, intent, reply, askAfterJolt };
});
