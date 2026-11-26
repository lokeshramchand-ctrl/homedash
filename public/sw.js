// homedash service worker: lets the dashboard install as an app and open instantly. It caches only the static shell
// (the page and its hashed assets). Anything under /api, /status, /metrics or an event stream always goes to the network,
// so nothing sensitive is ever stored and live data is never stale.
const CACHE = 'homedash-shell-v1';
const NEVER = /^\/(api|status|metrics)(\/|\.|$)/;

self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || NEVER.test(url.pathname)) return;
  if (req.mode === 'navigate') {
    // Page loads: network first, the cached page when offline.
    e.respondWith(fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('./', copy)); return res; }).catch(() => caches.match('./').then((r) => r || Response.error())));
    return;
  }
  if (url.pathname.startsWith('/assets/') || /\.(png|svg|webmanifest|woff2?)$/.test(url.pathname)) {
    // Built files have hashed names: cache first, fill on a miss.
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; })));
  }
});
