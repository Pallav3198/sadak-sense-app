// Small geodesy helpers (WGS84, metres, degrees).
const R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

function haversine(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function headingDiff(a, b) {
  if (a == null || b == null || Number.isNaN(a) || Number.isNaN(b)) return 0;
  const d = Math.abs(((a - b) % 360 + 540) % 360 - 180);
  return d;
}

// Offset a point by distance (m) along bearing (deg).
function offset(lat, lon, dist, brg) {
  const d = dist / R, b = toRad(brg), p1 = toRad(lat), l1 = toRad(lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [toDeg(p2), toDeg(l2)];
}

// Distance from point to a polyline [[lat,lon],...] (m), approximate (local equirectangular).
function distToPolyline(lat, lon, line) {
  let best = Infinity;
  const kx = Math.cos(toRad(lat)) * 111320, ky = 110540;
  for (let i = 0; i < line.length - 1; i++) {
    const [ay, ax] = line[i], [by, bx] = line[i + 1];
    const Ax = (ax - lon) * kx, Ay = (ay - lat) * ky, Bx = (bx - lon) * kx, By = (by - lat) * ky;
    const dx = Bx - Ax, dy = By - Ay, L = dx * dx + dy * dy;
    let t = L ? -(Ax * dx + Ay * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    const px = Ax + t * dx, py = Ay + t * dy;
    best = Math.min(best, Math.hypot(px, py));
  }
  return best;
}

module.exports = { haversine, bearing, headingDiff, offset, distToPolyline, toRad, toDeg };
