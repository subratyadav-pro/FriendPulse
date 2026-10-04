// FriendPulse Service Worker — Push Notifications & Offline Support
const CACHE_NAME = 'friendpulse-v3.0.0';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
        )
      )
    ])
  );
});

self.addEventListener('fetch', (event) => {
  // Pass network requests through directly (API and WS require fresh data)
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});

// ─── PUSH NOTIFICATION HANDLER ────────────────────────────
// Fired when the server sends an emergency SOS push (even when browser/app is closed)
self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (_) {
      try {
        data = { body: event.data.text() };
      } catch (__) {
        data = {};
      }
    }
  }

  const senderName = data.name || 'A friend';
  const lat = data.lat != null ? Number(data.lat) : null;
  const lng = data.lng != null ? Number(data.lng) : null;
  const room = data.room || '';
  const title = data.title || `🚨 EMERGENCY SOS: ${senderName}!`;
  
  const locText = (lat != null && lng != null) 
    ? `📍 Location: ${lat.toFixed(5)}, ${lng.toFixed(5)}` 
    : '📍 Location shared';

  const body = data.body || `🚨 ${senderName} triggered an emergency SOS! Tap to open live radar & rescue.`;

  const notificationOptions = {
    body: `${body}\n${locText}`,
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: 'friendpulse-sos', // groups alerts together
    renotify: true,
    requireInteraction: true, // Keep alert visible on screen until user acts
    vibrate: [500, 200, 500, 200, 1000, 300, 1000, 300, 1000], // Emergency siren vibration pattern
    data: {
      url: `/?room=${encodeURIComponent(room)}&sos=1&lat=${lat || ''}&lng=${lng || ''}&name=${encodeURIComponent(senderName)}`,
      lat,
      lng,
      room,
      name: senderName
    },
    actions: [
      { action: 'open_app', title: '🚨 Open Radar & Help' },
      ...(lat && lng ? [{ action: 'google_maps', title: '📍 Google Maps' }] : [])
    ]
  };

  event.waitUntil(
    self.registration.showNotification(title, notificationOptions)
  );
});

// ─── NOTIFICATION CLICK HANDLER ───────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const notifData = event.notification.data || {};

  // If user tapped "Google Maps" action
  if (event.action === 'google_maps' && notifData.lat && notifData.lng) {
    const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${notifData.lat},${notifData.lng}`;
    event.waitUntil(clients.openWindow(mapsUrl));
    return;
  }

  // Open / Focus FriendPulse window and navigate to SOS alert
  const targetUrl = notifData.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If an existing window is open, navigate and focus it
      for (const client of clientList) {
        if ('focus' in client) {
          if (client.url && client.url.includes(self.location.origin)) {
            client.navigate(targetUrl);
            return client.focus();
          }
        }
      }
      // If no window is currently open, open a new one
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
