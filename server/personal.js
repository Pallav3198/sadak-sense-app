// The personal side of Sadak Sense: the owner's sign-in, real maps, and the co-pilot over Gmail, Calendar and Teams.
// Only the owner (OWNER_EMAIL) can use these routes. Nothing is sent without an explicit confirmation from the driver.
const express = require("express");
const { seal, open, cookies, setCookie, randomState } = require("./secure");
const { leaveBy, lateMessage, nextTrip } = require("./copilot");

function mountPersonal(app, { engine, accounts, maps, env = process.env, limit }) {
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
  app.post("/api/maps/route", needOwner, limit, async (req, res) => {
    const { from, to } = req.body || {};
    if (![from?.lat, from?.lon, to?.lat, to?.lon].every(Number.isFinite)) return res.status(400).json({ error: "from and to required" });
    try { const r = await maps.route(from, to); res.json({ ...r, hazards: along(r.coords) }); } catch (e) { fail(res, e); }
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
    const ev = nextTrip(events);
    if (!ev) return res.json({ event: null, errors, upcoming: events.length });
    try {
      const place = (await maps.search(ev.location, { lat, lon }))[0];
      if (!place) return res.json({ event: ev, place: null, errors, why: "couldn't find the meeting's location on the map" });
      const route = await maps.route({ lat, lon }, place);
      const hazards = along(route.coords);
      const plan = leaveBy({ event: ev, route, hazards, raining: !!raining });
      const draft = plan.late > 0 ? lateMessage({ event: ev, arrival: plan.arriveIfNow + 5 * 60e3 }) : null;
      res.json({ event: ev, place, route: { lengthM: route.lengthM, durationS: route.durationS, trafficDelayS: route.trafficDelayS, coords: route.coords }, hazards, plan, draft, errors });
    } catch (e) { fail(res, e); }
  });

  /* ---------- co-pilot: new mail and Teams chats, read out only at stops (the phone decides when) ---------- */
  app.get("/api/copilot/inbox", needOwner, limit, async (req, res) => {
    const items = [], errors = [];
    const g = ck(req, "ss_g"), m = ck(req, "ss_m");
    if (g) { try { items.push(...(await accounts.google.unread(g.r))); } catch (e) { errors.push({ source: "gmail", error: e.message }); } }
    if (m) { try { const r = await accounts.microsoft.unread(m.r, m.uid); keepMs(res, m, r.rotated); items.push(...r.items); } catch (e) { errors.push({ source: "teams", error: e.message }); } }
    res.json({ items: items.sort((a, b) => b.ts - a.ts), errors });
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

  return { isOwner, ready };
}

module.exports = { mountPersonal };
