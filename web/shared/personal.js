// Personalisation (spec 14.9). Pure functions, shared by the phone and the tests.
//  9.1 commute memory: brief only what changed on the usual route since last time
//  9.3 learned comfort profile: how this driver takes breakers → adjust the advised speed
//  9.4 focus before important meetings + quiet hours
//  9.5 monsoon personal warning before leaving
//  9.7 road-wear cost forecast for a route (assumptions stated)
// (9.2 gentler advice lives in mycar.js setProfile; 9.2 smoother route and 9.6 "reached safely" use the server.)
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SadakPersonal = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const hav = (a, b, c, d) => { const R = 6371000, r = Math.PI / 180, x = Math.sin(((c - a) * r) / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
  const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

  // 9.1 Snapshot of confirmed hazards on a route, and what changed since the last one.
  const snap = (hazards) => hazards.filter((h) => h.state === undefined || h.state === "confirmed").map((h) => ({ id: h.id, type: h.type, lat: h.lat, lon: h.lon }));
  function routeDiff(prev, hazards) {
    const now = snap(hazards);
    if (!prev) return { first: true, added: [], removed: [], snapshot: now };
    const same = (a, b) => a.id === b.id || (a.type === b.type && hav(a.lat, a.lon, b.lat, b.lon) < 25);
    return { first: false, added: now.filter((h) => !prev.some((p) => same(p, h))), removed: prev.filter((p) => !now.some((h) => same(p, h))), snapshot: now };
  }

  // 9.3 Comfort: from this car's own breaker crossings {speed (km/h), peakG, advised}.
  // Takes breakers fast and feels them hard → advise 5 km/h slower; consistently slow and smooth → no extra nagging.
  function comfort(samples) {
    const s = samples.filter((x) => Number.isFinite(x.speed) && Number.isFinite(x.peakG)).slice(-30);
    if (s.length < 5) return { style: "learning", adjust: 0, crossings: s.length };
    const sp = median(s.map((x) => x.speed)), g = median(s.map((x) => x.peakG)), adv = median(s.map((x) => x.advised || 20));
    if (sp > adv + 5 && g >= 0.8) return { style: "fast", adjust: -5, speed: sp, peakG: g, crossings: s.length };
    if (sp <= adv && g < 0.6) return { style: "gentle", adjust: 0, quiet: true, speed: sp, peakG: g, crossings: s.length };
    return { style: "normal", adjust: 0, speed: sp, peakG: g, crossings: s.length };
  }

  // 9.4 Focus before important meetings, and quiet hours. Returns { on, reason, until } — only VIP/urgent pass.
  const IMPORTANT = /\b(review|interview|exam|viva|presentation|pitch|client|board|demo|defen[cs]e|final|appraisal|evaluation)\b/i;
  function important(e, vips = []) {
    const v = vips.map((x) => String(x).toLowerCase());
    return IMPORTANT.test(e.title || "") || (e.attendees || []).length >= 4 || (e.organizer && v.includes(String(e.organizer).toLowerCase()));
  }
  function focus({ events = [], vips = [], quiet = null, now = Date.now() }) {
    const e = events.filter((x) => x.start > now && x.start - now <= 30 * 60e3 && important(x, vips)).sort((a, b) => a.start - b.start)[0];
    if (e) return { on: true, reason: "meeting", title: e.title, until: e.start };
    if (quiet && quiet.from && quiet.to) {
      const d = new Date(now + 5.5 * 3600e3), m = d.getUTCHours() * 60 + d.getUTCMinutes();
      const [fh, fm] = quiet.from.split(":").map(Number), [th, tm] = quiet.to.split(":").map(Number);
      const f = fh * 60 + fm, t = th * 60 + tm, inQ = f <= t ? m >= f && m < t : m >= f || m < t;
      if (inQ) return { on: true, reason: "quiet hours" };
    }
    return { on: false };
  }

  // 9.5 Monsoon personal warning before leaving: rain soon AND this driver's route has flooded before.
  function monsoon({ env, route = [], waterHistory = [], carClearanceMm = 190 }) {
    const rainSoon = env && ((env.rainMm || 0) >= 0.5 || (env.rainProbNext2h || 0) >= 60);
    if (!rainSoon || !route.length) return null;
    const near = waterHistory.filter((w) => route.some(([la, lo]) => hav(la, lo, w.lat, w.lon) < 150));
    if (!near.length) return null;
    const last = near.sort((a, b) => (b.lastHitTs || 0) - (a.lastHitTs || 0))[0];
    return { spot: last, times: near.length, lowCar: carClearanceMm < 175, rainNow: (env.rainMm || 0) >= 0.5, prob: env.rainProbNext2h || null, leaveEarlyMin: carClearanceMm < 175 ? 20 : 15 };
  }

  // 9.7 Road-wear cost forecast. Stated assumptions (rupees per crossing of a confirmed hazard, at city speeds):
  // pothole ₹1.50 (tyre, rim and alignment wear), hard breaker ₹0.40, other breaker ₹0.15; scaled by fleet severity.
  // Trips per year: 2 a day on work days (≈ 480). A rough estimate to compare routes, not a quote.
  const RS = { pothole: 1.5, breakerHard: 0.4, breaker: 0.15 };
  function wearCost(hazards, { tripsPerYear = 480 } = {}) {
    let perTrip = 0;
    for (const h of hazards) {
      const sev = Math.max(0.5, Math.min(2, h.severity ?? 1));
      if (h.type === "pothole") perTrip += RS.pothole * sev;
      else if (h.type === "breaker") perTrip += ((h.severity ?? 1) >= 1.2 ? RS.breakerHard : RS.breaker) * sev;
    }
    return { perTrip: Math.round(perTrip * 100) / 100, perYear: Math.round((perTrip * tripsPerYear) / 50) * 50, tripsPerYear, assumptions: "₹1.50 per pothole, ₹0.40 per hard breaker, ₹0.15 per other breaker, scaled by severity; 480 trips a year" };
  }

  return { routeDiff, comfort, focus, important, monsoon, wearCost, RS };
});
