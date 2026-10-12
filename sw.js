// Dispatch service worker.
//
// Strategy:
// - Same-origin page, scripts and data files (articles.json, releases.json,
//   recent archive days…) are "network-first": the freshest version when
//   online, the cached copy offline.
// - Other same-origin assets (icons, manifest, older archive days that never
//   change) and Google Fonts are "cache-first".
// - Third-party images (thumbnails, covers) are NOT stored here: the
//   browser's normal HTTP cache handles them, and storing hundreds of opaque
//   images in Cache Storage would grow without limit.
// - Periodic background sync recomputes the unread badge while the app is
//   closed, from the cached articles.json + the read/hidden/favorite lists
//   the page last sent (service workers can't read localStorage).

const CACHE_NAME = 'dispatch-v19';
const STATE_CACHE_KEY = './__dispatch_state_cache';   // synthetic request key
const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './releases.js',
  './archive.js',
  './twitch.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/badge-96.png',
];
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

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

const putInCache = (req, res) => caches.open(CACHE_NAME).then((cache) => cache.put(req, res)).catch(() => {});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // Cross-origin: only Google Fonts are cached; everything else (GitHub
  // API, thumbnails, covers) goes straight to the network as usual.
  if (!sameOrigin) {
    if (!FONT_HOSTS.has(url.hostname)) return;
    event.respondWith(caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') putInCache(req, res.clone());
      return res;
    })));
    return;
  }

  // Archive: index.json and the last two days still change → network-first.
  // Older day files never change → cache-first (default branch below).
  const arcDay = /\/archive\/(\d{4}-\d{2}-\d{2})\.json$/.exec(url.pathname);
  const recentArchive = url.pathname.endsWith('/archive/index.json') ||
    (arcDay && arcDay[1] >= new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10));
  const isNavigation = req.mode === 'navigate';
  const networkFirst = isNavigation || recentArchive ||
    /\/(articles|releases|wishlists|tracker|push-state|twitch|twitch-history)\.json$/.test(url.pathname) ||
    /\/(app|releases|archive|twitch)\.js$/.test(url.pathname);

  if (networkFirst) {
    event.respondWith(
      fetch(req)
        .then((res) => { if (res.ok) putInCache(req, res.clone()); return res; })
        .catch(() => caches.match(req).then((cached) =>
          cached || (isNavigation ? caches.match('./index.html') : Response.error())))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      if (res.ok) putInCache(req, res.clone());
      return res;
    }))
  );
});

// --- Badge recomputation (background) ------------------------------------
async function readCachedJson(request){
  try {
    const res = await (await caches.open(CACHE_NAME)).match(request);
    return res ? await res.json() : null;
  } catch (e) { return null; }
}

// Unread = in the feed, not read, not deleted, not a favorite — the same
// number as the "All" badge in the app.
async function computeAndSetBadge(){
  try {
    let data = null;
    try {
      const res = await fetch('./articles.json', { cache: 'no-cache' });
      if (res.ok) { data = await res.clone().json(); putInCache('./articles.json', res); }
    } catch (e) { /* offline */ }
    if (!data) data = await readCachedJson('./articles.json');
    if (!data || !Array.isArray(data.articles)) return;

    const blob = await readCachedJson(STATE_CACHE_KEY) || {};
    const done = new Set([...(blob.read || []), ...(blob.hidden || []), ...(blob.favorites || [])]);
    const unread = data.articles.filter((a) => !done.has(a.link)).length;
    if ('setAppBadge' in self.navigator) {
      if (unread > 0) await self.navigator.setAppBadge(unread);
      else await self.navigator.clearAppBadge();
    }
  } catch (e) { /* nothing we can do in the background */ }
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'dispatch-badge-refresh') event.waitUntil(computeAndSetBadge());
});

// The open app sets the badge itself; it only sends the lists so the
// background computation above stays in step with it.
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'dispatch-state-update') return;
  const body = JSON.stringify({ read: data.read || [], hidden: data.hidden || [], favorites: data.favorites || [] });
  event.waitUntil(putInCache(STATE_CACHE_KEY, new Response(body, { headers: { 'Content-Type': 'application/json' } })));
});

// --- Push notifications ------------------------------------------------
// Sent by scripts/send-push.mjs after an articles run finds new items.
// Payload: { title, body, count, url }. One notification at a time (same
// tag, replaced by the next one); the icon badge shows the count to review
// where the launcher supports it (on Samsung, the notification itself
// makes the icon bubble appear).
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'Dispatch', body: event.data ? event.data.text() : '' }; }
  event.waitUntil(Promise.all([
    self.registration.showNotification(String(data.title || 'Dispatch').slice(0, 120), {
      body: String(data.body || 'New articles to review').slice(0, 240),
      icon: './icons/icon-192.png',
      // Android draws the small (status bar) icon from its transparency
      // only: a white glyph on transparent, never a full-colour square.
      badge: './icons/badge-96.png',
      tag: 'dispatch-new-articles',
      renotify: true,
      data: { url: data.url || './', count: Number(data.count) || 0 },
    }),
    (async () => {
      try { if ('setAppBadge' in self.navigator && data.count > 0) await self.navigator.setAppBadge(Number(data.count)); } catch (e) { /* unsupported */ }
    })(),
  ]));
});

// Tapping the notification focuses Dispatch (or opens it). Only URLs inside
// this app are ever opened, whatever the payload says.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  let url = new URL('./', self.registration.scope).href;
  try {
    const wanted = new URL((event.notification.data && event.notification.data.url) || './', self.registration.scope);
    if (wanted.href.startsWith(self.registration.scope)) url = wanted.href;
  } catch (e) { /* keep the app root */ }
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if ('focus' in w) { await w.focus(); w.postMessage({ type: 'dispatch-open-feed' }); return; }
    }
    await self.clients.openWindow(url);
  })());
});
