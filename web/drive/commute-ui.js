// Commute awareness in the app (spec 14.5): optional ~30-second onboarding, defaults when skipped,
// trip logging to learn the real commute, a gentle reminder, and the voice override for today.
const Commute = (() => {
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || "null") ?? d; } catch { return d; } };
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  let P = SadakCommute.profile(load("ss-profile", null));
  const saveP = () => { store("ss-profile", P); store("ss-vip", P.vips); };
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  /* ---------- onboarding sheet ---------- */
  function open() {
    const f = $("onboard"); f.hidden = false;
    $("obDays").innerHTML = DAYS.map((d, i) => `<label class="day"><input type="checkbox" value="${i}" ${P.workDays.includes(i) ? "checked" : ""}>${d}</label>`).join("");
    $("obOffice").value = P.officeTime || ""; $("obLearn").checked = P.learn !== false;
    $("obVip").value = (P.vips || []).join(", "); $("obEvening").value = P.evening || "urgent";
    $("obPass").value = String(P.passengers || 1); $("obElders").checked = !!P.elders; $("obKids").checked = !!P.kids;
    $("obDomains").value = (P.workDomains || []).join(", ");
    $("obLang").value = $("lang").value; $("obAlert").value = S.style || "chime";
    $("obHome").textContent = P.home ? "Home saved ✓ (tap to update)" : "Use where I am now as home";
    $("obWork").textContent = P.office ? "Office saved ✓ (tap to update)" : "Use where I am now as office";
    const g = window.CO?.me; $("obApps").hidden = !g?.configured;
  }
  function here(cb) { navigator.geolocation?.getCurrentPosition((p) => cb({ lat: p.coords.latitude, lon: p.coords.longitude }), () => alert("Location is off."), { enableHighAccuracy: true, timeout: 10000 }); }
  $("obHome").onclick = () => here((p) => { P.home = p; $("obHome").textContent = "Home saved ✓"; });
  $("obWork").onclick = () => here((p) => { P.office = p; $("obWork").textContent = "Office saved ✓"; });
  $("obSave").onclick = () => {
    P.workDays = [...$("obDays").querySelectorAll("input:checked")].map((x) => +x.value);
    P.officeTime = $("obOffice").value || null; P.learn = $("obLearn").checked;
    P.vips = $("obVip").value.split(",").map((x) => x.trim()).filter(Boolean);
    P.evening = $("obEvening").value; P.passengers = +$("obPass").value; P.elders = $("obElders").checked; P.kids = $("obKids").checked;
    P.workDomains = $("obDomains").value.split(",").map((x) => x.trim().replace(/^@/, "")).filter(Boolean);
    P.skipped = false; saveP(); apply();
    $("lang").value = $("obLang").value; $("lang").dispatchEvent(new Event("change")); setStyle($("obAlert").value);
    $("onboard").hidden = true; remindBox();
  };
  $("obSkip").onclick = () => { if (!localStorage.getItem("ss-profile")) { P.skipped = true; saveP(); } $("onboard").hidden = true; remindBox(); };
  $("obOpen").onclick = open;

  // Profile → app: usual passengers and a work domain guessed from the connected Teams account.
  function apply() {
    $("people").value = String(Math.min(5, Math.max(1, P.passengers || 1)));
    const ms = window.CO?.me?.microsoft?.email; const dom = ms && ms.split("@")[1];
    if (dom && !P.workDomains.includes(dom)) { P.workDomains.push(dom); saveP(); }
  }

  /* ---------- gentle reminder every few days (start screen only, never while driving) ---------- */
  function remindBox() {
    const show = !S.mode && SadakCommute.remind(P);
    $("remindBox").hidden = !show;
  }
  $("remindNow").onclick = () => { P.lastReminder = Date.now(); saveP(); $("remindBox").hidden = true; open(); };
  $("remindLater").onclick = () => { P.lastReminder = Date.now(); saveP(); $("remindBox").hidden = true; };

  /* ---------- trips: learn the real commute after about a week ---------- */
  let trip = null;
  setInterval(() => {
    if (!S.mode || S.mode === "demo" || !S.pos) return;
    const kmh = (S.pos.speed || 0) * 3.6, m = window.MomentUI?.state?.kind;
    if (!trip && kmh > 10) trip = { start: { lat: S.pos.lat, lon: S.pos.lon, ts: Date.now() } };
    if (trip && m === "parked") endTrip();
  }, 2000);
  function endTrip() {
    if (!trip || !S.pos) return;
    trip.end = { lat: S.pos.lat, lon: S.pos.lon, ts: Date.now() };
    if (trip.end.ts - trip.start.ts > 3 * 60e3) {
      const trips = load("ss-trips", []); trips.push(trip); store("ss-trips", trips.slice(-80));
      const L = SadakCommute.learn(trips);
      if (L && P.learn !== false) { P.learned = L; if (!P.home) P.home = L.home; if (!P.office) P.office = L.office; saveP(); }
    }
    trip = null;
  }
  $("stopBtn").addEventListener("click", endTrip);

  /* ---------- voice override for today ---------- */
  function voice(text) {
    const o = SadakCommute.override(text); if (!o) return false;
    P.override = o; saveP();
    const l = o.work === "on" ? T3("Okay, I'll tell you office messages for the rest of today.", "Theek hai, aaj baaki din office messages bhi bataunga.", "ठीक है, आज बाक़ी दिन ऑफ़िस संदेश भी बताऊँगा।")
      : T3("Okay, office messages are held for the rest of today, except urgent and VIP.", "Theek hai, aaj office messages rok diye, sirf zaroori aur VIP aayenge.", "ठीक है, आज ऑफ़िस संदेश रोक दिए, सिर्फ़ ज़रूरी और VIP आएँगे।");
    openConvo(); bubble("a", "Sadak Sense", l); say(l, "reply"); return true;
  }

  setTimeout(() => { apply(); remindBox(); if (!localStorage.getItem("ss-profile")) open(); }, 800);
  return { holds: (it) => SadakCommute.holds(it, P), voice, open, get profile() { return P; }, window: () => SadakCommute.window(P) };
})();

window.Commute = Commute;
