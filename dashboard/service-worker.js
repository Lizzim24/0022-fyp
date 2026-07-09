// Print Lab Digital Twin — Service Worker
// Strategy:
//   1. HTML/JS/CSS/manifest: "network-first, cache fallback"
//      → users see the latest push whenever the network is up, and the shell
//        still loads if the venue Wi-Fi is briefly down.
//   2. Supabase API calls: NEVER cache (real-time data must be live).
//   3. Everything else static (icons, images): "cache-first".
// Bump CACHE_VERSION to invalidate old caches on the next deploy.

const CACHE_VERSION = 'v1-2026-07-09';
const SHELL_CACHE   = `shell-${CACHE_VERSION}`;
const STATIC_CACHE  = `static-${CACHE_VERSION}`;

const SHELL_URLS = [
  '/', '/index.html',
  '/live.js', '/analysis.js', '/planner.js', '/supabase.js',
  '/manifest.json',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(c => c.addAll(SHELL_URLS).catch(() => {}))  // partial success is fine
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !k.endsWith(CACHE_VERSION))
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 1. Never cache Supabase (live data + auth headers) — pass through
  if (url.hostname.endsWith('.supabase.co')) return;

  // 2. HTML documents: network-first, fall back to cache
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then(c => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then(r => r || caches.match('/index.html')))
    );
    return;
  }

  // 3. Own scripts/styles: network-first (so latest deploy wins), cache fallback
  if (url.origin === self.location.origin &&
      /\.(js|css|json)$/.test(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then(c => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // 4. Everything else (icons, images, CDN scripts): cache-first
  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(STATIC_CACHE).then(c => c.put(req, copy));
      return res;
    }).catch(() => cached))
  );
});
