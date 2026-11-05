// Sadak Sense speech: picks the most natural free Indian voice the browser offers and prepares the
// text for it. Roman Hinglish goes through a word list into Devanagari, because a Hindi voice reads
// "gaddha" badly but "गड्ढा" well. No network service or API key: Edge brings Microsoft's neural
// voices, Chrome brings Google's Hindi voice, phones bring their own. Shared by the apps and tests.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SadakSpeech = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const WORDS = {
    aage: "आगे", aagey: "आगे", aap: "आप", aapke: "आपके", aapki: "आपकी", aaj: "आज", aur: "और", abhi: "अभी", andar: "अंदर", atak: "अटक", atkin: "अटकीं", aa: "आ", aaram: "आराम",
    bada: "बड़ा", bade: "बड़े", baad: "बाद", baithi: "बैठी", bana: "बना", bagal: "बग़ल", bata: "बता", bataunga: "बताऊँगा", bataya: "बताया", behtar: "बेहतर", bhara: "भरा", bhej: "भेज", bhejne: "भेजने", bolo: "बोलो", boliye: "बोलिए", book: "बुक", brief: "ब्रीफ़", breaker: "ब्रेकर", breakers: "ब्रेकर",
    call: "कॉल", car: "कार", chaliye: "चलिए", chalun: "चलूँ", claim: "क्लेम", clearance: "क्लीयरेंस", confirm: "कन्फ़र्म", confirmed: "कन्फ़र्म्ड",
    dekh: "देख", dekhein: "देखें", demo: "डेमो", der: "देर", dheere: "धीरे", dikha: "दिखा", dikhega: "दिखेगा", dikkat: "दिक़्क़त", diya: "दिया", do: "दो", doon: "दूँ", doosra: "दूसरा", doosre: "दूसरे", draft: "ड्राफ़्ट", dunga: "दूँगा", denge: "देंगे",
    ek: "एक", front: "फ़्रंट",
    gaadi: "गाड़ी", gaadiyan: "गाड़ियाँ", gaadiyon: "गाड़ियों", gaddha: "गड्ढा", gaddhe: "गड्ढे", gaddhon: "गड्ढों", gaya: "गया", gehra: "गहरा", ghar: "घर", gir: "गिर", good: "गुड",
    ha: "हाँ", haan: "हाँ", hai: "है", hain: "हैं", har: "हर", hisaab: "हिसाब", ho: "हो", honge: "होंगे", hone: "होने", hoon: "हूँ", hospital: "हॉस्पिटल",
    insurance: "इंश्योरेंस", is: "इस", isliye: "इसलिए",
    ja: "जा", jagah: "जगह", jaiye: "जाइए", jawab: "जवाब", jayega: "जाएगा", jayegi: "जाएगी", jhatka: "झटका", jo: "जो",
    ka: "का", kar: "कर", karenge: "करेंगे", karengi: "करेंगी", kareeb: "क़रीब", karun: "करूँ", karunga: "करूँगा", ke: "के", ki: "की", kijiye: "कीजिए", kilometre: "किलोमीटर", ko: "को", koi: "कोई", kuch: "कुछ", kya: "क्या", khatarnaak: "ख़तरनाक",
    lag: "लग", lagbhag: "लगभग", late: "लेट", le: "ले", left: "लेफ़्ट", lijiye: "लीजिए", limit: "लिमिट", log: "लॉग", logon: "लोगों",
    maaf: "माफ़", main: "मैं", maine: "मैंने", mark: "मार्क", mat: "मत", me: "में", mein: "में", message: "मैसेज", metre: "मीटर", metres: "मीटर", mil: "मिल", mila: "मिला", minute: "मिनट", morning: "मॉर्निंग", mude: "मुड़े", mujhse: "मुझसे",
    na: "ना", nahi: "नहीं", nahin: "नहीं", nearest: "नियरेस्ट", neeche: "नीचे", network: "नेटवर्क", nikal: "निकल", nikaliye: "निकालिए",
    paani: "पानी", pahunchte: "पहुँचते", par: "पर", pe: "पे", pehle: "पहले", phone: "फ़ोन", pichhle: "पिछले", poochhiye: "पूछिए", pooch: "पूछ", pressure: "प्रेशर", psi: "पी एस आई",
    raaste: "रास्ते", raasta: "रास्ता", rahe: "रहे", raha: "रहा", rahi: "रही", rahiye: "रहिए", rakhiye: "रखिए", report: "रिपोर्ट", right: "राइट", rim: "रिम", risky: "रिस्की", road: "रोड", route: "रूट", ruk: "रुक", rukiye: "रुकिए",
    saaf: "साफ़", saath: "साथ", sabko: "सबको", safe: "सेफ़", sakte: "सकते", sakti: "सकती", sake: "सके", samajh: "समझ", save: "सेव", se: "से", sensor: "सेंसर", service: "सर्विस", shaam: "शाम", shukriya: "शुक्रिया", slot: "स्लॉट", speed: "स्पीड", stop: "स्टॉप", suspension: "सस्पेंशन",
    tak: "तक", tha: "था", theek: "ठीक", thodi: "थोड़ी", thoda: "थोड़ा", time: "टाइम", toh: "तो", tyre: "टायर",
    underpass: "अंडरपास", uske: "उसके",
    wahan: "वहाँ", wapas: "वापस", wear: "वियर", wo: "वो",
    yahan: "यहाँ", ya: "या", zor: "ज़ोर",
    ne: "ने", kiya: "किया", di: "दी", meri: "मेरी", liye: "लिए", hazard: "हैज़र्ड", kahin: "कहीं", laga: "लगा", lagta: "लगता", agle: "अगले", check: "चेक", mm: "मिलीमीटर", cm: "सेंटीमीटर", g: "जी",
  };

  // Pure Roman text to the spelling a Hindi voice pronounces well. Unknown words (road names,
  // places) stay in Roman; neural Hindi voices read those as English.
  function hinglishForSpeech(text) {
    return String(text).replace(/[A-Za-z]+/g, (w) => WORDS[w.toLowerCase()] || w).replace(/\.(\s|$)/g, "।$1");
  }

  const CODE = (lang) => (lang === "English" ? "en-IN" : "hi-IN");
  const norm = (l) => String(l || "").replace("_", "-").toLowerCase();

  // Higher is better. Neural and "Online" voices sound human; the old desktop ones sound robotic.
  function score(v, want) {
    const name = String(v.name || ""), lang = norm(v.lang);
    if (lang !== want.toLowerCase()) return 0;
    let s = 10;
    if (/natural|neural|online/i.test(name)) s += 100;
    if (/swara|madhur|neerja|prabhat|aarav|ananya|kavya|aarti/i.test(name)) s += 40;
    if (/google|-x-.*-(local|network)/i.test(name)) s += 70; // Chrome and Android
    if (/lekha|rishi|veena|isha|premium|enhanced/i.test(name)) s += 50;
    if (/kalpana|hemant|heera|ravi/i.test(name)) s += 5;
    return s;
  }
  function rank(voices, lang) {
    const want = CODE(lang);
    const list = (voices || []).map((v) => ({ v, s: score(v, want) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.v);
    // Desktop Chrome has no Indian English voice: its Hindi voice keeps the Indian accent, a US one would not.
    return list.length || lang !== "English" ? list : rank(voices, "Hindi").filter(isNatural);
  }
  const isNatural = (v) => !!v && (score(v, norm(v.lang)) >= 80);

  // Which voice, spelling and pace to use. chosen is a voice name the driver picked, if any.
  function plan(text, lang, voices, chosen) {
    const list = rank(voices, lang);
    const voice = list.find((v) => v.name === chosen) || list[0] || null;
    if (lang === "Hinglish" && !voice) {
      // No Hindi voice at all: an Indian English voice reading the Roman text beats silence.
      const en = rank(voices, "English")[0] || null;
      return { voice: en, code: "en-IN", text: String(text), rate: 0.95, pitch: 1 };
    }
    return { voice, code: voice ? voice.lang.replace("_", "-") : CODE(lang), text: lang === "Hinglish" ? hinglishForSpeech(text) : String(text), rate: isNatural(voice) ? 1 : 0.92, pitch: 1 };
  }

  // Chrome's online voices stop after about 15 s, so long replies go sentence by sentence.
  function chunks(text) {
    return (String(text).match(/[^.।?!]+[.।?!]*\s*/g) || [String(text)]).map((s) => s.trim()).filter(Boolean);
  }

  const synth = () => (typeof speechSynthesis !== "undefined" ? speechSynthesis : null);
  function voices() {
    const s = synth(); if (!s) return Promise.resolve([]);
    const now = s.getVoices(); if (now.length) return Promise.resolve(now);
    // Browsers load voices late; wait briefly rather than speak with the default.
    return new Promise((res) => {
      const done = () => { s.removeEventListener?.("voiceschanged", done); res(s.getVoices()); };
      s.addEventListener?.("voiceschanged", done); setTimeout(done, 1200);
    });
  }
  const KEY = "ss-voice";
  const chosen = () => { try { return localStorage.getItem(KEY) || ""; } catch { return ""; } };
  const choose = (name) => { try { name ? localStorage.setItem(KEY, name) : localStorage.removeItem(KEY); } catch {} };

  let turn = 0, live = []; // live keeps utterances referenced: Chrome can drop unreferenced ones mid-speech
  // on: optional { start(voiceName), end(), fail(reason) } so the page can say what is happening.
  async function speak(text, lang = "English", on = {}) {
    const s = synth();
    if (!s) return on.fail?.("unsupported");
    if (!text) return;
    const mine = ++turn;
    const list = await voices();
    if (mine !== turn) return; // a newer line arrived while voices were loading
    const p = plan(text, lang, list, chosen());
    s.cancel(); s.resume();
    const parts = chunks(p.text);
    let started = false;
    const watchdog = setTimeout(() => { if (!started && mine === turn) on.fail?.("silent"); }, 5000);
    live = parts.map((part, i) => {
      const u = new SpeechSynthesisUtterance(part);
      u.lang = p.code; u.rate = p.rate; u.pitch = p.pitch; if (p.voice) u.voice = p.voice;
      u.onstart = () => { if (!started) { started = true; clearTimeout(watchdog); on.start?.(p.voice ? p.voice.name : ""); } };
      u.onerror = (e) => { if (e.error !== "canceled" && e.error !== "interrupted") { clearTimeout(watchdog); on.fail?.(e.error || "error"); } };
      if (i === parts.length - 1) u.onend = () => on.end?.();
      return u;
    });
    live.forEach((u) => s.speak(u));
  }

  return { WORDS, hinglishForSpeech, rank, isNatural, plan, chunks, voices, chosen, choose, speak };
});
