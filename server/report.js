// Sadak Sense reports to road authorities. Real emails, sent through Resend (env RESEND_API_KEY).
// Pilot rule: everything goes to REPORT_TO (our own test inbox), never to a real government office,
// until a city agrees to receive it. Each hazard is reported at most once a week, never once per driver.
const TYPE = { pothole: "Pothole", breaker: "Unmarked / harsh speed breaker", water: "Waterlogging" };
const ONE_WEEK = 7 * 864e5;

// Where a real complaint would go today (verified channels only; no city exposes a public API).
const CHANNELS = [
  { name: "Delhi PWD helpline", how: "Call 1908 (toll free)", href: "tel:1908" },
  { name: "Delhi PWD complaint centre", how: "1800-11-0093 (toll free)", href: "tel:18001100093" },
  { name: "MCD-311 app (municipal roads)", how: "Open the app; photo is required", href: "https://apps.apple.com/in/app/mcd-311/id1626991180" },
  { name: "NHAI (national highways)", how: "Call 1033, or the Rajmargyatra app while on the highway", href: "tel:1033" },
];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const day = (ts) => new Date(ts).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const mapLink = (h) => `https://www.openstreetmap.org/?mlat=${h.lat}&mlon=${h.lon}#map=19/${h.lat}/${h.lon}`;
const sevWord = (s) => s == null ? "not measured" : s >= 1.4 ? "severe" : s >= 1 ? "high" : s >= 0.7 ? "moderate" : "mild";
const dir = (h) => h.heading == null || h.type !== "pothole" ? "both directions" : `vehicles heading ${["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(h.heading / 45) % 8]}`;

function complaint(h, now = Date.now()) {
  const ref = `SS-${h.id}-${new Date(now).toISOString().slice(0, 10).replace(/-/g, "")}`;
  const subject = `[${ref}] ${TYPE[h.type] || h.type} at ${h.lat}, ${h.lon} — confirmed by ${h.devices} vehicles`;
  const lines = [
    `Reference: ${ref}`,
    `Issue: ${TYPE[h.type] || h.type}`,
    `Location: ${h.lat}, ${h.lon} (${mapLink(h)})`,
    `Affects: ${dir(h)}`,
    `Severity: ${sevWord(h.severity)} (median vertical jolt ${h.severity ?? "n/a"} g, normalised to 30 km/h)`,
    `Evidence: felt independently by ${h.devices} different vehicles (${h.events} sensor events); first felt ${day(h.createdTs)}, last felt ${day(h.lastHitTs)}.`,
    `Request: please inspect and repair. We will confirm automatically when vehicles stop feeling it (8 clean passes).`,
    ``,
    `Sent by Sadak Sense, a connected-car road sensing pilot. Data is anonymous: no driver, vehicle or phone is identified.`,
  ];
  const html = `<div style="font:14px/1.5 system-ui,sans-serif;color:#1d2b3a;max-width:640px">
<h2 style="margin:0 0 8px;font-size:18px">${esc(TYPE[h.type] || h.type)} — confirmed by ${h.devices} vehicles</h2>
<table style="border-collapse:collapse">${lines.slice(0, 7).map((l) => { const [k, ...v] = l.split(": "); return `<tr><td style="padding:4px 12px 4px 0;color:#5b6b7c;vertical-align:top">${esc(k)}</td><td style="padding:4px 0">${k === "Location" ? `<a href="${mapLink(h)}">${h.lat}, ${h.lon}</a>` : esc(v.join(": "))}</td></tr>`; }).join("")}</table>
<p style="color:#5b6b7c;font-size:12px;margin-top:16px">${esc(lines[8])}</p></div>`;
  return { ref, subject, text: lines.join("\n"), html };
}

function cityReport(hazards, { now = Date.now(), area = "Delhi", realOnly = false } = {}) {
  const list = hazards.filter((h) => h.state === "confirmed" && h.family !== "water").sort((a, b) => (b.severity || 0) - (a.severity || 0));
  const since = now - ONE_WEEK, fresh = list.filter((h) => h.confirmedTs >= since);
  const ref = `SS-CITY-${new Date(now).toISOString().slice(0, 10).replace(/-/g, "")}`;
  const subject = `[${ref}] Weekly road hazard report, ${area}: ${list.length} confirmed (${fresh.length} new this week)`;
  const rows = list.map((h, i) => `<tr><td>${i + 1}</td><td>${esc(TYPE[h.type] || h.type)}</td><td><a href="${mapLink(h)}">${h.lat}, ${h.lon}</a></td><td>${sevWord(h.severity)}</td><td>${h.devices}</td><td>${day(h.createdTs)}</td><td>${h.confirmedTs >= since ? "new" : ""}</td></tr>`).join("");
  const html = `<!doctype html><meta charset="utf-8"><title>${esc(subject)}</title>
<div style="font:14px/1.5 system-ui,sans-serif;color:#1d2b3a;max-width:900px;margin:24px auto;padding:0 16px">
<h1 style="font-size:20px;margin:0">Weekly road hazard report — ${esc(area)}</h1>
<p style="color:#5b6b7c;margin:4px 0 16px">Reference ${ref} · generated ${day(now)} · ${realOnly ? "real drives only" : "all sources"} · each hazard confirmed by at least 3 different vehicles</p>
<p><b>${list.length}</b> confirmed hazards, <b>${fresh.length}</b> new this week. Sorted by severity.</p>
<table style="border-collapse:collapse;width:100%" cellpadding="6" border="1" bordercolor="#d5dde6">
<tr style="background:#eef3f8;text-align:left"><th>#</th><th>Type</th><th>Location (map)</th><th>Severity</th><th>Vehicles</th><th>First felt</th><th></th></tr>${rows || '<tr><td colspan="7">No confirmed hazards.</td></tr>'}</table>
<p style="color:#5b6b7c;font-size:12px;margin-top:16px">Sent by Sadak Sense, a connected-car road sensing pilot. Anonymous data; no driver or vehicle is identified. Hazards are removed automatically after 8 vehicles pass without feeling them.</p></div>`;
  const text = `${subject}\n\n` + list.map((h, i) => `${i + 1}. ${TYPE[h.type] || h.type} at ${h.lat}, ${h.lon} — ${sevWord(h.severity)}, ${h.devices} vehicles, first felt ${day(h.createdTs)} — ${mapLink(h)}`).join("\n");
  return { ref, subject, html, text, count: list.length, fresh: fresh.length };
}

function createMailer({ key = process.env.RESEND_API_KEY, to = process.env.REPORT_TO, from = process.env.REPORT_FROM || "Sadak Sense <onboarding@resend.dev>", fetchImpl = globalThis.fetch } = {}) {
  const on = !!(key && to);
  async function send({ subject, html, text }) {
    if (!on) return { status: "prepared", why: "email not configured (RESEND_API_KEY, REPORT_TO)" };
    try {
      const r = await fetchImpl("https://api.resend.com/emails", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ from, to: [to], subject, html, text }) });
      const b = await r.json().catch(() => ({}));
      return r.ok ? { status: "sent", providerId: b.id || null } : { status: "failed", why: b.message || `HTTP ${r.status}` };
    } catch (e) { return { status: "failed", why: e.message }; }
  }
  return { on, to: on ? to : null, send };
}

module.exports = { complaint, cityReport, createMailer, CHANNELS, ONE_WEEK };
