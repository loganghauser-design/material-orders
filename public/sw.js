// Minimal service worker — enables install + offline shell for static assets
const CACHE = 'mo-v1';
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Cache-first for our own static CSS/icons; network for everything else
  if (e.request.method === 'GET' && (url.pathname.startsWith('/css/') || url.pathname === '/icon.svg')) {
    e.respondWith(
      caches.open(CACHE).then(c => c.match(e.request).then(hit => hit || fetch(e.request).then(res => { c.put(e.request, res.clone()); return res; })))
    );
  }
});
