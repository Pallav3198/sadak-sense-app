// Sadak Sense server: REST API + live stream + static apps (fleet console, driver app).
const express = require("express");
const path = require("node:path");
const { openDb } = require("./db");
const { Engine } = require("./engine");
const { brief } = require("./brief");
const Voice = require("../web/shared/hinglish.js");
const { haversine, bearing, headingDiff } = require("./geo");
const { FleetSim, ROUTES } = require("../sim/fleet");

function createApp({ dbFile = process.env.DB_FILE || path.join(__dirname, "..", "data", "sadak.db"), enableSim = process.env.ENABLE_SIM !== "false" } = {}) {
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
    res.json({ hazards: engine.list({ lat, lon, radius: +(req.query.radius || 5000), states, since }) });
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
  app.post("/api/ask", limit, (req, res) => {
    const { text, lat, lon, heading, device, routeId, pending, prefer } = req.body || {};
    if (typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "text required" });
    const ctx = { pending: pending || null, prefer };
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const near = engine.list({ lat, lon, radius: 1500, states: ["confirmed"] });
      ctx.ahead = near.filter((h) => h.family !== "water").map((h) => ({ ...h, dist: haversine(lat, lon, h.lat, h.lon) }))
        .filter((h) => heading == null || h.dist < 15 || headingDiff(bearing(lat, lon, h.lat, h.lon), heading) < 40).filter((h) => h.dist <= 1000).sort((a, b) => a.dist - b.dist);
      const w = near.filter((h) => h.family === "water").map((h) => ({ ...h, dist: haversine(lat, lon, h.lat, h.lon) })).sort((a, b) => a.dist - b.dist)[0];
      ctx.water = w || null;
    }
    const line = ROUTES[routeId]?.coords;
    const along = line ? engine.alongRoute(line) : (ctx.ahead || []);
    ctx.brief = { breakers: along.filter((h) => h.type === "breaker").length, potholes: along.filter((h) => h.type === "pothole").length, water: along.some((h) => h.type === "water") || !!ctx.water };
    const out = Voice.reply(text, ctx);
    if (out.action?.report && Number.isFinite(lat) && typeof device === "string") {
      out.result = engine.ingest({ device, lat, lon, heading, speed: null, peak_g: null, type: out.action.report, rain: out.action.report === "crawl", ts: Date.now() }, "voice");
    }
    res.json(out);
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
