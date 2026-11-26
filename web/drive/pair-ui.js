// Pairing in the app: the car screen (/car/) shows a code; the dashboard phone enters it. Then the phone
// senses and decides as usual, and streams what it shows (position, warning, cards) and says to the car
// screen, which displays it and speaks it through the car's speakers. The phone stays quiet while paired.
const Pair = (() => {
  const st = { code: null, role: null, es: null, timer: null, lastRoute: null };
  const send = (msg) => st.code && fetch(`/api/pair/${st.code}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg), keepalive: true }).catch(() => {});

  // Phone: forward speech and conversation lines to the car screen. Returns true when the car speaks instead.
  function forward(kind, data) {
    if (st.role !== "phone") return false;
    send({ type: kind, ...data });
    return kind === "say";
  }
  const txt = (id) => $(id)?.textContent || "";
  function snapshot() {
    const p = S.pos;
    return { type: "state", ts: Date.now(),
      pos: p ? { lat: p.lat, lon: p.lon, speed: p.speed, heading: p.heading } : null,
      alert: { cls: $("alert").className, ic: $("alert").querySelector(".ic").textContent, t: txt("aT"), s: txt("aS"), d: parseInt(txt("aD"), 10) || null },
      car: { cls: $("carBar").className, cn: txt("carName"), cl: txt("carLine"), cw: txt("carWear") },
      co: { hidden: $("coBar").hidden, t: txt("coT"), s: txt("coS"), i: txt("coInbox") },
      env: { hidden: $("envBar").hidden, cls: $("envBar").className, txt: txt("envTxt"), act: txt("envAct") },
      moment: txt("cMoment"), road: txt("mRoad"), known: txt("mKnown"), jolts: txt("mJolts"), note: txt("tNote") };
  }
  function startStreaming() {
    clearInterval(st.timer);
    st.timer = setInterval(() => {
      if (!S.mode) return;
      send(snapshot());
      const coords = routeLine ? routeLine.getLatLngs().map((x) => [+x.lat.toFixed(6), +x.lng.toFixed(6)]) : null, key = coords ? coords.length + ":" + coords[0] : null;
      if (key && key !== st.lastRoute) { st.lastRoute = key; send({ type: "route", coords: coords.filter((_, i) => i % Math.ceil(coords.length / 600) === 0) }); }
    }, 1000);
  }

  /* ---------- phone side: enter the car screen's code ---------- */
  $("pairBtn").onclick = async () => {
    const code = $("pairCode").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length < 6) { $("pairState").textContent = "Type the 6-character code shown on the car screen."; return; }
    const r = await fetch(`/api/pair/${code}`).then((x) => x.json()).catch(() => ({}));
    if (!r.ok) { $("pairState").textContent = "That code isn't active. Check the car screen."; return; }
    st.code = code; st.role = "phone"; send({ type: "hello", car: S.car });
    $("pairState").textContent = "Connected to the car screen. Start driving: the car screen shows and speaks everything.";
    startStreaming();
  };

  /* ---------- car screen side: show a code, then mirror the phone ---------- */
  let wire = null, vroute = null;
  $("pairShow").onclick = async () => {
    const r = await fetch("/api/pair/new", { method: "POST" }).then((x) => x.json()).catch(() => null);
    if (!r?.code) { $("pairShowState").textContent = "Couldn't create a code. Check the connection."; return; }
    st.code = r.code; st.role = "screen";
    $("pairBig").textContent = r.code.replace(/(...)(...)/, "$1 $2"); $("pairSheet").hidden = false;
    st.es?.close(); st.es = new EventSource(`/api/pair/${r.code}/stream`);
    st.es.onmessage = (m) => { let d; try { d = JSON.parse(m.data); } catch { return; } apply(d); };
  };
  $("pairCancel").onclick = () => { $("pairSheet").hidden = true; st.es?.close(); st.code = null; st.role = null; };

  function enterMirror() {
    if (S.mode === "mirror") return;
    S.mode = "mirror"; $("pairSheet").hidden = true; $("start").hidden = true; $("onboard").hidden = true;
    $("cImu").textContent = "PHONE SENSORS"; $("cImu").className = "chip ok"; $("cNet").textContent = "PHONE LINKED"; $("cNet").className = "chip ok";
    $("simBtn").hidden = true; $("briefBtn").hidden = true; drawTrace();
  }
  function setText(id, v) { const el = $(id); if (el && v != null) el.textContent = v; }
  function apply(d) {
    if (d.type === "hello") { enterMirror(); if (d.car) { S.car = d.car; } return; }
    if (d.type === "state") {
      enterMirror();
      if (d.pos) updatePos(d.pos.lat, d.pos.lon, d.pos.speed, d.pos.heading, null);
      const a = d.alert || {}; $("alert").className = (a.cls || "alert clear").replace(/[^a-z \-]/gi, ""); $("alert").querySelector(".ic").textContent = a.ic || ""; setText("aT", a.t); setText("aS", a.s);
      if (Number.isFinite(a.d)) { $("aD").innerHTML = ""; $("aD").append(String(Math.round(a.d))); const sm = document.createElement("small"); sm.textContent = "metres"; $("aD").append(sm); } else $("aD").textContent = "";
      const c = d.car || {}; $("carBar").className = (c.cls || "car").replace(/[^a-z \-]/gi, ""); setText("carName", c.cn); setText("carLine", c.cl); setText("carWear", c.cw);
      const co = d.co || {}; $("coBar").hidden = !!co.hidden; setText("coT", co.t); setText("coS", co.s); setText("coInbox", co.i);
      const e = d.env || {}; $("envBar").hidden = !!e.hidden; $("envBar").className = (e.cls || "env").replace(/[^a-z \-]/gi, ""); setText("envTxt", e.txt); setText("envAct", e.act);
      setText("cMoment", d.moment); setText("mRoad", d.road); setText("mKnown", d.known); setText("mJolts", d.jolts); setText("tNote", d.note);
      glow((a.cls || "").split(" ").find((x) => ["breaker", "pothole", "water"].includes(x)) || null);
      return;
    }
    if (d.type === "route" && Array.isArray(d.coords) && d.coords.length > 1) {
      if (vroute) map.removeLayer(vroute);
      vroute = L.polyline(d.coords, { color: "#3fd0c9", weight: 6, opacity: 0.6 }).addTo(map); map.fitBounds(vroute.getBounds(), { padding: [30, 30], maxZoom: 16 });
      return;
    }
    if (d.type === "say" && typeof d.text === "string") {
      // The car screen speaks with ITS alert style (Voice / Chime + card / Silent).
      const keepL = S.lang, keepV = S.replyVoice;
      if (["English", "Hinglish", "Hindi"].includes(d.written)) S.lang = d.written;
      if (["Tamil", "Telugu", "Malayalam", "Kannada", "Bengali"].includes(d.lang)) S.replyVoice = d.lang;
      say(d.text.slice(0, 1500), ["info", "serious", "reply", "test"].includes(d.kind) ? d.kind : "info");
      S.lang = keepL; S.replyVoice = keepV; return;
    }
    if (d.type === "bubble" && typeof d.text === "string") {
      openConvo();
      const el = document.createElement("div"); el.className = d.cls === "u" ? "u" : "a";
      const w = document.createElement("span"); w.className = "who"; w.textContent = String(d.who || "").slice(0, 60);
      el.append(w, document.createTextNode(d.text.slice(0, 2000))); $("msgs").append(el); $("msgs").scrollTop = 1e6;
      while ($("msgs").children.length > 8) $("msgs").firstChild.remove();
    }
  }
  return { forward, get role() { return st.role; }, get code() { return st.code; } };
})();
window.Pair = Pair;
