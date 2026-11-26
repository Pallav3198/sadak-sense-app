// Sadak Sense server: REST API + live stream + static apps (fleet console, driver app).
const express = require("express");
const path = require("node:path");
const { openDb } = require("./db");
const { Engine } = require("./engine");
const { brief } = require("./brief");
const Voice = require("../web/shared/hinglish.js");
const { haversine, bearing, headingDiff } = require("./geo");
const { FleetSim, ROUTES } = require("../sim/fleet");
const { createSarvam } = require("./sarvam");
const { complaint, cityReport, createMailer, CHANNELS, ONE_WEEK } = require("./report");
const fs = require("node:fs");
const { createAccounts } = require("./accounts");
const { createMaps } = require("./maps");
const { mountPersonal } = require("./personal");
const { createSignals } = require("./signals");
const { createPairing } = require("./pair");
const { createLLM, hazardSafe } = require("./llm");
const SadakCar = require("../web/shared/mycar.js");

function createApp({ dbFile = process.env.DB_FILE || path.join(__dirname, "..", "data", "sadak.db"), enableSim = process.env.ENABLE_SIM !== "false",
  seedFile = process.env.SEED_FILE || path.join(__dirname, "..", "seed", "real-drives.json"), sarvam = createSarvam(), mailer = createMailer(), accounts = createAccounts(), maps = createMaps(), env = process.env, signalsImpl = null, llm = createLLM() } = {}) {
  const db = openDb(dbFile);
  const clients = new Set();
  const send = (type, data) => { const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) c.write(msg); };
  const engine = new Engine(db, { onChange: (c) => send("hazard", c) });
  const sim = enableSim ? new FleetSim({
    ingest: (e) => engine.ingest(e, "sim"),
    pass: (id, d, ts) => engine.pass(id, d, ts),
    hazards: async () => engine.list({ states: ["candidate", "confirmed"] }),
  }) : null;

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // behind Render's proxy: real https and client IP
  app.use(express.json({ limit: "64kb" }));
  app.use((req, res, next) => { res.set("Access-Control-Allow-Origin", "*"); res.set("Access-Control-Allow-Headers", "content-type"); if (req.method === "OPTIONS") return res.sendStatus(204); next(); });

  // naive per-IP rate limit for write endpoints (600 writes / min)
  const buckets = new Map();
  const limit = (req, res, next) => {
    const k = req.ip, now = Date.now(), b = buckets.get(k) || { n: 0, t: now };
    if (now - b.t > 60e3) { b.n = 0; b.t = now; }
    if (++b.n > 600) return res.status(429).json({ error: "rate limited" });
    buckets.set(k, b); next();
  };

  app.get("/healthz", (_, res) => res.json({ ok: true }));
  app.get("/api/routes", (_, res) => res.json(Object.fromEntries(Object.entries(ROUTES).map(([k, r]) => [k, { name: r.name, distance_m: r.distance_m, coords: r.coords }]))));

  // Sensor events from phones / cars. Accepts one event or an array (offline batches).
  app.post("/api/events", limit, (req, res) => {
    const arr = Array.isArray(req.body) ? req.body.slice(0, 200) : [req.body];
    const results = arr.map((e) => engine.ingest({ ...e, ts: Number.isFinite(e.ts) ? e.ts : Date.now() }, e.source === "sim" ? "sim" : "phone"));
    res.status(results.every((r) => r.ok) ? 201 : 207).json({ results });
  });
  app.post("/api/label", limit, (req, res) => {
    const b = req.body || {};
    if (typeof b.device !== "string" || ![b.lat, b.lon].every(Number.isFinite)) return res.status(400).json({ error: "device, lat, lon required" });
    const r = engine.label({ ...b, ts: Number.isFinite(b.ts) ? b.ts : Date.now() });
    res.status(r.ok ? 200 : 400).json(r);
  });
  // A car crossed a known hazard and felt nothing.
  app.post("/api/passes", limit, (req, res) => {
    const { hazardId, device, ts } = req.body || {};
    if (!Number.isInteger(hazardId) || typeof device !== "string") return res.status(400).json({ error: "hazardId and device required" });
    res.json(engine.pass(hazardId, device, Number.isFinite(ts) ? ts : Date.now()));
  });

  app.get("/api/hazards", (req, res) => {
    const states = (req.query.states || "candidate,confirmed").split(",").filter((s) => ["candidate", "confirmed", "cleared", "rejected"].includes(s));
    const lat = req.query.lat != null ? +req.query.lat : undefined, lon = req.query.lon != null ? +req.query.lon : undefined;
    const since = req.query.since ? +req.query.since : undefined;
    res.json({ hazards: engine.list({ lat, lon, radius: +(req.query.radius || 5000), states, since, realOnly: req.query.real === "1" }) });
  });
  app.get("/api/hazards/:id", (req, res) => {
    const h = engine.hazard(+req.params.id);
    if (!h) return res.status(404).json({ error: "not found" });
    const timeline = db.prepare("SELECT ts, hit FROM passes WHERE hazard_id = ? ORDER BY ts DESC LIMIT 40").all(h.id);
    res.json({ hazard: h, timeline });
  });
  app.get("/api/stats", (_, res) => res.json(engine.stats(Date.now())));

  app.post("/api/brief", async (req, res) => {
    const { routeId, coords, lang = "English" } = req.body || {};
    const line = coords || ROUTES[routeId]?.coords;
    if (!line) return res.status(400).json({ error: "routeId or coords required" });
    const hz = engine.alongRoute(line);
    const out = await brief(hz, lang, ROUTES[routeId]?.name.split("→").map((s) => s.trim()).join(" to ") || "");
    res.json({ ...out, hazards: hz });
  });

  // Two-way voice: the driver speaks (English, Hindi or Hinglish); we answer from live data in the same language.
  let personal = null; // set below; the ask route needs the owner check and inbox at request time
  app.post("/api/ask", limit, async (req, res) => {
    const { text, lat, lon, heading, device, routeId, pending, prefer, car, people, trip } = req.body || {};
    if (typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "text required" });
    const ctx = { pending: pending || null, prefer };
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const near = engine.list({ lat, lon, radius: 1500, states: ["confirmed"] });
      ctx.ahead = near.filter((h) => h.family === "surface").map((h) => ({ ...h, dist: haversine(lat, lon, h.lat, h.lon) }))
        .filter((h) => heading == null || h.dist < 15 || headingDiff(bearing(lat, lon, h.lat, h.lon), heading) < 40).filter((h) => h.dist <= 1000).sort((a, b) => a.dist - b.dist);
      const w = near.filter((h) => h.family === "water").map((h) => ({ ...h, dist: haversine(lat, lon, h.lat, h.lon) })).sort((a, b) => a.dist - b.dist)[0];
      ctx.water = w || null;
    }
    const line = ROUTES[routeId]?.coords;
    const along = line ? engine.alongRoute(line) : (ctx.ahead || []);
    ctx.brief = { breakers: along.filter((h) => h.type === "breaker").length, potholes: along.filter((h) => h.type === "pothole").length, water: along.some((h) => h.type === "water") || !!ctx.water };
    const report = (type) => Number.isFinite(lat) && typeof device === "string"
      ? engine.ingest({ device, lat, lon, heading, speed: null, peak_g: null, type, rain: type === "crawl", ts: Date.now() }, "voice") : { ok: false, error: "no position" };
    const rule = Voice.reply(text, ctx);
    // Deterministic intents (yes/no to a pending question, explicit reports) stay with the rule brain.
    const keepRule = ["yes", "no", "report"].includes(rule.intent);
    if (!keepRule && llm.on) {
      try {
        const out = await askLLM({ text, ctx, car, people, trip, req, res, report });
        if (out) return res.json(out);
      } catch { /* network or model failure: the rule brain answers (offline fallback, 14.7) */ }
    }
    if (rule.action?.report) rule.result = report(rule.action.report);
    res.json({ ...rule, brain: "rules" });
  });

  // Free speech in any of the 8 languages: the LLM answers from tools that read live data (14.7).
  const TOOLS = [
    { type: "function", function: { name: "hazards_ahead", description: "Confirmed road hazards (potholes, speed breakers) within 1 km ahead in the driving direction, and waterlogging nearby. The ONLY source of hazard facts.", parameters: { type: "object", properties: {}, required: [] } } },
    { type: "function", function: { name: "route_brief", description: "Counts of confirmed speed breakers, potholes and waterlogging on today's route.", parameters: { type: "object", properties: {}, required: [] } } },
    { type: "function", function: { name: "my_car_check", description: "Whether the driver's own car (model, people on board, ground clearance) can safely cross the next hazard, and at what speed.", parameters: { type: "object", properties: {}, required: [] } } },
    { type: "function", function: { name: "trip_eta", description: "Current destination, minutes left with live traffic, and arrival time.", parameters: { type: "object", properties: {}, required: [] } } },
    { type: "function", function: { name: "my_messages", description: "The driver's unread Gmail and Teams messages (sender, subject, short text). Only for the car's owner.", parameters: { type: "object", properties: {}, required: [] } } },
    { type: "function", function: { name: "report_hazard", description: "Report a hazard the driver says is here right now.", parameters: { type: "object", properties: { type: { type: "string", enum: ["pothole", "breaker", "crawl"] } }, required: ["type"] } } },
  ];
  const SYSTEM = "You are Sadak Sense, the voice assistant inside a Hyundai in India. Reply in the same language and script the driver used (Roman Hinglish if they wrote Roman Hinglish). Keep it to one or two short spoken sentences. For anything about potholes, speed breakers, waterlogging or the road ahead you MUST call hazards_ahead and state only what it returns; never mention a hazard it did not return, and say the road is clear if it returns none. Use metres for distance. Never invent messages, times or places: use the tools. If you don't know, say so briefly.";
  async function askLLM({ text, ctx, car, people, trip, req, res, report }) {
    const handlers = {
      hazards_ahead: () => ({ hazards: (ctx.ahead || []).slice(0, 5).map((h) => ({ type: h.type, distance_m: Math.round(h.dist), cars_confirmed: h.devices })), water: ctx.water ? { distance_m: Math.round(ctx.water.dist), cars: ctx.water.devices } : null }),
      route_brief: () => ctx.brief,
      my_car_check: () => { const next = (ctx.ahead || [])[0]; if (!next) return { next_hazard: null }; const v = SadakCar.check(car || "creta", +people || 1, next); return { next_hazard: next.type, distance_m: Math.round(next.dist), advice: SadakCar.line(v, "English") }; },
      trip_eta: () => trip && trip.destination ? trip : { destination: null },
      my_messages: async () => personal?.isOwner(req) ? { messages: (await personal.inboxFor(req, res)).items.slice(0, 5).map((m) => ({ from: m.from, subject: m.subject, text: m.snippet, via: m.source })) } : { error: "not signed in as the owner" },
      report_hazard: ({ type }) => (["pothole", "breaker", "crawl"].includes(type) ? report(type) : { ok: false }),
    };
    const r = await llm.run({ system: SYSTEM, messages: [{ role: "user", content: text.slice(0, 600) }], tools: TOOLS, handlers });
    if (!r.content || !hazardSafe(r.content, r.used)) return null; // invented a hazard → rule brain answers
    const lang = Voice.detectLang(r.content);
    const reported = r.used.find((u) => u.name === "report_hazard");
    return { reply: r.content, lang, voice: ["Tamil", "Telugu", "Malayalam", "Kannada", "Bengali"].includes(lang) ? lang : null, intent: "llm", brain: "llm", tools: r.used.map((u) => u.name), result: reported?.result };
  }

  personal = mountPersonal(app, { engine, accounts, maps, env, limit, llm });

  /* ---------- pairing: dashboard phone → car screen ---------- */
  const pairing = createPairing();
  app.post("/api/pair/new", limit, (_, res) => res.json({ code: pairing.create() }));
  app.get("/api/pair/:code", (req, res) => res.json({ ok: pairing.exists(req.params.code) }));
  app.get("/api/pair/:code/stream", (req, res) => {
    if (!pairing.exists(req.params.code)) return res.status(404).json({ error: "unknown or expired code" });
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" }); res.flushHeaders(); res.write("retry: 2000\n\n");
    pairing.subscribe(req.params.code, res);
  });
  app.post("/api/pair/:code", limit, (req, res) => { const r = pairing.publish(req.params.code, req.body); res.status(r.ok ? 200 : 400).json(r); });

  /* ---------- traffic signals: red light vs jam, red time left (spec 14.4) ---------- */
  const signals = signalsImpl || createSignals({ db });
  app.get("/api/signals/state", limit, async (req, res) => {
    const lat = +req.query.lat, lon = +req.query.lon, heading = req.query.heading != null && req.query.heading !== "" ? +req.query.heading : null;
    if (![lat, lon].every(Number.isFinite)) return res.status(400).json({ error: "lat, lon required" });
    res.json(await signals.state({ lat, lon, heading }));
  });
  app.get("/api/signals/near", limit, async (req, res) => {
    const lat = +req.query.lat, lon = +req.query.lon; if (![lat, lon].every(Number.isFinite)) return res.status(400).json({ error: "lat, lon required" });
    res.json({ signals: (await signals.near(lat, lon, 1500)).slice(0, 80) });
  });
  app.post("/api/stops", limit, (req, res) => {
    const b = req.body || {};
    if (typeof b.key !== "string" || typeof b.device !== "string" || ![b.lat, b.lon, b.start].every(Number.isFinite)) return res.status(400).json({ error: "key, device, lat, lon, start required" });
    if (b.action === "start") { signals.stopStart(b); return res.json({ ok: true }); }
    if (b.action === "end" && Number.isFinite(b.end)) return res.json(signals.stopEnd(b));
    res.status(400).json({ error: "action start|end" });
  });

  /* ---------- Sarvam voice: 8 Indian languages, key stays on this server ---------- */
  app.get("/api/voice/status", (_, res) => res.json({ sarvam: sarvam.on, languages: Object.keys(sarvam.LANGS) }));
  app.post("/api/voice/say", limit, async (req, res) => {
    const { text, lang = "English", writtenIn = "English" } = req.body || {};
    if (typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "text required" });
    try { res.json(await sarvam.say(text.slice(0, 1500), lang, writtenIn)); }
    catch (e) { res.status(e.status === 503 ? 503 : 502).json({ error: e.message }); }
  });
  app.post("/api/voice/listen", limit, express.raw({ type: ["audio/*", "application/octet-stream"], limit: "3mb" }), async (req, res) => {
    if (!req.body?.length) return res.status(400).json({ error: "audio required" });
    try { res.json(await sarvam.listen(req.body, req.get("content-type") || "audio/webm")); }
    catch (e) { res.status(e.status === 503 ? 503 : 502).json({ error: e.message }); }
  });

  /* ---------- reports to road authorities (real email to the pilot test inbox) ---------- */
  const q = {
    addReport: db.prepare("INSERT INTO reports (kind,hazard_id,ref,recipient,channel,status,provider_id,ts) VALUES (?,?,?,?,?,?,?,?)"),
    lastReport: db.prepare("SELECT * FROM reports WHERE kind = ? AND COALESCE(hazard_id, -1) = COALESCE(?, -1) AND status = 'sent' ORDER BY ts DESC LIMIT 1"),
    reportsOf: db.prepare("SELECT kind, ref, recipient, channel, status, ts FROM reports WHERE hazard_id = ? ORDER BY ts DESC LIMIT 10"),
  };
  app.get("/api/report/status", (_, res) => res.json({ email: mailer.on, to: mailer.to ? mailer.to.replace(/(^.).*(@.*$)/, "$1…$2") : null, channels: CHANNELS }));
  app.get("/api/report/:hazardId", (req, res) => {
    const h = engine.hazard(+req.params.hazardId);
    if (!h) return res.status(404).json({ error: "not found" });
    res.json({ hazard: h, draft: complaint(h), history: q.reportsOf.all(h.id), channels: CHANNELS });
  });
  app.post("/api/report", limit, async (req, res) => {
    const { hazardId, consent } = req.body || {};
    const h = Number.isInteger(hazardId) ? engine.hazard(hazardId) : null;
    if (!h) return res.status(404).json({ error: "hazard not found" });
    if (consent !== true) return res.status(400).json({ error: "the driver's consent is required" });
    if (h.state !== "confirmed") return res.status(409).json({ error: "only confirmed hazards (3+ vehicles) are reported" });
    const prev = q.lastReport.get("complaint", h.id);
    if (prev && Date.now() - prev.ts < ONE_WEEK) return res.json({ status: "already", ref: prev.ref, ts: prev.ts });
    const c = complaint(h), r = await mailer.send(c);
    q.addReport.run("complaint", h.id, c.ref, mailer.to, "email", r.status, r.providerId || null, Date.now());
    res.status(r.status === "failed" ? 502 : 200).json({ ...r, ref: c.ref, subject: c.subject });
  });
  app.get("/api/city-report", (req, res) => {
    const realOnly = req.query.real === "1";
    res.type("html").send(cityReport(engine.list({ states: ["confirmed"], realOnly }), { realOnly }).html);
  });
  app.post("/api/city-report/send", limit, async (req, res) => {
    const realOnly = req.body?.real === true;
    const prev = q.lastReport.get("city", null);
    if (prev && Date.now() - prev.ts < 10 * 60e3) return res.json({ status: "already", ref: prev.ref, ts: prev.ts });
    const c = cityReport(engine.list({ states: ["confirmed"], realOnly }), { realOnly }), r = await mailer.send(c);
    q.addReport.run("city", null, c.ref, mailer.to, "email", r.status, r.providerId || null, Date.now());
    res.status(r.status === "failed" ? 502 : 200).json({ ...r, ref: c.ref, count: c.count, fresh: c.fresh });
  });

  /* ---------- real drives: export, and replay on boot (free hosting has no lasting disk) ---------- */
  app.get("/api/export", (_, res) => {
    const events = db.prepare("SELECT device,lat,lon,heading,speed,peak_g,type,rain,ts,source,car FROM events WHERE source != 'sim' ORDER BY ts").all();
    const passes = db.prepare("SELECT p.device, p.ts, h.lat, h.lon, h.type FROM passes p JOIN hazards h ON h.id = p.hazard_id WHERE p.hit = 0 AND p.device LIKE 'ph-%' ORDER BY p.ts").all();
    res.set("Content-Disposition", `attachment; filename="sadak-real-drives-${new Date().toISOString().slice(0, 10)}.json"`).json({ exported: Date.now(), events, passes });
  });
  let seeded = 0;
  try {
    if (seedFile && fs.existsSync(seedFile) && !db.prepare("SELECT 1 FROM events WHERE source != 'sim' LIMIT 1").get()) {
      const seed = JSON.parse(fs.readFileSync(seedFile, "utf8"));
      const all = [...(seed.events || []).map((e) => ({ k: "e", ...e })), ...(seed.passes || []).map((p) => ({ k: "p", ...p }))].sort((a, b) => a.ts - b.ts);
      for (const x of all) {
        if (x.k === "e") { if (engine.ingest({ ...x, rain: !!x.rain }, x.source || "phone").ok) seeded++; }
        else { const h = engine.list({ lat: x.lat, lon: x.lon, radius: 20 })[0]; if (h) engine.pass(h.id, x.device, x.ts); }
      }
    }
  } catch (e) { console.error("seed replay failed:", e.message); }
  app.get("/api/real/summary", (_, res) => {
    const hz = engine.list({ states: ["candidate", "confirmed", "cleared"], realOnly: true });
    res.json({ seeded, phones: db.prepare("SELECT COUNT(DISTINCT device) n FROM events WHERE source != 'sim'").get().n,
      events: db.prepare("SELECT COUNT(*) n FROM events WHERE source != 'sim'").get().n,
      confirmed: hz.filter((h) => h.state === "confirmed").length, candidates: hz.filter((h) => h.state === "candidate").length, hazards: hz });
  });

  app.get("/api/stream", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders(); res.write("retry: 3000\n\n");
    clients.add(res); req.on("close", () => clients.delete(res));
  });

  if (sim) {
    app.get("/api/sim", (_, res) => res.json({ ...sim.snapshot(), truth: sim.truth }));
    app.post("/api/sim", (req, res) => {
      const { action, carsPerMin, speedup, monsoon } = req.body || {};
      sim.configure({ carsPerMin, speedup, monsoon });
      if (action === "start") sim.start();
      if (action === "stop") sim.stop();
      let repaired = null; if (action === "repair") repaired = sim.repairOne();
      res.json({ ...sim.snapshot(), repaired });
    });
  }

  // Android app (Trusted Web Activity): proves this site and the APK belong together, so the app opens full screen.
  app.get("/.well-known/assetlinks.json", (_, res) => {
    const pkg = env.ANDROID_PACKAGE, prints = String(env.ANDROID_SHA256 || "").split(",").map((x) => x.trim()).filter(Boolean);
    res.json(pkg && prints.length ? [{ relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: prints } }] : []);
  });
  // The service worker controls the whole site (scope "/"), so it must be served with this header.
  app.get("/drive/sw.js", (req, res, next) => { res.set("Service-Worker-Allowed", "/"); res.set("Cache-Control", "no-cache"); next(); });
  // Car-screen mode: the same driver app laid out for an in-dash touchscreen.
  app.get(["/car", "/car/"], (_, res) => res.sendFile(path.join(__dirname, "..", "web", "drive", "index.html")));
  app.use("/vendor/leaflet", express.static(path.join(__dirname, "..", "node_modules", "leaflet", "dist"), { maxAge: "7d" }));
  app.use(express.static(path.join(__dirname, "..", "web"), { extensions: ["html"] }));
  app.get("/", (_, res) => res.redirect("/console/"));

  const timers = [
    setInterval(() => engine.sweep(Date.now()), 30e3),
    setInterval(() => { send("stats", engine.stats(Date.now())); if (sim?.running) send("sim", sim.snapshot()); }, 1000),
  ];
  const close = () => { timers.forEach(clearInterval); sim?.stop(); db.close(); };
  return { app, engine, sim, close };
}

module.exports = { createApp };

if (require.main === module) {
  const { app, sim } = createApp();
  const port = +process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Sadak Sense on http://localhost:${port}  (console: /console/, driver app: /drive/)`);
    if (sim && process.env.AUTOSTART_SIM === "true") sim.start();
  });
}
