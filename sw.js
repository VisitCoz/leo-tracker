// ============================================================
//  Leo Tracker: service worker
//  Makes the app installable and loads it fast/offline.
//  Only our own files are cached. Supabase calls always go to
//  the network (live data must be fresh), so they are never cached.
// ============================================================

const CACHE = "leo-v20";
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "config.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

// A new version installs straight away and replaces the old one (no waiting
// for every tab to close), then deletes the old caches.
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return; // Supabase and CDNs: always live
  if (e.request.method !== "GET") return;

  // Network first: the freshest file when online (and refresh the cache with it),
  // the cached copy only when offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
