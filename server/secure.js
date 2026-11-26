// Stateless security for a personal app on free hosting (no lasting disk):
// sign-ins live in encrypted, httpOnly cookies on the owner's phone, sealed with SESSION_SECRET.
// A server restart loses nothing; nobody without the secret can read or forge them.
const crypto = require("node:crypto");

function keyFrom(secret) { return crypto.createHash("sha256").update("sadak-sense:" + secret).digest(); }

function seal(obj, secret) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString("base64url");
}
function open(token, secret) {
  try {
    const b = Buffer.from(String(token), "base64url");
    const d = crypto.createDecipheriv("aes-256-gcm", keyFrom(secret), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    const obj = JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8"));
    return obj.exp && obj.exp < Date.now() ? null : obj;
  } catch { return null; }
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) { const i = part.indexOf("="); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
function setCookie(res, name, value, { maxAgeDays = 30, secure = true } = {}) {
  const attrs = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", value ? `Max-Age=${Math.round(maxAgeDays * 86400)}` : "Max-Age=0"];
  if (secure) attrs.push("Secure");
  const prev = res.getHeader("Set-Cookie"); res.setHeader("Set-Cookie", [...(Array.isArray(prev) ? prev : prev ? [prev] : []), attrs.join("; ")]);
}

const randomState = () => crypto.randomBytes(16).toString("base64url");

module.exports = { seal, open, cookies, setCookie, randomState };
