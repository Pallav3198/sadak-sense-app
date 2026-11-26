// Pairing (car screen ↔ dashboard phone): the phone senses the road, the car screen shows and speaks it.
// A short code links them for 12 hours. The server only relays small JSON messages; nothing is stored.
const crypto = require("node:crypto");
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I

function createPairing({ ttlMs = 12 * 3600e3 } = {}) {
  const pairs = new Map(); // code -> { created, screens: Set<res>, last }
  const sweep = () => { for (const [c, p] of pairs) if (Date.now() - p.created > ttlMs) { for (const r of p.screens) r.end(); pairs.delete(c); } };
  function create() {
    sweep();
    let code; do { code = [...crypto.randomBytes(6)].map((b) => ALPHA[b % ALPHA.length]).join(""); } while (pairs.has(code));
    pairs.set(code, { created: Date.now(), screens: new Set(), last: null });
    return code;
  }
  const norm = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const get = (c) => { const p = pairs.get(norm(c)); return p && Date.now() - p.created <= ttlMs ? p : null; };
  function subscribe(code, res) {
    const p = get(code); if (!p) return false;
    p.screens.add(res); res.on("close", () => p.screens.delete(res));
    if (p.last) res.write(`data: ${JSON.stringify(p.last)}\n\n`);
    return true;
  }
  // Only known message types and plain values pass through (the screen renders them as text).
  const TYPES = new Set(["state", "say", "bubble", "route", "hello", "bye"]);
  function publish(code, msg) {
    const p = get(code); if (!p) return { ok: false, error: "unknown or expired code" };
    if (!msg || !TYPES.has(msg.type)) return { ok: false, error: "bad message" };
    const body = JSON.stringify(msg); if (body.length > 64000) return { ok: false, error: "too big" };
    if (msg.type === "state") p.last = msg;
    for (const r of p.screens) r.write(`data: ${body}\n\n`);
    return { ok: true, screens: p.screens.size };
  }
  return { create, subscribe, publish, exists: (c) => !!get(c), norm };
}

module.exports = { createPairing };
