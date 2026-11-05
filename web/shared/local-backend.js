// Browser-only backend for the shareable edition. It runs the same rules as the server
// (in memory) and answers the apps' /api/* calls and /api/stream, so the console and the
// driver app work from a static link with no server. Requires: SSMods (geo, fleet, brief), SadakVoice.
(function () {
  const { haversine, bearing, headingDiff, distToPolyline } = SSMods.geo;
  const CFG = { surfaceRadiusM: 20, waterRadiusM: 60, headingTolDeg: 60, confirmDevices: 3, confirmWindowMs: 7 * 864e5, clearAfterCleanPasses: 8, rejectCandidateAfter: 8, waterDevices: 3, waterWindowMs: 30 * 60e3, waterDecayMs: 120 * 60e3, candidateTtlMs: 7 * 864e5 };
  const FAMILY = { breaker: "surface", pothole: "surface", bump: "surface", crawl: "water" };
  const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const mode = (a) => { const c = {}; let b = a[0], n = 0; for (const x of a) { c[x] = (c[x] || 0) + 1; if (c[x] > n) { n = c[x]; b = x; } } return b; };
  const cmean = (a) => { if (!a.length) return null; let s = 0, c = 0; for (const d of a) { s += Math.sin((d * Math.PI) / 180); c += Math.cos((d * Math.PI) / 180); } return ((Math.atan2(s, c) * 180) / Math.PI + 360) % 360; };
  const r6 = (x) => Math.round(x * 1e6) / 1e6;

  class MemEngine {
    constructor(onChange) { this.hz = new Map(); this.nextId = 1; this.recentEvents = []; this.recentPasses = []; this.onChange = onChange || (() => {}); }
    _nearby(family, lat, lon, heading, type) {
      const r = family === "water" ? CFG.waterRadiusM : CFG.surfaceRadiusM; let best = null, bd = Infinity;
      for (const h of this.hz.values()) {
        if (h.family !== family || !["candidate", "confirmed"].includes(h.state)) continue;
        const d = haversine(lat, lon, h.lat, h.lon);
        const dirOk = family === "water" || type === "breaker" || h.type === "breaker" || headingDiff(heading, h.heading) <= CFG.headingTolDeg;
        if (d <= r && dirOk && d < bd) { best = h; bd = d; }
      }
      return best;
    }
    ingest(e) {
      if (!(e && typeof e.device === "string" && Number.isFinite(e.lat) && Number.isFinite(e.lon) && FAMILY[e.type])) return { ok: false };
      const ts = e.ts || Date.now(), family = FAMILY[e.type], type = e.type === "crawl" ? "water" : e.type === "bump" ? "breaker" : e.type;
      let h = this._nearby(family, e.lat, e.lon, e.heading, type), created = false;
      if (!h) { h = { id: this.nextId++, family, type, lat: e.lat, lon: e.lon, heading: e.heading ?? null, state: "candidate", created_ts: ts, last_hit_ts: ts, severity: e.peak_g ?? null, clean_streak: 0, n_events: 0, events: [], passes: [] }; this.hz.set(h.id, h); created = true; }
      h.events.push({ lat: e.lat, lon: e.lon, heading: e.heading, peak_g: e.peak_g, speed: e.speed, type: e.type, device: e.device, ts }); if (h.events.length > 200) h.events.shift();
      h.passes.push({ ts, hit: 1 }); if (h.passes.length > 60) h.passes.shift();
      this.recentEvents.push(ts); this.recentPasses.push({ ts, device: e.device });
      const ev = h.events;
      h.lat = median(ev.map((v) => v.lat)); h.lon = median(ev.map((v) => v.lon)); h.heading = cmean(ev.map((v) => v.heading).filter((x) => x != null));
      h.type = family === "water" ? "water" : mode(ev.map((v) => (v.type === "bump" ? "breaker" : v.type)));
      const sev = median(ev.filter((v) => v.peak_g != null).map((v) => v.peak_g * (30 / Math.max(10, v.speed || 30)))); h.severity = Number.isFinite(sev) ? sev : null;
      const n = this._devices(h, ts), need = family === "water" ? CFG.waterDevices : CFG.confirmDevices;
      const just = h.state !== "confirmed" && n >= need; if (just) { h.state = "confirmed"; h.confirmed_ts = ts; }
      h.last_hit_ts = ts; h.clean_streak = 0; h.n_events++;
      const out = this.hazard(h.id);
      this.onChange({ kind: created ? "created" : just ? "confirmed" : "updated", hazard: out, event: { lat: e.lat, lon: e.lon, type: e.type } });
      return { ok: true, hazardId: h.id, state: h.state, created, justConfirmed: just, devices: n };
    }
    _devices(h, ref) { const w = h.family === "water" ? CFG.waterWindowMs : CFG.confirmWindowMs; return new Set(h.events.filter((v) => v.ts >= ref - w).map((v) => v.device)).size; }
    pass(id, device, ts = Date.now()) {
      const h = this.hz.get(id); if (!h || !["candidate", "confirmed"].includes(h.state) || h.family === "water") return { ok: false };
      h.passes.push({ ts, hit: 0 }); if (h.passes.length > 60) h.passes.shift(); this.recentPasses.push({ ts, device });
      h.clean_streak++;
      let st = h.state;
      if (h.state === "confirmed" && h.clean_streak >= CFG.clearAfterCleanPasses) st = "cleared";
      if (h.state === "candidate" && h.clean_streak >= CFG.rejectCandidateAfter) st = "rejected";
      if (st !== h.state) { h.state = st; h.cleared_ts = ts; this.onChange({ kind: st, hazard: this.hazard(id) }); }
      return { ok: true, state: h.state };
    }
    sweep(now) { for (const h of this.hz.values()) { if (!["candidate", "confirmed"].includes(h.state)) continue; if (h.family === "water" && now - h.last_hit_ts > CFG.waterDecayMs) { h.state = "cleared"; h.cleared_ts = now; this.onChange({ kind: "swept", hazard: this.hazard(h.id) }); } } }
    hazard(id) {
      const h = this.hz.get(id); if (!h) return null;
      return { id: h.id, type: h.type, family: h.family, lat: r6(h.lat), lon: r6(h.lon), heading: h.heading == null ? null : Math.round(h.heading), state: h.state, severity: h.severity == null ? null : Math.round(h.severity * 100) / 100, cleanStreak: h.clean_streak, events: h.n_events, devices: this._devices(h, h.last_hit_ts || Date.now()), createdTs: h.created_ts, confirmedTs: h.confirmed_ts, clearedTs: h.cleared_ts, lastHitTs: h.last_hit_ts };
    }
    list({ lat, lon, radius = 5000, states = ["candidate", "confirmed"] } = {}) { return [...this.hz.values()].filter((h) => states.includes(h.state)).map((h) => this.hazard(h.id)).filter((h) => lat == null || haversine(lat, lon, h.lat, h.lon) <= radius); }
    alongRoute(line, tol = 25) {
      const hits = this.list({ states: ["confirmed"] }).filter((h) => distToPolyline(h.lat, h.lon, line) <= (h.family === "water" ? 80 : tol));
      const idx = (h) => { let bi = 0, bd = Infinity; line.forEach(([a, b], i) => { const d = haversine(h.lat, h.lon, a, b); if (d < bd) { bd = d; bi = i; } }); return bi; };
      return hits.sort((a, b) => idx(a) - idx(b));
    }
    stats(now) {
      this.recentEvents = this.recentEvents.filter((t) => t >= now - 3600e3); this.recentPasses = this.recentPasses.filter((p) => p.ts >= now - 3600e3);
      const c = (s) => [...this.hz.values()].filter((h) => h.state === s).length;
      return { confirmed: c("confirmed"), candidates: c("candidate"), cleared: c("cleared"), rejected: c("rejected"), eventsLastHour: this.recentEvents.length, eventsTotal: this.recentEvents.length, devicesLastHour: new Set(this.recentPasses.map((p) => p.device)).size };
    }
  }

  const listeners = new Set();
  const emit = (type, data) => { for (const l of listeners) l(type, data); };
  const engine = new MemEngine((c) => emit("hazard", c));
  const ROUTES = SSMods.routes;
  const sim = new SSMods.fleet.FleetSim({ ingest: (e) => engine.ingest(e), pass: (id, d, ts) => engine.pass(id, d, ts), hazards: async () => engine.list() });
  setInterval(() => engine.sweep(Date.now()), 30e3);
  setInterval(() => { emit("stats", engine.stats(Date.now())); if (sim.running) emit("sim", sim.snapshot()); }, 1000);

  // Warm start: the virtual fleet has already been driving for a while when the page opens.
  sim.configure({ carsPerMin: 24, speedup: 8 });
  // In slices, so the page and its buttons respond at once instead of freezing for seconds.
  (function warm() {
    const realNow = Date.now; let fake = realNow() - 40 * 60e3, i = 0;
    const inPast = (fn) => { Date.now = () => fake; try { fn(); } finally { Date.now = realNow; } };
    inPast(() => { sim.last = fake; });
    (function slice() {
      inPast(() => { for (const end = Math.min(1400, i + 40); i < end; i++) { fake += 200; sim.tick(); } });
      if (i < 1400) return setTimeout(slice, 0);
      sim.cars = []; sim.spawnAcc = 0;
      if (window.SS_AUTOSTART !== false) sim.start();
    })();
  })();

  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  async function handle(path, method, body) {
    const u = new URL(path, "http://local"), q = Object.fromEntries(u.searchParams), p = u.pathname;
    if (p === "/api/routes") return json(Object.fromEntries(Object.entries(ROUTES).map(([k, r]) => [k, { name: r.name, distance_m: r.distance_m, coords: r.coords }])));
    if (p === "/api/events" && method === "POST") { const arr = Array.isArray(body) ? body : [body]; return json({ results: arr.map((e) => engine.ingest({ ...e, ts: e.ts || Date.now() })) }, 201); }
    if (p === "/api/passes" && method === "POST") return json(engine.pass(body.hazardId, body.device, body.ts || Date.now()));
    if (p === "/api/hazards") return json({ hazards: engine.list({ lat: q.lat != null ? +q.lat : undefined, lon: q.lon != null ? +q.lon : undefined, radius: +(q.radius || 5000), states: (q.states || "candidate,confirmed").split(",") }) });
    const m = p.match(/^\/api\/hazards\/(\d+)$/);
    if (m) { const h = engine.hz.get(+m[1]); if (!h) return json({ error: "not found" }, 404); return json({ hazard: engine.hazard(h.id), timeline: [...h.passes].reverse().slice(0, 40) }); }
    if (p === "/api/stats") return json(engine.stats(Date.now()));
    if (p === "/api/brief" && method === "POST") { const line = body.coords || ROUTES[body.routeId]?.coords; const hz = engine.alongRoute(line); const name = ROUTES[body.routeId]?.name.split("→").map((s) => s.trim()).join(" to ") || ""; return json({ text: SSMods.brief.template(hz, body.lang || "English", name), source: "template", hazards: hz }); }
    if (p === "/api/ask" && method === "POST") {
      const { text, lat, lon, heading, device, routeId, pending, prefer } = body; const ctx = { pending: pending || null, prefer };
      if (Number.isFinite(lat)) {
        const near = engine.list({ lat, lon, radius: 1500, states: ["confirmed"] });
        ctx.ahead = near.filter((h) => h.family !== "water").map((h) => ({ ...h, dist: haversine(lat, lon, h.lat, h.lon) })).filter((h) => heading == null || h.dist < 15 || headingDiff(bearing(lat, lon, h.lat, h.lon), heading) < 40).filter((h) => h.dist <= 1000).sort((a, b) => a.dist - b.dist);
        ctx.water = near.filter((h) => h.family === "water").map((h) => ({ ...h, dist: haversine(lat, lon, h.lat, h.lon) })).sort((a, b) => a.dist - b.dist)[0] || null;
      }
      const along = ROUTES[routeId] ? engine.alongRoute(ROUTES[routeId].coords) : ctx.ahead || [];
      ctx.brief = { breakers: along.filter((h) => h.type === "breaker").length, potholes: along.filter((h) => h.type === "pothole").length, water: along.some((h) => h.type === "water") || !!ctx.water };
      const out = SadakVoice.reply(text, ctx);
      if (out.action?.report && Number.isFinite(lat)) out.result = engine.ingest({ device, lat, lon, heading, type: out.action.report, rain: out.action.report === "crawl", ts: Date.now() });
      return json(out);
    }
    if (p === "/api/sim") {
      if (method === "POST") { sim.configure(body); if (body.action === "start") sim.start(); if (body.action === "stop") sim.stop(); let repaired = null; if (body.action === "repair") repaired = sim.repairOne(); return json({ ...sim.snapshot(), repaired }); }
      return json({ ...sim.snapshot(), truth: sim.truth });
    }
    return json({ error: "not found" }, 404);
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("/api/")) return handle(url, (init.method || "GET").toUpperCase(), init.body ? JSON.parse(init.body) : null);
    return realFetch(input, init);
  };
  window.EventSource = class LocalEventSource {
    constructor() { this.handlers = {}; this.l = (type, data) => (this.handlers[type] || []).forEach((f) => f({ data: JSON.stringify(data) })); listeners.add(this.l); setTimeout(() => this.onopen && this.onopen(), 0); }
    addEventListener(type, f) { (this.handlers[type] = this.handlers[type] || []).push(f); }
    close() { listeners.delete(this.l); }
  };
})();
