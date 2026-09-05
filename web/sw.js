// Derived from the contents of web/ at boot, by server/serve-sw.js. A version
// nobody has to remember to bump is a version that cannot be forgotten -- and
// a worker whose bytes have not changed is one the browser will not update.
const CACHE_NAME = 'plate-__BUILD_VERSION__';

importScripts('/sw-update.js');

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    await self.clients.claim();
    // Announce rather than navigate. Forcing every window to reload was
    // instant and it also threw away whatever was on screen -- which here can
    // be a photo estimate with a correction typed into it and not yet saved.
    await announceUpdate();
  })());
});

// Where a shared photo waits between the share sheet handing it over and the
// page opening. Cache Storage rather than a message: the share arrives as a
// POST that navigates, so there is no page listening yet to send it to.
const SHARE_CACHE = 'plate-shared-photo';
const SHARE_SLOT = '/__shared-photo';

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // A photo sent from the gallery's share sheet. Android POSTs it here as a
  // navigation, so the worker has to take the body, put it somewhere the page
  // can find, and then send the browser to a page -- a POST cannot render.
  if (e.request.method === 'POST' && url.pathname === '/share') {
    e.respondWith((async () => {
      try {
        const form = await e.request.formData();
        const file = form.get('photo');
        if (file && file.size) {
          const cache = await caches.open(SHARE_CACHE);
          await cache.put(SHARE_SLOT, new Response(file, {
            headers: {
              'Content-Type': file.type || 'image/jpeg',
              // The name survives so the page can read the date out of it.
              'X-Shared-Name': encodeURIComponent(file.name || 'shared.jpg')
            }
          }));
          return Response.redirect('/?shared=1', 303);
        }
      } catch (err) {
        // A share that cannot be read should land the user in the app rather
        // than on a browser error page with their photo lost.
      }
      return Response.redirect('/?shared=0', 303);
    })());
    return;
  }

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
