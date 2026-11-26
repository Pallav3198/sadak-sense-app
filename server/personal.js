// The personal side of Sadak Sense: the owner's sign-in, real maps, and the co-pilot over Gmail, Calendar and Teams.
// Only the owner (OWNER_EMAIL) can use these routes. Nothing is sent without an explicit confirmation from the driver.
const express = require("express");
const { seal, open, cookies, setCookie, randomState } = require("./secure");
const { leaveBy, lateMessage, nextTrip, etaLine, composeRules, hhmm } = require("./copilot");
const { buildGraph, contextFor, nextCall } = require("./knowledge");

function mountPersonal(app, { engine, accounts, maps, env = process.env, limit, llm = null }) {
  const graphs = new Map(); // owner -> latest knowledge graph (memory only; rebuilt from the accounts)
  const secret = env.SESSION_SECRET || "";
  const owner = (env.OWNER_EMAIL || "").trim().toLowerCase();
  const ready = secret.length >= 32 && !!owner;
  const secure = env.NODE_ENV === "production";
  const base = (req) => env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
  const ck = (req, name) => { const v = cookies(req)[name]; return v ? open(v, secret) : null; };
  const put = (res, name, obj, days) => setCookie(res, name, seal({ ...obj, exp: Date.now() + days * 864e5 }, secret), { maxAgeDays: days, secure });
  const isOwner = (req) => ready && ck(req, "ss_owner")?.email === owner;
  const needOwner = (req, res, next) => (isOwner(req) ? next() : res.status(401).json({ error: "sign in as the owner first" }));
  const fail = (res, e) => res.status(e.status === 401 || e.status === 400 ? 401 : e.status === 503 ? 503 : 502).json({ error: e.status === 401 || e.status === 400 ? "sign-in expired, connect the account again" : e.message });
  // Microsoft rotates refresh tokens; keep the phone's cookie current.
  const keepMs = (res, m, rotated) => { if (rotated) put(res, "ss_m", { ...m, r: rotated }, 90); };

  app.get("/api/me", (req, res) => {
    const m = ck(req, "ss_m");
    res.json({ owner: isOwner(req), google: isOwner(req) && !!ck(req, "ss_g"), microsoft: isOwner(req) && m ? { email: m.email } : false,
      configured: { owner: ready, google: accounts.google.on, microsoft: accounts.microsoft.on, maps: maps.on } });
  });

  /* ---------- sign-in: Google is also the owner check ---------- */
  const start = (provider) => (req, res) => {
    if (!ready || !accounts[provider].on) return res.status(503).send("This sign-in is not set up on the server yet.");
    if (provider === "microsoft" && !isOwner(req)) return res.redirect("/drive/?signin=owner-first");
    const state = randomState(); put(res, "ss_state", { state, provider }, 0.01);
    res.redirect(accounts[provider].authUrl(`${base(req)}/auth/${provider}/callback`, state));
  };
  app.get("/auth/google", start("google"));
  app.get("/auth/microsoft", start("microsoft"));

  app.get("/auth/:provider/callback", async (req, res) => {
    const provider = req.params.provider, st = ck(req, "ss_state");
    setCookie(res, "ss_state", "", { secure });
    if (!["google", "microsoft"].includes(provider) || !st || st.state !== req.query.state || st.provider !== provider) return res.redirect("/drive/?signin=failed");
    if (req.query.error || !req.query.code) return res.redirect(`/drive/?signin=${encodeURIComponent(String(req.query.error || "cancelled"))}`);
    try {
      const r = await accounts[provider].exchange(String(req.query.code), `${base(req)}/auth/${provider}/callback`);
      if (provider === "google") {
        if (String(r.email || "").toLowerCase() !== owner) return res.redirect("/drive/?signin=not-owner");
        put(res, "ss_owner", { email: owner }, 30);
        if (r.refresh) put(res, "ss_g", { r: r.refresh }, 30);
      } else {
        if (!isOwner(req)) return res.redirect("/drive/?signin=owner-first");
        put(res, "ss_m", { r: r.refresh, uid: r.userId, email: r.email }, 90);
      }
      res.redirect(`/drive/?signin=${provider}`);
    } catch (e) { res.redirect(`/drive/?signin=failed&why=${encodeURIComponent(e.message.slice(0, 120))}`); }
  });
  app.post("/auth/logout", (req, res) => { for (const n of ["ss_owner", "ss_g", "ss_m"]) setCookie(res, n, "", { secure }); res.json({ ok: true }); });
  app.post("/auth/microsoft/disconnect", needOwner, (req, res) => { setCookie(res, "ss_m", "", { secure }); res.json({ ok: true }); });

  /* ---------- real maps ---------- */
  app.get("/api/maps/search", needOwner, limit, async (req, res) => {
    const q = String(req.query.q || "").trim(); if (q.length < 2) return res.status(400).json({ error: "type a place" });
    const near = Number.isFinite(+req.query.lat) && req.query.lat !== undefined ? { lat: +req.query.lat, lon: +req.query.lon } : null;
    try { res.json({ results: await maps.search(q, near) }); } catch (e) { fail(res, e); }
  });
  const along = (coords) => engine.alongRoute(coords).map((h) => ({ id: h.id, type: h.type, lat: h.lat, lon: h.lon, devices: h.devices, severity: h.severity }));
  // smooth: elders or kids on board (14.9) → of the fastest and up to 2 alternatives, take the one with the
  // fewest/least severe hazards, unless it is more than 15% slower.
  const roughness = (hz) => hz.reduce((s, h) => s + (h.type === "pothole" ? 3 : h.type === "water" ? 10 : (h.severity ?? 1) >= 1.2 ? 2 : 1) * Math.max(0.5, Math.min(2, h.severity ?? 1)), 0);
  app.post("/api/maps/route", needOwner, limit, async (req, res) => {
    const { from, to, smooth } = req.body || {};
    if (![from?.lat, from?.lon, to?.lat, to?.lon].every(Number.isFinite)) return res.status(400).json({ error: "from and to required" });
    try {
      const all = (await maps.routes(from, to, { alternatives: smooth ? 2 : 0 })).map((r) => ({ ...r, hazards: along(r.coords) }));
      const fastest = all[0];
      let pick = fastest, why = null;
      if (smooth && all.length > 1) {
        const ok = all.filter((r) => r.durationS <= fastest.durationS * 1.15).sort((a, b) => roughness(a.hazards) - roughness(b.hazards));
        if (ok[0] && roughness(ok[0].hazards) < roughness(fastest.hazards)) {
          pick = ok[0]; why = `smoother route: ${fastest.hazards.length - pick.hazards.length >= 0 ? fastest.hazards.length - pick.hazards.length : 0} fewer hazards, ${Math.round((pick.durationS - fastest.durationS) / 60)} min longer`;
        } else why = "the fastest route is also the smoothest";
      }
      res.json({ ...pick, smoothWhy: why, alternatives: all.length });
    } catch (e) { fail(res, e); }
  });
  app.get("/api/maps/reverse", needOwner, limit, async (req, res) => {
    const lat = +req.query.lat, lon = +req.query.lon; if (![lat, lon].every(Number.isFinite)) return res.status(400).json({ error: "lat, lon required" });
    try { res.json(await maps.reverse(lat, lon)); } catch (e) { fail(res, e); }
  });

  // "Reached safely" (14.9): the owner switched it on for a parent; sent automatically on arrival.
  app.post("/api/copilot/arrived", needOwner, limit, async (req, res) => {
    const { to, name, dest } = req.body || {};
    if (!/^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/.test(String(to || ""))) return res.status(400).json({ error: "parent's email required" });
    const g = ck(req, "ss_g"); if (!g) return res.status(401).json({ error: "connect Gmail first" });
    const who = String(name || "I").slice(0, 40), where = String(dest || "the destination").slice(0, 80);
    try { const r = await accounts.google.send(g.r, { to, subject: `${who} reached ${where} safely`, body: `${who} reached ${where} safely at ${hhmm(Date.now())}.\n\n(Automatic message from the car, Sadak Sense.)` }); res.json({ sent: true, id: r.id }); }
    catch (e) { fail(res, e); }
  });

  /* ---------- co-pilot: calendar + traffic + hazards -> leave-by, late message ---------- */
  async function allEvents(req, res) {
    const out = [], errors = [];
    const g = ck(req, "ss_g"), m = ck(req, "ss_m");
    if (g) { try { out.push(...(await accounts.google.events(g.r))); } catch (e) { errors.push({ source: "google", error: e.message }); } }
    if (m) { try { const r = await accounts.microsoft.events(m.r); keepMs(res, m, r.rotated); out.push(...r.items); } catch (e) { errors.push({ source: "outlook", error: e.message }); } }
    return { events: out, errors };
  }
  app.post("/api/copilot/next", needOwner, limit, async (req, res) => {
    const { lat, lon, raining } = req.body || {};
    if (![lat, lon].every(Number.isFinite)) return res.status(400).json({ error: "position required" });
    const { events, errors } = await allEvents(req, res);
    const ev = nextTrip(events), call = nextCall(events);
    // Meeting rescue (14.6): an online call starting soon while driving → tell the organiser / join by audio when parked.
    const rescue = call ? { title: call.title, start: call.start, joinUrl: call.joinUrl, organizer: call.organizer, source: call.source,
      draft: call.organizer ? { to: [call.organizer], subject: `Joining by audio: ${call.title}`, body: `I'm driving and will join "${call.title}" (${hhmm(call.start)}) by audio from the car.` } : null } : null;
    const soon = events.filter((e) => e.start > Date.now() - 60e3).slice(0, 8).map((e) => ({ title: e.title, start: e.start, attendees: (e.attendees || []).map((a) => a.email), organizer: e.organizer || null }));
    if (!ev) return res.json({ event: null, call: rescue, events: soon, errors, upcoming: events.length });
    try {
      const place = (await maps.search(ev.location, { lat, lon }))[0];
      if (!place) return res.json({ event: ev, place: null, errors, why: "couldn't find the meeting's location on the map" });
      const route = await maps.route({ lat, lon }, place);
      const hazards = along(route.coords);
      const plan = leaveBy({ event: ev, route, hazards, raining: !!raining });
      const draft = plan.late > 0 ? lateMessage({ event: ev, arrival: plan.arriveIfNow + 5 * 60e3 }) : null;
      res.json({ event: ev, place, route: { lengthM: route.lengthM, durationS: route.durationS, trafficDelayS: route.trafficDelayS, coords: route.coords }, hazards, plan, draft, call: rescue, events: soon, errors });
    } catch (e) { fail(res, e); }
  });

  /* ---------- co-pilot: new mail and Teams chats, read out only at stops (the phone decides when) ---------- */
  async function inboxFor(req, res, trip = null) {
    const items = [], errors = [];
    const g = ck(req, "ss_g"), m = ck(req, "ss_m");
    if (g) { try { items.push(...(await accounts.google.unread(g.r))); } catch (e) { errors.push({ source: "gmail", error: e.message }); } }
    if (m) { try { const r = await accounts.microsoft.unread(m.r, m.uid); keepMs(res, m, r.rotated); items.push(...r.items); } catch (e) { errors.push({ source: "teams", error: e.message }); } }
    items.sort((a, b) => b.ts - a.ts);
    // Knowledge across apps (14.6): earlier messages in each thread/chat + meetings → graph → context per message.
    const history = {};
    for (const it of items.slice(0, 6)) {
      try {
        if (it.source === "gmail" && g) history[`thread:${it.threadId || it.id}`] = (await accounts.google.thread(g.r, it.threadId)).filter((h) => h.id !== it.id);
        if (it.source === "teams" && m) { const r = await accounts.microsoft.chatHistory(m.r, it.chatId); keepMs(res, m, r.rotated); history[`chat:${it.chatId}`] = r.items.filter((h) => h.id !== it.id); }
      } catch {}
    }
    const { events } = await allEvents(req, res);
    const graph = buildGraph({ events, items, history });
    graphs.set(owner, graph);
    for (const it of items) Object.assign(it, contextFor(it, graph, { trip, history }));
    if (llm?.on) await refineContext(items, events, trip).catch(() => {});
    return { items, errors };
  }
  // Optional LLM pass: for messages the rules couldn't link, ask which meeting (if any) they refer to.
  // The answer must be one of the real meetings; anything else is ignored.
  async function refineContext(items, events, trip) {
    const open = items.filter((it) => !it.refersTo).slice(0, 4); if (!open.length || !events.length) return;
    const meetings = events.slice(0, 8).map((e) => ({ id: e.id, title: e.title, start: hhmm(e.start), with: (e.attendees || []).map((a) => a.name).slice(0, 5) }));
    const r = await llm.run({ system: "You link messages to the owner's meetings. Reply only with JSON {\"links\":[{\"message\":<index>,\"meeting_id\":<id or null>}]}. Link only when the message clearly refers to that meeting.", json: true,
      messages: [{ role: "user", content: JSON.stringify({ meetings, messages: open.map((it, i) => ({ index: i, from: it.from, subject: it.subject, text: it.snippet })) }) }], maxTokens: 300 });
    let links = []; try { links = JSON.parse(r.content).links || []; } catch {}
    for (const l of links) {
      const it = open[l.message], ev = events.find((e) => e.id === l.meeting_id);
      if (!it || !ev) continue;
      it.refersTo = { kind: "meeting", id: `meeting:${ev.id}`, title: ev.title, start: ev.start, location: ev.location || null };
      it.context = `${(it.from || "Someone").split(" ")[0]} about ${ev.title} at ${hhmm(ev.start)}.`;
    }
  }
  const tripOf = (q) => q.dest ? { destination: String(q.dest).slice(0, 80), minutes_left: Number.isFinite(+q.mins) ? +q.mins : null, traffic_delay_min: +q.delay || 0, hazards_on_route: +q.hz || 0, flooded: q.flood === "1" } : null;
  app.get("/api/copilot/inbox", needOwner, limit, async (req, res) => res.json(await inboxFor(req, res, tripOf(req.query))));

  // "What I know" (14.6): the owner's own knowledge graph, shown in the app.
  app.get("/api/copilot/graph", needOwner, limit, async (req, res) => {
    if (!graphs.has(owner)) await inboxFor(req, res, null);
    const gr = graphs.get(owner) || { nodes: [], edges: [] };
    const by = (k) => gr.nodes.filter((n) => n.kind === k);
    const label = (id) => gr.nodes.find((n) => n.id === id)?.label || id;
    res.json({ builtAt: gr.builtAt, people: by("person").map((p) => ({ name: p.label, email: p.email || null, links: gr.edges.filter((e) => e.from === p.id).length })).sort((a, b) => b.links - a.links),
      meetings: by("meeting").map((mt) => ({ title: mt.label, start: mt.start, place: mt.location || null, online: !!mt.joinUrl, people: gr.edges.filter((e) => e.to === mt.id && e.rel !== "about").map((e) => label(e.from)), conversations: gr.edges.filter((e) => e.to === mt.id && e.rel === "about").map((e) => label(e.from)) })),
      conversations: [...by("thread"), ...by("chat")].map((c) => ({ title: c.label, via: c.kind === "chat" ? "Teams" : "Gmail", people: gr.edges.filter((e) => e.to === c.id && e.rel === "wrote").map((e) => label(e.from)), about: gr.edges.filter((e) => e.from === c.id && e.rel === "about").map((e) => label(e.to)) })),
      edges: gr.edges.length });
  });

  // Vague spoken reply → proper message + context + automatic ETA line (14.6). Demo items need no account.
  app.post("/api/copilot/compose", limit, async (req, res) => {
    const { item = {}, said, trip = null, car = "creta", demo = false } = req.body || {};
    if (!demo && !isOwner(req)) return res.status(401).json({ error: "sign in as the owner first" });
    if (typeof said !== "string" || !said.trim()) return res.status(400).json({ error: "said required" });
    let text = composeRules(said, item), brain = "rules";
    if (llm?.on && !demo) {
      try {
        const r = await llm.run({ system: "Turn the driver's spoken words into a short, polite reply message. Keep their meaning exactly; do not add facts, times, places or promises they didn't say. One or two sentences. Write in English unless the original message is in Hindi or Hinglish, then match it. Output only the message text.", maxTokens: 200,
          messages: [{ role: "user", content: JSON.stringify({ replying_to: { from: item.from, subject: item.subject, text: item.snippet }, context: item.context || null, driver_said: said.slice(0, 400) }) }] });
        // No invented times: the only time in a reply comes from the live ETA line.
        if (r.content && !/\b\d{1,2}[:.]\d{2}\b/.test(r.content)) { text = r.content.replace(/^"|"$/g, ""); brain = "llm"; }
      } catch {}
    }
    const line = etaLine({ car, trip });
    res.json({ text, etaLine: line, full: `${text}\n\n${line}`, brain });
  });

  // Sends only with confirmed:true, which the phone sets after the driver hears the text read back and says yes.
  app.post("/api/copilot/send", needOwner, limit, express.json(), async (req, res) => {
    const b = req.body || {};
    if (b.confirmed !== true) return res.status(400).json({ error: "the driver must confirm first" });
    const text = String(b.body || "").trim(); if (!text || text.length > 4000) return res.status(400).json({ error: "message text required" });
    try {
      if (b.source === "teams") {
        const m = ck(req, "ss_m"); if (!m) return res.status(401).json({ error: "connect Teams first" });
        const r = await accounts.microsoft.send(m.r, String(b.chatId), text); keepMs(res, m, r.rotated); return res.json({ sent: true, id: r.id });
      }
      const g = ck(req, "ss_g"); if (!g) return res.status(401).json({ error: "connect Gmail first" });
      const to = [].concat(b.to || []).map(String).filter((x) => /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/.test(x)).slice(0, 20);
      if (!to.length) return res.status(400).json({ error: "no valid recipient" });
      const subject = String(b.subject || "").slice(0, 200) || "(no subject)";
      const r = await accounts.google.send(g.r, { to: to.join(", "), subject: b.inReplyTo && !/^re:/i.test(subject) ? "Re: " + subject : subject, body: text, threadId: b.threadId, inReplyTo: b.inReplyTo });
      res.json({ sent: true, id: r.id, to });
    } catch (e) { fail(res, e); }
  });

  return { isOwner, ready, inboxFor };
}

module.exports = { mountPersonal };
