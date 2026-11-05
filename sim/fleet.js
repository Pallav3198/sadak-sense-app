// Fleet simulator: virtual connected cars drive real Delhi roads (OSRM geometry) and
// report what their sensors would feel. It uses the same event format and the same
// API as the phone app, so the backend cannot tell simulated cars from real ones.
//
// In-process:  new FleetSim({ routes, ingest, pass, hazards }).start()
// Against a deployed server:  node sim/fleet.js --url https://your-app.onrender.com --cars 12 --speedup 8
const { haversine, bearing, offset, headingDiff } = require("../server/geo");
const ROUTES = require("./routes.json");

// Ground truth for the simulation: hazards placed on real roads (positions are simulated).
const SCENARIO = [
  ["iit-hauzkhas", 0.28, "breaker", "Unmarked speed breaker"], ["iit-hauzkhas", 0.62, "pothole", "Pothole, kerb lane"],
  ["iit-aiims", 0.16, "breaker", "Speed breaker, faded paint"], ["iit-aiims", 0.47, "pothole", "Deep pothole"], ["iit-aiims", 0.81, "breaker", "Speed breaker near gate"],
  ["saket-munirka", 0.30, "pothole", "Pothole cluster"], ["saket-munirka", 0.56, "pothole", "Broken patch after rain"], ["saket-munirka", 0.76, "breaker", "Rumble strip / breaker"],
  ["iit-vasantvihar", 0.35, "breaker", "Speed breaker, no sign"], ["iit-vasantvihar", 0.70, "pothole", "Pothole near bus stop"],
  ["cp-minto", 0.12, "pothole", "Pothole near Outer Circle"], ["cp-minto", null, "water", "Minto Bridge underpass"], ["cp-minto", 0.86, "breaker", "Speed breaker near station"],
];
const MINTO = [28.6363, 77.2226]; // Minto Bridge underpass (Minto Road under the railway)

function prepRoute(r) {
  const cum = [0];
  for (let i = 1; i < r.coords.length; i++) cum.push(cum[i - 1] + haversine(...r.coords[i - 1], ...r.coords[i]));
  return { ...r, cum, length: cum[cum.length - 1] };
}
function pointAt(r, s) {
  s = Math.max(0, Math.min(r.length, s));
  let i = 1; while (i < r.cum.length - 1 && r.cum[i] < s) i++;
  const [a, b] = [r.coords[i - 1], r.coords[i]], seg = r.cum[i] - r.cum[i - 1] || 1, f = (s - r.cum[i - 1]) / seg;
  return { lat: a[0] + (b[0] - a[0]) * f, lon: a[1] + (b[1] - a[1]) * f, heading: bearing(...a, ...b) };
}
function project(r, lat, lon) {
  let best = { d: Infinity, s: 0 };
  for (let i = 0; i < r.coords.length - 1; i++) {
    for (let k = 0; k <= 10; k++) {
      const s = r.cum[i] + ((r.cum[i + 1] - r.cum[i]) * k) / 10, p = pointAt(r, s), d = haversine(lat, lon, p.lat, p.lon);
      if (d < best.d) best = { d, s };
    }
  }
  return best;
}

class FleetSim {
  constructor({ ingest, pass, hazards, now = () => Date.now(), log = () => {} }) {
    this.routes = Object.fromEntries(Object.entries(ROUTES).map(([k, r]) => [k, prepRoute(r)]));
    this.ingest = ingest; this.pass = pass; this.hazardsFn = hazards; this.now = now; this.log = log;
    this.cars = []; this.running = false; this.carsPerMin = 20; this.speedup = 6; this.monsoon = false;
    this.spawnAcc = 0; this.known = []; this.stats = { spawned: 0, events: 0, passes: 0 };
    this.truth = SCENARIO.map(([rid, f, type, label], i) => {
      const r = this.routes[rid];
      const s = f == null ? project(r, ...MINTO).s : f * r.length;
      const p = pointAt(r, s);
      return { id: `T${i + 1}`, route: rid, s, type, label, lat: p.lat, lon: p.lon, heading: p.heading, active: type !== "water" };
    });
  }

  configure({ carsPerMin, speedup, monsoon }) {
    if (carsPerMin != null) this.carsPerMin = Math.max(1, Math.min(120, +carsPerMin));
    if (speedup != null) this.speedup = Math.max(1, Math.min(30, +speedup));
    if (monsoon != null) { this.monsoon = !!monsoon; this.truth.find((t) => t.type === "water").active = this.monsoon; }
  }

  repairOne() {
    const t = this.truth.find((h) => h.type === "pothole" && h.active && this.known.some((k) => k.state === "confirmed" && haversine(k.lat, k.lon, h.lat, h.lon) < 25))
      || this.truth.find((h) => h.type === "pothole" && h.active);
    if (t) t.active = false;
    return t || null;
  }

  start() {
    if (this.running) return; this.running = true; this.last = Date.now();
    this.timer = setInterval(() => this.tick(), 200);
    this.refresh = setInterval(() => this.refreshKnown(), 1500); this.refreshKnown();
  }
  stop() { this.running = false; clearInterval(this.timer); clearInterval(this.refresh); this.cars = []; }

  async refreshKnown() {
    try {
      const list = await this.hazardsFn();
      this.known = list.filter((h) => h.family !== "water" && ["candidate", "confirmed"].includes(h.state)).map((h) => {
        const proj = {};
        for (const [rid, r] of Object.entries(this.routes)) { const p = project(r, h.lat, h.lon); if (p.d < 15) proj[rid] = p.s; }
        return { ...h, proj };
      });
    } catch (e) { this.log("refresh failed: " + e.message); }
  }

  spawn() {
    const ids = Object.keys(this.routes), rid = ids[Math.floor(Math.random() * ids.length)], r = this.routes[rid];
    const dir = Math.random() < 0.5 ? 1 : -1;
    const kmh = Math.max(14, Math.min(52, (r.length / r.duration_s) * 3.6 * (0.7 + Math.random() * 0.6)));
    this.cars.push({ device: "sim-" + Math.random().toString(36).slice(2, 10), rid, dir, s: dir > 0 ? 0 : r.length, v: kmh / 3.6, crawled: false });
    this.stats.spawned++;
  }

  tick() {
    const now = Date.now(), dt = Math.min(1, (now - this.last) / 1000) * this.speedup; this.last = now;
    this.spawnAcc += (this.carsPerMin / 60) * dt;
    while (this.spawnAcc >= 1) { this.spawn(); this.spawnAcc--; }
    const ts = this.now();
    for (const c of this.cars) {
      const r = this.routes[c.rid];
      const water = this.truth.find((t) => t.type === "water" && t.route === c.rid);
      const inWater = water && water.active && Math.abs(c.s - water.s) < 70;
      const v = inWater ? 1.4 : c.v;
      const s0 = c.s, s1 = c.s + c.dir * v * dt;
      const crossed = (s) => (s - s0) * (s - s1) <= 0;
      const hdg = (pointAt(r, Math.min(s0, s1)).heading + (c.dir < 0 ? 180 : 0)) % 360;
      const reported = [];
      for (const t of this.truth) {
        if (t.route !== c.rid || !t.active || t.type === "water" || !crossed(t.s)) continue;
        const sameDir = headingDiff(hdg, t.heading) < 90;
        const p = t.type === "breaker" ? 0.9 : sameDir ? 0.6 : 0; // potholes are in one carriageway
        if (Math.random() < p) {
          const [la, lo] = offset(t.lat, t.lon, Math.random() * 5, Math.random() * 360); // GPS error ~5 m
          const peak = (t.type === "breaker" ? 0.75 : 1.0) * (v * 3.6 / 30) * (0.75 + Math.random() * 0.5);
          this.ingest({ device: c.device, lat: la, lon: lo, heading: hdg, speed: v * 3.6, peak_g: +peak.toFixed(2), type: t.type, ts });
          this.stats.events++; reported.push(t);
        }
      }
      if (inWater && !c.crawled && Math.random() < 0.85) {
        const [la, lo] = offset(water.lat, water.lon, Math.random() * 20, Math.random() * 360);
        this.ingest({ device: c.device, lat: la, lon: lo, heading: hdg, speed: 5, peak_g: null, type: "crawl", rain: true, ts });
        c.crawled = true; this.stats.events++;
      }
      // Clean passes over hazards the server knows about, where this car felt nothing.
      for (const k of this.known) {
        const ks = k.proj[c.rid];
        if (ks == null || !crossed(ks)) continue;
        if (k.type === "pothole" && headingDiff(hdg, k.heading) > 90) continue;
        if (reported.some((t) => haversine(t.lat, t.lon, k.lat, k.lon) < 25)) continue;
        this.pass(k.id, c.device, ts); this.stats.passes++;
      }
      c.s = s1;
    }
    this.cars = this.cars.filter((c) => c.s >= 0 && c.s <= this.routes[c.rid].length);
  }

  snapshot() {
    return {
      running: this.running, carsPerMin: this.carsPerMin, speedup: this.speedup, monsoon: this.monsoon, stats: this.stats,
      cars: this.cars.map((c) => { const p = pointAt(this.routes[c.rid], c.s); return [+p.lat.toFixed(6), +p.lon.toFixed(6)]; }),
    };
  }
}

module.exports = { FleetSim, ROUTES, SCENARIO };

// CLI: drive a remote deployment through its public API.
if (require.main === module) {
  const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };
  const url = arg("url", "http://localhost:3000").replace(/\/$/, "");
  const post = (p, body) => fetch(url + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
  const sim = new FleetSim({
    ingest: (e) => post("/api/events", e),
    pass: (id, device, ts) => post("/api/passes", { hazardId: id, device, ts }),
    hazards: async () => (await (await fetch(url + "/api/hazards?states=candidate,confirmed")).json()).hazards,
    log: console.log,
  });
  sim.configure({ carsPerMin: +arg("cars", 20), speedup: +arg("speedup", 6), monsoon: process.argv.includes("--monsoon") });
  sim.start();
  setInterval(() => console.log(new Date().toISOString(), JSON.stringify(sim.snapshot().stats)), 5000);
}
