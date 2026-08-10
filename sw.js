// Dispatch service worker.
//
// Strategy:
// - The page itself and articles.json are "network-first": always try to
//   get the freshest version when online, and only fall back to the
//   cached copy when there's no connection. This matters because a news
//   app showing stale-but-cached headlines while actually online would be
//   worse than showing nothing.
// - Everything else (fonts, icons, article thumbnail images) is
//   "cache-first": these rarely change, so serve the cached copy
//   immediately and don't force a network round-trip on every visit.
//
// Bump CACHE_NAME whenever this file or the app shell changes, so old
// caches get cleaned up automatically on the next activate.
const CACHE_NAME = 'dispatch-v1';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => { /* offline-friendly: don't fail install if one asset 404s */ })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isNavigation = req.mode === 'navigate';
  const isArticlesJson = url.pathname.endsWith('articles.json');

  if (isNavigation || isArticlesJson) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res && (res.status === 200 || res.type === 'opaque')) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
    })
  );
});
