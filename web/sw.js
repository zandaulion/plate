// Cache-first for the shell, network-only for the API.
//
// CACHE_NAME must be bumped on every shell change, or installed clients keep
// serving the old build indefinitely.
const CACHE_NAME = 'plate-v38';

const SHELL = [
  '/', '/index.html', '/app.css', '/app.js', '/track.js',
  '/core/analysis/estimate.js', '/core/analysis/prompt.js',
  '/core/nutrition.js', '/core/day.js', '/core/foods.js',
  '/core/weight.js', '/core/expenditure.js',
  '/manifest.webmanifest', '/icons/icon.svg', '/icons/maskable.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Never cache the API. A stale day total is worse than no day total, and
  // photos are already immutable-cached by the browser from their headers.
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    caches.match(event.request).then((hit) => hit || fetch(event.request).then((res) => {
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(event.request, copy));
      }
      return res;
    }).catch(() => caches.match('/index.html')))
  );
});
