/* ============================================================
   FriendPulse — app.js
   Real-time friend GPS tracker with IP fallback.
   No mock data. Every friend must join via WebSocket room.
   ============================================================ */

'use strict';

// ────────────────────────────────────────────────────────────
// State
// ────────────────────────────────────────────────────────────
const STATE = {
  myId: null,
  myName: '',
  roomCode: null,
  roomName: null,
  isLocationLocked: false,
  publicUrl: null,       // public tunnel URL (localtunnel)
  ws: null,
  myLocation: null,
  friends: {},
  map: null,
  myMarker: null,
  accuracyCircle: null,
  tileLayer: null,
  mapTheme: 'dark',
  showDistanceLines: true,
  distanceLines: {},
  locationWatchId: null,
  sosHoldTimer: null,
  wsReconnectTimer: null,
  wsReconnectAttempts: 0,
  locationBroadcastInterval: null,
  sosPhotos: {},        // userId → [{ photoUrl, camera, timestamp, ... }]
  currentSosAlertUserId: null,
  ackNames: new Set(),  // friends who acknowledged my active SOS
  watch: null,          // Safety Watch state { expiresAt, durationMs, timer }
};

// ── Native Android GPS Bridge (from FriendPulse Native App WebView) ──
window.__nativeGpsCallback = function(pos) {
  if (!pos || !pos.coords) return;
  onMyLocationUpdate({
    lat: pos.coords.latitude,
    lng: pos.coords.longitude,
    type: 'gps',
    accuracy: Math.round(pos.coords.accuracy || 1),
    speed: pos.coords.speed,
    label: `GPS • ±${Math.round(pos.coords.accuracy || 1)}m accuracy`
  });
};
window.addEventListener('nativeGps', function(e) {
  if (e.detail) window.__nativeGpsCallback(e.detail);
});

// Color palette for friend avatars
const AVATAR_COLORS = [
  '#6366f1','#ec4899','#14b8a6','#f59e0b','#8b5cf6',
  '#ef4444','#10b981','#3b82f6','#f97316','#84cc16'
];

function avatarColor(userId) {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function initial(name) {
  return (name || '?')[0].toUpperCase();
}

// ────────────────────────────────────────────────────────────
// Utility
// ────────────────────────────────────────────────────────────
function generateRoomCode() {
  const words = ['PULSE','RADAR','TRACE','ORBIT','GRID','WAVE','LINK','NODE'];
  const word = words[Math.floor(Math.random() * words.length)];
  const num = Math.floor(1000 + Math.random() * 9000);
  return `${word}-${num}`;
}

function generateUserId() {
  return 'uid-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
  const dp = (lat2 - lat1) * Math.PI / 180;
  const dl = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dp/2)**2 + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function formatDist(m) {
  if (m == null || isNaN(m)) return '—';
  return m < 1000 ? `${Math.round(m)} m` : `${(m/1000).toFixed(2)} km`;
}

function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}

// ────────────────────────────────────────────────────────────
// Geolocation — GPS + IP fallback
// ────────────────────────────────────────────────────────────
async function getIPLocation() {
  try {
    const res = await fetch('/api/ip-location');
    const data = await res.json();
    if (data.success && data.latitude != null && data.longitude != null) {
      return {
        lat: Number(data.latitude),
        lng: Number(data.longitude),
        type: 'ip',
        city: data.city,
        country: data.country,
        accuracy: null,
        label: `${data.city || 'City'}, ${data.country || ''} (Network/IP location)`
      };
    }
  } catch (e) {}

  // Direct client-side fallback if server IP api didn't yield coords (e.g. local IP)
  try {
    const res2 = await fetch('https://ipapi.co/json/');
    const d2 = await res2.json();
    if (d2.latitude != null && d2.longitude != null) {
      return {
        lat: Number(d2.latitude),
        lng: Number(d2.longitude),
        type: 'ip',
        city: d2.city,
        country: d2.country_name,
        accuracy: null,
        label: `${d2.city || 'City'}, ${d2.country_name || ''} (Network/IP location)`
      };
    }
  } catch (e2) {}

  return null;
}

let gpsRetryInterval = null;

function startLocationTracking() {
  updateMyLocationCard('detecting', 'Getting your location…');

  // 1. Immediately restore cached last known location if available
  try {
    const cached = localStorage.getItem('friendpulse_last_loc');
    if (cached) {
      const loc = JSON.parse(cached);
      if (loc && loc.lat != null && loc.lng != null && !STATE.myLocation) {
        onMyLocationUpdate({ ...loc, label: `Cached position · ${loc.label || ''}` });
      }
    }
  } catch (e) {}

  // 2. Fetch IP location right away so user is locatable even if GPS is off
  getIPLocation().then(ipLoc => {
    if (ipLoc && (!STATE.myLocation || STATE.myLocation.type !== 'gps')) {
      onMyLocationUpdate(ipLoc);
    }
  });

  // 3. Try high-accuracy device GPS
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          type: 'gps',
          accuracy: Math.round(pos.coords.accuracy),
          speed: pos.coords.speed,
          label: `GPS • ±${Math.round(pos.coords.accuracy)}m accuracy`
        };
        onMyLocationUpdate(loc);
        if (gpsRetryInterval) { clearInterval(gpsRetryInterval); gpsRetryInterval = null; }
      },
      async (err) => {
        console.warn('GPS off or denied:', err.message);
        const ipLoc = await getIPLocation();
        if (ipLoc) {
          onMyLocationUpdate(ipLoc);
          showToast('📡 GPS off — using approximate Network/IP location so friends can find you', 'info', 4500);
        } else {
          updateMyLocationCard('none', 'Location unavailable');
        }

        // Retry GPS every 20s in case user toggles GPS on
        if (!gpsRetryInterval) {
          gpsRetryInterval = setInterval(() => {
            navigator.geolocation.getCurrentPosition((pos) => {
              const loc = {
                lat: pos.coords.latitude,
                lng: pos.coords.longitude,
                type: 'gps',
                accuracy: Math.round(pos.coords.accuracy),
                speed: pos.coords.speed,
                label: `GPS • ±${Math.round(pos.coords.accuracy)}m accuracy`
              };
              onMyLocationUpdate(loc);
              clearInterval(gpsRetryInterval);
              gpsRetryInterval = null;
              showToast('🎯 High-accuracy GPS active!', 'success', 3000);
            }, () => {}, { enableHighAccuracy: true, timeout: 5000 });
          }, 20000);
        }
      },
      { enableHighAccuracy: true, timeout: 7000, maximumAge: 10000 }
    );

    // Watch continuously for movements
    STATE.locationWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        onMyLocationUpdate({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          type: 'gps',
          accuracy: Math.round(pos.coords.accuracy),
          speed: pos.coords.speed,
          label: `GPS • ±${Math.round(pos.coords.accuracy)}m accuracy`
        });
      },
      (err) => {
        console.warn('Watch error:', err.message);
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 }
    );
  } else {
    getIPLocation().then(ipLoc => {
      if (ipLoc) onMyLocationUpdate(ipLoc);
      else updateMyLocationCard('none', 'Location not supported by browser');
    });
  }
}

function onMyLocationUpdate(loc, isManual = false) {
  if (STATE.isLocationLocked && !isManual) {
    return; // Prevent background IP or periodic checks from reverting locked snap
  }
  STATE.myLocation = loc;
  updateMyLocationCard(loc.type, loc.label || `${loc.type.toUpperCase()} location`);
  updateMapHud(loc.speed, loc.accuracy, loc.type === 'gps');

  // Save last known location to localStorage
  try {
    localStorage.setItem('friendpulse_last_loc', JSON.stringify({
      lat: loc.lat,
      lng: loc.lng,
      type: loc.type,
      accuracy: loc.accuracy,
      city: loc.city,
      savedAt: Date.now()
    }));
  } catch (e) {}

  // Update my map marker & center map on user
  if (STATE.map) {
    if (STATE.myMarker) {
      STATE.myMarker.setLatLng([loc.lat, loc.lng]);
    } else {
      addMyMarker(loc.lat, loc.lng);
    }
    updateAccuracyCircle(loc.lat, loc.lng, loc.accuracy);
    drawDistanceLines();
    STATE.map.flyTo([loc.lat, loc.lng], 15, { duration: 0.8 });
  }

  // Refresh UI so friend distances are computed and shown immediately
  renderFriendsList();
  renderBottomStrip();

  // Send location to server (both modern and legacy protocols)
  if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
    STATE.ws.send(JSON.stringify({
      type: 'location',
      room: STATE.roomCode,
      userId: STATE.myId,
      name: STATE.myName,
      lat: loc.lat,
      lng: loc.lng,
      locationType: loc.type,
      accuracy: loc.accuracy || null,
    }));
    STATE.ws.send(JSON.stringify({
      type: 'UPDATE_LOCATION',
      location: {
        lat: loc.lat, lng: loc.lng,
        locType: loc.type,
        accuracy: loc.accuracy || null,
        city: loc.city || null,
        lastUpdated: Date.now()
      }
    }));
  }

  // Keep the Safety Watch's last-known location fresh for the native timer
  if (STATE.watch) syncWatchToNative();
}

// Beacon sent before tab unloads or backgrounded to keep location persistent
function sendLastLocationBeacon() {
  if (!STATE.roomCode || !STATE.myId || !STATE.myLocation) return;
  const payload = JSON.stringify({
    room: STATE.roomCode,
    userId: STATE.myId,
    name: STATE.myName,
    lat: STATE.myLocation.lat,
    lng: STATE.myLocation.lng,
    locationType: STATE.myLocation.type,
    accuracy: STATE.myLocation.accuracy
  });
  if (navigator.sendBeacon) {
    navigator.sendBeacon('/api/last-location', new Blob([payload], { type: 'application/json' }));
  } else {
    fetch('/api/last-location', {
      method: 'POST',
      body: payload,
      headers: { 'Content-Type': 'application/json' },
      keepalive: true
    }).catch(() => {});
  }
}
window.addEventListener('beforeunload', sendLastLocationBeacon);
window.addEventListener('pagehide', sendLastLocationBeacon);

function updateMyLocationCard(type, label) {
  const icon = document.getElementById('myLocIcon');
  const typeEl = document.getElementById('myLocType');
  const detailEl = document.getElementById('myLocDetail');
  if (!icon) return;
  if (type === 'gps') {
    icon.textContent = '📍';
    typeEl.textContent = 'GPS Active';
    typeEl.style.color = 'var(--green)';
  } else if (type === 'ip') {
    icon.textContent = '🌐';
    typeEl.textContent = 'IP Location (city-level)';
    typeEl.style.color = 'var(--orange)';
  } else if (type === 'detecting') {
    icon.textContent = '🔄';
    typeEl.textContent = 'Detecting…';
    typeEl.style.color = 'var(--muted)';
  } else {
    icon.textContent = '❌';
    typeEl.textContent = 'Location unavailable';
    typeEl.style.color = 'var(--red)';
  }
  detailEl.textContent = label || '';
}

// Retry GPS from SOS tab
document.getElementById('retryLocationBtn')?.addEventListener('click', () => {
  if (STATE.locationWatchId != null) {
    navigator.geolocation.clearWatch(STATE.locationWatchId);
    STATE.locationWatchId = null;
  }
  STATE.myLocation = null;
  startLocationTracking();
});

// Snap all devices in the room to 0m (Sync PC & Phone for testing or close proximity)
const snapAllToZero = () => {
  const friends = Object.values(STATE.friends);
  if (friends.length === 0) {
    showToast('⚠️ No friends in room yet. Open app on second device first!', 'warn', 3000);
    return;
  }

  // 1. Check if a friend has GPS location
  const friendWithGps = friends.find(f => f.location && f.location.lat != null && f.location.locType === 'gps');
  // 2. Or any friend with location
  const friendWithLoc = friends.find(f => f.location && f.location.lat != null);
  // 3. Or my location if GPS active
  const myGps = (STATE.myLocation && STATE.myLocation.lat != null && STATE.myLocation.type === 'gps') ? STATE.myLocation : null;

  let targetLat, targetLng, sourceName;

  if (friendWithGps) {
    targetLat = Number(friendWithGps.location.lat);
    targetLng = Number(friendWithGps.location.lng);
    sourceName = friendWithGps.name;
  } else if (myGps) {
    targetLat = Number(myGps.lat);
    targetLng = Number(myGps.lng);
    sourceName = 'your GPS';
  } else if (friendWithLoc) {
    targetLat = Number(friendWithLoc.location.lat);
    targetLng = Number(friendWithLoc.location.lng);
    sourceName = friendWithLoc.name;
  } else if (STATE.myLocation && STATE.myLocation.lat != null) {
    targetLat = Number(STATE.myLocation.lat);
    targetLng = Number(STATE.myLocation.lng);
    sourceName = 'your position';
  } else {
    showToast('⚠️ Detecting coordinates… please wait a few seconds and try again.', 'warn', 3500);
    return;
  }

  // Lock this device's location to the target coordinates
  STATE.isLocationLocked = true;
  const snapLoc = {
    lat: targetLat,
    lng: targetLng,
    type: 'gps',
    accuracy: 1,
    label: `GPS • Synced with ${sourceName} (0m)`
  };
  onMyLocationUpdate(snapLoc, true);

  // Broadcast location update
  if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
    STATE.ws.send(JSON.stringify({
      type: 'location',
      room: STATE.roomCode,
      userId: STATE.myId,
      name: STATE.myName,
      lat: targetLat,
      lng: targetLng,
      locationType: 'gps',
      accuracy: 1,
      isSnap: true
    }));
  }
  fetch('/api/bg-location', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      room: STATE.roomCode,
      userId: STATE.myId,
      name: STATE.myName,
      lat: targetLat,
      lng: targetLng,
      locationType: 'gps',
      accuracy: 1
    }),
    keepalive: true
  }).catch(() => {});

  // Update friends locally and tell server to snap all friends to identical coords
  friends.forEach(f => {
    f.location = {
      lat: targetLat,
      lng: targetLng,
      locType: 'gps',
      accuracy: 1,
      lastUpdated: Date.now()
    };
    addOrUpdateFriendMarker(f.id, f);

    if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
      STATE.ws.send(JSON.stringify({
        type: 'SYNC_FRIEND_LOCATION',
        room: STATE.roomCode,
        targetUserId: f.id,
        lat: targetLat,
        lng: targetLng
      }));
    }

    fetch('/api/sync-friend-location', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room: STATE.roomCode,
        targetUserId: f.id,
        lat: targetLat,
        lng: targetLng
      }),
      keepalive: true
    }).catch(() => {});
  });

  drawDistanceLines();
  renderFriendsList();
  renderBottomStrip();
  showToast(`🎯 All devices synced to ${sourceName}! Distance is 0m!`, 'success', 4500);
};

const doSnapLocation = snapAllToZero;

document.getElementById('syncLocationBtn')?.addEventListener('click', snapAllToZero);
document.getElementById('snapGpsBtn')?.addEventListener('click', snapAllToZero);
document.getElementById('radarSnapBtn')?.addEventListener('click', snapAllToZero);

// Zoom in / out controls — tap for one step, press & hold to zoom continuously
function setupZoomHold(btnId, stepFn) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  let holdDelay = null;
  let repeatTimer = null;
  const stop = () => {
    clearTimeout(holdDelay);
    clearInterval(repeatTimer);
    holdDelay = null;
    repeatTimer = null;
  };
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    stop();
    if (STATE.map) stepFn();
    holdDelay = setTimeout(() => {
      repeatTimer = setInterval(() => { if (STATE.map) stepFn(); }, 200);
    }, 400);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(evt =>
    btn.addEventListener(evt, stop)
  );
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}
setupZoomHold('zoomInBtn', () => STATE.map.zoomIn(0.5, { duration: 0.18 }));
setupZoomHold('zoomOutBtn', () => STATE.map.zoomOut(0.5, { duration: 0.18 }));

// ────────────────────────────────────────────────────────────
// Map
// ────────────────────────────────────────────────────────────
function initMap() {
  if (typeof L === 'undefined') {
    console.error('Leaflet is not available on window');
    return;
  }
  if (STATE.map) {
    try { STATE.map.remove(); } catch (e) {}
    STATE.map = null;
    STATE.myMarker = null;
  }
  const defaultCenter = STATE.myLocation && STATE.myLocation.lat != null 
    ? [Number(STATE.myLocation.lat), Number(STATE.myLocation.lng)] 
    : [20.5937, 78.9629];
  const defaultZoom = STATE.myLocation ? 16 : 5;

  try {
    STATE.map = L.map('map', {
      zoomControl: false,
      attributionControl: false,
      // 'center' lets a two-finger pinch zoom the map even when a finger
      // starts on a marker/HUD pill instead of bare map.
      touchZoom: 'center',
      doubleClickZoom: true,
      // Fine snap so pinch-zoom settles smoothly instead of jumping in
      // half-level steps; FAB taps still move 0.5 per step.
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      wheelPxPerZoomLevel: 90,
      minZoom: 3,
    }).setView(defaultCenter, defaultZoom);

    setMapTheme(STATE.mapTheme || 'dark');

    // Force map to layout and fetch tiles across multiple ticks
    [50, 150, 350, 700, 1200].forEach(delay => {
      setTimeout(() => {
        if (STATE.map) {
          STATE.map.invalidateSize();
        }
      }, delay);
    });

    // Add own marker if we already have location
    if (STATE.myLocation && STATE.myLocation.lat != null) {
      addMyMarker(STATE.myLocation.lat, STATE.myLocation.lng);
    }

    // Add existing friend markers
    Object.entries(STATE.friends).forEach(([uid, friend]) => {
      addOrUpdateFriendMarker(uid, friend);
    });
  } catch (err) {
    console.error('Failed to initialize Leaflet map:', err);
  }
}

function setMapTheme(theme) {
  STATE.mapTheme = theme;
  const mapEl = document.getElementById('map');
  
  // Highlight active layer button in menu
  document.querySelectorAll('.layer-opt').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-layer') === theme);
  });

  if (mapEl) {
    if (theme === 'dark') {
      mapEl.classList.add('dark-map');
    } else {
      mapEl.classList.remove('dark-map');
    }
  }

  if (!STATE.map) return;

  if (STATE.tileLayer) {
    try { STATE.map.removeLayer(STATE.tileLayer); } catch (e) {}
    STATE.tileLayer = null;
  }

  const layerUrls = {
    dark: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    street: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    satellite: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    topo: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png'
  };

  const attributions = {
    dark: '&copy; OpenStreetMap',
    street: '&copy; OpenStreetMap contributors',
    satellite: '&copy; Esri World Imagery',
    topo: '&copy; OpenTopoMap'
  };

  const url = layerUrls[theme] || layerUrls.dark;
  const attr = attributions[theme] || attributions.dark;

  // OpenTopoMap only serves tiles up to z17 — higher zooms 404 and the map
  // goes blank, so cap each source at what it actually has.
  const layerMaxZoom = { dark: 19, street: 19, satellite: 19, topo: 17 };

  STATE.tileLayer = L.tileLayer(url, {
    maxZoom: layerMaxZoom[theme] || 19,
    subdomains: theme === 'topo' ? 'abc' : '',
    attribution: attr
  }).addTo(STATE.map);
}

function updateAccuracyCircle(lat, lng, accuracy) {
  if (!STATE.map) return;
  if (!accuracy || isNaN(accuracy)) {
    if (STATE.accuracyCircle) {
      STATE.map.removeLayer(STATE.accuracyCircle);
      STATE.accuracyCircle = null;
    }
    return;
  }

  if (STATE.accuracyCircle) {
    STATE.accuracyCircle.setLatLng([lat, lng]).setRadius(accuracy);
  } else {
    STATE.accuracyCircle = L.circle([lat, lng], {
      radius: accuracy,
      color: '#6366f1',
      fillColor: '#6366f1',
      fillOpacity: 0.12,
      weight: 1.5,
      dashArray: '4,4'
    }).addTo(STATE.map);
  }
}

function addMyMarker(lat, lng) {
  if (!STATE.map || lat == null || lng == null) return;
  const numLat = Number(lat);
  const numLng = Number(lng);
  if (isNaN(numLat) || isNaN(numLng)) return;

  const icon = L.divIcon({
    className: '',
    iconSize: [44, 66],
    iconAnchor: [22, 44],
    html: `<div class="my-marker">
      <div class="my-marker-inner">${initial(STATE.myName)}</div>
      <div class="my-label">YOU</div>
    </div>`
  });

  if (STATE.myMarker) {
    STATE.myMarker.setLatLng([numLat, numLng]).setIcon(icon);
  } else {
    STATE.myMarker = L.marker([numLat, numLng], { icon, zIndexOffset: 1000 }).addTo(STATE.map);
    STATE.map.setView([numLat, numLng], 15);
  }

  updateAccuracyCircle(numLat, numLng, STATE.myLocation?.accuracy);
  drawDistanceLines();
}

function addOrUpdateFriendMarker(userId, friend) {
  if (!STATE.map || !friend || !friend.location || friend.location.lat == null || friend.location.lng == null) return;
  const numLat = Number(friend.location.lat);
  const numLng = Number(friend.location.lng);
  if (isNaN(numLat) || isNaN(numLng)) return;

  const color = avatarColor(userId);
  const isOnline = friend.isOnline !== false;
  const isGps = friend.location.locType === 'gps';
  const borderClass = !isOnline ? 'offline-border' : isGps ? 'gps-border' : 'ip-border';
  const borderColor = !isOnline ? '#64748b' : isGps ? 'var(--green)' : 'var(--orange)';
  const statusLabel = !isOnline ? ' (Away)' : '';
  const nameClass = !isOnline ? 'friend-marker-name offline' : 'friend-marker-name';

  const icon = L.divIcon({
    className: '',
    iconSize: [44, 66],
    iconAnchor: [22, 44],
    html: `<div class="friend-marker-wrap">
      <div class="friend-marker-inner ${borderClass}" style="background:${color}">${initial(friend.name)}</div>
      <div class="${nameClass}" style="border-color:${borderColor}">${escHtml(friend.name)}${statusLabel}</div>
    </div>`
  });

  if (friend.marker) {
    friend.marker.setLatLng([numLat, numLng]).setIcon(icon);
  } else {
    friend.marker = L.marker([numLat, numLng], { icon })
      .addTo(STATE.map)
      .on('click', () => openFriendDetail(userId));
  }

  drawDistanceLines();
}

function drawDistanceLines() {
  if (!STATE.map) return;

  // Clear existing lines if disabled
  if (!STATE.showDistanceLines || !STATE.myLocation || STATE.myLocation.lat == null) {
    Object.values(STATE.distanceLines).forEach(item => {
      if (item.line) STATE.map.removeLayer(item.line);
      if (item.label) STATE.map.removeLayer(item.label);
    });
    STATE.distanceLines = {};
    return;
  }

  const myLat = Number(STATE.myLocation.lat);
  const myLng = Number(STATE.myLocation.lng);

  Object.entries(STATE.friends).forEach(([uid, f]) => {
    if (!f.location || f.location.lat == null) {
      if (STATE.distanceLines[uid]) {
        if (STATE.distanceLines[uid].line) STATE.map.removeLayer(STATE.distanceLines[uid].line);
        if (STATE.distanceLines[uid].label) STATE.map.removeLayer(STATE.distanceLines[uid].label);
        delete STATE.distanceLines[uid];
      }
      return;
    }

    const fLat = Number(f.location.lat);
    const fLng = Number(f.location.lng);
    const midLat = (myLat + fLat) / 2;
    const midLng = (myLng + fLng) / 2;
    const distText = formatDist(distanceMeters(myLat, myLng, fLat, fLng));

    const linePoints = [[myLat, myLng], [fLat, fLng]];

    if (STATE.distanceLines[uid]) {
      STATE.distanceLines[uid].line.setLatLngs(linePoints);
      STATE.distanceLines[uid].label.setLatLng([midLat, midLng]);
      const el = STATE.distanceLines[uid].label.getElement();
      if (el) el.innerHTML = `<div class="distance-pill-label">⚡ ${distText}</div>`;
    } else {
      const line = L.polyline(linePoints, {
        color: '#818cf8',
        weight: 2,
        dashArray: '6, 8',
        opacity: 0.8
      }).addTo(STATE.map);

      const labelIcon = L.divIcon({
        className: '',
        html: `<div class="distance-pill-label">⚡ ${distText}</div>`,
        iconSize: [60, 20],
        iconAnchor: [30, 10]
      });

      const label = L.marker([midLat, midLng], {
        icon: labelIcon,
        interactive: false
      }).addTo(STATE.map);

      STATE.distanceLines[uid] = { line, label };
    }
  });
}

function removeFriendMarker(userId) {
  const f = STATE.friends[userId];
  if (f && f.marker) {
    if (STATE.map) {
      try { STATE.map.removeLayer(f.marker); } catch (e) {}
    }
    f.marker = null;
  }
  if (STATE.distanceLines[userId]) {
    if (STATE.distanceLines[userId].line) STATE.map.removeLayer(STATE.distanceLines[userId].line);
    if (STATE.distanceLines[userId].label) STATE.map.removeLayer(STATE.distanceLines[userId].label);
    delete STATE.distanceLines[userId];
  }
}

function recenterMap() {
  if (STATE.myLocation && STATE.myLocation.lat != null && STATE.map) {
    STATE.map.flyTo([Number(STATE.myLocation.lat), Number(STATE.myLocation.lng)], 16, { duration: 0.8 });
  }
}

function fitAllFriends() {
  if (!STATE.map) return;
  const points = [];
  if (STATE.myLocation && STATE.myLocation.lat != null) {
    points.push([Number(STATE.myLocation.lat), Number(STATE.myLocation.lng)]);
  }
  Object.values(STATE.friends).forEach(f => {
    if (f.location && f.location.lat != null) {
      points.push([Number(f.location.lat), Number(f.location.lng)]);
    }
  });

  if (points.length === 0) {
    showToast('No active locations to fit yet', 'info');
    return;
  }
  if (points.length === 1) {
    STATE.map.flyTo(points[0], 16, { duration: 0.8 });
    return;
  }

  const bounds = L.latLngBounds(points);
  STATE.map.fitBounds(bounds, { padding: [60, 60], maxZoom: 17, duration: 0.8 });
  showToast(`🔍 Showing all ${points.length} locations on radar`, 'info');
}

function updateMapHud(speed, accuracy, isGps) {
  const gpsText = document.getElementById('hudGpsText');
  const speedText = document.getElementById('hudSpeedText');
  if (gpsText) {
    if (accuracy) {
      gpsText.textContent = `${isGps ? 'GPS' : 'IP'}: ±${accuracy}m`;
    } else {
      gpsText.textContent = 'Locating…';
    }
  }
  if (speedText) {
    if (speed != null && !isNaN(speed) && speed > 0) {
      const kmh = Math.round(speed * 3.6);
      speedText.textContent = `${kmh} km/h`;
    } else {
      speedText.textContent = '0 km/h';
    }
  }
}

// ────────────────────────────────────────────────────────────
// WebSocket
// ────────────────────────────────────────────────────────────
function buildWsUrl() {
  // wss:// when served over HTTPS (localtunnel), ws:// on plain http (local)
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}`;
}

function connectWs(roomCode, userId, name) {
  // Cancel any pending reconnect and detach the old socket's handlers so its
  // close event can't trigger a duplicate reconnect (and ping-pong loops).
  if (STATE.wsReconnectTimer) {
    clearTimeout(STATE.wsReconnectTimer);
    STATE.wsReconnectTimer = null;
  }
  if (STATE.ws) {
    STATE.ws.onclose = null;
    STATE.ws.onerror = null;
    STATE.ws.close();
  }

  const ws = new WebSocket(buildWsUrl());
  STATE.ws = ws;

  ws.onopen = () => {
    STATE.wsReconnectAttempts = 0;
    updateConnectionStatus('connected');
    
    // Send join message compatible with both protocols
    ws.send(JSON.stringify({
      type: 'join',
      room: roomCode,
      roomCode,
      userId,
      name,
      deviceType: 'web',
      userData: { name, id: userId }
    }));

    // Broadcast location helper
    const broadcastMyLocation = () => {
      if (!STATE.myLocation || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({
        type: 'location',
        room: roomCode,
        userId,
        name,
        lat: STATE.myLocation.lat,
        lng: STATE.myLocation.lng,
        locationType: STATE.myLocation.type,
        accuracy: STATE.myLocation.accuracy || null,
      }));
    };

    // Send current location immediately if available
    broadcastMyLocation();

    // Also re-broadcast after 2s and 5s to catch GPS firing after join
    setTimeout(broadcastMyLocation, 2000);
    setTimeout(broadcastMyLocation, 5000);

    // Start periodic 8-second location broadcast to keep everyone in sync
    if (STATE.locationBroadcastInterval) clearInterval(STATE.locationBroadcastInterval);
    STATE.locationBroadcastInterval = setInterval(broadcastMyLocation, 8000);
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleServerMessage(msg);
    } catch (e) {
      console.error('WS parse error', e);
    }
  };

  ws.onclose = () => {
    updateConnectionStatus('disconnected');
    // While the page is hidden (app backgrounded/closed) the native Android
    // SOS service owns the room connection — don't fight it for the socket.
    if (document.hidden) return;
    if (STATE.wsReconnectAttempts < 5) {
      const delay = Math.min(1000 * 2 ** STATE.wsReconnectAttempts, 15000);
      STATE.wsReconnectAttempts++;
      STATE.wsReconnectTimer = setTimeout(() => {
        STATE.wsReconnectTimer = null;
        connectWs(STATE.roomCode, STATE.myId, STATE.myName);
      }, delay);
    }
  };

  ws.onerror = (e) => {
    console.error('WS error', e);
  };
}

function handleServerMessage(msg) {
  updateConnectionStatus('connected');

  switch (msg.type) {
    case 'join':
    case 'JOINED':
      updateConnectionStatus('connected');
      if (msg.roomName) applyRoomName(msg.roomName, false);
      showToast(`✅ Connected to room ${msg.roomCode || STATE.roomCode}`, 'success');
      break;

    case 'room_members':
    case 'ROOM_STATE': {
      updateConnectionStatus('connected');
      if (msg.roomName) applyRoomName(msg.roomName, false);
      const members = msg.members || [];
      let hasFriendWithLocation = false;
      members.forEach(member => {
        if (member.id === STATE.myId || (member.name && member.name === STATE.myName)) return;
        updateFriend(member.id, member);
        // Ping every member immediately to get fresh GPS coordinates
        if (STATE.ws?.readyState === WebSocket.OPEN) {
          STATE.ws.send(JSON.stringify({
            type: 'ping',
            targetId: member.id,
            room: STATE.roomCode,
          }));
        }
        if (STATE.friends[member.id]?.location?.lat != null) {
          hasFriendWithLocation = true;
        }
      });
      renderFriendsList();
      renderBottomStrip();
      // Auto-fit map to show all friends when room state arrives
      if (hasFriendWithLocation) {
        setTimeout(() => fitAllFriends(), 800);
      }
      // Also re-ping all after 3s in case their GPS just fired
      setTimeout(() => {
        members.forEach(member => {
          if (member.id === STATE.myId || !member.id) return;
          if (STATE.friends[member.id]?.location?.lat == null && STATE.ws?.readyState === WebSocket.OPEN) {
            STATE.ws.send(JSON.stringify({ type: 'ping', targetId: member.id, room: STATE.roomCode }));
          }
        });
      }, 3000);
      break;
    }

    case 'ROOM_RENAMED':
      if (msg.roomName) {
        applyRoomName(msg.roomName, false);
        showToast(`🏷️ Room named "${msg.roomName}"`, 'info', 3500);
      }
      break;

    case 'SNAP_LOCATION': {
      const targetId = msg.targetUserId || msg.userId;
      if (targetId === STATE.myId) {
        STATE.isLocationLocked = true;
        const snapLoc = {
          lat: Number(msg.lat),
          lng: Number(msg.lng),
          type: 'gps',
          accuracy: 1,
          label: 'GPS • Synced with room (0m)'
        };
        onMyLocationUpdate(snapLoc, true);
        showToast('🎯 Location synchronized to 0m!', 'success', 3500);
      } else if (STATE.friends[targetId]) {
        STATE.friends[targetId].location = {
          lat: Number(msg.lat),
          lng: Number(msg.lng),
          locType: 'gps',
          accuracy: 1,
          lastUpdated: Date.now()
        };
        addOrUpdateFriendMarker(targetId, STATE.friends[targetId]);
        drawDistanceLines();
        renderFriendsList();
        renderBottomStrip();
      }
      break;
    }

    case 'joined': {
      if (msg.userId && msg.userId !== STATE.myId && msg.name !== STATE.myName) {
        updateFriend(msg.userId, { id: msg.userId, name: msg.name || 'Friend' });
        renderFriendsList();
        renderBottomStrip();
        // Respond with our location so newly joined friend gets our data immediately
        if (STATE.myLocation && STATE.ws?.readyState === WebSocket.OPEN) {
          STATE.ws.send(JSON.stringify({
            type: 'location',
            room: STATE.roomCode,
            userId: STATE.myId,
            name: STATE.myName,
            lat: STATE.myLocation.lat,
            lng: STATE.myLocation.lng,
            locationType: STATE.myLocation.type,
            accuracy: STATE.myLocation.accuracy || null,
          }));
        }
        // Ping new peer to immediately request their location
        if (STATE.ws?.readyState === WebSocket.OPEN) {
          STATE.ws.send(JSON.stringify({
            type: 'ping',
            targetId: msg.userId,
            room: STATE.roomCode,
          }));
        }
      }
      break;
    }

    case 'location': {
      if (msg.userId === STATE.myId && msg.isSnap) {
        STATE.isLocationLocked = true;
        const snapLoc = {
          lat: Number(msg.lat),
          lng: Number(msg.lng),
          type: 'gps',
          accuracy: 1,
          label: 'GPS • Synced with room (0m)'
        };
        onMyLocationUpdate(snapLoc, true);
        showToast('🎯 Location synchronized to 0m!', 'success', 3500);
        break;
      }
      if (msg.userId && msg.userId !== STATE.myId) {
        const hadLocationBefore = STATE.friends[msg.userId]?.location?.lat != null;
        updateFriend(msg.userId, {
          id: msg.userId,
          name: msg.name || 'Friend',
          lat: msg.lat,
          lng: msg.lng,
          locType: msg.locationType || msg.locType || 'gps',
          accuracy: msg.accuracy,
          isOnline: true
        });
        renderFriendsList();
        renderBottomStrip();
        // Auto-fit map the first time we receive this friend's location
        if (!hadLocationBefore && STATE.friends[msg.userId]?.location?.lat != null) {
          setTimeout(() => fitAllFriends(), 600);
        }
      }
      break;
    }

    case 'FRIEND_LOCATION_UPDATE':
      if (msg.userId && msg.userId !== STATE.myId) {
        updateFriend(msg.userId, {
          id: msg.userId,
          name: msg.name || 'Friend',
          lat: msg.location?.lat,
          lng: msg.location?.lng,
          locType: msg.location?.locType || 'gps',
          accuracy: msg.location?.accuracy,
          isOnline: true
        });
        renderFriendsList();
        renderBottomStrip();
      }
      break;

    // Friend disconnected temporarily (closed app, tab, or locked screen)
    case 'member_status': {
      if (msg.userId && msg.userId !== STATE.myId) {
        updateFriend(msg.userId, {
          id: msg.userId,
          name: msg.name,
          isOnline: msg.isOnline,
          lastSeen: msg.lastSeen || Date.now(),
          lat: msg.lat,
          lng: msg.lng,
          locType: msg.locationType
        });
        renderFriendsList();
        renderBottomStrip();
        const fName = STATE.friends[msg.userId]?.name || 'Friend';
        if (msg.isOnline === false) {
          showToast(`📱 ${fName} closed the app (last known location pinned)`, 'info', 3500);
        } else if (msg.isOnline === true) {
          showToast(`🟢 ${fName} is back online!`, 'success', 2500);
        }
      }
      break;
    }

    // Legacy temporary disconnect event: keep location pinned, do NOT remove marker
    case 'left':
    case 'FRIEND_LEFT':
      if (STATE.friends[msg.userId]) {
        STATE.friends[msg.userId].isOnline = false;
        STATE.friends[msg.userId].lastSeen = Date.now();
        if (STATE.friends[msg.userId].location) {
          addOrUpdateFriendMarker(msg.userId, STATE.friends[msg.userId]);
        }
        renderFriendsList();
        renderBottomStrip();
      }
      break;

    // Friend explicitly left the room permanently: erase their marker and location
    case 'member_left_permanent':
      if (STATE.friends[msg.userId]) {
        const leftName = STATE.friends[msg.userId].name;
        removeFriendMarker(msg.userId);
        if (STATE.distanceLines[msg.userId]) {
          if (STATE.distanceLines[msg.userId].line) STATE.map?.removeLayer(STATE.distanceLines[msg.userId].line);
          if (STATE.distanceLines[msg.userId].label) STATE.map?.removeLayer(STATE.distanceLines[msg.userId].label);
          delete STATE.distanceLines[msg.userId];
        }
        delete STATE.friends[msg.userId];
        renderFriendsList();
        renderBottomStrip();
        showToast(`🛑 ${leftName} left the room permanently`, 'info', 4000);
      }
      break;

    case 'sos':
    case 'SOS_ALERT':
      showSosAlert(msg);
      logSosActivity(msg);
      break;

    case 'SOS_PHOTO': {
      if (!STATE.sosPhotos[msg.userId]) STATE.sosPhotos[msg.userId] = [];
      if (!STATE.sosPhotos[msg.userId].some(p => p.photoUrl === msg.photoUrl)) {
        STATE.sosPhotos[msg.userId].push(msg);
        addSosPhotoToAlert(msg);
        showToast(`📸 ${msg.name || 'Friend'} sent an evidence photo`, 'info', 3000);
      }
      break;
    }

    // A friend saw MY SOS — update the ack counter on the sender panel
    case 'SOS_ACK': {
      if (msg.targetUserId === STATE.myId) {
        handleMySosAck(msg);
      }
      break;
    }

    // Someone in the room marked themselves safe after an SOS
    case 'SAFE_ALERT': {
      const safeName = msg.name || 'A friend';
      if (msg.userId === STATE.myId) break;
      hideAckPanel();
      showToast(`✅ ${safeName} is SAFE!`, 'success', 5000);
      if (navigator.vibrate) navigator.vibrate([80, 60, 80]);
      logSafeActivity(safeName, false);
      // If their SOS alarm screen is open, stand down automatically
      if (msg.userId === STATE.currentSosAlertUserId) {
        STATE.currentSosAlertUserId = null;
        const alertOverlay = document.getElementById('sosAlertOverlay');
        if (alertOverlay && !alertOverlay.classList.contains('hidden')) {
          alertOverlay.classList.add('hidden');
          stopEmergencySiren();
        }
      }
      break;
    }

    case 'ping':
    case 'PING_YOU':
      if (STATE.ws?.readyState === WebSocket.OPEN) {
        if (STATE.myLocation) {
          // Respond with current location immediately
          STATE.ws.send(JSON.stringify({
            type: 'location',
            room: STATE.roomCode,
            userId: STATE.myId,
            name: STATE.myName,
            lat: STATE.myLocation.lat,
            lng: STATE.myLocation.lng,
            locationType: STATE.myLocation.type,
            accuracy: STATE.myLocation.accuracy || null,
          }));
        } else {
          // No GPS yet — try to get location and then respond
          getIPLocation().then(ipLoc => {
            if (ipLoc) {
              onMyLocationUpdate(ipLoc);
            }
          });
          // Retry response after 2 seconds
          setTimeout(() => {
            if (STATE.myLocation && STATE.ws?.readyState === WebSocket.OPEN) {
              STATE.ws.send(JSON.stringify({
                type: 'location',
                room: STATE.roomCode,
                userId: STATE.myId,
                name: STATE.myName,
                lat: STATE.myLocation.lat,
                lng: STATE.myLocation.lng,
                locationType: STATE.myLocation.type,
                accuracy: STATE.myLocation.accuracy || null,
              }));
            }
          }, 2000);
        }
      }
      break;
  }
}

function updateFriend(uid, data) {
  if (!STATE.friends[uid]) {
    STATE.friends[uid] = {
      name: data.name || 'Friend',
      location: null,
      marker: null,
      isOnline: data.isOnline !== false,
      lastSeen: data.lastSeen || Date.now()
    };
  } else {
    STATE.friends[uid].name = data.name || STATE.friends[uid].name;
    if (data.isOnline !== undefined) STATE.friends[uid].isOnline = data.isOnline !== false;
    if (data.lastSeen) STATE.friends[uid].lastSeen = data.lastSeen;
  }

  // Deduplicate: If an older entry with the exact same name exists under a different uid (e.g. from prior tab test),
  // clean up its old marker so they don't overlap!
  const currentName = (STATE.friends[uid].name || '').trim().toLowerCase();
  if (currentName) {
    Object.keys(STATE.friends).forEach(otherUid => {
      if (otherUid !== uid && STATE.friends[otherUid]?.name?.trim().toLowerCase() === currentName) {
        removeFriendMarker(otherUid);
        if (STATE.distanceLines[otherUid]) {
          if (STATE.distanceLines[otherUid].line) STATE.map?.removeLayer(STATE.distanceLines[otherUid].line);
          if (STATE.distanceLines[otherUid].label) STATE.map?.removeLayer(STATE.distanceLines[otherUid].label);
          delete STATE.distanceLines[otherUid];
        }
        delete STATE.friends[otherUid];
      }
    });
  }

  // Normalize: server sends lat/lng at top level, locType or locationType
  const lat = data.lat ?? data.location?.lat;
  const lng = data.lng ?? data.location?.lng;
  const locType = data.locType || data.locationType || data.location?.locType || 'gps';
  const accuracy = data.accuracy ?? data.location?.accuracy;

  if (lat != null && !isNaN(Number(lat)) && lng != null && !isNaN(Number(lng))) {
    STATE.friends[uid].location = {
      lat: Number(lat),
      lng: Number(lng),
      locType,
      accuracy,
      city: data.city || data.location?.city,
      lastUpdated: data.lastUpdated || data.location?.lastUpdated || Date.now()
    };
    addOrUpdateFriendMarker(uid, STATE.friends[uid]);
  }
}

function updateConnectionStatus(status) {
  const dot = document.getElementById('connectionDot');
  const label = document.getElementById('roomStatusLabel');
  if (status === 'connected') {
    dot.className = 'pulsing-dot connected';
    label.textContent = STATE.roomName ? `${STATE.roomName} • ${STATE.roomCode}` : `Room ${STATE.roomCode}`;
  } else {
    dot.className = 'pulsing-dot';
    label.textContent = 'Reconnecting…';
  }
}

// ── Room Naming & Aliases ────────────────────────────────────
function applyRoomName(name, broadcast = true) {
  const cleanName = (name || '').trim();
  STATE.roomName = cleanName || null;

  try {
    if (cleanName && STATE.roomCode) {
      localStorage.setItem('friendpulse_room_name_' + STATE.roomCode, cleanName);
      localStorage.setItem('friendpulse_last_room_name', cleanName);
    } else if (!cleanName && STATE.roomCode) {
      localStorage.removeItem('friendpulse_room_name_' + STATE.roomCode);
      localStorage.removeItem('friendpulse_last_room_name');
    }
  } catch (_) {}

  // Update header status pill
  updateConnectionStatus('connected');

  // Update Room Info Card
  const customDisplay = document.getElementById('roomCustomNameDisplay');
  const cardTitle = document.getElementById('roomCardTitle');
  if (customDisplay) {
    if (cleanName) {
      customDisplay.textContent = cleanName;
      customDisplay.style.display = 'block';
      if (cardTitle) cardTitle.textContent = cleanName;
    } else {
      customDisplay.textContent = '';
      customDisplay.style.display = 'none';
      if (cardTitle) cardTitle.textContent = 'Your Room';
    }
  }

  // Update Rejoin Card if present
  const rejoinCodeText = document.getElementById('rejoinCodeText');
  if (rejoinCodeText && STATE.roomCode) {
    rejoinCodeText.textContent = cleanName ? `${cleanName} (${STATE.roomCode})` : STATE.roomCode;
  }

  if (broadcast && STATE.roomCode) {
    if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
      STATE.ws.send(JSON.stringify({
        type: 'RENAME_ROOM',
        room: STATE.roomCode,
        roomName: cleanName
      }));
    }
    fetch('/api/rename-room', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: STATE.roomCode, roomName: cleanName })
    }).catch(() => {});
  }
}

function initRoomNaming() {
  const editBtn = document.getElementById('editRoomNameBtn');
  const modal = document.getElementById('renameModalOverlay');
  const input = document.getElementById('renameRoomInput');
  const saveBtn = document.getElementById('btnSaveRoomName');
  const cancelBtn = document.getElementById('btnCancelRename');

  if (!editBtn || !modal) return;

  editBtn.onclick = () => {
    input.value = STATE.roomName || '';
    modal.classList.remove('hidden');
    setTimeout(() => input.focus(), 150);
  };

  const closeModal = () => modal.classList.add('hidden');
  if (cancelBtn) cancelBtn.onclick = closeModal;
  modal.onclick = (e) => {
    if (e.target === modal) closeModal();
  };

  if (saveBtn) {
    saveBtn.onclick = () => {
      const val = input.value.trim();
      applyRoomName(val, true);
      closeModal();
      showToast(val ? `🏷️ Room name saved: "${val}"` : '🏷️ Room name reset', 'success');
    };
  }

  input.onkeydown = (e) => {
    if (e.key === 'Enter') saveBtn?.click();
    if (e.key === 'Escape') closeModal();
  };
}

// ────────────────────────────────────────────────────────────
function calculateFriendDistance(f) {
  if (!f || !f.location || f.location.lat == null) return 'No location';
  if (!STATE.myLocation || STATE.myLocation.lat == null) {
    // Proactively fetch IP location if we don't have our own position yet
    getIPLocation().then(ipLoc => {
      if (ipLoc && !STATE.myLocation) onMyLocationUpdate(ipLoc);
    });
    return '📍 Locating…';
  }
  const myLat = Number(STATE.myLocation.lat);
  const myLng = Number(STATE.myLocation.lng);
  const fLat = Number(f.location.lat);
  const fLng = Number(f.location.lng);
  if (isNaN(myLat) || isNaN(myLng) || isNaN(fLat) || isNaN(fLng)) return '—';
  const d = distanceMeters(myLat, myLng, fLat, fLng);
  return formatDist(d);
}

// ────────────────────────────────────────────────────────────
// UI Render
// ────────────────────────────────────────────────────────────
function renderFriendsList() {
  const container = document.getElementById('friendsList');
  const noState = document.getElementById('noFriendsState');
  const badge = document.getElementById('memberCountBadge');
  const entries = Object.entries(STATE.friends);
  const totalCount = entries.length;
  const onlineCount = entries.filter(([_, f]) => f.isOnline !== false).length;

  badge.textContent = `${onlineCount} active · ${totalCount} in room`;

  if (totalCount === 0) {
    noState.style.display = 'block';
    container.innerHTML = '';
    container.appendChild(noState);
    return;
  }
  noState.style.display = 'none';

  container.innerHTML = entries.map(([uid, f]) => {
    const hasLoc = f.location && f.location.lat != null;
    const dist = calculateFriendDistance(f);
    const locType = f.location?.locType || 'unknown';
    const isOnline = f.isOnline !== false;
    const locLabel = !isOnline
      ? '⏸️ Offline (Last known location pinned)'
      : locType === 'gps' ? '📍 GPS (active live)' : locType === 'ip' ? '🌐 IP (city-level)' : '❓ Locating…';
    const locClass = !isOnline ? 'fc-unknown' : locType === 'gps' ? 'fc-gps' : locType === 'ip' ? 'fc-ip' : 'fc-unknown';
    const color = avatarColor(uid);
    const ago = f.lastSeen ? timeAgo(f.lastSeen) : '';
    const statusDot = isOnline ? '🟢' : '⚪';

    return `
      <div class="friend-card" onclick="openFriendDetail('${uid}')" style="${!isOnline ? 'opacity:0.86; border-color:rgba(255,255,255,0.08);' : ''}">
        <div class="fc-avatar" style="background:${color}">${initial(f.name)}</div>
        <div class="fc-info">
          <h4>${escHtml(f.name)} <span style="font-size:11px;font-weight:600;color:${isOnline ? 'var(--green)' : '#94a3b8'};">${statusDot} ${isOnline ? 'Online' : 'Away'}</span></h4>
          <div class="fc-dist">📏 ${dist}${ago ? ' · ' + ago : ''}</div>
          <div class="fc-loc-type ${locClass}">${locLabel}</div>
        </div>
        ${hasLoc ? `
          <button class="fc-nav-btn" onclick="event.stopPropagation(); navigateTo(${f.location.lat},${f.location.lng})" title="Open in Maps">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>
          </button>
        ` : ''}
      </div>`;
  }).join('');
}

function renderBottomStrip() {
  const strip = document.getElementById('bottomFriendStrip');
  const entries = Object.entries(STATE.friends);
  if (entries.length === 0) { strip.innerHTML = ''; return; }

  strip.innerHTML = entries.map(([uid, f]) => {
    const hasLoc = f.location && f.location.lat != null;
    const dist = calculateFriendDistance(f);
    const color = avatarColor(uid);
    const isOnline = f.isOnline !== false;
    const isGps = f.location?.locType === 'gps';
    const accClass = !hasLoc || !isOnline ? 'acc-none' : isGps ? 'acc-gps' : 'acc-ip';

    return `
      <div class="friend-strip-chip" onclick="focusFriendOnMap('${uid}')" style="${!isOnline ? 'opacity:0.8;' : ''}">
        <div class="strip-avatar" style="background:${color}">${initial(f.name)}</div>
        <div class="strip-info">
          <h4>${escHtml(f.name)}${!isOnline ? ' (Away)' : ''}</h4>
          <p>${dist}</p>
        </div>
        <div class="acc-dot ${accClass}"></div>
      </div>`;
  }).join('');
}

// ────────────────────────────────────────────────────────────
// Friend Detail Bottom Sheet
// ────────────────────────────────────────────────────────────
function openFriendDetail(uid) {
  const f = STATE.friends[uid];
  if (!f) return;

  const hasLoc = f.location && f.location.lat != null;
  const dist = calculateFriendDistance(f);
  const locType = f.location?.locType || 'unknown';
  const isOnline = f.isOnline !== false;
  const locLabel = !isOnline
    ? '⏸️ Offline (Last known location)'
    : locType === 'gps' ? '📍 GPS (high accuracy)' : locType === 'ip' ? '🌐 IP-based (city level)' : 'No location';
  const locBadgeClass = !isOnline ? 'fc-unknown' : locType === 'gps' ? 'fc-gps' : locType === 'ip' ? 'fc-ip' : 'fc-unknown';
  const color = avatarColor(uid);
  const coordText = hasLoc
    ? `${Number(f.location.lat).toFixed(5)}, ${Number(f.location.lng).toFixed(5)}`
    : 'Not available';
  const accText = f.location?.accuracy ? `±${f.location.accuracy}m` : f.location?.city ? f.location.city : '—';
  const ago = f.lastSeen ? timeAgo(f.lastSeen) : '—';
  const statusHtml = isOnline
    ? '<span style="color:var(--green);font-weight:700;">🟢 Active now</span>'
    : '<span style="color:#94a3b8;font-weight:700;">⚪ Away (app closed)</span>';

  document.getElementById('detailSheetBody').innerHTML = `
    <div class="sheet-profile-row">
      <div class="sheet-avatar" style="background:${color}">${initial(f.name)}</div>
      <div class="sheet-profile-info">
        <h3>${escHtml(f.name)}</h3>
        <p>${statusHtml} · Last seen: ${ago}</p>
        <div class="sheet-loc-type-badge fc-loc-type ${locBadgeClass}">${locLabel}</div>
      </div>
    </div>

    <div class="info-chips">
      <div class="info-chip">
        <div class="chip-label">DISTANCE</div>
        <div class="chip-val">${dist}</div>
      </div>
      <div class="info-chip">
        <div class="chip-label">ACCURACY</div>
        <div class="chip-val">${accText}</div>
      </div>
      <div class="info-chip">
        <div class="chip-label">COORDS</div>
        <div class="chip-val" style="font-size:10px">${hasLoc ? `${Number(f.location.lat).toFixed(4)}, ${Number(f.location.lng).toFixed(4)}` : '—'}</div>
      </div>
    </div>

    <div class="sheet-actions">
      ${hasLoc ? `
        <button class="sheet-btn sheet-btn-primary" onclick="navigateTo(${f.location.lat},${f.location.lng})">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>
          Navigate to ${escHtml(f.name)}'s Position
        </button>
        ${isOnline ? `
          <button class="sheet-btn sheet-btn-ghost" title="Ping for fresh location" onclick="pingFriend('${uid}')">
            ⚡
          </button>
        ` : ''}
        <button class="sheet-btn" style="background:linear-gradient(135deg, #10b981, #059669); color:#fff; font-weight:700; width:100%; margin-top:8px;" onclick="snapFriendToMe('${uid}')">
          🎯 Snap ${escHtml(f.name)} to My Location (0m Test)
        </button>
      ` : `
        <div style="color:var(--muted);font-size:13px;text-align:center;padding:10px 0;">
          📡 Waiting for ${escHtml(f.name)}'s location…<br>
          <span style="font-size:12px">They may have GPS turned off. Approximate location will appear once available.</span>
        </div>
      `}
    </div>
  `;

  openSheet();
}

window.snapFriendToMe = function(uid) {
  const f = STATE.friends[uid];
  if (!f) return;
  if (!STATE.myLocation || STATE.myLocation.lat == null) {
    showToast('⚠️ Waiting for your own GPS location first…', 'warn', 3000);
    return;
  }
  const myLat = Number(STATE.myLocation.lat);
  const myLng = Number(STATE.myLocation.lng);

  f.location = {
    lat: myLat,
    lng: myLng,
    locType: 'gps',
    accuracy: 1,
    lastUpdated: Date.now()
  };
  addOrUpdateFriendMarker(uid, f);
  drawDistanceLines();
  renderFriendsList();
  renderBottomStrip();

  if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
    STATE.ws.send(JSON.stringify({
      type: 'SYNC_FRIEND_LOCATION',
      room: STATE.roomCode,
      targetUserId: uid,
      lat: myLat,
      lng: myLng
    }));
  }

  fetch('/api/sync-friend-location', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      room: STATE.roomCode,
      targetUserId: uid,
      lat: myLat,
      lng: myLng
    }),
    keepalive: true
  }).catch(() => {});

  closeSheet();
  showToast(`🎯 Snapped ${f.name} to your location! Distance is 0m!`, 'success', 4500);
};

function openSheet() {
  document.getElementById('detailSheet').classList.add('open');
  const bd = document.getElementById('sheetBackdrop');
  bd.classList.add('active');
  bd.setAttribute('aria-hidden', 'false');
}

function closeSheet() {
  document.getElementById('detailSheet').classList.remove('open');
  const bd = document.getElementById('sheetBackdrop');
  bd.classList.remove('active');
  bd.setAttribute('aria-hidden', 'true');
}

function focusFriendOnMap(uid) {
  const f = STATE.friends[uid];
  if (!f || !f.location) return;
  switchTab('tab-map');
  STATE.map.flyTo([f.location.lat, f.location.lng], 16, { duration: 0.9 });
  setTimeout(() => openFriendDetail(uid), 700);
}

function navigateTo(lat, lng) {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const url = isIOS
    ? `maps://maps.apple.com/?daddr=${lat},${lng}`
    : `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  window.open(url, '_blank');
}

function pingFriend(uid) {
  if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
    STATE.ws.send(JSON.stringify({ type: 'PING_REQUEST', targetId: uid }));
    showToast('⚡ Location ping sent!', 'info');
  }
}

// ────────────────────────────────────────────────────────────
// SOS
// ────────────────────────────────────────────────────────────
let sosHoldInterval = null;
let sosProgress = 0;

function initSosButton() {
  const btn = document.getElementById('sosPanicBtn');
  const startSos = () => {
    sosProgress = 0;
    btn.classList.add('held');
    btn.querySelector('#sosBtnText').textContent = '2…';
    sosHoldInterval = setInterval(() => {
      sosProgress += 50;
      const remaining = Math.ceil((2000 - sosProgress) / 1000);
      btn.querySelector('#sosBtnText').textContent = remaining > 0 ? `${remaining}…` : 'SOS';
      if (sosProgress >= 2000) {
        clearInterval(sosHoldInterval);
        sosHoldInterval = null;
        triggerSOS();
      }
    }, 50);
  };
  const cancelSos = () => {
    clearInterval(sosHoldInterval);
    sosHoldInterval = null;
    btn.classList.remove('held');
    btn.querySelector('#sosBtnText').textContent = 'SOS';
  };

  btn.addEventListener('mousedown', startSos);
  btn.addEventListener('touchstart', (e) => { e.preventDefault(); startSos(); }, { passive: false });
  btn.addEventListener('mouseup', cancelSos);
  btn.addEventListener('mouseleave', cancelSos);
  btn.addEventListener('touchend', cancelSos);
  btn.addEventListener('touchcancel', cancelSos);
}

function triggerSOS(auto = false) {
  // Try to get location: live > cached localStorage
  let loc = STATE.myLocation;
  if (!loc) {
    try {
      const cached = localStorage.getItem('friendpulse_last_loc');
      if (cached) loc = JSON.parse(cached);
    } catch (_) {}
  }

  if (!loc || loc.lat == null) {
    showToast('⚠️ Cannot send SOS — no location available. Enable GPS and try again.', 'error', 4000);
    return;
  }

  const sosPayload = {
    type: 'SOS',
    room: STATE.roomCode,
    userId: STATE.myId,
    name: STATE.myName,
    lat: loc.lat,
    lng: loc.lng,
    locType: loc.type || loc.locType || 'gps',
    auto,
    timestamp: Date.now()
  };

  let sent = false;

  // Primary: send via WebSocket if open
  if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
    STATE.ws.send(JSON.stringify(sosPayload));
    sent = true;
  }

  // Fallback ONLY: use HTTP if WS is not available
  if (!sent) {
    fetch('/api/sos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sosPayload),
      keepalive: true
    }).then(r => r.json()).then(() => {
      showToast('🚨 SOS sent via network fallback!', 'error', 5000);
    }).catch(() => {
      showToast('⚠️ SOS failed — no connection. Call 112 directly!', 'error', 6000);
    });
  }

  // Haptic feedback on mobile
  if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 400]);

  showToast(auto ? '⏰ Auto-SOS sent — Safety Watch expired!' : '🚨 SOS sent to all friends in the room!', 'error', 5000);
  logSosActivity({ name: STATE.myName, lat: loc.lat, lng: loc.lng, timestamp: Date.now(), self: true });
  document.getElementById('sosPanicBtn').querySelector('#sosBtnText').textContent = 'SOS';
  document.getElementById('sosPanicBtn').classList.remove('held');

  // Show the sender panel: friends acknowledge + "I'm Safe" check-in
  resetAckPanel();
  showAckPanel(auto);

  // Auto-capture evidence photos (front then back camera) and send to friends
  captureSosEvidencePhotos(loc);
}

// ─── SOS Evidence Photos (auto front + back camera capture) ───
async function captureSosEvidencePhotos(loc) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  const cameras = [
    { camera: 'front', facingMode: 'user' },
    { camera: 'back', facingMode: 'environment' }
  ];
  for (const c of cameras) {
    try {
      const dataUrl = await captureSinglePhoto(c.facingMode);
      if (dataUrl) await uploadSosPhoto(dataUrl, c.camera, loc);
    } catch (e) {
      console.warn(`[SOS-PHOTO] ${c.camera} camera capture failed:`, e.message);
    }
  }
}

async function captureSinglePhoto(facingMode) {
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    // Give auto-exposure/focus a moment to settle before grabbing the frame
    await new Promise(r => setTimeout(r, 600));
    const w = video.videoWidth || 1280;
    const h = video.videoHeight || 720;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(video, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.7);
  } finally {
    if (stream) stream.getTracks().forEach(t => t.stop());
  }
}

async function uploadSosPhoto(dataUrl, camera, loc) {
  try {
    const res = await fetch('/api/sos-photo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room: STATE.roomCode,
        userId: STATE.myId,
        name: STATE.myName,
        image: dataUrl,
        camera,
        lat: loc?.lat ?? null,
        lng: loc?.lng ?? null
      })
    });
    if (res.ok) {
      showToast(`📸 ${camera === 'front' ? 'Front' : 'Back'} camera photo sent to friends`, 'success', 3000);
    }
  } catch (e) {
    console.warn('[SOS-PHOTO] upload failed:', e.message);
  }
}

// ─── Emergency Siren Dual-Engine Audio System ─────────────
let globalAudioCtx = null;
let fallbackSirenAudio = null;
let isSirenPlaying = false;
let sirenCarrier = null;
let sirenLfo = null;
let sirenMasterGain = null;

// Synthesizes a valid looping 16-bit PCM WAV siren in memory with 0 network dependencies
function createSirenWavBlob() {
  const sampleRate = 22050;
  const duration = 1.0;
  const numSamples = Math.floor(sampleRate * duration);
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // 1 channel (mono)
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  // Generate loud dual-tone emergency police sweep (700Hz to 1300Hz)
  let phase = 0;
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const freq = 900 + 400 * Math.sin(2 * Math.PI * 2.2 * t);
    phase += (2 * Math.PI * freq) / sampleRate;
    const sample = Math.sin(phase) * 0.85; // 85% full loudness
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

// Unlocks browser audio context on any user touch/click on screen
function unlockAudio() {
  try {
    if (!globalAudioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) globalAudioCtx = new AudioContextClass();
    }
    if (globalAudioCtx && globalAudioCtx.state === 'suspended') {
      globalAudioCtx.resume().catch(() => {});
    }
    if (!fallbackSirenAudio) {
      const blob = createSirenWavBlob();
      fallbackSirenAudio = new Audio(URL.createObjectURL(blob));
      fallbackSirenAudio.loop = true;
      fallbackSirenAudio.volume = 1.0;
    }
  } catch (_) {}
}

// Bind audio unlock to common user interactions
['click', 'touchstart', 'pointerdown', 'keydown'].forEach(ev => {
  window.addEventListener(ev, () => {
    unlockAudio();
    // If siren is currently triggered but was muted by browser autoplay, unmute immediately
    if (isSirenPlaying) {
      if (globalAudioCtx && globalAudioCtx.state === 'suspended') {
        globalAudioCtx.resume().then(() => updateSirenUiState(true)).catch(() => {});
      }
      if (fallbackSirenAudio && fallbackSirenAudio.paused) {
        fallbackSirenAudio.play().then(() => updateSirenUiState(true)).catch(() => {});
      }
    }
  }, { passive: true });
});

function updateSirenUiState(isPlaying) {
  const unmuteBtn = document.getElementById('sosAlertUnmuteBtn');
  const badge = document.getElementById('sosSirenBadge');
  if (!unmuteBtn || !badge) return;

  if (isPlaying) {
    unmuteBtn.classList.add('hidden');
    badge.textContent = '🔊 EMERGENCY SIREN RINGING';
    badge.style.background = 'rgba(239, 68, 68, 0.25)';
    badge.style.color = '#fca5a5';
  } else {
    // If browser suspended audio due to zero-interaction policy
    unmuteBtn.classList.remove('hidden');
    badge.textContent = '⚠️ AUDIO MUTED BY BROWSER';
    badge.style.background = 'rgba(245, 158, 11, 0.25)';
    badge.style.color = '#fde68a';
    unmuteBtn.onclick = () => {
      unlockAudio();
      if (globalAudioCtx && globalAudioCtx.state === 'suspended') {
        globalAudioCtx.resume().catch(() => {});
      }
      if (fallbackSirenAudio) {
        fallbackSirenAudio.play().catch(() => {});
      }
      updateSirenUiState(true);
    };
  }
}

function startEmergencySiren() {
  if (isSirenPlaying) return;
  isSirenPlaying = true;

  unlockAudio();
  let soundStarted = false;

  // 1. Hardware Web Audio FM Siren (Continuous hardware-modulated siren)
  if (globalAudioCtx) {
    try {
      if (globalAudioCtx.state === 'suspended') {
        globalAudioCtx.resume().then(() => {
          soundStarted = true;
          updateSirenUiState(true);
        }).catch(() => {
          updateSirenUiState(false);
        });
      }

      const carrier = globalAudioCtx.createOscillator();
      const lfo = globalAudioCtx.createOscillator();
      const modGain = globalAudioCtx.createGain();
      const masterGain = globalAudioCtx.createGain();

      carrier.type = 'sawtooth';
      carrier.frequency.setValueAtTime(950, globalAudioCtx.currentTime);

      lfo.type = 'triangle';
      lfo.frequency.setValueAtTime(2.2, globalAudioCtx.currentTime);

      modGain.gain.setValueAtTime(450, globalAudioCtx.currentTime); // Sweeps 500Hz to 1400Hz
      masterGain.gain.setValueAtTime(0.85, globalAudioCtx.currentTime); // Full volume

      lfo.connect(modGain);
      modGain.connect(carrier.frequency);

      carrier.connect(masterGain);
      masterGain.connect(globalAudioCtx.destination);

      lfo.start();
      carrier.start();

      sirenCarrier = carrier;
      sirenLfo = lfo;
      sirenMasterGain = masterGain;

      if (globalAudioCtx.state === 'running') soundStarted = true;
    } catch (err) {
      console.warn('[SIREN] Web Audio oscillator error:', err);
    }
  }

  // 2. HTML5 Audio backup element
  if (fallbackSirenAudio) {
    fallbackSirenAudio.currentTime = 0;
    fallbackSirenAudio.play().then(() => {
      soundStarted = true;
      updateSirenUiState(true);
    }).catch(err => {
      console.warn('[SIREN] HTML5 Audio autoplay restriction:', err.message);
    });
  }

  // 3. Continuous phone vibration pattern
  if (navigator.vibrate) {
    navigator.vibrate([500, 200, 500, 200, 1000, 300, 1000, 300, 1000]);
  }

  updateSirenUiState(soundStarted);
  console.log('[SIREN] Emergency siren activated');
}

function stopEmergencySiren() {
  if (!isSirenPlaying) return;
  isSirenPlaying = false;

  try {
    if (sirenCarrier) {
      sirenCarrier.stop();
      sirenCarrier.disconnect();
      sirenCarrier = null;
    }
    if (sirenLfo) {
      sirenLfo.stop();
      sirenLfo.disconnect();
      sirenLfo = null;
    }
    if (sirenMasterGain) {
      sirenMasterGain.disconnect();
      sirenMasterGain = null;
    }
  } catch (_) {}

  if (fallbackSirenAudio) {
    try {
      fallbackSirenAudio.pause();
      fallbackSirenAudio.currentTime = 0;
    } catch (_) {}
  }

  if (navigator.vibrate) {
    navigator.vibrate(0);
  }

  const unmuteBtn = document.getElementById('sosAlertUnmuteBtn');
  if (unmuteBtn) unmuteBtn.classList.add('hidden');
  console.log('[SIREN] Emergency siren stopped');
}

function showSosAlert(msg) {
  startEmergencySiren();

  const overlay = document.getElementById('sosAlertOverlay');
  const text = document.getElementById('sosAlertText');
  const coordsEl = document.getElementById('sosAlertCoords');
  STATE.currentSosAlertUserId = msg.userId;

  const senderName = msg.name || 'Friend';
  const autoSos = msg.auto === true;
  text.textContent = autoSos
    ? `${senderName} did NOT check in — Safety Watch sent this SOS automatically!`
    : `${senderName} is in DANGER and needs immediate help!`;

  // Tell the sender we saw their SOS (server counts acks and informs them)
  if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN && msg.userId !== STATE.myId) {
    STATE.ws.send(JSON.stringify({
      type: 'sos_ack',
      room: STATE.roomCode,
      userId: STATE.myId,
      name: STATE.myName,
      targetUserId: msg.userId,
      timestamp: Date.now()
    }));
  }

  const lat = msg.lat != null ? Number(msg.lat) : null;
  const lng = msg.lng != null ? Number(msg.lng) : null;

  if (coordsEl) {
    if (lat && lng) {
      coordsEl.textContent = `📍 GPS: ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    } else {
      coordsEl.textContent = '📍 Location: GPS signal being acquired...';
    }
  }

  // Render any evidence photos already received from this sender
  const photosWrap = document.getElementById('sosAlertPhotos');
  if (photosWrap) {
    photosWrap.innerHTML = '';
    photosWrap.classList.add('hidden');
    const photos = (STATE.sosPhotos[msg.userId] || []).slice();
    if (photos.length) {
      photosWrap.classList.remove('hidden');
      const label = document.createElement('div');
      label.className = 'sos-photos-label';
      label.textContent = `📸 EVIDENCE PHOTOS (${photos.length})`;
      photosWrap.appendChild(label);
      photos.forEach(p => appendSosPhotoThumb(photosWrap, p));
    }
  }

  // Button 1: Google Maps directions
  const navBtn = document.getElementById('sosAlertNavigateBtn');
  if (navBtn) {
    navBtn.onclick = () => {
      if (lat && lng) {
        window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`, '_blank');
      } else {
        showToast('Waiting for friend coordinates...', 'warn');
      }
    };
  }

  // Button 2: Center on radar map
  const trackBtn = document.getElementById('sosAlertTrackBtn');
  if (trackBtn) {
    trackBtn.onclick = () => {
      overlay.classList.add('hidden');
      stopEmergencySiren();
      if (lat && lng && STATE.map) {
        STATE.map.setView([lat, lng], 17, { animate: true });
        const mapTabBtn = document.querySelector('[data-tab="tab-map"]');
        if (mapTabBtn) mapTabBtn.click();
      }
    };
  }

  // Button 3: Dismiss & Stop Siren
  const dismissBtn = document.getElementById('sosAlertDismissBtn');
  if (dismissBtn) {
    dismissBtn.onclick = () => {
      overlay.classList.add('hidden');
      stopEmergencySiren();
    };
  }

  overlay.classList.remove('hidden');

  // Center map on sender in background
  if (lat && lng && STATE.map) {
    STATE.map.setView([lat, lng], 16, { animate: true });
  }
}

// ─── SOS evidence photo rendering ──────────────────────────
function appendSosPhotoThumb(container, photo) {
  const img = document.createElement('img');
  img.src = photo.photoUrl;
  img.className = 'sos-photo-thumb';
  img.alt = `SOS evidence (${photo.camera} camera)`;
  img.title = `${photo.camera === 'front' ? 'Front' : 'Back'} camera · ${new Date(photo.timestamp).toLocaleTimeString()}`;
  img.onclick = () => window.open(photo.photoUrl, '_blank');
  container.appendChild(img);
}

function addSosPhotoToAlert(photo) {
  const photosWrap = document.getElementById('sosAlertPhotos');
  if (!photosWrap) return;
  // Only show in the overlay when the alert is currently visible
  const overlay = document.getElementById('sosAlertOverlay');
  if (!overlay || overlay.classList.contains('hidden')) return;

  photosWrap.classList.remove('hidden');
  let label = photosWrap.querySelector('.sos-photos-label');
  if (!label) {
    label = document.createElement('div');
    label.className = 'sos-photos-label';
    label.textContent = '📸 EVIDENCE PHOTOS';
    photosWrap.appendChild(label);
  }
  const count = photosWrap.querySelectorAll('.sos-photo-thumb').length + 1;
  label.textContent = `📸 EVIDENCE PHOTOS (${count})`;
  appendSosPhotoThumb(photosWrap, photo);
}

// Fetch photos that were broadcast while this phone was closed (opened via
// the SOS notification deep link) and merge them into the alert view.
function fetchSosPhotosForDeepLink(roomCode, senderName) {
  fetch(`/api/sos-photos?room=${encodeURIComponent(roomCode)}`)
    .then(r => r.json())
    .then(({ photos }) => {
      (photos || []).filter(p => p.name === senderName).forEach(p => {
        if (!STATE.sosPhotos[p.userId]) STATE.sosPhotos[p.userId] = [];
        if (!STATE.sosPhotos[p.userId].some(x => x.photoUrl === p.photoUrl)) {
          STATE.sosPhotos[p.userId].push(p);
          addSosPhotoToAlert(p);
        }
      });
    })
    .catch(() => {});
}

function logSosActivity(msg) {
  const feed = document.getElementById('sosActivityFeed');
  const p = feed.querySelector('.feed-empty');
  if (p) p.remove();

  const el = document.createElement('div');
  el.className = 'sos-feed-item';
  const time = new Date(msg.timestamp).toLocaleTimeString();
  el.innerHTML = `<strong>🚨 ${msg.self ? 'You sent' : escHtml(msg.name) + ' sent'} an SOS</strong> at ${time}`;
  feed.prepend(el);
}

function logSafeActivity(name, self) {
  const feed = document.getElementById('sosActivityFeed');
  const p = feed.querySelector('.feed-empty');
  if (p) p.remove();
  const el = document.createElement('div');
  el.className = 'sos-feed-item safe';
  const time = new Date().toLocaleTimeString();
  el.innerHTML = `<strong>✅ ${self ? 'You are' : escHtml(name) + ' is'} SAFE</strong> — checked in at ${time}`;
  feed.prepend(el);
}

// ────────────────────────────────────────────────────────────
// I'm Safe check-in + SOS acknowledgment count (sender panel)
// ────────────────────────────────────────────────────────────
function resetAckPanel() {
  STATE.ackNames = new Set();
  const banner = document.getElementById('sosAckBanner');
  if (banner) banner.classList.remove('acked');
  const icon = document.getElementById('sosAckIcon');
  if (icon) icon.textContent = '⏳';
  const title = document.getElementById('sosAckTitle');
  if (title) title.textContent = 'SOS sent — waiting for friends…';
  const detail = document.getElementById('sosAckDetail');
  if (detail) detail.textContent = 'Friends who see your alert are counted here';
}

function showAckPanel(autoSos) {
  const banner = document.getElementById('sosAckBanner');
  const safeBtn = document.getElementById('sosSafeBtn');
  if (banner) banner.classList.remove('hidden');
  if (safeBtn) safeBtn.classList.remove('hidden');
  if (autoSos) {
    const title = document.getElementById('sosAckTitle');
    if (title) title.textContent = '⏰ Auto-SOS sent (Safety Watch expired)';
  }
  // Bring the SOS tab forward so the sender sees the panel
  const sosTabBtn = document.querySelector('[data-tab="tab-sos"]');
  const sosTab = document.getElementById('tab-sos');
  if (sosTabBtn && sosTab && !sosTab.classList.contains('active')) sosTabBtn.click();
}

function hideAckPanel() {
  document.getElementById('sosAckBanner')?.classList.add('hidden');
  document.getElementById('sosSafeBtn')?.classList.add('hidden');
}

function handleMySosAck(msg) {
  if (msg.ackUserId && msg.ackName) STATE.ackNames.add(msg.ackName);
  const banner = document.getElementById('sosAckBanner');
  if (!banner) return;
  banner.classList.add('acked');
  const icon = document.getElementById('sosAckIcon');
  if (icon) icon.textContent = '👀';
  const count = msg.ackCount || STATE.ackNames.size;
  const title = document.getElementById('sosAckTitle');
  if (title) title.textContent = `👥 ${count} friend${count === 1 ? '' : 's'} saw your SOS`;
  const detail = document.getElementById('sosAckDetail');
  if (detail) {
    const names = [...STATE.ackNames].slice(-3).join(', ');
    detail.textContent = `${names} — help is on the way!`;
  }
  if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
}

async function sendSafeCheckIn() {
  const payload = {
    room: STATE.roomCode,
    userId: STATE.myId,
    name: STATE.myName,
    timestamp: Date.now()
  };
  let sent = false;
  if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
    STATE.ws.send(JSON.stringify({ type: 'safe', ...payload }));
    sent = true;
  } else {
    try {
      await fetch('/api/safe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
      });
      sent = true;
    } catch (e) {}
  }
  hideAckPanel();
  showToast(sent ? '✅ You marked yourself SAFE — friends notified.' : '⚠️ No connection — could not notify friends!', sent ? 'success' : 'error', 4500);
  if (sent && navigator.vibrate) navigator.vibrate([80, 60, 80]);
  logSafeActivity(STATE.myName, true);
}

// ────────────────────────────────────────────────────────────
// Safety Watch — dead-man switch. If you don't check in before
// the timer runs out, an SOS with your last location fires
// automatically: the web timer handles the foreground, the
// native timer (background service) handles locked/closed app.
// ────────────────────────────────────────────────────────────
const WATCH_STORAGE_KEY = 'friendpulse_watch';
const WATCH_GRACE_MS = 30000;
let watchSelectedMins = 30;
let watchTimer = null;

function postToNative(data) {
  try {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(data));
    }
  } catch (e) {}
}

function initSafetyFeatures() {
  document.querySelectorAll('.watch-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.watch-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      watchSelectedMins = parseInt(chip.dataset.mins, 10) || 30;
    });
  });
  document.getElementById('watchArmBtn')?.addEventListener('click', () => armWatch(watchSelectedMins * 60000));
  document.getElementById('watchCheckInBtn')?.addEventListener('click', checkInWatch);
  document.getElementById('watchCancelBtn')?.addEventListener('click', () => cancelWatch(false));
  document.getElementById('sosSafeBtn')?.addEventListener('click', sendSafeCheckIn);
}

function armWatch(durationMs) {
  stopWatchTicker();
  STATE.watch = {
    expiresAt: Date.now() + durationMs,
    durationMs,
    expiredGrace: false
  };
  persistWatch();
  syncWatchToNative();
  startWatchTicker();
  updateWatchUi();
  restoreWatchStatus();
  showToast(`🛡️ Safety Watch armed — ${Math.round(durationMs / 60000)} min. Check in before it expires!`, 'success', 4500);
}

function persistWatch() {
  try {
    if (STATE.watch) {
      localStorage.setItem(WATCH_STORAGE_KEY, JSON.stringify({
        expiresAt: STATE.watch.expiresAt,
        durationMs: STATE.watch.durationMs
      }));
    } else {
      localStorage.removeItem(WATCH_STORAGE_KEY);
    }
  } catch (e) {}
}

// Keep the native side in sync: it fires the timer when the app is closed.
// Absolute expiresAt (not remaining) so frequent location updates don't drift.
function syncWatchToNative() {
  if (!STATE.watch) {
    postToNative({ type: 'WATCH_CANCEL' });
    return;
  }
  if (STATE.watch.expiresAt <= Date.now()) return;
  postToNative({
    type: 'WATCH_UPDATE',
    expiresAt: STATE.watch.expiresAt,
    lat: STATE.myLocation?.lat || 0,
    lng: STATE.myLocation?.lng || 0
  });
}

function startWatchTicker() {
  stopWatchTicker();
  watchTimer = setInterval(watchTick, 1000);
  watchTick();
}

function stopWatchTicker() {
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = null;
}

function watchTick() {
  if (!STATE.watch) return;
  const remaining = STATE.watch.expiresAt - Date.now();
  if (remaining <= 0) {
    fireWatchExpired();
    return;
  }
  updateWatchUi(remaining);
}

function updateWatchUi(remaining) {
  const idle = document.getElementById('watchIdle');
  const active = document.getElementById('watchActive');
  if (!idle || !active) return;
  if (!STATE.watch) {
    idle.classList.remove('hidden');
    active.classList.add('hidden');
    return;
  }
  idle.classList.add('hidden');
  active.classList.remove('hidden');
  const rem = remaining != null ? remaining : Math.max(0, STATE.watch.expiresAt - Date.now());
  const cd = document.getElementById('watchCountdown');
  if (cd) {
    cd.textContent = formatWatchRemaining(rem);
    cd.classList.toggle('urgent', rem < 120000);
  }
}

function restoreWatchStatus() {
  const status = document.getElementById('watchStatus');
  if (!status) return;
  status.textContent = 'SOS fires automatically if you don\'t check in';
  status.classList.remove('expired');
}

function formatWatchRemaining(ms) {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function checkInWatch() {
  if (!STATE.watch) return;
  if (STATE.watch.expiredGrace) {
    // Watch already expired — check-in means "I'm safe, don't fire"
    cancelWatch(true);
    return;
  }
  armWatch(STATE.watch.durationMs);
  showToast('✅ Checked in — Safety Watch timer reset!', 'success', 4000);
}

function cancelWatch(silent) {
  const wasGrace = STATE.watch?.expiredGrace;
  stopWatchTicker();
  STATE.watch = null;
  persistWatch();
  postToNative({ type: 'WATCH_CANCEL' });
  updateWatchUi();
  if (wasGrace) {
    // Nothing was sent yet — just confirm safe and stand down
    sendSafeCheckIn();
  } else if (!silent) {
    showToast('Safety Watch cancelled', 'info', 3000);
  }
}

function fireWatchExpired() {
  stopWatchTicker();
  STATE.watch = null;
  persistWatch();
  postToNative({ type: 'WATCH_CANCEL' });
  updateWatchUi();
  triggerSOS(true);
}

// Called from enterApp: resume a ticking watch or handle one that
// expired while the app was closed.
async function initWatchFromStorage() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(WATCH_STORAGE_KEY) || 'null'); } catch (e) {}
  if (!saved || !saved.expiresAt) return;

  const remaining = saved.expiresAt - Date.now();
  if (remaining > 0) {
    STATE.watch = { expiresAt: saved.expiresAt, durationMs: saved.durationMs || remaining, expiredGrace: false };
    syncWatchToNative();
    startWatchTicker();
    updateWatchUi();
    showToast(`🛡️ Safety Watch running — ${formatWatchRemaining(remaining)} left`, 'info', 4000);
    return;
  }

  // Timer expired while we were away. If the native service already fired
  // the auto-SOS (phone was closed), don't fire again — let the user just
  // confirm they're safe. Otherwise give a short grace before firing here.
  let nativeFired = false;
  if (window.ReactNativeWebView) {
    nativeFired = await new Promise(resolve => {
      const timeout = setTimeout(() => resolve(false), 800);
      window.__watchFiredResolved = fired => {
        clearTimeout(timeout);
        resolve(!!fired);
      };
      postToNative({ type: 'GET_WATCH_FIRED' });
    });
  }

  if (nativeFired) {
    STATE.watch = null;
    persistWatch();
    updateWatchUi();
    showToast('⏰ Safety Watch triggered while you were away — SOS was sent to your friends!', 'error', 8000);
    resetAckPanel();
    showAckPanel(true);
    return;
  }

  STATE.watch = {
    expiresAt: Date.now() + WATCH_GRACE_MS,
    durationMs: saved.durationMs || 30 * 60000,
    expiredGrace: true
  };
  persistWatch();
  syncWatchToNative();
  startWatchTicker();
  updateWatchUi();
  const status = document.getElementById('watchStatus');
  if (status) {
    status.textContent = `⚠️ WATCH EXPIRED — auto-SOS in ${WATCH_GRACE_MS / 1000}s. Check in if you are safe!`;
    status.classList.add('expired');
  }
  showToast(`⏰ Safety Watch expired while you were away — auto-SOS in ${WATCH_GRACE_MS / 1000} seconds!`, 'error', 8000);
  if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]);
  const sosTabBtn = document.querySelector('[data-tab="tab-sos"]');
  if (sosTabBtn) sosTabBtn.click();
}

// ────────────────────────────────────────────────────────────
// Share Room Code
// ────────────────────────────────────────────────────────────
function getShareUrl() {
  // Prefer the public tunnel URL if available, fall back to current origin
  return STATE.publicUrl
    ? `${STATE.publicUrl}?room=${STATE.roomCode}`
    : `${window.location.origin}?room=${STATE.roomCode}`;
}

function shareRoom() {
  const code = STATE.roomCode;
  const url  = getShareUrl();
  const text = `Join my FriendPulse radar room!\n\nRoom code: ${code}\nOpen link: ${url}`;

  if (navigator.share) {
    navigator.share({ title: 'FriendPulse — Live Tracker', text, url }).catch(() => {});
  } else {
    navigator.clipboard.writeText(text).then(() => {
      showToast('📋 Invite link copied to clipboard!', 'success');
    }).catch(() => {
      prompt('Copy this invite link:', text);
    });
  }
}

async function fetchPublicUrl() {
  try {
    const res  = await fetch('/api/public-url');
    const data = await res.json();
    if (data.url) {
      STATE.publicUrl = data.url;
      // Update the room info card link
      const linkEl = document.getElementById('publicUrlDisplay');
      if (linkEl) {
        linkEl.textContent = data.url;
        linkEl.href = `${data.url}?room=${STATE.roomCode}`;
        linkEl.closest('.public-url-row')?.classList.remove('hidden');
      }
    }
  } catch (_) {}
}

// ────────────────────────────────────────────────────────────
// Tab Navigation
// ────────────────────────────────────────────────────────────
function switchTab(tabId) {
  document.querySelectorAll('.tab-panel').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(tabId).classList.add('active');
  document.querySelector(`.nav-btn[data-tab="${tabId}"]`).classList.add('active');
  if (tabId === 'tab-map' && STATE.map) {
    // Force Leaflet to recalculate container size and re-render tiles
    setTimeout(() => { STATE.map.invalidateSize(); }, 50);
    setTimeout(() => { STATE.map.invalidateSize(); }, 200);
    setTimeout(() => { STATE.map.invalidateSize(); }, 500);
  }
}

// ────────────────────────────────────────────────────────────
// Toast Notifications
// ────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(message, type = 'info', duration = 3000) {
  let toast = document.getElementById('globalToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'globalToast';
    toast.style.cssText = `
      position:fixed; bottom:90px; left:50%; transform:translateX(-50%) translateY(20px);
      z-index:9999; min-width:220px; max-width:90vw; padding:12px 18px;
      border-radius:16px; font-size:14px; font-weight:700;
      box-shadow:0 8px 24px rgba(0,0,0,0.5); backdrop-filter:blur(10px);
      transition:opacity 0.3s, transform 0.3s;
      opacity:0; pointer-events:none; text-align:center;
    `;
    document.body.appendChild(toast);
  }
  const colors = {
    success: { bg: 'rgba(16,185,129,0.9)', color: '#fff' },
    warn:    { bg: 'rgba(245,158,11,0.9)', color: '#fff' },
    error:   { bg: 'rgba(239,68,68,0.9)', color: '#fff' },
    info:    { bg: 'rgba(30,41,59,0.95)',  color: '#f1f5f9', border: '1px solid rgba(255,255,255,0.1)' },
  };
  const c = colors[type] || colors.info;
  toast.style.background = c.bg;
  toast.style.color = c.color;
  toast.style.border = c.border || 'none';
  toast.textContent = message;
  toast.style.opacity = '1';
  toast.style.transform = 'translateX(-50%) translateY(0)';

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(20px)';
  }, duration);
}

// ────────────────────────────────────────────────────────────
// Helper
// ────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ────────────────────────────────────────────────────────────
// Onboarding — enter the app
// ────────────────────────────────────────────────────────────
// ── Web Background Geolocation Engine ──────────────────────
let bgWakeLock = null;
let bgAudio = null;
let bgInterval = null;

async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      bgWakeLock = await navigator.wakeLock.request('screen');
      bgWakeLock.addEventListener('release', () => { bgWakeLock = null; });
    } catch (_) {}
  }
}

function enableSilentAudioKeepalive() {
  if (!bgAudio) {
    // 1-second silent WAV base64 to keep media session active on mobile OS
    bgAudio = document.createElement('audio');
    bgAudio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAP//';
    bgAudio.loop = true;
    bgAudio.volume = 0.01;
    bgAudio.setAttribute('playsinline', '');
    bgAudio.setAttribute('webkit-playsinline', '');
    document.body.appendChild(bgAudio);
  }
  bgAudio.play().catch(() => {});
}

function startBackgroundLocationEngine() {
  requestWakeLock();
  enableSilentAudioKeepalive();

  // Register PWA service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // Periodic background ping: runs every 4 seconds to guarantee updates even when tab is backgrounded
  if (bgInterval) clearInterval(bgInterval);
  bgInterval = setInterval(() => {
    if (!STATE.roomCode || !STATE.myId) return;

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const lat = pos.coords.latitude;
          const lng = pos.coords.longitude;
          const accuracy = Math.round(pos.coords.accuracy);
          const speed = pos.coords.speed;

          if (document.visibilityState === 'visible') {
            onMyLocationUpdate({
              lat, lng,
              type: 'gps',
              accuracy,
              speed,
              label: `GPS • ±${accuracy}m accuracy`
            });
          } else {
            // Document is in background / screen locked:
            // Send directly via HTTP keepalive to /api/bg-location to ensure server gets coordinates even if WS is suspended
            fetch('/api/bg-location', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                room: STATE.roomCode,
                userId: STATE.myId,
                name: STATE.myName,
                lat, lng,
                locationType: 'gps',
                accuracy
              }),
              keepalive: true
            }).catch(() => {});

            // Also send over WS if still open
            if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
              STATE.ws.send(JSON.stringify({
                type: 'location',
                room: STATE.roomCode,
                userId: STATE.myId,
                name: STATE.myName,
                lat, lng,
                locationType: 'gps',
                accuracy,
                isBackground: true
              }));
            }
          }
        },
        () => {},
        { enableHighAccuracy: true, timeout: 5000, maximumAge: 4000 }
      );
    }
  }, 4000);
}

function stopBackgroundLocationEngine() {
  if (bgInterval) { clearInterval(bgInterval); bgInterval = null; }
  if (bgAudio) { bgAudio.pause(); }
  if (bgWakeLock) { bgWakeLock.release().catch(() => {}); bgWakeLock = null; }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    requestWakeLock();
    enableSilentAudioKeepalive();
    const bgPill = document.getElementById('hudBgText');
    if (bgPill) bgPill.textContent = 'Live Bg Active';
    // We're visible again — retake the room connection (the native SOS
    // service stops when the app is foregrounded). Skip if another
    // reconnect is already pending.
    if (STATE.roomCode && STATE.ws && STATE.ws.readyState !== WebSocket.OPEN &&
        !STATE.wsReconnectTimer) {
      STATE.wsReconnectAttempts = 0;
      connectWs(STATE.roomCode, STATE.myId, STATE.myName);
    }
  } else {
    const bgPill = document.getElementById('hudBgText');
    if (bgPill) bgPill.textContent = 'Tracking in Bg';
  }
});

function enterApp(roomCode, myName) {
  unlockAudio();
  let savedId = null;
  try { savedId = localStorage.getItem('friendpulse_uid'); } catch (e) {}
  if (!savedId) {
    savedId = generateUserId();
    try { localStorage.setItem('friendpulse_uid', savedId); } catch (e) {}
  }
  STATE.myId = savedId;
  STATE.myName = myName;
  STATE.roomCode = roomCode;

  // Save user name & last room code to localStorage for quick rejoin next time
  try {
    localStorage.setItem('friendpulse_name', myName);
    localStorage.setItem('friendpulse_last_room', roomCode);
  } catch (e) {}

  // Update UI
  document.getElementById('onboardScreen').classList.remove('active');
  document.getElementById('appScreen').classList.add('active');
  document.getElementById('roomCodeDisplay').textContent = roomCode;

  // Init room naming and restore saved custom name
  initRoomNaming();
  try {
    const savedRoomName = localStorage.getItem('friendpulse_room_name_' + roomCode) || localStorage.getItem('friendpulse_last_room_name');
    if (savedRoomName) {
      applyRoomName(savedRoomName, false);
    }
  } catch (e) {}

  // Init map
  initMap();
  initSosButton();
  initSafetyFeatures();

  // Force Leaflet to render correctly after CSS layout settles
  setTimeout(() => { STATE.map?.invalidateSize(); }, 100);
  setTimeout(() => { STATE.map?.invalidateSize(); }, 400);
  setTimeout(() => { STATE.map?.invalidateSize(); }, 1000);

  // Start location tracking
  startLocationTracking();

  // Start background location engine (wake lock, keepalive audio, periodic beacon)
  startBackgroundLocationEngine();

  // Connect WebSocket
  connectWs(roomCode, STATE.myId, myName);

  // Tell the native Android wrapper (APK) to arm its background SOS listener.
  // The native foreground service takes over the room connection when the app
  // is closed, so emergency SOS broadcasts still ring this phone.
  try {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'REGISTER_BG_LISTENER',
        room: roomCode,
        userId: STATE.myId,
        name: myName,
        wsUrl: buildWsUrl()
      }));
    }
  } catch (e) {}

  // Register Web Push notifications so phone rings even when app is closed!
  registerPushNotifications(roomCode, STATE.myId, myName);

  // Resume or clean up any Safety Watch from a previous session
  initWatchFromStorage();

  // Fetch public tunnel URL for sharing (async, non-blocking)
  fetchPublicUrl();

  // Check URL for pre-filled room
  const params = new URLSearchParams(window.location.search);
  if (!params.has('room')) {
    history.replaceState(null, '', `?room=${roomCode}`);
  }
}

// ─── Web Push Notifications (Phone ringing even when closed) ───
function urlB64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function registerPushNotifications(roomCode, userId, name) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.log('[PUSH] Web Push not supported by this browser');
    return;
  }

  try {
    const reg = await navigator.serviceWorker.ready;
    if (!reg) return;

    if (Notification.permission === 'granted') {
      await subscribeUserToPush(reg, roomCode, userId, name);
    } else {
      setupNotificationBanner(reg, roomCode, userId, name);
    }
  } catch (err) {
    console.warn('[PUSH] registerPushNotifications error:', err);
  }
}

async function subscribeUserToPush(reg, roomCode, userId, name) {
  try {
    const res = await fetch('/api/vapid-public-key');
    const { publicKey } = await res.json();
    if (!publicKey) return;

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(publicKey)
      });
    }

    await fetch('/api/push-subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room: roomCode,
        userId,
        name,
        subscription: sub
      })
    });
    console.log('[PUSH] Successfully subscribed & registered with server for room', roomCode);

    const banner = document.getElementById('notifPermissionBanner');
    if (banner) banner.classList.add('hidden');
  } catch (err) {
    console.warn('[PUSH] subscribeUserToPush error:', err);
  }
}

function setupNotificationBanner(reg, roomCode, userId, name) {
  const banner = document.getElementById('notifPermissionBanner');
  const btn = document.getElementById('btnEnableNotifs');
  if (!banner || !btn) return;

  if (Notification.permission === 'granted') {
    banner.classList.add('hidden');
    return;
  }

  // Show banner asking user to enable ringing emergency alerts
  banner.classList.remove('hidden');
  btn.onclick = async () => {
    try {
      const perm = await Notification.requestPermission();
      if (perm === 'granted') {
        showToast('🔔 Emergency SOS ringing enabled!', 'success');
        banner.classList.add('hidden');
        if (reg) {
          await subscribeUserToPush(reg, roomCode, userId, name);
        }
      } else {
        banner.classList.add('hidden');
        showToast('Notifications blocked. App must remain open for alerts.', 'warn', 5000);
      }
    } catch (_) {
      banner.classList.add('hidden');
    }
  };
}

// ────────────────────────────────────────────────────────────
// Boot / Event Listeners
// ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  // ── Onboarding ───────────────────────────────────────────
  document.getElementById('createRoomBtn').addEventListener('click', () => {
    const name = document.getElementById('myNameInput').value.trim();
    if (!name) { showToast('Please enter your display name first', 'warn'); return; }
    const code = generateRoomCode();
    enterApp(code, name);
  });

  document.getElementById('joinRoomBtn').addEventListener('click', () => {
    const name = document.getElementById('myNameInput').value.trim();
    const code = document.getElementById('roomCodeInput').value.trim().toUpperCase();
    if (!name) { showToast('Please enter your display name first', 'warn'); return; }
    if (!code) { showToast("Please enter your friend's room code", 'warn'); return; }
    enterApp(code, name);
  });

  // Rejoin last room handler
  const rejoinBtn = document.getElementById('rejoinLastRoomBtn');
  if (rejoinBtn) {
    rejoinBtn.addEventListener('click', () => {
      const name = document.getElementById('myNameInput').value.trim();
      const lastRoom = localStorage.getItem('friendpulse_last_room');
      if (!name) { showToast('Please enter your display name first', 'warn'); return; }
      if (lastRoom) enterApp(lastRoom, name);
    });
  }

  // Allow Enter key to trigger join
  document.getElementById('roomCodeInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('joinRoomBtn').click();
  });
  document.getElementById('myNameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('createRoomBtn').click();
  });

  // Restore saved display name & last room if available
  try {
    const savedName = localStorage.getItem('friendpulse_name');
    if (savedName) document.getElementById('myNameInput').value = savedName;

    const lastRoom = localStorage.getItem('friendpulse_last_room');
    const lastRoomName = localStorage.getItem('friendpulse_last_room_name') || localStorage.getItem('friendpulse_room_name_' + lastRoom);
    const rejoinCard = document.getElementById('rejoinCard');
    const rejoinCodeText = document.getElementById('rejoinCodeText');
    if (lastRoom && rejoinCard && rejoinCodeText) {
      rejoinCodeText.textContent = lastRoomName ? `${lastRoomName} (${lastRoom})` : lastRoom;
      rejoinCard.classList.remove('hidden');
    }
  } catch (e) {}

  // Auto-fill from URL ?room=CODE
  const params = new URLSearchParams(window.location.search);
  if (params.has('room')) {
    document.getElementById('roomCodeInput').value = params.get('room').toUpperCase();
    document.getElementById('myNameInput').focus();
    showToast(`📡 Room code ${params.get('room')} detected — enter your name and tap Join!`, 'info', 5000);
  }

  // If the page is served over HTTPS (localtunnel), show a banner
  if (window.location.protocol === 'https:') {
    const banner = document.createElement('div');
    banner.style.cssText = `
      position:fixed; top:0; left:0; right:0; z-index:9000;
      background:rgba(16,185,129,0.95); color:white;
      font-size:13px; font-weight:700; text-align:center;
      padding:10px 16px; letter-spacing:0.3px;
    `;
    banner.textContent = '🌍 Connected via public internet — friends anywhere can join!';
    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), 5000);
  }

// ── Leave Room Modal Logic ───────────────────────────────
function openLeaveModal() {
  const modal = document.getElementById('leaveModalOverlay');
  const codeEl = document.getElementById('leaveModalRoomCode');
  if (codeEl) codeEl.textContent = STATE.roomCode || 'Room';
  if (modal) modal.classList.remove('hidden');
}

function closeLeaveModal() {
  const modal = document.getElementById('leaveModalOverlay');
  if (modal) modal.classList.add('hidden');
}

function leaveTemporarily() {
  // Save last known location before closing
  sendLastLocationBeacon();
  stopBackgroundLocationEngine();
  if (STATE.ws) {
    try { STATE.ws.close(); } catch {}
  }
  if (STATE.locationWatchId != null) {
    navigator.geolocation.clearWatch(STATE.locationWatchId);
    STATE.locationWatchId = null;
  }
  if (STATE.wsReconnectTimer) clearTimeout(STATE.wsReconnectTimer);

  closeLeaveModal();
  document.getElementById('appScreen').classList.remove('active');
  document.getElementById('onboardScreen').classList.add('active');
  history.replaceState(null, '', window.location.pathname);
  showToast('⏸️ Radar closed. Your friends can still see your last location.', 'info', 4500);
}

function leavePermanently() {
  const code = STATE.roomCode;
  const uid = STATE.myId;

  stopBackgroundLocationEngine();

  // 1. Notify peers via WebSocket
  if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
    STATE.ws.send(JSON.stringify({
      type: 'leave_permanent',
      room: code,
      userId: uid
    }));
    try { STATE.ws.close(); } catch {}
  }

  // 2. Call HTTP leave-room endpoint for permanent removal guarantee
  const payload = JSON.stringify({ room: code, userId: uid });
  if (navigator.sendBeacon) {
    navigator.sendBeacon('/api/leave-room', new Blob([payload], { type: 'application/json' }));
  } else {
    fetch('/api/leave-room', {
      method: 'POST',
      body: payload,
      headers: { 'Content-Type': 'application/json' },
      keepalive: true
    }).catch(() => {});
  }

  // 3. Clear stored room from localStorage
  try {
    localStorage.removeItem('friendpulse_last_room');
    const rejoinCard = document.getElementById('rejoinCard');
    if (rejoinCard) rejoinCard.classList.add('hidden');
  } catch (e) {}

  if (STATE.locationWatchId != null) {
    navigator.geolocation.clearWatch(STATE.locationWatchId);
    STATE.locationWatchId = null;
  }
  if (STATE.wsReconnectTimer) clearTimeout(STATE.wsReconnectTimer);

  // Clear friends markers
  Object.values(STATE.friends).forEach(f => {
    if (f.marker && STATE.map) STATE.map.removeLayer(f.marker);
  });
  STATE.friends = {};

  closeLeaveModal();
  document.getElementById('appScreen').classList.remove('active');
  document.getElementById('onboardScreen').classList.add('active');
  history.replaceState(null, '', window.location.pathname);
  showToast('🛑 You left the room permanently. You are no longer locatable.', 'success', 5000);
}

  // ── App Controls ─────────────────────────────────────────
  document.getElementById('backToOnboardBtn')?.addEventListener('click', openLeaveModal);
  document.getElementById('leaveRoomModalBtn')?.addEventListener('click', openLeaveModal);
  document.getElementById('btnTempLeave')?.addEventListener('click', leaveTemporarily);
  document.getElementById('btnPermLeave')?.addEventListener('click', leavePermanently);
  document.getElementById('btnCancelLeave')?.addEventListener('click', closeLeaveModal);
  document.getElementById('leaveModalOverlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'leaveModalOverlay') closeLeaveModal();
  });

  document.getElementById('shareRoomBtn')?.addEventListener('click', shareRoom);
  document.getElementById('shareRoomLinkBtn')?.addEventListener('click', shareRoom);
  // ── Map Controls ──────────────────────────────────────────
  document.getElementById('recenterBtn')?.addEventListener('click', recenterMap);
  
  document.getElementById('fitAllBtn')?.addEventListener('click', fitAllFriends);

  const toggleLinesBtn = document.getElementById('toggleLinesBtn');
  if (toggleLinesBtn) {
    toggleLinesBtn.addEventListener('click', () => {
      STATE.showDistanceLines = !STATE.showDistanceLines;
      toggleLinesBtn.classList.toggle('active', STATE.showDistanceLines);
      drawDistanceLines();
      showToast(STATE.showDistanceLines ? '📏 Distance radar lines ON' : '📏 Distance radar lines OFF', 'info', 2000);
    });
  }

  const mapThemeBtn = document.getElementById('mapThemeBtn');
  const layersMenu = document.getElementById('mapLayersMenu');
  if (mapThemeBtn && layersMenu) {
    mapThemeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      layersMenu.classList.toggle('hidden');
    });

    document.querySelectorAll('.layer-opt').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const layer = opt.getAttribute('data-layer');
        setMapTheme(layer);
        layersMenu.classList.add('hidden');
        showToast(`🗺️ View switched to ${opt.textContent.trim()}`, 'success', 2000);
      });
    });

    document.addEventListener('click', (e) => {
      if (!layersMenu.contains(e.target) && e.target !== mapThemeBtn) {
        layersMenu.classList.add('hidden');
      }
    });
  }

  // Tab switching
  document.querySelectorAll('.nav-btn[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.getAttribute('data-tab')));
  });

  // Bottom sheet dismiss
  document.getElementById('sheetBackdrop').addEventListener('click', closeSheet);

  // Make invalidateSize work when switching back to map
  document.getElementById('tab-map').addEventListener('focus', () => STATE.map?.invalidateSize(), true);

  // ── Handle incoming emergency link (from Push Notification click) ──
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('sos') === '1') {
    const sosLat = parseFloat(urlParams.get('lat'));
    const sosLng = parseFloat(urlParams.get('lng'));
    const sosName = urlParams.get('name') || 'Friend';
    const roomParam = urlParams.get('room');
    let mySavedName = 'Friend';
    try { mySavedName = localStorage.getItem('friendpulse_name') || 'Friend'; } catch (_) {}

    if (roomParam && !STATE.roomCode) {
      enterApp(roomParam.toUpperCase(), mySavedName);
    }

    setTimeout(() => {
      showSosAlert({
        name: sosName,
        lat: !isNaN(sosLat) ? sosLat : null,
        lng: !isNaN(sosLng) ? sosLng : null,
        timestamp: Date.now()
      });
      // Pull in any evidence photos captured by the sender (we may have
      // been closed when they were broadcast)
      fetchSosPhotosForDeepLink(roomParam || STATE.roomCode || '', sosName);
    }, 1000);
  }
});
