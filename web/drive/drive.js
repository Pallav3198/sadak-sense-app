// Sadak Sense driver app: real sensors (or a demo drive), on-device detection, anonymous
// reporting, clean-pass reporting, and voice alerts for hazards confirmed by other cars.
const $ = (id) => document.getElementById(id);
const G = 9.80665;
const S = { mode: null, lang: "Hinglish", voice: true, rain: false, pos: null, known: [], alerted: new Map(), queue: [], sent: 0, jolts: 0, recent: [], track: new Map(), device: null, lastFetch: 0, car: "creta", people: 4, hits: [], carCheck: null, agentDone: new Set(), pendingAgent: null, reroute: null };

/* ---------- identity: anonymous ID that rotates daily ---------- */
async function dailyId() {
  let secret; try { secret = localStorage.getItem("ss-secret"); if (!secret) { secret = crypto.randomUUID(); localStorage.setItem("ss-secret", secret); } } catch { secret = crypto.randomUUID(); }
  const day = new Date().toISOString().slice(0, 10);
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret + day));
  return "ph-" + [...new Uint8Array(buf)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------- map ---------- */
const map = L.map("map", { zoomControl: false, attributionControl: true }).setView([28.5457, 77.1926], 16);
SS.tiles(map);
const me = L.circleMarker([0, 0], { radius: 8, color: "#fff", weight: 3, fillColor: "#3fd0c9", fillOpacity: 1 }).addTo(map);
const hzLayer = L.layerGroup().addTo(map);
let routeLine = null;

/* ---------- detector ---------- */
const det = SadakDetector.createDetector({ onEvent: (e) => onJolt(e) });
function onJolt(e) {
  if (!S.pos) return;
  S.jolts++; $("mJolts").textContent = S.jolts;
  S.recent.push({ lat: S.pos.lat, lon: S.pos.lon, ts: Date.now() });
  S.hits.push({ ts: Date.now(), type: e.type, peakG: e.peakG, road: $("mRoad").textContent, speed: Math.round(S.pos.speed * 3.6) }); renderCar();
  // In the car this is triggered by the tyre-pressure sensor; the demo uses the first hard pothole hit.
  if (e.type === "pothole" && e.peakG >= (S.mode === "demo" ? 0.5 : 0.9) && !S.agentDone.has("tyre")) setTimeout(() => tyreAgent(e), 3500);
  const ev = { device: S.device, lat: +S.pos.lat.toFixed(6), lon: +S.pos.lon.toFixed(6), heading: Math.round(S.pos.heading ?? 0), speed: +(S.pos.speed * 3.6).toFixed(1), peak_g: e.peakG, type: e.type, ts: Date.now() };
  // A jolt where no hazard is known yet: ask the driver once (human-in-the-loop false-alarm filter).
  const known = S.known.some((h) => SS.hav(h.lat, h.lon, ev.lat, ev.lon) < 25);
  if (known || S.pendingJolt) S.queue.push(ev); else askConfirm(ev);
  $("tNote").textContent = `${e.type === "breaker" ? "speed breaker" : "pothole"} detected · ${e.peakG} g`;
  try { localStorage.setItem("ss-queue", JSON.stringify(S.queue.slice(-200))); } catch {}
}

/* ---------- voice + chime ---------- */
let actx = null;
function chime() { try { actx = actx || new AudioContext(); [880, 660].forEach((f, i) => { const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = f; o.connect(g); g.connect(actx.destination); const t = actx.currentTime + i * 0.18; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16); o.start(t); o.stop(t + 0.18); }); } catch {} }
function say(text) { if (S.voice) SadakSpeech.speak(text, S.lang); }
const PHRASE = {
  breaker: { English: (d) => [`Speed breaker in ${d} metres`, "Slow to 20"], Hinglish: (d) => [`${d} metre mein speed breaker`, "20 ki speed rakhiye"], Hindi: (d) => [`${d} मीटर पर स्पीड ब्रेकर`, "गति 20 रखें"] },
  pothole: { English: (d) => [`Pothole in ${d} metres`, "Keep right if safe"], Hinglish: (d) => [`${d} metre mein gaddha`, "Ho sake toh right rahiye"], Hindi: (d) => [`${d} मीटर पर गड्ढा`, "संभव हो तो दाईं ओर रहें"] },
  water: { English: (d) => [`Waterlogging in ${d} metres`, "Take another road if you can"], Hinglish: (d) => [`${d} metre aage paani bhara hai`, "Doosra raasta lijiye"], Hindi: (d) => [`${d} मीटर आगे जलभराव`, "दूसरा रास्ता लें"] },
};

/* ---------- position updates ---------- */
function updatePos(lat, lon, speed, heading, acc) {
  const p = S.pos;
  if (p && (speed == null || heading == null)) {
    const d = SS.hav(p.lat, p.lon, lat, lon), dt = (Date.now() - p.t) / 1000;
    if (speed == null && dt > 0) speed = d / dt;
    if (heading == null && d > 3) heading = SS.bearing(p.lat, p.lon, lat, lon);
  }
  S.pos = { lat, lon, speed: speed ?? 0, heading: heading ?? p?.heading ?? null, acc, t: Date.now() };
  me.setLatLng([lat, lon]);
  if (!S.zoomed) { S.zoomed = true; map.setView([lat, lon], 16); } else map.panTo([lat, lon], { animate: true, duration: 0.4 });
  $("spd").textContent = Math.round(S.pos.speed * 3.6);
  $("cGps").className = "chip " + (acc != null && acc > 30 ? "bad" : "ok"); $("cGps").textContent = acc != null ? `GPS ±${Math.round(acc)}m` : "GPS";
}

/* ---------- server sync ---------- */
async function fetchKnown() {
  if (!S.pos) return; S.lastFetch = Date.now();
  try {
    const { hazards } = await SS.api(`/api/hazards?lat=${S.pos.lat}&lon=${S.pos.lon}&radius=3000&states=candidate,confirmed`);
    S.known = hazards; $("mKnown").textContent = hazards.filter((h) => h.state === "confirmed").length;
    hzLayer.clearLayers(); hazards.forEach((h) => L.marker([h.lat, h.lon], { icon: SS.hazardIcon(h, ""), interactive: false }).addTo(hzLayer));
    $("cNet").className = "chip ok";
  } catch { $("cNet").className = "chip bad"; }
}
async function flush() {
  if (!S.queue.length) return;
  const batch = S.queue.splice(0, 50);
  try { await fetch("/api/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batch) }); S.sent += batch.length; $("cNet").textContent = `${S.sent} SENT`; $("cNet").className = "chip ok"; }
  catch { S.queue.unshift(...batch); $("cNet").className = "chip bad"; }
}

/* ---------- alerts + clean passes ---------- */
function tick() {
  if (!S.pos) return;
  if (Date.now() - S.lastFetch > 12000) fetchKnown();
  const { lat, lon, speed, heading } = S.pos;
  const warnD = Math.max(60, speed * 6 + 40);
  let next = null, nextD = Infinity;
  for (const h of S.known) {
    const d = SS.hav(lat, lon, h.lat, h.lon);
    // clean pass bookkeeping: we came within 15 m and are now moving away without a jolt there
    if (h.family !== "water") {
      const tr = S.track.get(h.id) || { min: Infinity };
      if (d < tr.min) tr.min = d;
      if (tr.min < 15 && d > tr.min + 10 && !tr.done) {
        tr.done = true;
        const felt = S.recent.some((r) => Date.now() - r.ts < 8000 && SS.hav(r.lat, r.lon, h.lat, h.lon) < 25);
        const dirOk = h.type !== "pothole" || h.heading == null || heading == null || SS.hdiff(h.heading, heading) < 90;
        if (!felt && dirOk) SS.api("/api/passes", { hazardId: h.id, device: S.device, ts: Date.now() }).catch(() => {});
      }
      if (d > 200) tr.done = false, (tr.min = Infinity);
      S.track.set(h.id, tr);
    }
    if (h.state !== "confirmed" || heading == null) continue;
    const ahead = SS.hdiff(SS.bearing(lat, lon, h.lat, h.lon), heading) < 35 || d < 12;
    const dirOk = h.type !== "pothole" || h.heading == null || SS.hdiff(h.heading, heading) < 90;
    if (ahead && dirOk && d < Math.max(warnD, 250) && d < nextD) { next = h; nextD = d; }
  }
  const el = $("alert");
  // "Fits my car" looks a little further ahead, so the driver can ask about it before the alert
  const nextCar = next || S.known.filter((h) => h.state === "confirmed").map((h) => ({ h, d: SS.hav(lat, lon, h.lat, h.lon) }))
    .filter(({ h, d }) => d < 1000 && (heading == null || SS.hdiff(SS.bearing(lat, lon, h.lat, h.lon), heading) < 35)).sort((a, b) => a.d - b.d)[0]?.h;
  S.carCheck = nextCar ? SadakCar.check(S.car, S.people, nextCar) : null;
  renderCar(next ? S.carCheck : null);
  // Flood agent: water ahead that this car should not (or only just) cross.
  const wAhead = S.known.find((h) => h.family === "water" && h.state === "confirmed" && SS.hav(lat, lon, h.lat, h.lon) < 900 && (heading == null || SS.hdiff(SS.bearing(lat, lon, h.lat, h.lon), heading) < 40));
  if (wAhead) floodAgent(wAhead);
  if (next && nextD < warnD + 150) {
    const dist = Math.max(10, Math.round(nextD / 10) * 10);
    const [t, s] = PHRASE[next.type][S.lang](dist);
    const v = SadakCar.check(S.car, S.people, next), cl = SadakCar.line(v, S.lang);
    el.className = "alert " + next.type; el.querySelector(".ic").textContent = SS.SYM[next.type];
    $("aT").textContent = t; $("aS").textContent = v.kind === "pothole" ? `${s} · felt by ${next.devices} cars` : `Felt by ${next.devices} cars`;
    $("aD").innerHTML = `${dist}<small>metres</small>`;
    const last = S.alerted.get(next.id) || 0;
    if (nextD <= warnD && Date.now() - last > 10 * 60e3) { S.alerted.set(next.id, Date.now()); chime(); setTimeout(() => say(`${t}. ${cl}`), 400); }
  } else {
    el.className = "alert clear"; el.querySelector(".ic").textContent = "✓";
    $("aT").textContent = { English: "Road ahead is clear", Hinglish: "Aage raasta saaf hai", Hindi: "आगे रास्ता साफ़ है" }[S.lang];
    $("aS").textContent = `No confirmed hazards in the next ${Math.round(warnD + 150)} m`; $("aD").textContent = "";
  }
  S.recent = S.recent.filter((r) => Date.now() - r.ts < 15000);
}

/* ---------- trace ---------- */
function drawTrace() {
  const c = $("tr"), g = c.getContext("2d"), W = c.width, H = c.height, tr = det.trace.slice(-300);
  g.clearRect(0, 0, W, H);
  const y = (v) => H / 2 - v * (H / 3.2);
  if (tr.length) { const thr = tr[tr.length - 1].thr; g.strokeStyle = "#2d3d57"; g.setLineDash([6, 6]); g.lineWidth = 2; [thr, -thr].forEach((t) => { g.beginPath(); g.moveTo(0, y(t)); g.lineTo(W, y(t)); g.stroke(); }); g.setLineDash([]); }
  g.strokeStyle = "#3fd0c9"; g.lineWidth = 3; g.beginPath();
  tr.forEach((p, i) => { const x = (i / 300) * W; i ? g.lineTo(x, y(p.v)) : g.moveTo(x, y(p.v)); }); g.stroke();
  requestAnimationFrame(drawTrace);
}

/* ---------- real sensors ---------- */
async function startReal() {
  if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
    try { if ((await DeviceMotionEvent.requestPermission()) !== "granted") throw 0; } catch { alert("Motion sensor access is needed to detect jolts."); }
  }
  window.addEventListener("devicemotion", (e) => {
    const a = e.accelerationIncludingGravity; if (!a || a.x == null) return;
    const r = e.rotationRate; const rot = r ? Math.hypot(r.alpha || 0, r.beta || 0, r.gamma || 0) : 0;
    det.push(performance.now(), a.x, a.y, a.z, S.pos?.speed || 0, rot);
    $("cImu").className = "chip ok";
  });
  if (!navigator.geolocation) return alert("This browser has no GPS access.");
  navigator.geolocation.watchPosition((p) => updatePos(p.coords.latitude, p.coords.longitude, p.coords.speed, Number.isFinite(p.coords.heading) ? p.coords.heading : null, p.coords.accuracy),
    () => { $("cGps").className = "chip bad"; }, { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 });
  try { await navigator.wakeLock?.request("screen"); } catch {}
}

/* ---------- demo drive: simulated GPS + synthetic accelerometer on a real road ---------- */
async function startDemo(routeId) {
  S.routeId = routeId;
  const routes = await SS.api("/api/routes"); const r = routes[routeId];
  let truth = []; try { truth = (await SS.api("/api/sim")).truth.filter((t) => t.route === routeId); } catch {}
  const cum = [0]; for (let i = 1; i < r.coords.length; i++) cum.push(cum[i - 1] + SS.hav(...r.coords[i - 1], ...r.coords[i]));
  const L_ = cum[cum.length - 1];
  const at = (s) => { s = Math.max(0, Math.min(L_, s)); let i = 1; while (i < cum.length - 1 && cum[i] < s) i++; const a = r.coords[i - 1], b = r.coords[i], f = (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1); return { lat: a[0] + (b[0] - a[0]) * f, lon: a[1] + (b[1] - a[1]) * f, heading: SS.bearing(a[0], a[1], b[0], b[1]) }; };
  routeLine = L.polyline(r.coords, { color: "#3fd0c9", weight: 5, opacity: 0.35 }).addTo(map);

  const firstS = truth.length ? Math.min(...truth.map((t) => t.s)) : 0;
  let s = Math.max(0, firstS - 300), v = 32 / 3.6, crawlT = 0, crawled = false;
  const pulses = []; const crossed = new Set();
  $("mRoad").textContent = r.name.split("→")[0].trim();
  $("cImu").className = "chip ok"; $("cImu").textContent = "SENSORS (DEMO)";
  // 60 Hz synthetic accelerometer feeding the real detector
  setInterval(() => {
    const t = performance.now();
    let a = (Math.random() - 0.5) * 0.06 + 0.02 * Math.sin(t / 180);
    for (const p of pulses) { const d = (t - p.t0) / 35; a += p.amp * Math.exp(-d * d) * Math.cos(d * 1.6); }
    det.push(t, 0.3, 0.2, G * (1 + a), S.pos?.speed || v, 3);
  }, 1000 / 60);
  // 10 Hz motion along the road
  setInterval(() => {
    const dt = 0.1;
    let target = 32 / 3.6;
    const al = $("alert").className, cv = S.carCheck;
    if (al.includes("breaker")) target = (cv?.kind === "breaker" ? cv.speed : 18) / 3.6; else if (al.includes("pothole")) target = 22 / 3.6; else if (al.includes("water")) target = 9 / 3.6;
    const water = truth.find((t) => t.type === "water" && t.active);
    if (water && Math.abs(s - water.s) < 70) target = 5 / 3.6;
    v += (target - v) * 0.12;
    // Rerouted by the flood agent: the demo driver turns back before the water.
    if (water && s > water.s - 90 && S.reroute === true) {
      s = Math.max(0, firstS - 300); crossed.clear(); S.alerted.clear();
      $("tNote").textContent = { English: "turned back before the water · rerouting", Hinglish: "paani se pehle wapas mude · doosra raasta", Hindi: "पानी से पहले वापस मुड़े · दूसरा रास्ता" }[S.lang];
    }
    const s0 = s; s = Math.min(L_, s + v * dt * 1.6);
    for (const t of truth) {
      if (!t.active || t.type === "water" || crossed.has(t.id) || !((t.s - s0) * (t.s - s) <= 0)) continue;
      crossed.add(t.id);
      const now = performance.now(), gap = (2.6 / v) * 1000, k = (v * 3.6) / 30;
      if (t.type === "breaker") pulses.push({ t0: now, amp: 0.8 * k + 0.2 }, { t0: now + gap, amp: 0.7 * k + 0.17 });
      else pulses.push({ t0: now, amp: -(1.0 * k + 0.25) }, { t0: now + gap, amp: -0.15 });
    }
    while (pulses.length && performance.now() - pulses[0].t0 > 3000) pulses.shift();
    if (v < 10 / 3.6) crawlT += dt; else crawlT = 0;
    const p = at(s);
    if (!crawled && crawlT > 20 / 1.6 && (S.rain || water)) { crawled = true; S.queue.push({ device: S.device, lat: p.lat, lon: p.lon, heading: Math.round(p.heading), speed: +(v * 3.6).toFixed(1), type: "crawl", rain: true, ts: Date.now() }); $("tNote").textContent = "crawling in rain · waterlogging report sent"; }
    updatePos(p.lat + (Math.random() - 0.5) * 2e-5, p.lon + (Math.random() - 0.5) * 2e-5, v, p.heading, 4);
    if (s >= L_) { s = Math.max(0, firstS - 300); crossed.clear(); S.alerted.clear(); }
  }, 100);
}

/* ---------- wiring ---------- */
(async () => {
  const routes = await SS.api("/api/routes");
  for (const [id, r] of Object.entries(routes)) { const o = document.createElement("option"); o.value = id; o.textContent = r.name; $("route").append(o); }
  try { S.queue = JSON.parse(localStorage.getItem("ss-queue") || "[]"); } catch {}
})();
/* ---------- Fits my car: car-specific verdicts, road wear, service and claim log ---------- */
function seedHits() {
  // Demo sample: a plausible earlier week of hits for this car (clearly labelled in the panel).
  const roads = ["Aurobindo Marg", "Outer Ring Road", "Mehrauli-Badarpur Rd", "Press Enclave Marg", "Ring Road underpass"], out = [];
  for (let i = 0; i < 34; i++) out.push({ ts: Date.now() - (6.5 - i * 0.19) * 864e5, type: i % 3 ? "breaker" : "pothole", peakG: +(0.55 + ((i * 37) % 9) / 10).toFixed(2), road: roads[i % roads.length], speed: 18 + ((i * 7) % 17), sample: true });
  return out;
}
function renderCar(v) {
  const car = SadakCar.CARS[S.car], w = SadakCar.wear(S.hits);
  $("carName").textContent = `${car.name} · ${S.people}`;
  $("carWear").textContent = `wear ${w.pct}%`;
  const bar = $("carBar");
  if (v) { bar.className = "car " + v.level; $("carLine").textContent = SadakCar.line(v, S.lang); }
  else { bar.className = "car"; $("carLine").textContent = { English: `Clearance ${SadakCar.effectiveClearanceMm(car, S.people)} mm with ${S.people} on board · tap for road wear`, Hinglish: `${S.people} logon ke saath clearance ${SadakCar.effectiveClearanceMm(car, S.people)} mm · road wear dekhein`, Hindi: `${S.people} लोगों के साथ क्लीयरेंस ${SadakCar.effectiveClearanceMm(car, S.people)} मिमी · रोड वियर देखें` }[S.lang]; }
  if (!$("health").hidden) renderHealth();
}
function renderHealth() {
  const car = SadakCar.CARS[S.car], w = SadakCar.wear(S.hits);
  $("hTitle").textContent = `My ${car.name}`;
  $("hSpec").textContent = `Ground clearance about ${car.clearanceMm} mm unladen${car.assumed ? " (assumed)" : ""}, lower with ${S.people} on board. In the car this comes from the VIN and seat sensors; hits come from the car's own motion and tyre-pressure sensors.`;
  $("hPct").textContent = `${w.pct}%`; $("hBar").style.width = w.pct + "%";
  $("hMsg").textContent = w.due ? `${w.hits} hard hits this week. A suspension and alignment check is due before tyre wear shows.` : `${w.hits} hard hits this week. No check needed yet.`;
  $("hLog").innerHTML = "";
  S.hits.slice(-6).reverse().forEach((h) => { const d = document.createElement("div"); d.textContent = `${new Date(h.ts).toLocaleString("en-IN", { weekday: "short", hour: "2-digit", minute: "2-digit" })} · ${h.type} · ${h.peakG} g at ${h.speed} km/h · ${h.road}${h.sample ? " · sample" : ""}`; $("hLog").append(d); });
  const more = document.createElement("div"); more.textContent = `${S.hits.length} entries in total, with time, place, speed and jolt size`; $("hLog").append(more);
}
$("carBar").onclick = () => { $("health").hidden = !$("health").hidden; if (!$("health").hidden) renderHealth(); };
$("hClose").onclick = () => { $("health").hidden = true; };
$("hBook").onclick = () => { $("hBook").innerHTML = "<b>Request sent to Hyundai service (demo)</b><br><span class=\"note\">The centre gets this car's hit log, so the technician knows where to look</span>"; };

/* ---------- agents: act on what only the car knows, after one "haan" from the driver ---------- */
const T3 = (en, hl, hi) => ({ English: en, Hinglish: hl, Hindi: hi }[S.lang]);
function propose(id, text, onYes, onNo) {
  if (S.agentDone.has(id)) return true;
  if (S.pendingAgent || S.pendingJolt) return false;
  S.agentDone.add(id); S.pendingAgent = { id, onYes, onNo };
  openConvo(); $("yn").hidden = false; bubble("a", "Sadak Sense · agent", text); chime();
  setTimeout(() => { say(text); if (SR) setTimeout(listen, 5200); }, 300);
  clearTimeout(S.agentTimer); S.agentTimer = setTimeout(() => S.pendingAgent?.id === id && resolveAgent(null), 16000);
  return true;
}
function resolveAgent(ok) {
  const a = S.pendingAgent; if (!a) return; S.pendingAgent = null; $("yn").hidden = true; clearTimeout(S.agentTimer);
  if (ok === true) a.onYes(); else if (ok === false) a.onNo?.();
  else agentSay(T3("No answer, so I haven't done anything.", "Jawab nahi mila, isliye maine kuch nahi kiya.", "जवाब नहीं मिला, इसलिए मैंने कुछ नहीं किया।"));
}
function agentSay(text) { bubble("a", "Sadak Sense · agent", text); say(text); }
// Keep home updated: when a road hazard changes the trip, the car tells the family by itself
// through the paired phone (simulated in the demo). Turned on once in setup, not per message.
function tellHome(msg) {
  if (!S.homeOn) return false;
  bubble("a", T3("Message to Home · demo", "Ghar ko message · demo", "घर को संदेश · डेमो"), `“${msg}”`);
  return true;
}
// Flood agent: a waterlogged stretch ahead, confirmed by cars crawling or stalling in rain.
function floodAgent(h) {
  const n = h.devices || 3;
  const text = T3(`The underpass ahead is waterlogged: ${n} cars crawled or got stuck there in the last 30 minutes. Shall I take the other road?`,
    `Aage underpass mein paani bhara hai: pichhle 30 minute mein ${n} gaadiyan wahan atkin. Doosre raaste se le chalun?`,
    `आगे अंडरपास में पानी भरा है: पिछले 30 मिनट में ${n} गाड़ियाँ वहाँ अटकीं। दूसरे रास्ते से ले चलूँ?`);
  propose("flood-" + h.id, text,
    () => { S.reroute = true;
            const told = tellHome(T3("The underpass is flooded, coming by another road. About 10 minutes late.", "Underpass mein paani bhara hai, doosre raaste se aa rahe hain. Lagbhag 10 minute late.", "अंडरपास में पानी भरा है, दूसरे रास्ते से आ रहे हैं। लगभग 10 मिनट देर।"));
            agentSay(T3(`Rerouting around the underpass.${told ? " I've told home you'll be about 10 minutes late." : ""}`, `Underpass ke bagal se le ja raha hoon.${told ? " Ghar pe bata diya ki 10 minute late honge." : ""}`, `अंडरपास से हटकर ले जा रहा हूँ।${told ? " घर पर बता दिया कि 10 मिनट देर होगी।" : ""}`)); },
    () => { S.reroute = false; agentSay(T3("Okay. Walking pace through the water, and don't stop.", "Theek hai. Paani mein dheere chaliye, aur rukiye mat.", "ठीक है। पानी में धीरे चलें, और रुकें नहीं।")); });
}
// Damage agent: a hard pothole hit followed by falling tyre pressure (TPMS, simulated in the demo).
function tyreAgent(e) {
  if (S.agentDone.has("tyre")) return;
  if (S.pendingAgent || S.pendingJolt) return setTimeout(() => tyreAgent(e), 3000);
  const text = T3(`That was a hard pothole hit, and the front-left tyre pressure is dropping, 33 to 28 psi. Shall I book this evening at the nearest Hyundai service centre and prepare an insurance claim draft?`,
    `Bade gaddhe ke baad front-left tyre ka pressure gir raha hai, 33 se 28 psi. Nearest Hyundai service pe aaj shaam ka slot book karun, aur insurance claim ka draft bana doon?`,
    `बड़े गड्ढे के बाद आगे-बाएँ टायर का प्रेशर गिर रहा है, 33 से 28 psi। नज़दीकी Hyundai सर्विस पर आज शाम का स्लॉट बुक करूँ, और इंश्योरेंस क्लेम का ड्राफ़्ट बना दूँ?`);
  propose("tyre", text,
    () => { S.booked = true; renderCar();
            tellHome(T3("A tyre took a hard hit, so driving slowly and may be a little late. The car is booked at Hyundai service this evening.", "Ek gaddhe se tyre mein dikkat lag rahi hai, isliye dheere aa rahe hain, thodi der ho sakti hai. Shaam ko Hyundai service pe dikha denge.", "एक गड्ढे से टायर में दिक़्क़त लग रही है, इसलिए धीरे आ रहे हैं, थोड़ी देर हो सकती है। शाम को Hyundai सर्विस पर दिखा देंगे।"));
            agentSay(T3(`Booked for 6:30 pm at the nearest Hyundai service centre (demo). The claim draft has the time, place, your speed, the ${e.peakG} g jolt and the tyre pressure log. Check it before you send it.`,
              `Shaam 6:30 ka slot book ho gaya, nearest Hyundai service pe (demo). Claim draft mein time, jagah, speed, ${e.peakG} g ka jhatka aur tyre pressure log hai. Bhejne se pehle dekh lijiye.`,
              `शाम 6:30 का स्लॉट बुक हो गया, नज़दीकी Hyundai सर्विस पर (डेमो)। क्लेम ड्राफ़्ट में समय, जगह, गति, ${e.peakG} g का झटका और टायर प्रेशर लॉग है। भेजने से पहले देख लें।`)); },
    () => agentSay(T3("Okay. Stay under 60 and check the tyre at the next stop.", "Theek hai. 60 se neeche chaliye aur agle stop pe tyre check kar lijiye.", "ठीक है। 60 से नीचे चलें और अगले स्टॉप पर टायर जाँच लें।")));
}

/* ---------- voice picker: Indian voices for the chosen language, best first ---------- */
const SAMPLE = { English: "Speed breaker in 110 metres. Slow to 20.", Hinglish: "110 metre mein speed breaker hai. 20 ki speed rakhiye.", Hindi: "110 मीटर पर स्पीड ब्रेकर है। गति 20 रखें।" };
async function fillVoices() {
  const all = await SadakSpeech.voices(), lang = $("lang").value, list = SadakSpeech.rank(all, lang), sel = $("voiceSel"), keep = SadakSpeech.chosen();
  sel.innerHTML = "";
  list.forEach((v, i) => { const o = document.createElement("option"); o.value = v.name; o.textContent = (i ? "" : "Best: ") + v.name.replace(/^Microsoft /, "").replace(/ (Online )?\(Natural\)/, "").replace(/ - .*$/, ""); sel.append(o); });
  if (!list.length) { const o = document.createElement("option"); o.value = ""; o.textContent = "No Indian voice in this browser"; sel.append(o); }
  if (list.some((v) => v.name === keep)) sel.value = keep;
  $("voiceHint").textContent = SadakSpeech.isNatural(list[0]) ? "Natural Indian voice found" : "For the most natural voice, open this in Microsoft Edge or Chrome";
}
$("lang").addEventListener("change", fillVoices);
$("voiceSel").onchange = () => SadakSpeech.choose($("voiceSel").value);
$("voiceTest").onclick = () => { SadakSpeech.choose($("voiceSel").value); SadakSpeech.speak(SAMPLE[$("lang").value], $("lang").value); };
fillVoices();
if (typeof speechSynthesis !== "undefined") speechSynthesis.addEventListener?.("voiceschanged", fillVoices);

async function go(mode) {
  S.mode = mode; S.lang = $("lang").value; S.rain = $("rain").checked; S.device = await dailyId();
  S.car = $("carSel").value; S.people = +$("people").value; S.homeOn = $("homeOn").checked; S.hits = seedHits(); renderCar();
  // Browser-only edition: this page runs its own virtual fleet, so rain floods its underpass too.
  if (S.rain && window.SSMods) SS.api("/api/sim", { monsoon: true }).catch(() => {});
  $("start").hidden = true; chime();
  if (mode === "real") await startReal(); else await startDemo($("route").value);
  setInterval(tick, 400); setInterval(flush, 3000); drawTrace();
}
$("realBtn").onclick = () => go("real");
$("demoBtn").onclick = () => go("demo");
$("voiceBtn").onclick = () => { S.voice = !S.voice; $("voiceBtn").textContent = "Voice: " + (S.voice ? "on" : "off"); };
$("stopBtn").onclick = () => location.reload();
$("briefBtn").onclick = async () => {
  const b = $("brief");
  if (b.classList.contains("show")) return b.classList.remove("show");
  $("briefT").textContent = "Preparing…"; b.classList.add("show");
  const coords = routeLine ? routeLine.getLatLngs().map((p) => [p.lat, p.lng]) : null;
  const res = await SS.api("/api/brief", coords ? { coords, lang: S.lang } : { routeId: $("route").value, lang: S.lang });
  $("briefT").textContent = res.text; say(res.text);
  setTimeout(() => b.classList.remove("show"), 12000);
};


/* ---------- two-way voice: Hinglish / Hindi / English ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, listening = false;
const CHIPS = { Hinglish: ["Aage koi gaddha hai?", "Meri gaadi nikal jayegi?", "Underpass mein paani hai kya?", "Yahan bada gaddha hai", "Aaj ka road brief do"], Hindi: ["आगे कोई गड्ढा है?", "मेरी गाड़ी निकल जाएगी?", "अंडरपास में पानी है क्या?", "यहाँ बड़ा गड्ढा है", "आज का रोड ब्रीफ़ दो"], English: ["Any pothole ahead?", "Will my car make it?", "Is the underpass flooded?", "Pothole here", "Give me today's road brief"] };
function bubble(cls, who, text) { const d = document.createElement("div"); d.className = cls; d.innerHTML = `<span class="who">${who}</span>`; d.append(document.createTextNode(text)); $("msgs").append(d); $("msgs").scrollTop = 1e6; while ($("msgs").children.length > 8) $("msgs").firstChild.remove(); }
function openConvo() { $("convo").hidden = false; $("chips").innerHTML = ""; for (const c of CHIPS[S.lang]) { const b = document.createElement("button"); b.className = "btn"; b.type = "button"; b.textContent = c; b.onclick = () => ask(c); $("chips").append(b); } }
async function ask(text) {
  openConvo(); bubble("u", S.lang === "English" ? "You" : "Aap", text);
  const itn = SadakVoice.intent(text).name;
  if (S.pendingAgent && (itn === "yes" || itn === "no")) return resolveAgent(itn === "yes");
  if (itn === "ask_car") {
    // Answered in the car from its own specification and load: no server, works offline.
    let lang = SadakVoice.detectLang(text); if (S.lang === "Hinglish" && lang === "Hindi") lang = "Hinglish";
    const r = SadakVoice.reply(text, { prefer: S.lang, carCheck: S.carCheck ? SadakCar.line(S.carCheck, lang) : null });
    bubble("a", "Sadak Sense", r.reply); const keep = S.lang; S.lang = r.lang; say(r.reply); S.lang = keep; return;
  }
  const p = S.pos || {};
  try {
    const r = await SS.api("/api/ask", { text, lat: p.lat, lon: p.lon, heading: p.heading, device: S.device, routeId: S.routeId, pending: S.pendingJolt ? { type: S.pendingJolt.type } : null, prefer: S.lang });
    bubble("a", "Sadak Sense", r.reply);
    const keep = S.lang; S.lang = r.lang; say(r.reply); S.lang = keep;
    if (r.action && "confirm" in r.action && S.pendingJolt) resolveJolt(r.action.confirm);
    if (r.action?.report) { S.sent++; $("cNet").textContent = `${S.sent} SENT`; fetchKnown(); }
  } catch { bubble("a", "Sadak Sense", "Network nahi mil raha. Report phone mein save hai, baad mein bhej dunga."); }
}
function askConfirm(ev) {
  S.pendingJolt = ev; openConvo(); $("yn").hidden = false;
  const q = SadakVoice.askAfterJolt(ev.type, S.lang);
  bubble("a", "Sadak Sense", q); chime(); setTimeout(() => { say(q); if (SR) setTimeout(listen, 2600); }, 300);
  clearTimeout(S.pendTimer); S.pendTimer = setTimeout(() => S.pendingJolt === ev && resolveJolt(true, true), 9000);
}
function resolveJolt(ok, timeout) {
  const ev = S.pendingJolt; if (!ev) return; S.pendingJolt = null; $("yn").hidden = true; clearTimeout(S.pendTimer);
  if (ok) { ev.confirmed = !timeout; S.queue.push(ev); } else { S.jolts = Math.max(0, S.jolts - 1); $("mJolts").textContent = S.jolts; $("tNote").textContent = "driver said no · jolt not reported"; }
  if (timeout) bubble("a", "Sadak Sense", { English: "No answer, reporting it from the sensors.", Hinglish: "Jawab nahi mila, sensor ke hisaab se report kar diya.", Hindi: "जवाब नहीं मिला, सेंसर के आधार पर रिपोर्ट कर दिया।" }[S.lang]);
}
function listen() {
  if (!SR) { $("micState").textContent = "type or tap a phrase"; return; }
  if (listening) { rec?.stop(); return; }
  rec = new SR(); rec.lang = S.lang === "English" ? "en-IN" : "hi-IN"; rec.interimResults = false; rec.maxAlternatives = 1;
  rec.onstart = () => { listening = true; $("micBtn").classList.add("listening"); $("micState").textContent = "listening…"; };
  rec.onend = () => { listening = false; $("micBtn").classList.remove("listening"); $("micState").textContent = ""; };
  rec.onerror = () => { $("micState").textContent = "mic unavailable · type instead"; };
  rec.onresult = (e) => { const t = e.results[0][0].transcript; if (t) ask(t); };
  try { rec.start(); } catch {}
}
$("micBtn").onclick = () => { openConvo(); listen(); };
$("ynYes").onclick = () => ask({ English: "Yes", Hinglish: "Haan", Hindi: "हाँ" }[S.lang]);
$("ynNo").onclick = () => ask({ English: "No", Hinglish: "Na", Hindi: "ना" }[S.lang]);
$("sayForm").onsubmit = (e) => { e.preventDefault(); const v = $("sayIn").value.trim(); if (v) { ask(v); $("sayIn").value = ""; } };
