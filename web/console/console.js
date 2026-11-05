const $ = (id) => document.getElementById(id);
const map = L.map("map", { zoomControl: true, preferCanvas: true }).setView([28.585, 77.205], 13);
SS.tiles(map);

const markers = new Map();
const carLayer = L.layerGroup().addTo(map), truthLayer = L.layerGroup(), routeLayer = L.layerGroup().addTo(map);
let selected = null, routes = {}, sim = null, showTruth = false;

function toast(t) { const el = $("toast"); el.textContent = t; el.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("show"), 2600); }

function upsert(h) {
  let m = markers.get(h.id);
  if (["cleared", "rejected"].includes(h.state)) {
    if (m) {
      m.setIcon(L.divIcon({ className: "", iconSize: [22, 22], iconAnchor: [11, 11], html: `<div class="hz" style="background:transparent;border:2px dashed var(--ok);width:22px;height:22px;position:relative"><span class="hzlabel" style="color:var(--ok)">${h.state === "cleared" ? "repaired · removed" : "false alarm · dropped"}</span></div>` }));
      setTimeout(() => { map.removeLayer(m); markers.delete(h.id); }, 12000);
    }
    return;
  }
  if (!m) { m = L.marker([h.lat, h.lon], { icon: SS.hazardIcon(h), keyboard: true, title: SS.LABEL[h.type] }).addTo(map); m.on("click", () => select(h.id)); markers.set(h.id, m); }
  else { m.setLatLng([h.lat, h.lon]); m.setIcon(SS.hazardIcon(h)); }
  m.h = h;
}

async function select(id) {
  selected = id;
  const { hazard: h, timeline } = await SS.api(`/api/hazards/${id}`);
  const pill = h.state === "confirmed" ? `<span class="pill ok">confirmed</span>` : h.state === "candidate" ? `<span class="pill cand">candidate · ${h.devices}/3 cars</span>` : `<span class="pill gone">${h.state}</span>`;
  const sev = h.severity == null ? null : Math.min(1, h.severity / 1.4);
  $("detail").innerHTML = `
    <div class="label">Hazard #${h.id}</div>
    <div class="row" style="justify-content:space-between;margin-top:6px"><div class="big">${SS.LABEL[h.type]}</div>${pill}</div>
    <div style="color:var(--muted);font-size:12.5px;margin-top:4px">${h.family === "water" ? "Reported by" : "Felt by"} <b style="color:var(--fg)">${h.devices}</b> different cars · ${h.events} reports · first seen ${SS.ago(h.createdTs)}${h.confirmedTs ? ` · confirmed ${SS.ago(h.confirmedTs)}` : ""}</div>
    ${sev == null ? "" : `<div style="margin-top:10px;font-size:12px;color:var(--muted)">Severity (speed-normalised jolt): <b style="color:var(--fg)">${h.severity} g</b><div class="bar"><i style="width:${Math.round(sev * 100)}%"></i></div></div>`}
    ${h.family === "water" ? `<div style="margin-top:10px;font-size:12px;color:var(--muted)">Confirmed from cars crawling below 10 km/h in rain. Recedes after 2 h without reports.</div>` :
      `<div style="margin-top:10px;font-size:12px;color:var(--muted)">Recent passes (red = jolt felt, grey = clean). ${h.cleanStreak}/8 clean in a row before removal.</div><div class="passes">${timeline.slice(0, 32).reverse().map((p) => `<i class="${p.hit ? "h" : ""}" title="${new Date(p.ts).toLocaleTimeString()}"></i>`).join("")}</div>`}
    <div style="margin-top:8px;font-family:var(--mono);font-size:10.5px;color:var(--dim)">${h.lat.toFixed(5)}, ${h.lon.toFixed(5)}${h.heading != null ? ` · heading ${h.heading}°` : ""}</div>`;
}

function feed(kind, h) {
  const col = { breaker: "var(--breaker)", pothole: "var(--pothole)", water: "var(--water)" }[h.type];
  const text = { created: `New candidate: ${SS.LABEL[h.type].toLowerCase()}`, confirmed: `Confirmed by ${h.devices} cars: ${SS.LABEL[h.type].toLowerCase()}`, cleared: `${SS.LABEL[h.type]} removed: cars stopped feeling it`, rejected: `Dropped a one-off false alarm`, swept: `${SS.LABEL[h.type]} expired` }[kind];
  if (!text) return;
  const d = document.createElement("div");
  d.innerHTML = `<i class="dot" style="background:${col}"></i><span></span><time>${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>`;
  d.querySelector("span").textContent = text;
  d.onclick = () => { map.flyTo([h.lat, h.lon], 17, { duration: 0.8 }); select(h.id); };
  d.style.cursor = "pointer";
  $("feed").prepend(d); while ($("feed").children.length > 40) $("feed").lastChild.remove();
  if (kind === "confirmed") toast(`Confirmed: ${SS.LABEL[h.type].toLowerCase()} · ${h.devices} cars agree`);
  if (kind === "cleared") toast(`${SS.LABEL[h.type]} repaired and removed automatically`);
}

function flash(lat, lon, type) {
  const col = { breaker: "var(--breaker)", pothole: "var(--pothole)", crawl: "var(--water)" }[type] || "var(--breaker)";
  const m = L.marker([lat, lon], { interactive: false, icon: L.divIcon({ className: "", iconSize: [14, 14], iconAnchor: [7, 7], html: `<div class="flash" style="border-color:${col}"></div>` }) }).addTo(map);
  setTimeout(() => map.removeLayer(m), 1500);
}

function stats(s) {
  $("kConf").textContent = s.confirmed; $("kCand").textContent = s.candidates; $("kClear").textContent = s.cleared;
  $("kEv").textContent = s.eventsLastHour; $("kDev").textContent = s.devicesLastHour; $("kRej").textContent = s.rejected;
}

function drawSim(s) {
  sim = s;
  carLayer.clearLayers();
  for (const [la, lo] of s.cars || []) L.circleMarker([la, lo], { radius: 4, color: "#3fd0c9", weight: 0, fillOpacity: 0.9 }).addTo(carLayer);
  $("simBtn").textContent = s.running ? "Stop fleet" : "Start fleet"; $("simBtn").classList.toggle("primary", !s.running);
  $("monsoonBtn").textContent = "Monsoon: " + (s.monsoon ? "on" : "off"); $("monsoonBtn").classList.toggle("on", s.monsoon);
}

function drawTruth() {
  truthLayer.clearLayers();
  if (!sim?.truth) return;
  for (const t of sim.truth) if (t.active) L.circle([t.lat, t.lon], { radius: 18, color: "#fff", weight: 1.5, dashArray: "4 4", fill: false }).bindTooltip(t.label).addTo(truthLayer);
}

async function boot() {
  routes = await SS.api("/api/routes");
  for (const [id, r] of Object.entries(routes)) {
    L.polyline(r.coords, { color: "#3fd0c9", weight: 3, opacity: 0.18 }).addTo(routeLayer);
    const o = document.createElement("option"); o.value = id; o.textContent = r.name; $("route").append(o);
  }
  map.fitBounds(L.latLngBounds(Object.values(routes).flatMap((r) => r.coords)), { padding: [30, 30] });
  const { hazards } = await SS.api("/api/hazards?states=candidate,confirmed"); hazards.forEach(upsert);
  stats(await SS.api("/api/stats"));
  try { drawSim(await SS.api("/api/sim")); } catch { $("simCard").hidden = true; }

  const es = new EventSource("/api/stream");
  es.addEventListener("hazard", (m) => { const c = JSON.parse(m.data); upsert(c.hazard); if (c.event) flash(c.event.lat, c.event.lon, c.event.type); feed(c.kind, c.hazard); if (selected === c.hazard.id) select(c.hazard.id); });
  es.addEventListener("stats", (m) => stats(JSON.parse(m.data)));
  es.addEventListener("sim", (m) => drawSim({ ...sim, ...JSON.parse(m.data) }));
  es.onerror = () => { $("live").style.color = "var(--pothole)"; };
  es.onopen = () => { $("live").style.color = ""; };
}

const simPost = async (body) => { const s = await SS.api("/api/sim", body); drawSim({ ...sim, ...s }); return s; };
$("simBtn").onclick = () => simPost({ action: sim?.running ? "stop" : "start", carsPerMin: +$("cars").value, speedup: +$("spd").value });
$("monsoonBtn").onclick = async () => { await simPost({ monsoon: !sim?.monsoon }); sim = await SS.api("/api/sim"); if (showTruth) drawTruth(); toast(sim.monsoon ? "Monsoon on: Minto Bridge underpass is flooding" : "Monsoon off"); };
$("repairBtn").onclick = async () => { const s = await simPost({ action: "repair" }); if (s.repaired) { toast(`Road crew fixed: ${s.repaired.label}. Watch it disappear as cars pass.`); map.flyTo([s.repaired.lat, s.repaired.lon], 16); } sim = await SS.api("/api/sim"); if (showTruth) drawTruth(); };
$("truthBtn").onclick = async () => { showTruth = !showTruth; $("truthBtn").classList.toggle("on", showTruth); if (showTruth) { sim = await SS.api("/api/sim"); drawTruth(); truthLayer.addTo(map); } else map.removeLayer(truthLayer); };
$("cars").oninput = (e) => { $("carsV").textContent = e.target.value; };
$("spd").oninput = (e) => { $("spdV").textContent = e.target.value; };
$("cars").onchange = () => simPost({ carsPerMin: +$("cars").value });
$("spd").onchange = () => simPost({ speedup: +$("spd").value });
$("briefBtn").onclick = async () => {
  $("brief").textContent = "Preparing brief…";
  const b = await SS.api("/api/brief", { routeId: $("route").value, lang: $("lang").value });
  $("brief").textContent = b.text;
  const r = routes[$("route").value]; map.flyToBounds(L.latLngBounds(r.coords), { padding: [40, 40], duration: 0.8 });
  try { const u = new SpeechSynthesisUtterance(b.text); u.lang = $("lang").value === "English" ? "en-IN" : "hi-IN"; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch {}
};
boot();
