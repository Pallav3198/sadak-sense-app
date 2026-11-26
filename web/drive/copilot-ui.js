// Personal co-pilot in the driver app (owner only): real place search and live-traffic route,
// leave-by from the owner's calendar, and Gmail / Teams read aloud ONLY when the car is stopped.
// Nothing is ever sent until the driver hears it read back and says yes.
const CO = { me: null, dest: null, next: null, inbox: [], seen: new Set(), speeds: [], step: null, item: null, draft: null, saidLeave: false, saidLate: false, here: null };
window.CO = CO;
try { CO.seen = new Set(JSON.parse(localStorage.getItem("ss-seen") || "[]")); } catch {}
const keepSeen = () => { try { localStorage.setItem("ss-seen", JSON.stringify([...CO.seen].slice(-200))); } catch {} };
const coT = (en, hl, hi) => T3(en, hl, hi);
const hm = (ts) => new Date(ts).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
const post = (p, b) => fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) }).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
const coHere = () => S.pos || CO.here;

/* ---------- sign-in state on the start screen ---------- */
async function coMe() {
  try { CO.me = await fetch("/api/me").then((r) => (r.ok ? r.json() : null)); } catch { CO.me = null; }
  const box = $("meBox"); if (!CO.me?.configured) { box.hidden = true; return; }
  box.hidden = false; const c = CO.me.configured;
  $("gIn").hidden = !c.google || CO.me.owner; $("mIn").hidden = !c.microsoft || !CO.me.owner || !!CO.me.microsoft; $("outBtn").hidden = !CO.me.owner;
  $("destRow").hidden = $("destList").hidden = !(CO.me.owner && c.maps);
  const bits = [];
  if (!c.owner) bits.push("Personal features are not set up on this server yet.");
  else if (!CO.me.owner) bits.push("Sign in with your Google account to use your calendar, Gmail, Teams and maps.");
  else { bits.push("Gmail and Calendar connected."); bits.push(CO.me.microsoft ? `Teams connected (${CO.me.microsoft.email}).` : c.microsoft ? "Teams not connected." : ""); }
  const q = new URLSearchParams(location.search).get("signin");
  if (q) bits.unshift({ google: "Signed in.", microsoft: "Teams connected.", "not-owner": "That Google account isn't the owner of this app.", "owner-first": "Sign in with Google first, then connect Teams.", failed: "Sign-in failed, try again.", access_denied: "Sign-in cancelled." }[q] || `Sign-in: ${q}`);
  $("meState").textContent = bits.filter(Boolean).join(" ");
  if (CO.me.owner) { locateOnce(); }
}
function locateOnce() {
  navigator.geolocation?.getCurrentPosition((p) => { CO.here = { lat: p.coords.latitude, lon: p.coords.longitude }; refreshNext(); }, () => {}, { enableHighAccuracy: true, timeout: 10000 });
}
$("outBtn").onclick = async () => { await post("/auth/logout"); location.href = "/drive/"; };

/* ---------- where to: real search + live-traffic route ---------- */
let searchT = null;
$("dest").addEventListener("input", () => {
  clearTimeout(searchT); const q = $("dest").value.trim(); if (q.length < 3) { $("destList").innerHTML = ""; return; }
  searchT = setTimeout(async () => {
    const p = coHere(), r = await fetch(`/api/maps/search?q=${encodeURIComponent(q)}${p ? `&lat=${p.lat}&lon=${p.lon}` : ""}`).then((x) => x.json()).catch(() => ({}));
    $("destList").innerHTML = "";
    for (const x of r.results || []) { const b = document.createElement("button"); b.type = "button"; b.className = "btn"; b.innerHTML = "<b></b><span></span>"; b.querySelector("b").textContent = x.name; b.querySelector("span").textContent = x.address; b.onclick = () => pickDest(x); $("destList").append(b); }
    if (r.error) $("destList").textContent = r.error;
  }, 450);
});
function pickDest(x) { CO.dest = x; $("dest").value = x.name; $("destList").innerHTML = ""; $("meState").textContent = `Destination: ${x.name}. Press Start driving.`; }
async function routeToDest() {
  const p = coHere(); if (!CO.dest || !p) return;
  const r = await post("/api/maps/route", { from: { lat: p.lat, lon: p.lon }, to: CO.dest, smooth: !!window.PersonalUI?.gentle });
  if (!r.coords) { bubble("a", "Maps", r.error || "Couldn't get a route."); return; }
  if (routeLine) map.removeLayer(routeLine);
  routeLine = L.polyline(r.coords, { color: "#3fd0c9", weight: 6, opacity: 0.6 }).addTo(map);
  const mins = Math.round(r.durationS / 60), late = Math.round(r.trafficDelayS / 60);
  CO.route = r; $("mRoad").textContent = CO.dest.name; document.dispatchEvent(new Event("ss-route"));
  coShow(`${CO.dest.name} · ${mins} min`, `${(r.lengthM / 1000).toFixed(1)} km, arrive ${hm(Date.now() + r.durationS * 1000)}${late ? ` · ${late} min traffic delay` : ""} · ${r.hazards.length} hazards on route`);
  say(coT(`${mins} minutes to ${CO.dest.name} with current traffic. ${r.hazards.length ? `${r.hazards.length} confirmed hazards on the way; I'll warn you before each.` : "No confirmed hazards on the way."}`,
    `${CO.dest.name} tak abhi ke traffic mein ${mins} minute. ${r.hazards.length ? `Raaste mein ${r.hazards.length} confirmed hazard hain, har ek se pehle bata dunga.` : "Raaste mein koi confirmed hazard nahi."}`,
    `${CO.dest.name} तक अभी के ट्रैफ़िक में ${mins} मिनट। ${r.hazards.length ? `रास्ते में ${r.hazards.length} पक्के ख़तरे हैं, हर एक से पहले बताऊँगा।` : "रास्ते में कोई पक्का ख़तरा नहीं।"}`));
}
function coShow(t, s) { const b = $("coBar"); b.hidden = false; $("coT").textContent = t; $("coS").textContent = s; }

/* ---------- leave-by and running late (calendar + traffic + hazards + rain) ---------- */
async function refreshNext() {
  const p = coHere(); if (!CO.me?.owner || !p) return;
  const r = await post("/api/copilot/next", { lat: p.lat, lon: p.lon, raining: !!S.rain });
  if (r.status !== 200) return;
  CO.next = r;
  rescue(r.call);
  const box = $("nextBox");
  if (!r.event) { box.textContent = r.upcoming ? "No in-person meetings with a location in the next 12 hours." : "No meetings in the next 12 hours."; return; }
  if (!r.place) { box.textContent = `${r.event.title} at ${hm(r.event.start)}: ${r.why}`; return; }
  const why = r.plan.parts.map((x) => `${x.min} min ${x.what}`).join(" + ");
  box.textContent = r.plan.late > 0 ? `${r.event.title} at ${hm(r.event.start)}: you'll be about ${r.plan.late} min late (${why}).` : `${r.event.title} at ${hm(r.event.start)} · leave by ${hm(r.plan.leave)} (${why}).`;
  if (!S.mode) return;
  coShow(r.plan.late > 0 ? `${r.event.title}: ~${r.plan.late} min late` : `${r.event.title} ${hm(r.event.start)} · leave by ${hm(r.plan.leave)}`, `${r.place.name} · ${why}`);
  if (!CO.dest) { CO.dest = r.place; routeToDest(); }
  const minsToLeave = (r.plan.leave - Date.now()) / 60e3;
  if (!CO.saidLeave && minsToLeave <= 10 && minsToLeave > 0 && (S.pos?.speed || 0) < 2) {
    CO.saidLeave = true; say(coT(`Leave in ${Math.round(minsToLeave)} minutes for ${r.event.title}. Traffic and road hazards are included.`, `${r.event.title} ke liye ${Math.round(minsToLeave)} minute mein nikliye. Traffic aur raaste ke hazard jod liye hain.`, `${r.event.title} के लिए ${Math.round(minsToLeave)} मिनट में निकलें। ट्रैफ़िक और रास्ते के ख़तरे जोड़ लिए हैं।`));
  }
  if (!CO.saidLate && r.plan.late >= 3 && r.draft && r.event.attendees.length && !CO.step) {
    CO.saidLate = true; const names = r.event.attendees.slice(0, 2).map((a) => a.name.split(" ")[0]).join(" and ");
    coAsk("late", { to: r.event.attendees.map((a) => a.email), subject: r.draft.subject, body: r.draft.body, source: "gmail" },
      coT(`You'll be about ${r.plan.late} minutes late for ${r.event.title}. Shall I email ${names}: "${r.draft.short}"`, `${r.event.title} ke liye lagbhag ${r.plan.late} minute late honge. ${names} ko email kar dun: "${r.draft.short}"`, `${r.event.title} के लिए लगभग ${r.plan.late} मिनट देर होगी। ${names} को ईमेल कर दूँ: "${r.draft.short}"`));
  }
}

/* ---------- Gmail and Teams, read out only at stops ---------- */
async function refreshInbox() {
  if (!CO.me?.owner || !S.mode) return;
  const t = tripNow(), q = t ? `?dest=${encodeURIComponent(t.destination)}&mins=${t.minutes_left}&delay=${t.traffic_delay_min}&hz=${t.hazards_on_route}&flood=${t.flooded ? 1 : 0}` : "";
  const r = await fetch("/api/copilot/inbox" + q).then((x) => x.json()).catch(() => null); if (!r) return;
  CO.inbox = (r.items || []).filter((i) => !CO.seen.has(i.source + i.id));
  $("coInbox").textContent = CO.inbox.length ? `${CO.inbox.length} new · told at the next safe moment` : "";
}
// Delivery timing (when, and how much) lives in moment-ui.js (spec 14.4).
function coTick() {}

/* ---------- the yes / dictate / read-back / yes flow ---------- */
// Agent permission questions are "serious" (spoken in Chime + card mode too); the rest follow the alert style.
function coAsk(step, item, line) { CO.step = step; CO.item = item; openConvo(); $("yn").hidden = false; if (step !== "reply?") bubble("a", "Sadak Sense", line); say(line, step === "late" ? "serious" : step === "reply?" ? "info" : "reply"); }
// Called from ask() in drive.js with every driver utterance. Returns true when the co-pilot handled it.
window.coHandle = function (text, shown, itn) {
  if (window.Commute && Commute.voice(shown || text)) return true;
  if (!CO.step) return false;
  const yes = itn === "yes", no = itn === "no";
  if (CO.step === "dictate") {
    const said = (shown || text).trim(), it = CO.item, to = it.from; CO.step = "composing";
    post("/api/copilot/compose", { item: it, said, trip: tripNow(), car: S.car, demo: !!it.demo }).then((r) => {
      CO.draft = r.full || said;
      const shownDraft = r.text ? `${r.text} (+ "${r.etaLine}")` : said;
      coAsk("confirm", it, coT(`Sending to ${to}: "${shownDraft}". Send it?`, `${to} ko bhej rahe hain: "${shownDraft}". Bhej dun?`, `${to} को भेज रहे हैं: "${shownDraft}"। भेज दूँ?`));
    });
    return true;
  }
  if (!yes && !no) return false;
  $("yn").hidden = true;
  if (no) { CO.step = null; bubble("a", "Sadak Sense", coT("Okay, not sending.", "Theek hai, nahi bheja.", "ठीक है, नहीं भेजा।")); say(coT("Okay.", "Theek hai.", "ठीक है।"), "reply"); return true; }
  if (CO.step === "reply?") { CO.step = "dictate"; const l = coT("Go ahead, say your reply.", "Boliye, kya jawab dena hai.", "बोलिए, क्या जवाब देना है।"); bubble("a", "Sadak Sense", l); say(l, "reply"); setTimeout(() => listen(), 1800); return true; }
  if (CO.step === "confirm") { coSend({ ...replyOf(CO.item), body: CO.draft }); return true; }
  if (CO.step === "late") { coSend(CO.item); return true; }
  return false;
};
function replyOf(it) {
  const r = it.source === "teams" ? { source: "teams", chatId: it.chatId } : { source: "gmail", to: [it.fromAddr], subject: it.subject, threadId: it.threadId, inReplyTo: it.messageId };
  return it.demo ? { ...r, demo: true } : r;
}
async function coSend(msg) {
  if (msg.demo) { $("yn").hidden = true; CO.step = null; const l = coT("Sample data: shown, not sent.", "Sample data: dikhaya, bheja nahi.", "नमूना: दिखाया, भेजा नहीं।"); bubble("a", "Sadak Sense", l); say(l, "reply"); return; }
  $("yn").hidden = true;
  CO.step = null;
  const r = await post("/api/copilot/send", { ...msg, confirmed: true });
  const ok = r.status === 200 && r.sent;
  const l = ok ? coT("Sent.", "Bhej diya.", "भेज दिया।") : coT(`Not sent: ${r.error || "network problem"}.`, `Nahi gaya: ${r.error || "network problem"}.`, `नहीं गया: ${r.error || "नेटवर्क समस्या"}।`);
  bubble("a", "Sadak Sense", l); say(l, "reply");
}

/* ---------- wiring ---------- */
$("coBar").onclick = () => { if (CO.next?.plan) bubble("a", "Leave-by", CO.next.plan.parts.map((x) => `${x.min} min ${x.what}`).join("\n")); openConvo(); };
document.addEventListener("ss-drive-start", () => {
  if (!CO.me?.owner) return;
  if (CO.dest) routeToDest();
  refreshNext(); refreshInbox();
  setInterval(refreshNext, 3 * 60e3); setInterval(refreshInbox, 90e3); setInterval(coTick, 1000);
});
coMe(); setInterval(() => { if (!S.mode && CO.me?.owner) refreshNext(); }, 5 * 60e3);

// Car-screen clock (the head unit shows the time like any infotainment screen).
if (document.documentElement.classList.contains("carmode")) { const tickClock = () => { $("clock").textContent = new Date().toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }); }; tickClock(); setInterval(tickClock, 15e3); setTimeout(() => map.invalidateSize(), 400);
  const intro = document.querySelector("#start > p"); if (intro) intro.textContent = "The car feels speed breakers, potholes and flooded underpasses through its own sensors, shares anonymous reports with other Hyundais, and warns you before hazards the fleet has confirmed. In this prototype a phone on the dashboard does the sensing."; }
// Installable app: register the service worker on the server edition only (not the single-file demo).
if ("serviceWorker" in navigator && location.pathname.startsWith("/drive/")) navigator.serviceWorker.register("/drive/sw.js", { scope: "/" }).catch(() => {});

/* ---------- live trip: ETA, traffic and road events for context lines and replies (14.6) ---------- */
function tripNow() {
  if (!CO.route || !CO.dest) return null;
  return { destination: CO.dest.name, minutes_left: Math.round(CO.route.durationS / 60), traffic_delay_min: Math.round((CO.route.trafficDelayS || 0) / 60),
    hazards_on_route: (CO.route.hazards || []).filter((h) => h.type !== "water").length, flooded: (CO.route.hazards || []).some((h) => h.type === "water") };
}

/* ---------- meeting rescue (14.6): late for a call → tell the organiser; parked → join by audio ---------- */
function rescue(call) {
  if (!call || !S.mode) return;
  const moving = (S.pos?.speed || 0) * 3.6 > 5, parked = window.MomentUI?.state?.kind === "parked" || !moving;
  const mins = Math.round((call.start - Date.now()) / 60e3);
  if (parked && call.joinUrl && mins <= 2 && !CO.offeredJoin) {
    CO.offeredJoin = true; openConvo();
    const l = coT(`${call.title} ${mins > 0 ? `starts in ${mins} min` : "has started"}. Join by audio?`, `${call.title} ${mins > 0 ? `${mins} minute mein shuru` : "shuru ho gayi"}. Audio se join karna hai?`, `${call.title} ${mins > 0 ? `${mins} मिनट में शुरू` : "शुरू हो गई"}। ऑडियो से जुड़ना है?`);
    bubble("a", "Meeting rescue", l); say(l, "serious");
    const a = document.createElement("a"); a.href = call.joinUrl; a.target = "_blank"; a.rel = "noopener"; a.className = "btn"; a.style.cssText = "display:block;text-align:center;margin:4px 0";
    a.textContent = coT("Join by audio", "Audio se join", "ऑडियो से जुड़ें"); $("msgs").append(a);
    return;
  }
  if (moving && call.draft && mins <= 15 && !CO.saidRescue && !CO.step) {
    CO.saidRescue = true; const who = (call.organizer || "the organiser").split("@")[0];
    const t = tripNow(), body = call.draft.body + (t ? "\n\n" + `Sent from my Hyundai: reaching ${t.destination} in about ${t.minutes_left} min.` : "");
    coAsk("late", { to: call.draft.to, subject: call.draft.subject, body, source: "gmail", demo: !!call.demo },
      coT(`Your call ${call.title} starts in ${Math.max(0, mins)} minutes while you're driving. Tell ${who} you'll join by audio from the car?`,
        `${call.title} call ${Math.max(0, mins)} minute mein shuru hai aur aap drive kar rahe hain. ${who} ko bata dun ki car se audio pe judenge?`,
        `${call.title} कॉल ${Math.max(0, mins)} मिनट में शुरू है और आप गाड़ी चला रहे हैं। ${who} को बता दूँ कि कार से ऑडियो पर जुड़ेंगे?`));
  }
}

/* ---------- What I know (14.6): the owner's knowledge graph ---------- */
async function showKnowledge() {
  const sh = $("knowSheet"); sh.hidden = false; $("knowBody").textContent = "Reading your accounts…";
  const r = await fetch("/api/copilot/graph").then((x) => x.json()).catch(() => ({ error: "network" }));
  if (r.error) { $("knowBody").textContent = r.error; return; }
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const meet = r.meetings.map((m) => `<li><b>${esc(m.title)}</b> · ${new Date(m.start).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}${m.place ? ` · ${esc(m.place)}` : m.online ? " · online" : ""}${m.people.length ? `<br><span>with ${esc(m.people.slice(0, 5).join(", "))}</span>` : ""}${m.conversations.length ? `<br><span>related: ${esc(m.conversations.join(", "))}</span>` : ""}</li>`).join("");
  const conv = r.conversations.map((c) => `<li><b>${esc(c.title)}</b> · ${c.via}${c.people.length ? ` · ${esc(c.people.join(", "))}` : ""}${c.about.length ? `<br><span>about: ${esc(c.about.join(", "))}</span>` : ""}</li>`).join("");
  const ppl = r.people.slice(0, 12).map((p) => `<li>${esc(p.name)}${p.email ? ` <span>${esc(p.email)}</span>` : ""} · ${p.links} link${p.links === 1 ? "" : "s"}</li>`).join("");
  $("knowBody").innerHTML = `<div class="note">Built from your own Gmail, Teams and calendars just now (${r.edges} links). Kept only in memory, never stored.</div><div class="label">Meetings</div><ul>${meet || "<li>None in the next 14 hours</li>"}</ul><div class="label">Conversations</div><ul>${conv || "<li>No unread conversations</li>"}</ul><div class="label">People</div><ul>${ppl}</ul>`;
}
$("knowBtn").onclick = showKnowledge; $("knowClose").onclick = () => { $("knowSheet").hidden = true; };
