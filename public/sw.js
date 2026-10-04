// FriendPulse Service Worker for offline resilience & background tracking
const CACHE_NAME = 'friendpulse-v2.2.0';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Pass network requests through directly (API and WS require fresh data)
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
