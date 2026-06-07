// ============================================================
//  Leo Tracker — service worker
//  Makes the app installable and loads the shell fast/offline.
//  We only cache our own files. Supabase calls always go to the
//  network (live data must be fresh), so they are never cached.
// ============================================================

const CACHE = "leo-v2";
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
  // Never touch Supabase or other cross-origin/API traffic — always live.
  if (url.origin !== self.location.origin) return;
  if (e.request.method !== "GET") return;

  // Network-first: always try for the freshest file; refresh the cache with
  // it; fall back to the cached copy only when offline. This means code
  // updates show up on a normal reload, while the app still works offline.
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
