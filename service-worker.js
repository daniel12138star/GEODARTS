const CACHE_NAME = "geodarts-shell-v1";
const APP_SHELL = ["/index.html", "/manifest.json"];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith("geodarts-shell-") && key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (url.pathname === "/" || url.pathname === "/index.html") {
    event.respondWith(fetch(event.request).catch(() => caches.match("/index.html")));
  } else if (url.pathname === "/manifest.json") {
    event.respondWith(caches.match("/manifest.json").then(cached => cached || fetch(event.request)));
  }
});
