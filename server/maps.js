// Real maps for Sadak Sense: TomTom place search and traffic-aware routes (env TOMTOM_API_KEY).
// Server-side only, so the key is never in the page. Free tier: 2,500 requests a day.
function createMaps({ key = process.env.TOMTOM_API_KEY, fetchImpl = globalThis.fetch } = {}) {
  const on = typeof key === "string" && key.length > 10;
  const cache = new Map();
  async function get(url, ms = 9000) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetchImpl(url, { signal: ctl.signal });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) { const e = new Error(b?.detailedError?.message || b?.error?.description || `TomTom ${r.status}`); e.status = r.status; throw e; }
      return b;
    } finally { clearTimeout(t); }
  }
  const need = () => { if (!on) throw Object.assign(new Error("maps off"), { status: 503 }); };

  // Places in India, nearest to the driver first.
  async function search(q, near) {
    need();
    const k = `s|${q}|${near ? near.lat.toFixed(2) + "," + near.lon.toFixed(2) : ""}`;
    if (cache.has(k)) return cache.get(k);
    const p = new URLSearchParams({ key, countrySet: "IN", limit: "6", language: "en-GB", typeahead: "false" });
    if (near) { p.set("lat", near.lat); p.set("lon", near.lon); }
    const b = await get(`https://api.tomtom.com/search/2/search/${encodeURIComponent(q.slice(0, 120))}.json?${p}`);
    const out = (b.results || []).map((r) => ({ name: r.poi?.name || r.address?.freeformAddress || q, address: r.address?.freeformAddress || "", lat: r.position.lat, lon: r.position.lon }));
    cache.set(k, out); if (cache.size > 300) cache.delete(cache.keys().next().value);
    return out;
  }

  // Fastest route with live traffic: duration, traffic delay, arrival time and the line to draw.
  const shape = (r) => ({ lengthM: r.summary.lengthInMeters, durationS: r.summary.travelTimeInSeconds, trafficDelayS: r.summary.trafficDelayInSeconds || 0, arrival: Date.parse(r.summary.arrivalTime),
    coords: r.legs.flatMap((l) => l.points.map((x) => [+x.latitude.toFixed(6), +x.longitude.toFixed(6)])) });
  // alternatives > 0 asks for other routes too (for the smoother-route choice, 14.9).
  async function routes(from, to, { departAt, alternatives = 0 } = {}) {
    need();
    const p = new URLSearchParams({ key, traffic: "true", travelMode: "car", routeType: "fastest", routeRepresentation: "polyline" });
    if (alternatives) p.set("maxAlternatives", String(alternatives));
    if (departAt && departAt > Date.now() + 60e3) p.set("departAt", new Date(departAt).toISOString().replace(/\.\d+Z$/, "Z"));
    const b = await get(`https://api.tomtom.com/routing/1/calculateRoute/${from.lat},${from.lon}:${to.lat},${to.lon}/json?${p}`);
    if (!b.routes?.length) throw Object.assign(new Error("no route"), { status: 404 });
    return b.routes.map(shape);
  }
  const route = async (from, to, departAt) => (await routes(from, to, { departAt }))[0];
  // Street name for a point (commute memory: "new pothole since yesterday near <street>").
  async function reverse(lat, lon) {
    need();
    const k = `r|${lat.toFixed(4)},${lon.toFixed(4)}`; if (cache.has(k)) return cache.get(k);
    const b = await get(`https://api.tomtom.com/search/2/reverseGeocode/${lat},${lon}.json?${new URLSearchParams({ key, language: "en-GB" })}`);
    const a = b.addresses?.[0]?.address || {};
    const out = { street: a.streetName || null, area: a.municipalitySubdivision || a.municipality || null, text: a.streetName || a.freeformAddress || null };
    cache.set(k, out); return out;
  }

  return { on, search, route, routes, reverse };
}

module.exports = { createMaps };
