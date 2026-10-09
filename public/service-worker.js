/* WindowsForum AI public-shell worker. Keep private pages and APIs network-only. */
/* global self, caches, fetch, URL, Response, console */
'use strict';

// v2 (#9): activation deletes v1, which served executable chunks cache-first.
const CACHE_NAME = 'wf-ai-public-shell-v2';
const MAX_CACHE_ENTRIES = 80;
// Cache Storage is shared by the whole windowsforum.com origin: any page there
// can open this cache by name and put() anything into it. So nothing read back
// from it may run as code or become a document (#9):
//  - JS/CSS are never handled here; the browser HTTP cache (immutable for
//    hashed chunks) serves them, and page script cannot write that.
//  - The offline page is built from this script (OFFLINE_HTML), never from
//    Cache Storage. Keep it identical to public/offline.html (pwa test).
//  - What remains (icons, avatar, manifest) is network-first, so a cached copy
//    is used only while offline.
const OFFLINE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="theme-color" content="#111827">
    <title>WindowsForum AI is offline</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
      body { display: grid; min-height: 100vh; margin: 0; place-items: center; background: Canvas; color: CanvasText; }
      main { box-sizing: border-box; width: min(34rem, calc(100% - 2rem)); padding: 2rem; text-align: center; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: 1rem; }
      img { width: 5rem; height: 5rem; border-radius: 1rem; }
      button { padding: .65rem 1rem; font: inherit; font-weight: 650; cursor: pointer; }
    </style>
  </head>
  <body>
    <main>
      <img src="/chatpage/bot-avatar.webp" alt="">
      <h1>You’re offline</h1>
      <p>Reconnect to continue with WindowsForum AI. Private conversations are not stored in the offline cache.</p>
      <button type="button" onclick="location.reload()">Try again</button>
    </main>
  </body>
</html>
`;
const PRECACHE_URLS = [
  '/chatpage/manifest.json',
  '/chatpage/bot-avatar.webp',
  '/chatpage/pwa-icon-192.png',
  '/chatpage/pwa-icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Cache precache entries individually: one missing icon must not abort
    // installation. The offline page lives in this script, so nothing here is
    // required for the worker to serve it.
    await Promise.all(PRECACHE_URLS.map(async url => {
      try {
        await cache.add(url);
      } catch (error) {
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

  // Keep the precached icons and manifest. Oldest runtime entries are evicted
  // first, so release hashes cannot accumulate without bound in a long-lived worker.
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

const isExecutableAsset = pathname => /\.(?:m?js|css)$/i.test(pathname);

const isCacheablePublicAsset = url => (
  url.origin === self.location.origin
  && !isExecutableAsset(url.pathname)
  && (
    url.pathname.startsWith('/chatpage/static/')
    || url.pathname === '/chatpage/manifest.json'
    || url.pathname === '/chatpage/bot-avatar.webp'
    || url.pathname === '/chatpage/pwa-icon-192.png'
    || url.pathname === '/chatpage/pwa-icon-512.png'
  )
);

const offlineResponse = () => new Response(OFFLINE_HTML, {
  headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
});

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

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  if (isApplicationNavigation(request)) {
    // Never persist XenForo HTML: it can contain identity/session-specific data.
    event.respondWith(fetch(request).catch(offlineResponse));
    return;
  }

  const url = new URL(request.url);
  if (!isCacheablePublicAsset(url)) return;
  event.respondWith(networkFirst(request));
});
