// Own-car memory (spec 14.2), kept only on this phone:
// - every jolt spot this car felt, by day; felt on 2+ different days = a strong signal for THIS driver's route,
//   so the driver is warned there even before other cars confirm it;
// - a per-spot car tag sent with reports, so on the public map this car counts as ONE car at that spot,
//   however many days it drives over it (tags for different spots can't be linked to each other);
// - "Help improve the map" (optional, off by default): asks what a new jolt was, only when stopped or slow.
const OwnCar = (() => {
  const CELL = 0.0003; // about 33 m
  const cellOf = (lat, lon) => `${Math.round(lat / CELL)},${Math.round(lon / CELL)}`;
  const today = () => new Date().toISOString().slice(0, 10);
  let mem = {};
  try { mem = JSON.parse(localStorage.getItem("ss-mine") || "{}"); } catch {}
  const save = () => { try { localStorage.setItem("ss-mine", JSON.stringify(mem)); } catch {} };
  const secret = () => { try { let s = localStorage.getItem("ss-secret"); if (!s) { s = crypto.randomUUID(); localStorage.setItem("ss-secret", s); } return s; } catch { return "session-" + Math.random(); } };
  const tags = new Map();
  async function tag(lat, lon) {
    const c = cellOf(lat, lon); if (tags.has(c)) return tags.get(c);
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret() + "|spot|" + c));
    const t = [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
    tags.set(c, t); return t;
  }
  let help = false; try { help = localStorage.getItem("ss-helpmap") === "1"; } catch {}
  const asks = [];

  // Called for every reported jolt: adds the car tag, remembers the spot, maybe queues a question.
  async function record(ev, isNew) {
    try { ev.car = await tag(ev.lat, ev.lon); } catch {}
    const c = cellOf(ev.lat, ev.lon), m = mem[c] || (mem[c] = { lat: ev.lat, lon: ev.lon, type: ev.type, heading: ev.heading, days: [], clean: 0 });
    if (!m.days.includes(today())) m.days = [...m.days, today()].slice(-10);
    m.type = ev.type; m.clean = 0; m.last = Date.now(); save();
    if (help && isNew) asks.push({ ...ev, asked: false });
  }
  // A personal hazard ahead: felt by this car on 2+ days, not (yet) on the fleet map.
  function ahead(lat, lon, heading, warnD, known) {
    let best = null;
    for (const [c, m] of Object.entries(mem)) {
      if (m.days.length < 2) continue;
      if (known.some((h) => h.state === "confirmed" && SS.hav(h.lat, h.lon, m.lat, m.lon) < 30)) continue;
      const d = SS.hav(lat, lon, m.lat, m.lon);
      if (d > Math.max(warnD, 250) || (heading != null && d > 12 && SS.hdiff(SS.bearing(lat, lon, m.lat, m.lon), heading) > 35)) continue;
      if (!best || d < best.d) best = { d, h: { id: "mine-" + c, type: m.type, family: "surface", devices: 1, days: m.days.length, personal: true, lat: m.lat, lon: m.lon, severity: null } };
    }
    return best;
  }
  // Driving smoothly over a remembered spot 3 times forgets it (repaired, or a one-off).
  const near = new Map();
  function passCheck(lat, lon, speed, recent) {
    for (const [c, m] of Object.entries(mem)) {
      const d = SS.hav(lat, lon, m.lat, m.lon), tr = near.get(c) || { min: Infinity };
      if (d < tr.min) tr.min = d;
      if (tr.min < 15 && d > tr.min + 10 && !tr.done && speed > 2) {
        tr.done = true;
        const felt = recent.some((r) => Date.now() - r.ts < 8000 && SS.hav(r.lat, r.lon, m.lat, m.lon) < 25);
        if (!felt && ++m.clean >= 3) delete mem[c];
        save();
      }
      if (d > 200) { tr.done = false; tr.min = Infinity; }
      near.set(c, tr);
    }
  }
  // The optional question, only when stopped or slow (< 15 km/h) and nothing else is happening.
  function maybeAsk(kmh, busy) {
    if (!help || busy || kmh > 15) return null;
    const q = asks.find((a) => !a.asked && Date.now() - a.ts < 15 * 60e3);
    if (q) q.asked = true;
    return q || null;
  }
  function setHelp(on) { help = !!on; try { localStorage.setItem("ss-helpmap", help ? "1" : "0"); } catch {} }
  return { tag, record, ahead, passCheck, maybeAsk, setHelp, get help() { return help; }, get spots() { return mem; }, cellOf };
})();
