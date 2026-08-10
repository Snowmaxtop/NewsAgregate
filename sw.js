// Dispatch service worker.
//
// Strategy:
// - The page and articles.json are "network-first": always try the freshest
//   version when online, fall back to cache offline.
// - Other assets (fonts, icons, thumbnails) are "cache-first".
// - Periodic background sync recomputes the unread badge even when the app
//   is only backgrounded (no page actively rendering).
//
// Note: service workers cannot read localStorage. To recompute the unread
// count in the background, the page stashes two things into Cache Storage
// (which the SW *can* read): the latest articles.json response, and a small
// JSON blob of the read/hidden link lists under STATE_CACHE_KEY. The SW
// reads both and counts unread = articles not in read and not in hidden.

const CACHE_NAME = 'dispatch-v3';
const STATE_CACHE_KEY = './__dispatch_state_cache';   // synthetic request key
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
      .catch(() => { /* don't fail install if one asset 404s */ })
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

  // Never intercept GitHub API calls (authenticated, concurrency-sensitive).
  if (url.hostname === 'api.github.com') return;

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

// --- Badge recomputation ------------------------------------------------

async function readCachedJson(request){
  try {
    const cache = await caches.open(CACHE_NAME);
    const res = await cache.match(request);
    if (!res) return null;
    return await res.json();
  } catch (e) { return null; }
}

async function computeAndSetBadge(){
  try {
    let articlesData = null;
    try {
      const res = await fetch('./articles.json', { cache: 'no-store' });
      if (res.ok) {
        articlesData = await res.clone().json();
        const cache = await caches.open(CACHE_NAME);
        cache.put('./articles.json', res.clone());
      }
    } catch (e) { /* offline */ }

    if (!articlesData) articlesData = await readCachedJson('./articles.json');
    if (!articlesData || !Array.isArray(articlesData.articles)) return;

    const stateBlob = await readCachedJson(STATE_CACHE_KEY) || { read: [], hidden: [] };
    const readSet = new Set(stateBlob.read || []);
    const hiddenSet = new Set(stateBlob.hidden || []);

    const unread = articlesData.articles.filter((a) => {
      const id = a.link;
      return !readSet.has(id) && !hiddenSet.has(id);
    }).length;

    if ('setAppBadge' in self.navigator) {
      if (unread > 0) await self.navigator.setAppBadge(unread);
      else await self.navigator.clearAppBadge();
    }
  } catch (e) { /* nothing we can do in the background */ }
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'dispatch-badge-refresh') {
    event.waitUntil(computeAndSetBadge());
  }
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'dispatch-state-update') {
    event.waitUntil((async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        const body = JSON.stringify({ read: data.read || [], hidden: data.hidden || [] });
        await cache.put(STATE_CACHE_KEY, new Response(body, { headers: { 'Content-Type': 'application/json' } }));
      } catch (e) { /* ignore */ }
      await computeAndSetBadge();
    })());
  } else if (data.type === 'dispatch-refresh-badge') {
    event.waitUntil(computeAndSetBadge());
  }
});
