// Studio CLI service worker. Only page navigations are handled: when the local
// server is down, show a page explaining how to start it instead of Chrome's error.
const CACHE = 'studio-cli-v3';
const SHELL = ['/offline.html', '/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/offline.html')));
  } else if (SHELL.includes(url.pathname)) {
    e.respondWith(fetch(e.request).catch(() => caches.match(url.pathname)));
  }
});
