// ============================================================
//  Leo Tracker — service worker
//  Makes the app installable and loads the shell fast/offline.
//  We only cache our own files. Supabase calls always go to the
//  network (live data must be fresh), so they are never cached.
// ============================================================

const CACHE = "leo-v3";
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

// ============================================================
//  Push — the wake-watch function sends this even when the app
//  is closed. iOS shows it only for a PWA installed to the Home
//  Screen (Safari, iOS 16.4+) with notifications granted.
// ============================================================
self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) {}
  const title = data.title || "Leo Tracker";
  const body = data.body || "Wake window is closing — time to wind down. 😴";
  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png",
      tag: "wake-window",        // replaces any prior wake alert instead of stacking
      renotify: true,
      requireInteraction: true,  // stays until tapped/dismissed
    })
  );
});

// Tapping the notification focuses the open app, or opens it.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ("focus" in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow("./");
    })
  );
});
