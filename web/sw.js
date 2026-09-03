const CACHE_NAME = 'plate-v69';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      // Wipe ALL old caches unconditionally
      return Promise.all(keys.map((k) => caches.delete(k)));
    }).then(() => self.clients.claim()).then(() => {
      // Force reload all open windows with update query param
      return self.clients.matchAll({ type: 'window' }).then((clients) => {
        for (const client of clients) {
          if (client.navigate) {
            client.navigate('/?updated=' + Date.now());
          }
        }
      });
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Never intercept /bust, API requests, or non-GET requests
  if (url.pathname === '/bust' || url.pathname.startsWith('/api/') || e.request.method !== 'GET') {
    return;
  }

  // Network-first for EVERYTHING: Always get latest from server if online, fallback to cache only if offline
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((networkRes) => {
        if (networkRes.ok) {
          const clone = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        }
        return networkRes;
      })
      .catch(() => {
        return caches.match(e.request).then((cached) => {
          if (cached) return cached;
          if (e.request.mode === 'navigate') return caches.match('/index.html');
          return new Response('Offline', { status: 503, statusText: 'Offline' });
        });
      })
  );
});
