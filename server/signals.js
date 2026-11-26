// Traffic signals for drive-aware notifications (spec 14.4).
// - Where signals are: OpenStreetMap (Overpass API, cached), plus stop lines learned from the fleet.
// - Is the car at a red light or in a jam: the phone decides from where and how it stopped; the fleet adds
//   whether cars at this approach stop and then all start together (a signal) or creep (a jam).
// - How long is the red: learned per signal approach and hour from cars at the front of the queue;
//   the current phase comes from Hyundais already stopped there. Cold start: a cautious default.
const { haversine, headingDiff } = require("./geo");

const DEFAULT_RED_S = 45;        // cautious cold-start red length (Delhi fixed timers are mostly 60–120 s)
const FRONT_M = 25;              // stopped within 25 m of the signal = front of the queue
const NEAR_M = 70;               // a stop within 70 m (ahead) of a signal is at that signal
const approachOf = (heading) => (heading == null ? -1 : Math.round(((heading % 360) + 360) % 360 / 45) % 8); // 8 sectors

function createSignals({ db, fetchImpl = globalThis.fetch, overpass = process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter" } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS stops (
    id INTEGER PRIMARY KEY AUTOINCREMENT, signal_id TEXT NOT NULL, approach INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL,
    start_ts INTEGER NOT NULL, end_ts INTEGER NOT NULL, front INTEGER NOT NULL, hour INTEGER NOT NULL, device TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS st_sig ON stops(signal_id, approach);
    CREATE TABLE IF NOT EXISTS learned_signals (id TEXT PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL, n INTEGER NOT NULL);`);
  const q = {
    addStop: db.prepare("INSERT INTO stops (signal_id,approach,lat,lon,start_ts,end_ts,front,hour,device) VALUES (?,?,?,?,?,?,?,?,?)"),
    frontDur: db.prepare("SELECT end_ts - start_ts AS d FROM stops WHERE signal_id = ? AND approach = ? AND front = 1 AND hour = ? ORDER BY start_ts DESC LIMIT 60"),
    frontAny: db.prepare("SELECT end_ts - start_ts AS d FROM stops WHERE signal_id = ? AND approach = ? AND front = 1 ORDER BY start_ts DESC LIMIT 60"),
    frontPos: db.prepare("SELECT lat, lon FROM stops WHERE signal_id = ? AND approach = ? AND front = 1 ORDER BY start_ts DESC LIMIT 30"),
    ends: db.prepare("SELECT end_ts FROM stops WHERE signal_id = ? AND approach = ? AND end_ts >= ? ORDER BY end_ts"),
    learned: db.prepare("SELECT id, lat, lon, n FROM learned_signals"),
    upLearned: db.prepare("INSERT INTO learned_signals (id,lat,lon,n) VALUES (?,?,?,1) ON CONFLICT(id) DO UPDATE SET lat = (lat * n + excluded.lat) / (n + 1), lon = (lon * n + excluded.lon) / (n + 1), n = n + 1"),
  };
  const cache = new Map(); // OSM tile -> { at, list }
  const live = new Map();  // stopKey -> { signalId, approach, start, device, lat, lon }

  // OpenStreetMap traffic signals in a ~2 km tile around a point (cached for a day).
  async function osm(lat, lon) {
    const tile = `${Math.floor(lat / 0.02)},${Math.floor(lon / 0.02)}`, c = cache.get(tile);
    if (c && Date.now() - c.at < 864e5) return c.list;
    const s = Math.floor(lat / 0.02) * 0.02, w = Math.floor(lon / 0.02) * 0.02;
    const query = `[out:json][timeout:15];node[highway=traffic_signals](${s.toFixed(4)},${w.toFixed(4)},${(s + 0.02).toFixed(4)},${(w + 0.02).toFixed(4)});out;`;
    try {
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 12000);
      const r = await fetchImpl(`${overpass}?data=${encodeURIComponent(query)}`, { signal: ctl.signal, headers: { "user-agent": "sadak-sense/1.0" } }).finally(() => clearTimeout(t));
      const b = r.ok ? await r.json() : { elements: [] };
      const list = (b.elements || []).map((n) => ({ id: `osm:${n.id}`, lat: n.lat, lon: n.lon, source: "OpenStreetMap" }));
      cache.set(tile, { at: Date.now(), list }); return list;
    } catch { cache.set(tile, { at: Date.now() - 864e5 + 600e3, list: c?.list || [] }); return c?.list || []; }
  }
  // OSM signals + signals the fleet discovered (cars repeatedly stopping and all starting together where OSM has none).
  async function near(lat, lon, radius = 600) {
    const list = [...(await osm(lat, lon)), ...q.learned.all().filter((x) => x.n >= 5).map((x) => ({ id: x.id, lat: x.lat, lon: x.lon, source: "fleet" }))];
    return list.map((x) => ({ ...x, d: haversine(lat, lon, x.lat, x.lon) })).filter((x) => x.d <= radius).sort((a, b) => a.d - b.d);
  }

  const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  // Red length for one approach: cars at the front arrive at random points of the red, so the longest
  // typical front wait (90th percentile) is the red length. Needs 5+ samples; otherwise the cautious default.
  function red(signalId, approach, hour) {
    let d = q.frontDur.all(signalId, approach, hour).map((r) => r.d / 1000).filter((x) => x >= 5 && x <= 240);
    let scope = "this hour";
    if (d.length < 5) { d = q.frontAny.all(signalId, approach).map((r) => r.d / 1000).filter((x) => x >= 5 && x <= 240); scope = "all hours"; }
    if (d.length < 5) return { redS: DEFAULT_RED_S, learned: false, samples: d.length, scope: "default" };
    return { redS: Math.round(pct(d, 0.9)), learned: true, samples: d.length, scope };
  }
  // Fleet-learned stop line: median position of front-of-queue stops at this approach.
  function stopLine(signalId, approach) {
    const pts = q.frontPos.all(signalId, approach); if (pts.length < 3) return null;
    const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
    return { lat: med(pts.map((p) => p.lat)), lon: med(pts.map((p) => p.lon)), samples: pts.length };
  }
  // Signal pattern: share of recent stops at this approach that ended within 6 s of another (all start together).
  function released(signalId, approach, now = Date.now()) {
    const e = q.ends.all(signalId, approach, now - 3600e3).map((r) => r.end_ts);
    if (e.length < 4) return null;
    let together = 0; for (let i = 0; i < e.length; i++) if ((i > 0 && e[i] - e[i - 1] <= 6000) || (i < e.length - 1 && e[i + 1] - e[i] <= 6000)) together++;
    return Math.round((together / e.length) * 100) / 100;
  }

  // Live state for a car stopped (or about to stop) at a signal approach.
  async function state({ lat, lon, heading, now = Date.now() }) {
    const sigs = (await near(lat, lon, NEAR_M)).filter((s) => s.d < 12 || heading == null || headingDiff(heading, bearingTo(lat, lon, s)) < 50);
    const s = sigs[0];
    if (!s) return { signal: null };
    const approach = approachOf(heading), hour = new Date(now + 5.5 * 3600e3).getUTCHours();
    const r = red(s.id, approach, hour);
    // Current phase: the earliest stop among Hyundais still stopped at this approach right now.
    const stopped = [...live.values()].filter((x) => x.signalId === s.id && x.approach === approach && now - x.start < 240e3);
    const phaseStart = stopped.length ? Math.min(...stopped.map((x) => x.start)) : null;
    return { signal: { id: s.id, lat: s.lat, lon: s.lon, source: s.source, distanceM: Math.round(s.d) }, approach, ...r, stopLine: stopLine(s.id, approach), phaseStart, carsStopped: stopped.length, releasedTogether: released(s.id, approach, now) };
  }

  // The phone reports each stop's start and end (anonymous daily ID).
  function stopStart({ key, device, signalId, heading, lat, lon, start }) {
    live.set(key, { device, signalId, approach: approachOf(heading), lat, lon, start });
    for (const [k, v] of live) if (Date.now() - v.start > 600e3) live.delete(k);
  }
  function stopEnd({ key, device, signalId, heading, lat, lon, start, end, front, kind }) {
    live.delete(key);
    if (!(end > start) || end - start > 300e3) return { ok: false };
    if (!signalId && kind !== "signal") return { ok: false, why: "jam stop, not learned" };
    let id = signalId;
    // No known signal here but the car waited like at one: remember the spot; 5+ such stops make it a fleet-learned signal.
    if (!id) { id = `fleet:${Math.round(lat / 0.0004)},${Math.round(lon / 0.0004)}`; q.upLearned.run(id, lat, lon); }
    q.addStop.run(id, approachOf(heading), lat, lon, start, end, front ? 1 : 0, new Date(start + 5.5 * 3600e3).getUTCHours(), device);
    return { ok: true, signalId: id };
  }
  return { near, state, stopStart, stopEnd, red, DEFAULT_RED_S, FRONT_M, NEAR_M };
}

function bearingTo(lat, lon, s) { const { bearing } = require("./geo"); return bearing(lat, lon, s.lat, s.lon); }

module.exports = { createSignals, approachOf, DEFAULT_RED_S };
