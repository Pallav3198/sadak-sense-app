// Commute awareness and the driver's profile (spec 14.5). Pure logic, shared by the phone and the tests.
// - Profile from the optional 30-second onboarding; sensible defaults when skipped (no cold start).
// - Time rules: weekday 7–11 am work notifications on (at calm moments); evenings and weekends personal only,
//   work held unless VIP or urgent (or the driver's evening preference / today's voice override says otherwise).
// - Learns the real commute (home, office, usual arrival) from about a week of trips.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SadakCommute = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const DEFAULT = { workDays: [1, 2, 3, 4, 5], officeTime: null, home: null, office: null, learn: true, vips: [], evening: "urgent",
    passengers: 1, elders: false, kids: false, workDomains: [], skipped: true, override: null, lastReminder: 0, learned: null };
  const IST = (ts) => { const d = new Date(ts + 5.5 * 3600e3); return { day: d.getUTCDay(), hour: d.getUTCHours() + d.getUTCMinutes() / 60, date: d.toISOString().slice(0, 10) }; };

  function profile(saved) { return { ...DEFAULT, ...(saved || {}) }; }

  // Work or personal? Teams and Outlook are work; Gmail is personal unless the sender is at a work domain.
  function category(item, p) {
    if (item.source === "teams" || item.source === "outlook") return "work";
    const dom = String(item.fromAddr || "").split("@")[1]?.toLowerCase();
    return dom && p.workDomains.map((x) => x.toLowerCase()).includes(dom) ? "work" : "personal";
  }

  // Which part of the week is it, and are work messages on right now?
  function window_(p, now = Date.now()) {
    const t = IST(now), workday = p.workDays.includes(t.day);
    const ov = p.override && p.override.date === t.date ? p.override.work : null;
    if (workday && t.hour >= 7 && t.hour < 11) return { name: "morning commute", work: ov ?? "on" };
    if (workday && t.hour >= 11 && t.hour < 17) return { name: "work hours", work: ov ?? "on" };
    const evening = { yes: "on", urgent: "urgent", no: "off" }[p.evening] || "urgent";
    return { name: workday ? "evening" : "weekend", work: ov ?? (workday ? evening : "urgent") };
  }

  // true = hold this item for now. VIP and urgent are decided by the caller (they always pass the schedule).
  function holds(item, p, now = Date.now()) {
    if (category(item, p) !== "work") return false;
    const w = window_(p, now);
    return w.work !== "on";
  }

  // Voice override: "Aaj shaam bhi office messages batana" → work on for the rest of today; the opposite → off.
  const ON = /(aaj|today).*(office|work|kaam).*(batana|batao|bata do|tell|on)|office messages (bhi )?(batana|on)|आज.*(ऑफ़िस|ऑफिस|काम).*(बताना|बताओ)/i;
  const OFF = /(aaj|today).*(office|work|kaam).*\b(mat|nahi|off|band|don't|do not)\b|office messages (mat|band|off)\b|आज.*(ऑफ़िस|ऑफिस|काम).*(मत|नहीं)/i;
  function override(text, now = Date.now()) {
    const t = IST(now).date;
    if (OFF.test(text)) return { date: t, work: "off" };
    if (ON.test(text)) return { date: t, work: "on" };
    return null;
  }

  // Learn home, office and the usual arrival time from trips: [{ start: {lat,lon,ts}, end: {lat,lon,ts} }].
  const near = (a, b) => { const R = 6371000, r = Math.PI / 180, x = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)) < 250; };
  function cluster(points) { const cs = []; for (const p of points) { const c = cs.find((c) => near(c, p)); if (c) { c.n++; c.lat += (p.lat - c.lat) / c.n; c.lon += (p.lon - c.lon) / c.n; c.ts.push(p.ts); } else cs.push({ lat: p.lat, lon: p.lon, n: 1, ts: [p.ts] }); } return cs.sort((a, b) => b.n - a.n); }
  function learn(trips) {
    const weekday = trips.filter((t) => { const d = IST(t.start.ts); return d.day >= 1 && d.day <= 5; });
    const days = new Set(weekday.map((t) => IST(t.start.ts).date));
    if (weekday.length < 5 || days.size < 5) return null;
    const morning = weekday.filter((t) => { const h = IST(t.start.ts).hour; return h >= 6 && h < 12; });
    if (morning.length < 3) return null;
    const home = cluster(morning.map((t) => t.start))[0], office = cluster(morning.map((t) => t.end))[0];
    if (!home || !office || home.n < 3 || office.n < 3 || near(home, office)) return null;
    const arr = office.ts.map((ts) => IST(ts).hour).sort((a, b) => a - b), med = arr[arr.length >> 1];
    const hh = Math.floor(med), mm = Math.round((med - hh) * 60);
    return { home: { lat: home.lat, lon: home.lon }, office: { lat: office.lat, lon: office.lon }, arrive: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`, trips: weekday.length, days: days.size };
  }

  // Gentle reminder every 3 days while the office time is unknown (never while driving: the caller checks).
  function remind(p, now = Date.now()) { return !p.officeTime && !p.learned && now - (p.lastReminder || 0) > 3 * 864e5; }

  return { DEFAULT, profile, category, window: window_, holds, override, learn, remind, IST };
});
