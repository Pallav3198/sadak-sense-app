// Personalisation in the app (spec 14.9). Everything here stays on the phone unless it needs the owner's
// accounts (street names, the "reached safely" email), which go through the owner's own sign-in.
const PersonalUI = (() => {
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || "null") ?? d; } catch { return d; } };
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const prof = () => (window.Commute ? Commute.profile : {});
  const st = { gentle: false, focus: { on: false }, focusSaid: null, monsoonSaid: false, arrivedSent: false, comfort: { style: "learning", adjust: 0 } };

  /* ---------- 9.2 elders or kids on board: gentler advice and a smoother route ---------- */
  function setGentle(on) { st.gentle = !!on; $("gentleToday").checked = st.gentle; SadakCar.setProfile({ gentle: st.gentle }); }
  $("gentleToday").onchange = () => setGentle($("gentleToday").checked);

  /* ---------- 9.3 learned comfort profile ---------- */
  function onJolt(e) {
    if (e.type !== "breaker" || !S.pos) return;
    const advised = SadakCar.check(S.car, S.people, { type: "breaker", severity: 1 }).speed;
    const list = load("ss-comfort", []); list.push({ speed: Math.round(S.pos.speed * 3.6), peakG: e.peakG, advised, ts: Date.now() }); store("ss-comfort", list.slice(-60));
    applyComfort();
  }
  function applyComfort() { st.comfort = SadakPersonal.comfort(load("ss-comfort", [])); SadakCar.setProfile({ adjust: st.comfort.adjust }); }
  const quietBreakers = () => st.comfort.quiet === true;

  /* ---------- 9.4 focus before important meetings, and quiet hours ---------- */
  function updateFocus() {
    const p = prof(), events = window.CO?.next?.events || [];
    st.focus = SadakPersonal.focus({ events, vips: p.vips || [], quiet: p.quietFrom && p.quietTo ? { from: p.quietFrom, to: p.quietTo } : null });
    if (st.focus.on && S.mode && st.focusSaid !== (st.focus.title || st.focus.reason)) {
      st.focusSaid = st.focus.title || st.focus.reason;
      const l = st.focus.reason === "meeting"
        ? T3(`Focus mode until ${st.focus.title}: only VIP and urgent messages.`, `${st.focus.title} tak focus mode: sirf VIP aur zaroori message.`, `${st.focus.title} तक फ़ोकस मोड: सिर्फ़ VIP और ज़रूरी संदेश।`)
        : T3("Quiet hours: only VIP and urgent messages.", "Quiet hours: sirf VIP aur zaroori message.", "शांत समय: सिर्फ़ VIP और ज़रूरी संदेश।");
      openConvo(); bubble("a", "Sadak Sense", l); say(l, "info");
    }
  }
  const focusHolds = () => st.focus.on;

  /* ---------- 9.1 commute memory: brief only what changed ---------- */
  async function routeBrief() {
    const r = window.CO?.route, dest = window.CO?.dest; if (!r || !dest || !r.hazards) return;
    const key = dest.name, snaps = load("ss-snaps", {}), prev = snaps[key];
    const d = SadakPersonal.routeDiff(prev?.list || null, r.hazards);
    snaps[key] = { list: d.snapshot, at: Date.now() }; store("ss-snaps", snaps);
    if (d.first || (!d.added.length && !d.removed.length)) return; // nothing changed → say nothing
    const since = prev?.at && Date.now() - prev.at < 36 * 3600e3 ? T3("since yesterday", "kal se", "कल से") : T3("since your last trip", "pichhli trip se", "पिछली यात्रा से");
    // Where: the street name (TomTom), or else how far along the route, phrased for each language.
    const where = async (h) => {
      try { const a = await fetch(`/api/maps/reverse?lat=${h.lat}&lon=${h.lon}`).then((x) => (x.ok ? x.json() : null)); if (a?.text) return T3(`near ${a.text}`, `${a.text} ke paas`, `${a.text} के पास`); } catch {}
      const km = (SS.hav(r.coords[0][0], r.coords[0][1], h.lat, h.lon) / 1000).toFixed(1);
      return T3(`${km} km into the route`, `route mein ${km} km par`, `रास्ते में ${km} किमी पर`);
    };
    const name = (t) => T3({ pothole: "pothole", breaker: "speed breaker", water: "waterlogging" }[t] || t, { pothole: "gaddha", breaker: "speed breaker", water: "paani bhara" }[t] || t, { pothole: "गड्ढा", breaker: "स्पीड ब्रेकर", water: "जलभराव" }[t] || t);
    const parts = [];
    for (const h of d.added.slice(0, 2)) { const w = await where(h); parts.push(T3(`New ${name(h.type)} ${since}, ${w}.`, `${since} naya ${name(h.type)}, ${w}.`, `${since} नया ${name(h.type)}, ${w}।`)); }
    for (const h of d.removed.slice(0, 1)) { const w = await where(h); parts.push(T3(`The ${name(h.type)} ${w} is fixed.`, `${w} wala ${name(h.type)} theek ho gaya.`, `${w} वाला ${name(h.type)} ठीक हो गया।`)); }
    openConvo(); bubble("a", T3("What changed on your route", "Raaste mein kya badla", "रास्ते में क्या बदला"), parts.join("\n")); say(parts.join(" "), "info");
  }

  /* ---------- 9.5 monsoon personal warning before leaving ---------- */
  async function monsoonCheck() {
    if (st.monsoonSaid || !window.CO?.route?.coords || (S.pos?.speed || 0) * 3.6 > 5) return;
    const p = S.pos || window.CO?.here; if (!p) return;
    const env = S.env || (await SadakEnv.fetchEnv(p.lat, p.lon).catch(() => null)); if (!env) return;
    const since = Date.now() - 30 * 864e5;
    const hz = await SS.api(`/api/hazards?states=confirmed,cleared&since=${since}`).catch(() => ({ hazards: [] }));
    const m = SadakPersonal.monsoon({ env, route: CO.route.coords, waterHistory: (hz.hazards || []).filter((h) => h.family === "water"), carClearanceMm: SadakCar.effectiveClearanceMm(SadakCar.CARS[S.car] || SadakCar.CARS.creta, S.people) });
    if (!m) return;
    st.monsoonSaid = true;
    const l = T3(`${m.rainNow ? "It's raining" : `Rain is likely in the next 2 hours (${m.prob}%)`} and your route crosses a spot that flooded ${m.times > 1 ? `${m.times} times` : ""} this month${m.lowCar ? "; your car sits low with this load" : ""}. Leave ${m.leaveEarlyMin} minutes early or take another road.`,
      `${m.rainNow ? "Baarish ho rahi hai" : `Agle 2 ghante mein baarish ke chances hain (${m.prob}%)`} aur aapke raaste mein ek jagah is mahine paani bhara tha${m.lowCar ? ", aur is load mein gaadi neeche baithi hai" : ""}. ${m.leaveEarlyMin} minute jaldi nikliye ya doosra raasta lijiye.`,
      `${m.rainNow ? "बारिश हो रही है" : `अगले 2 घंटे में बारिश की संभावना है (${m.prob}%)`} और आपके रास्ते में एक जगह इस महीने पानी भरा था${m.lowCar ? ", और इस लोड में गाड़ी नीचे बैठी है" : ""}। ${m.leaveEarlyMin} मिनट जल्दी निकलें या दूसरा रास्ता लें।`);
    openConvo(); bubble("a", T3("Monsoon warning", "Monsoon chetavni", "मानसून चेतावनी"), l); say(l, "serious");
  }

  /* ---------- 9.6 "reached safely" for a parent of a young driver ---------- */
  async function arrivalCheck() {
    const p = prof(); if (!p.youngDriver || !p.parentEmail || st.arrivedSent || !window.CO?.dest || !S.pos) return;
    if (window.MomentUI?.state?.kind !== "parked" || SS.hav(S.pos.lat, S.pos.lon, CO.dest.lat, CO.dest.lon) > 250) return;
    st.arrivedSent = true;
    const r = await SS.api("/api/copilot/arrived", { to: p.parentEmail, name: p.myName || "I", dest: CO.dest.name }).catch(() => ({ error: "network" }));
    const l = r.sent ? T3("Told your parent you reached safely.", "Ghar pe bata diya ki aap safely pahunch gaye.", "घर पर बता दिया कि आप सुरक्षित पहुँच गए।") : T3(`Couldn't send the reached-safely message: ${r.error || "not signed in"}.`, `Pahunchne ka message nahi gaya: ${r.error || "sign in nahi"}.`, `पहुँचने का संदेश नहीं गया: ${r.error || "साइन इन नहीं"}।`);
    bubble("a", "Sadak Sense", l); say(l, "reply");
  }

  /* ---------- 9.7 road-wear cost forecast ---------- */
  function wearLine() {
    const r = window.CO?.route; if (!r?.hazards) return null;
    const c = SadakPersonal.wearCost(r.hazards);
    return { ...c, text: c.perYear ? T3(`This route costs about ₹${c.perYear} a year in extra tyre and suspension wear (${r.hazards.length} hazards, ${c.tripsPerYear} trips).`, `Is raaste se saal mein lagbhag ₹${c.perYear} ka extra tyre aur suspension wear (${r.hazards.length} hazard, ${c.tripsPerYear} trip).`, `इस रास्ते से साल में लगभग ₹${c.perYear} का अतिरिक्त टायर और सस्पेंशन घिसाव (${r.hazards.length} ख़तरे, ${c.tripsPerYear} यात्राएँ)।`) : T3("No confirmed hazards on this route: no extra wear.", "Is raaste pe koi confirmed hazard nahi: extra wear nahi.", "इस रास्ते पर कोई पक्का ख़तरा नहीं: अतिरिक्त घिसाव नहीं।") };
  }

  document.addEventListener("ss-route", () => { routeBrief(); monsoonCheck(); const w = wearLine(); if (w && window.CO?.route?.smoothWhy) bubble("a", "Sadak Sense", CO.route.smoothWhy); });
  document.addEventListener("ss-drive-start", () => { setGentle($("gentleToday").checked); applyComfort(); });
  setInterval(() => { updateFocus(); arrivalCheck(); }, 5000);
  setTimeout(() => { const p = prof(); setGentle(!!(p.elders || p.kids)); applyComfort(); }, 900);
  return { onJolt, quietBreakers, focusHolds, wearLine, get gentle() { return st.gentle; }, get focus() { return st.focus; }, get comfort() { return st.comfort; }, monsoonCheck, routeBrief };
})();
window.PersonalUI = PersonalUI;
