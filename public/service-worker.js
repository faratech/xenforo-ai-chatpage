/* WindowsForum AI public-shell worker. Keep private pages and APIs network-only. */
/* global self, caches, fetch, URL, Response, console */
'use strict';

const CACHE_NAME = 'wf-ai-public-shell-v1';
const MAX_CACHE_ENTRIES = 80;
const OFFLINE_URL = '/chatpage/offline.html';
const PRECACHE_URLS = [
  OFFLINE_URL,
  '/chatpage/manifest.json',
  '/chatpage/bot-avatar.webp',
  '/chatpage/pwa-icon-192.png',
  '/chatpage/pwa-icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Cache precache entries individually: one missing icon must not abort
    // installation - an uninstalled worker can never serve the offline
    // fallback, which is the only precache entry the fetch handler depends on.
    await Promise.all(PRECACHE_URLS.map(async url => {
      try {
        await cache.add(url);
      } catch (error) {
        if (url === OFFLINE_URL) throw error;
        console.warn('[sw] skipped precache entry', url, error);
      }
    }));
    await trimCache(cache);
  })());
});

self.addEventListener('message', event => {
  // waitUntil keeps the worker alive until the promise settles; a bare,
  // unawaited skipWaiting() could be dropped if the worker idled out first.
  if (event.data && event.data.type === 'SKIP_WAITING') event.waitUntil(self.skipWaiting());
});

const trimCache = async cache => {
  const keys = await cache.keys();
  const overflow = keys.length - MAX_CACHE_ENTRIES;
  if (overflow <= 0) return;

  // Keep the small offline shell. Oldest runtime chunks are evicted first, so
  // release hashes cannot accumulate without bound across a long-lived worker.
  const evictable = keys.filter(request => {
    const url = new URL(request.url);
    const isCanonicalPrecacheEntry = url.origin === self.location.origin
      && url.search === ''
      && PRECACHE_URLS.includes(url.pathname);
    return !isCanonicalPrecacheEntry;
  });
  await Promise.all(evictable.slice(0, overflow).map(request => cache.delete(request)));
};

self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key.startsWith('wf-ai-public-shell-') && key !== CACHE_NAME)
        .map(key => caches.delete(key)),
    )),
    self.clients.claim(),
  ]));
});

const isApplicationNavigation = request => {
  if (request.mode !== 'navigate') return false;
  const url = new URL(request.url);
  return url.origin === self.location.origin && (
    url.pathname === '/pages/ai'
    || url.pathname.startsWith('/pages/ai/')
    || url.pathname === '/chatpage'
    || url.pathname.startsWith('/chatpage/')
  );
};

const isCacheablePublicAsset = url => (
  url.origin === self.location.origin
  && (
    url.pathname.startsWith('/chatpage/static/')
    || url.pathname === '/chatpage/manifest.json'
    || url.pathname === '/chatpage/bot-avatar.webp'
    || url.pathname === '/chatpage/pwa-icon-192.png'
    || url.pathname === '/chatpage/pwa-icon-512.png'
    || url.pathname === OFFLINE_URL
  )
);

const isHashedAsset = pathname => /-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(pathname);

const networkFirst = async request => {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone());
      await trimCache(cache);
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
};

const cacheFirst = async request => {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    await trimCache(cache);
  }
  return response;
};

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  if (isApplicationNavigation(request)) {
    // Never persist XenForo HTML: it can contain identity/session-specific data.
    event.respondWith(fetch(request).catch(async () => (
      (await caches.match(OFFLINE_URL)) || Response.error()
    )));
    return;
  }

  const url = new URL(request.url);
  if (!isCacheablePublicAsset(url)) return;
  event.respondWith(isHashedAsset(url.pathname) ? cacheFirst(request) : networkFirst(request));
});
