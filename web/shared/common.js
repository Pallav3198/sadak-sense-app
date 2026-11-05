// Shared helpers for the console and the driver app.
window.SS = {
  api: (p, body) => fetch(p, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}).then((r) => r.json()),
  hav(a1, o1, a2, o2) { const R = 6371000, t = Math.PI / 180, dA = (a2 - a1) * t, dO = (o2 - o1) * t; const x = Math.sin(dA / 2) ** 2 + Math.cos(a1 * t) * Math.cos(a2 * t) * Math.sin(dO / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); },
  bearing(a1, o1, a2, o2) { const t = Math.PI / 180; const y = Math.sin((o2 - o1) * t) * Math.cos(a2 * t); const x = Math.cos(a1 * t) * Math.sin(a2 * t) - Math.sin(a1 * t) * Math.cos(a2 * t) * Math.cos((o2 - o1) * t); return (Math.atan2(y, x) / t + 360) % 360; },
  hdiff(a, b) { return Math.abs(((a - b) % 360 + 540) % 360 - 180); },
  LABEL: { breaker: "Speed breaker", pothole: "Pothole", water: "Waterlogging" },
  SYM: { breaker: "⌒", pothole: "●", water: "≈" },
  ago(ts) { const s = Math.max(0, (Date.now() - ts) / 1000); return s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; },
  tiles(map) {
    // OpenStreetMap standard tiles, rendered dark with a CSS filter. For production, swap in the
    // navigation partner's tile service (see README); OSM's public tiles are for light use only.
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, className: "dark-tiles",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
  },
  hazardIcon(h, extra = "") {
    const size = h.state === "confirmed" ? 22 : 18;
    const label = h.state === "candidate" ? `<span class="hzlabel">${h.devices}/3 cars</span>` : extra;
    return L.divIcon({ className: "", iconSize: [size, size], iconAnchor: [size / 2, size / 2],
      html: `<div class="hz ${h.type} ${h.state}" style="position:relative;width:${size}px;height:${size}px;font-size:${size * 0.6}px">${h.state === "confirmed" ? SS.SYM[h.type] : ""}${label}</div>` });
  },
};
