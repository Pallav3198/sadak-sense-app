// Sadak Sense service worker: makes the app installable and lets it open with a weak signal.
// Network first for everything; the app shell is cached as a fallback. API calls are never cached.
const SHELL = "ss-shell-v1";
const FILES = ["/drive/", "/drive/drive.js", "/drive/own-car.js", "/drive/copilot-ui.js", "/drive/moment-ui.js", "/shared/moment.js", "/drive/manifest.webmanifest", "/drive/icon-192.png",
  "/shared/common.js", "/shared/detector.js", "/shared/hinglish.js", "/shared/voice.js", "/shared/mail.js", "/shared/env.js", "/shared/mycar.js", "/shared/ui.css",
  "/vendor/leaflet/leaflet.js", "/vendor/leaflet/leaflet.css"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).catch(() => {})); self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== SHELL).map((k) => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api/") || u.pathname.startsWith("/auth/")) return;
  e.respondWith(fetch(e.request).then((r) => { if (r.ok && FILES.includes(u.pathname)) { const c = r.clone(); caches.open(SHELL).then((s) => s.put(e.request, c)); } return r; })
    .catch(() => caches.match(e.request).then((m) => m || caches.match("/drive/"))));
});
