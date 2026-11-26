// Sadak Sense hazard engine: turns anonymous sensor events from many cars into
// confirmed, self-expiring road hazards. Pure logic on top of a SQLite handle.
const { haversine, headingDiff, distToPolyline } = require("./geo");

const CFG = {
  surfaceRadiusM: 20,        // events within 20 m belong to one hazard
  waterRadiusM: 60,          // waterlogging covers a stretch (underpass)
  headingTolDeg: 60,         // potholes are lane/direction specific
  confirmDevices: 3,         // distinct cars needed to confirm
  confirmWindowMs: 7 * 864e5,
  clearAfterCleanPasses: 8,  // consecutive passes with no jolt => repaired
  rejectCandidateAfter: 8,   // candidate that 8 cars pass without feeling => false alarm
  waterDevices: 3,
  waterWindowMs: 30 * 60e3,
  waterDecayMs: 120 * 60e3,  // no crawl reports for 2 h => water receded
  candidateTtlMs: 7 * 864e5,
};

const FAMILY = { breaker: "surface", pothole: "surface", bump: "surface", crawl: "water", brake: "nearmiss" };
// Near-miss zones (14.8): hard braking clusters within 30 m, same direction; 3 different cars in 14 days confirm;
// a zone with no hard braking for 30 days is cleared. Hours of the day are kept, so the warning comes at the right time.
const NEARMISS = { radiusM: 30, windowMs: 14 * 864e5, decayMs: 30 * 864e5 };

class Engine {
  constructor(db, { onChange } = {}) {
    this.db = db;
    this.onChange = onChange || (() => {});
    this.q = {
      active: db.prepare("SELECT * FROM hazards WHERE family = ? AND state IN ('candidate','confirmed') AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?"),
      insHz: db.prepare("INSERT INTO hazards (family,type,lat,lon,heading,state,created_ts,last_hit_ts,severity,n_events) VALUES (?,?,?,?,?,'candidate',?,?,?,0)"),
      insEv: db.prepare("INSERT INTO events (device,lat,lon,heading,speed,peak_g,type,rain,ts,hazard_id,source,car,first,pair) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"),
      insPass: db.prepare("INSERT INTO passes (hazard_id,device,ts,hit) VALUES (?,?,?,?)"),
      getHz: db.prepare("SELECT * FROM hazards WHERE id = ?"),
      evOfHz: db.prepare("SELECT lat,lon,heading,peak_g,speed,type,device,ts,first,pair FROM events WHERE hazard_id = ? ORDER BY ts DESC LIMIT 200"),
      // A car is its per-spot tag when it sends one (own-car memory across days), otherwise its daily ID.
      devices: db.prepare("SELECT COUNT(DISTINCT COALESCE(car, device)) AS n FROM events WHERE hazard_id = ? AND ts >= ?"),
      upd: db.prepare("UPDATE hazards SET lat=?,lon=?,heading=?,type=?,state=?,confirmed_ts=COALESCE(confirmed_ts,?),last_hit_ts=?,severity=?,clean_streak=0,n_events=n_events+1 WHERE id=?"),
      setState: db.prepare("UPDATE hazards SET state=?, cleared_ts=? WHERE id=?"),
      streak: db.prepare("UPDATE hazards SET clean_streak = clean_streak + 1 WHERE id = ?"),
      // Felt by a real phone or car (not the virtual demo fleet)?
      realOf: db.prepare("SELECT COUNT(DISTINCT COALESCE(car, device)) AS n FROM events WHERE hazard_id = ? AND source != 'sim'"),
    };
  }

  static validEvent(e) {
    return e && typeof e.device === "string" && e.device.length >= 6 && e.device.length <= 64 &&
      Number.isFinite(e.lat) && Number.isFinite(e.lon) && Math.abs(e.lat) <= 90 && Math.abs(e.lon) <= 180 &&
      FAMILY[e.type] && Number.isFinite(e.ts);
  }

  _nearby(family, lat, lon, heading, type, first) {
    const r = family === "water" ? CFG.waterRadiusM : family === "nearmiss" ? NEARMISS.radiusM : CFG.surfaceRadiusM;
    const dLat = r / 110540, dLon = r / (111320 * Math.cos((lat * Math.PI) / 180));
    let best = null, bestD = Infinity;
    for (const h of this.q.active.all(family, lat - dLat, lat + dLat, lon - dLon, lon + dLon)) {
      const d = haversine(lat, lon, h.lat, h.lon);
      // Speed breakers span the road: either direction matches. Potholes are lane specific.
      // An up-first jolt looks like a breaker, so it may join a feature felt from the other direction too.
      const dirOk = family === "water" || type === "breaker" || h.type === "breaker" || first === "up" || headingDiff(heading, h.heading) <= CFG.headingTolDeg;
      if (d <= r && dirOk && d < bestD) { best = h; bestD = d; }
    }
    return best;
  }

  ingest(e, source = "phone") {
    if (!Engine.validEvent(e)) return { ok: false, error: "invalid event" };
    const family = FAMILY[e.type];
    const type = e.type === "crawl" ? "water" : e.type === "bump" ? "breaker" : e.type === "brake" ? "nearmiss" : e.type;
    const first = e.first === "up" || e.first === "down" ? e.first : null;
    let h = this._nearby(family, e.lat, e.lon, e.heading, type, first);
    let created = false;
    if (!h) {
      const r = this.q.insHz.run(family, type, e.lat, e.lon, e.heading ?? null, e.ts, e.ts, e.peak_g ?? null);
      h = this.q.getHz.get(r.lastInsertRowid); created = true;
    }
    const car = typeof e.car === "string" && /^[0-9a-f]{8,32}$/.test(e.car) ? e.car : null;
    this.q.insEv.run(e.device, e.lat, e.lon, e.heading ?? null, e.speed ?? null, e.peak_g ?? null, e.type, e.rain ? 1 : 0, e.ts, h.id, source, car, first, typeof e.pair === "boolean" ? +e.pair : null);
    this.q.insPass.run(h.id, e.device, e.ts, 1);

    // Re-estimate the hazard from its recent events: robust centre, majority type, median severity.
    const evs = this.q.evOfHz.all(h.id);
    const lat = median(evs.map((v) => v.lat)), lon = median(evs.map((v) => v.lon));
    const hdg = circularMean(evs.map((v) => v.heading).filter((x) => x != null));
    const majority = family === "water" ? "water" : family === "nearmiss" ? "nearmiss" : decideType(evs, h.created_ts, e.ts).type;
    // Severity: peak vertical g normalised to 30 km/h (impact grows roughly with speed).
    const sev = median(evs.filter((v) => v.peak_g != null).map((v) => v.peak_g * (30 / Math.max(10, v.speed || 30))));
    const windowMs = family === "water" ? CFG.waterWindowMs : family === "nearmiss" ? NEARMISS.windowMs : CFG.confirmWindowMs;
    const n = this.q.devices.get(h.id, e.ts - windowMs).n;
    const need = family === "water" ? CFG.waterDevices : CFG.confirmDevices;
    const state = h.state === "confirmed" || n >= need ? "confirmed" : "candidate";
    const justConfirmed = state === "confirmed" && h.state !== "confirmed";
    this.q.upd.run(lat, lon, hdg, majority, state, justConfirmed ? e.ts : null, e.ts, Number.isFinite(sev) ? sev : null, h.id);
    const out = this.hazard(h.id);
    this.onChange({ kind: created ? "created" : justConfirmed ? "confirmed" : "updated", hazard: out, event: { lat: e.lat, lon: e.lon, type: e.type } });
    return { ok: true, hazardId: h.id, state, created, justConfirmed, devices: n };
  }

  // A car drove over a known hazard location without feeling anything.
  pass(hazardId, device, ts) {
    const h = this.q.getHz.get(hazardId);
    if (!h || !["candidate", "confirmed"].includes(h.state) || h.family !== "surface") return { ok: false };
    this.q.insPass.run(h.id, device, ts, 0);
    this.q.streak.run(h.id);
    const streak = h.clean_streak + 1;
    let state = h.state;
    if (h.state === "confirmed" && streak >= CFG.clearAfterCleanPasses) state = "cleared";
    if (h.state === "candidate" && streak >= CFG.rejectCandidateAfter) state = "rejected";
    if (state !== h.state) {
      this.q.setState.run(state, ts, h.id);
      this.onChange({ kind: state, hazard: this.hazard(h.id) });
    }
    return { ok: true, state, cleanStreak: streak };
  }

  // "Help improve the map" (optional, off by default): the driver says what a jolt was.
  // "none" counts as this car passing smoothly; a type is one more vote for that type from the same car.
  label({ device, car, lat, lon, heading, label, ts = Date.now() }) {
    if (!["pothole", "breaker", "none"].includes(label)) return { ok: false, error: "label must be pothole, breaker or none" };
    const h = this.list({ lat, lon, radius: 25, states: ["candidate", "confirmed"] }).filter((x) => x.family === "surface")[0];
    if (!h) return { ok: false, error: "no hazard here" };
    if (label === "none") return { ok: true, hazardId: h.id, ...this.pass(h.id, device, ts) };
    return { ok: true, hazardId: h.id, ...this.ingest({ device, car, lat, lon, heading, speed: null, peak_g: null, type: label, ts }, "label") };
  }

  // Periodic housekeeping: water recedes, stale candidates expire.
  sweep(now) {
    const changed = [];
    for (const h of this.db.prepare("SELECT * FROM hazards WHERE state IN ('candidate','confirmed')").all()) {
      if (h.family === "water" && now - h.last_hit_ts > CFG.waterDecayMs) { this.q.setState.run("cleared", now, h.id); changed.push(h.id); }
      else if (h.family === "nearmiss" && now - h.last_hit_ts > NEARMISS.decayMs) { this.q.setState.run("cleared", now, h.id); changed.push(h.id); }
      else if (h.state === "candidate" && now - h.created_ts > CFG.candidateTtlMs) { this.q.setState.run("rejected", now, h.id); changed.push(h.id); }
    }
    changed.forEach((id) => this.onChange({ kind: "swept", hazard: this.hazard(id) }));
    return changed.length;
  }

  hazard(id) {
    const h = this.q.getHz.get(id);
    if (!h) return null;
    const windowMs = h.family === "water" ? CFG.waterWindowMs : h.family === "nearmiss" ? NEARMISS.windowMs : CFG.confirmWindowMs;
    const ref = h.last_hit_ts || Date.now();
    const hours = h.family === "nearmiss" ? hourly(this.q.evOfHz.all(h.id)) : null;
    const why = h.family === "surface" ? decideType(this.q.evOfHz.all(h.id), h.created_ts, h.last_hit_ts || Date.now()) : null;
    return {
      why: why && why.reasons, hours,
      id: h.id, type: h.type, family: h.family, lat: round(h.lat, 6), lon: round(h.lon, 6), heading: h.heading == null ? null : Math.round(h.heading),
      state: h.state, severity: h.severity == null ? null : round(h.severity, 2), cleanStreak: h.clean_streak, events: h.n_events,
      devices: this.q.devices.get(h.id, ref - windowMs).n, realDevices: this.q.realOf.get(h.id).n, createdTs: h.created_ts, confirmedTs: h.confirmed_ts, clearedTs: h.cleared_ts, lastHitTs: h.last_hit_ts,
    };
  }

  list({ lat, lon, radius = 5000, states = ["candidate", "confirmed"], since, realOnly = false } = {}) {
    const rows = this.db.prepare(`SELECT id FROM hazards WHERE state IN (${states.map(() => "?").join(",")})${since ? " AND COALESCE(cleared_ts, last_hit_ts) >= ?" : ""}`).all(...states, ...(since ? [since] : []));
    return rows.map((r) => this.hazard(r.id)).filter((h) => (lat == null || haversine(lat, lon, h.lat, h.lon) <= radius) && (!realOnly || h.realDevices > 0));
  }

  // Confirmed hazards along a route polyline, in driving order.
  alongRoute(line, tolM = 25) {
    const confirmed = this.list({ states: ["confirmed"] });
    const hits = confirmed.filter((h) => h.family !== "nearmiss" && distToPolyline(h.lat, h.lon, line) <= (h.family === "water" ? 80 : tolM));
    const idx = (h) => { let bi = 0, bd = Infinity; line.forEach(([a, b], i) => { const d = haversine(h.lat, h.lon, a, b); if (d < bd) { bd = d; bi = i; } }); return bi; };
    return hits.sort((a, b) => idx(a) - idx(b));
  }

  stats(now) {
    const c = (sql, ...a) => this.db.prepare(sql).get(...a).n;
    return {
      confirmed: c("SELECT COUNT(*) n FROM hazards WHERE state='confirmed'"),
      candidates: c("SELECT COUNT(*) n FROM hazards WHERE state='candidate'"),
      cleared: c("SELECT COUNT(*) n FROM hazards WHERE state='cleared'"),
      rejected: c("SELECT COUNT(*) n FROM hazards WHERE state='rejected'"),
      eventsLastHour: c("SELECT COUNT(*) n FROM events WHERE ts >= ?", now - 3600e3),
      eventsTotal: c("SELECT COUNT(*) n FROM events"),
      devicesLastHour: c("SELECT COUNT(DISTINCT device) n FROM passes WHERE ts >= ?", now - 3600e3),
    };
  }
}

// Breaker vs pothole for a hazard (spec 14.3), from all its jolts:
// - each jolt's own verdict (1 vote), its first movement up/down (1 vote), its axle pair (0.5 vote for breaker);
// - felt from both directions (headings 120°+ apart) = +3 for breaker: potholes are in one lane;
// - felt for 60+ days without being cleared = +1 for breaker: breakers are permanent, potholes get repaired.
function decideType(evs, createdTs, now) {
  let b = 0, p = 0, up = 0, down = 0, pairs = 0;
  for (const v of evs) {
    if (v.type === "breaker" || v.type === "bump") b++; else if (v.type === "pothole") p++;
    if (v.first === "up") { b++; up++; } else if (v.first === "down") { p++; down++; }
    if (v.pair === 1) { b += 0.5; pairs++; }
  }
  const hs = evs.map((v) => v.heading).filter((x) => x != null);
  let bothWays = false;
  for (let i = 0; i < hs.length && !bothWays; i++) for (let j = i + 1; j < hs.length; j++) if (headingDiff(hs[i], hs[j]) >= 120) { bothWays = true; break; }
  if (bothWays) b += 3;
  const ageDays = Math.max(0, Math.floor((now - createdTs) / 864e5));
  if (ageDays >= 60 && evs.length >= 3) b += 1;
  const type = b > p ? "breaker" : "pothole";
  const reasons = [];
  if (up || down) reasons.push(`${up} jolt${up === 1 ? "" : "s"} lifted the car first, ${down} dropped it first`);
  if (pairs) reasons.push(`front and rear axles both hit in ${pairs} jolt${pairs === 1 ? "" : "s"}`);
  reasons.push(bothWays ? "felt from both directions (spans the road)" : "felt from one direction only");
  if (ageDays) reasons.push(`first felt ${ageDays} day${ageDays === 1 ? "" : "s"} ago${ageDays >= 60 ? " and still there (permanent)" : ""}`);
  return { type, score: { breaker: b, pothole: p }, reasons };
}

// Hard braking by hour of day (IST) at a near-miss zone, and the hours when it is common.
function hourly(evs) {
  const counts = Array(24).fill(0);
  for (const v of evs) counts[new Date(v.ts + 5.5 * 3600e3).getUTCHours()]++;
  const total = counts.reduce((a, b) => a + b, 0), max = Math.max(...counts);
  const peak = counts.map((c, h) => ({ h, c })).filter((x) => x.c >= 2 && x.c >= max * 0.5).map((x) => x.h);
  return { counts, total, peak };
}
// Is hard braking common here at this hour (the hour itself or a neighbour is a peak hour)?
function nearMissNow(h, now = Date.now()) {
  if (!h.hours || h.state !== "confirmed") return false;
  const hr = new Date(now + 5.5 * 3600e3).getUTCHours();
  return h.hours.peak.some((p) => Math.min(Math.abs(p - hr), 24 - Math.abs(p - hr)) <= 1);
}

function median(a) { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function mode(a) { const c = {}; let best = a[0], n = 0; for (const x of a) { c[x] = (c[x] || 0) + 1; if (c[x] > n) { n = c[x]; best = x; } } return best; }
function circularMean(a) { if (!a.length) return null; let s = 0, c = 0; for (const d of a) { s += Math.sin((d * Math.PI) / 180); c += Math.cos((d * Math.PI) / 180); } return ((Math.atan2(s, c) * 180) / Math.PI + 360) % 360; }
function round(x, n) { const k = 10 ** n; return Math.round(x * k) / k; }

module.exports = { Engine, CFG, decideType, hourly, nearMissNow, NEARMISS };
