// Minimal service worker — enables install + offline shell for static assets
const CACHE = 'bd-v2';
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Network-first for our CSS/icon so theme changes show immediately; fall back to cache offline
  if (e.request.method === 'GET' && (url.pathname.startsWith('/css/') || url.pathname === '/icon.svg')) {
    e.respondWith(
      fetch(e.request).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res; })
        .catch(() => caches.open(CACHE).then(c => c.match(e.request)))
    );
  }
});
