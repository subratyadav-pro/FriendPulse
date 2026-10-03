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
  publicUrl: null,       // public tunnel URL (localtunnel)
  ws: null,
  myLocation: null,
  friends: {},
  map: null,
  myMarker: null,
  tileLayer: null,
  mapTheme: 'dark',
  locationWatchId: null,
  sosHoldTimer: null,
  wsReconnectTimer: null,
  wsReconnectAttempts: 0,
};

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
    if (data.success) {
      return {
        lat: data.latitude,
        lng: data.longitude,
        type: 'ip',
        city: data.city,
        country: data.country,
        accuracy: null,
        label: `${data.city || ''}, ${data.country || ''} (IP location – city level only)`
      };
    }
    return null;
  } catch (e) {
    return null;
  }
}

function startLocationTracking() {
  updateMyLocationCard('detecting', 'Getting your GPS…');

  // Immediately get IP location so distances can be calculated right away
  getIPLocation().then(ipLoc => {
    if (ipLoc && (!STATE.myLocation || STATE.myLocation.type !== 'gps')) {
      onMyLocationUpdate(ipLoc);
    }
  });

  if (navigator.geolocation) {
    // Try GPS
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          type: 'gps',
          accuracy: Math.round(pos.coords.accuracy),
          label: `GPS • ±${Math.round(pos.coords.accuracy)}m accuracy`
        };
        onMyLocationUpdate(loc);
      },
      async (err) => {
        console.warn('GPS denied/failed:', err.message);
        const ipLoc = await getIPLocation();
        if (ipLoc) {
          onMyLocationUpdate(ipLoc);
          showToast('📡 Using approximate IP location for PC/device', 'info', 4000);
        } else {
          updateMyLocationCard('none', 'Location unavailable');
        }
      },
      { enableHighAccuracy: true, timeout: 6000, maximumAge: 10000 }
    );

    // Watch continuously for GPS movements
    STATE.locationWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        onMyLocationUpdate({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          type: 'gps',
          accuracy: Math.round(pos.coords.accuracy),
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

function onMyLocationUpdate(loc) {
  STATE.myLocation = loc;
  updateMyLocationCard(loc.type, loc.label || `${loc.type.toUpperCase()} location`);

  // Update my map marker
  if (STATE.map) {
    if (STATE.myMarker) {
      STATE.myMarker.setLatLng([loc.lat, loc.lng]);
    } else {
      addMyMarker(loc.lat, loc.lng);
    }
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
}

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

// Snap PC location to phone location for testing 0m
const doSnapLocation = () => {
  const friends = Object.values(STATE.friends);
  const friendWithLoc = friends.find(f => f.location && f.location.lat != null);

  if (friendWithLoc) {
    const loc = {
      lat: friendWithLoc.location.lat,
      lng: friendWithLoc.location.lng,
      type: 'gps',
      accuracy: 1,
      label: 'GPS • Synced with phone (0m)'
    };
    onMyLocationUpdate(loc);
    showToast('🎯 PC location matched to phone GPS! Distance is 0m!', 'success', 4000);
  } else {
    showToast('⚠️ Waiting for your phone to send its GPS coordinates first…', 'warn', 4000);
  }
};

document.getElementById('syncLocationBtn')?.addEventListener('click', doSnapLocation);
document.getElementById('snapGpsBtn')?.addEventListener('click', doSnapLocation);

// ────────────────────────────────────────────────────────────
// Map
// ────────────────────────────────────────────────────────────
function initMap() {
  STATE.map = L.map('map', {
    zoomControl: false,
    attributionControl: false,
  }).setView([20.5937, 78.9629], 5); // Default India center

  setMapTheme('dark');
}

function setMapTheme(theme) {
  STATE.mapTheme = theme;
  const urls = {
    dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    light: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
  };
  if (STATE.tileLayer) STATE.map.removeLayer(STATE.tileLayer);
  STATE.tileLayer = L.tileLayer(urls[theme], { subdomains: 'abcd', maxZoom: 20 }).addTo(STATE.map);
}

function addMyMarker(lat, lng) {
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
    STATE.myMarker.setLatLng([lat, lng]).setIcon(icon);
  } else {
    STATE.myMarker = L.marker([lat, lng], { icon, zIndexOffset: 1000 }).addTo(STATE.map);
    STATE.map.setView([lat, lng], 15);
  }
}

function addOrUpdateFriendMarker(userId, friend) {
  if (!friend.location || !friend.location.lat) return;

  const color = avatarColor(userId);
  const isGps = friend.location.locType === 'gps';
  const borderClass = isGps ? 'gps-border' : 'ip-border';
  const borderColor = isGps ? 'var(--green)' : 'var(--orange)';

  const icon = L.divIcon({
    className: '',
    iconSize: [44, 66],
    iconAnchor: [22, 44],
    html: `<div class="friend-marker-wrap">
      <div class="friend-marker-inner ${borderClass}" style="background:${color}">${initial(friend.name)}</div>
      <div class="friend-marker-name" style="border-color:${borderColor}">${friend.name}</div>
    </div>`
  });

  if (friend.marker) {
    friend.marker.setLatLng([friend.location.lat, friend.location.lng]).setIcon(icon);
  } else {
    friend.marker = L.marker([friend.location.lat, friend.location.lng], { icon })
      .addTo(STATE.map)
      .on('click', () => openFriendDetail(userId));
  }
}

function removeFriendMarker(userId) {
  const f = STATE.friends[userId];
  if (f && f.marker) {
    STATE.map.removeLayer(f.marker);
    f.marker = null;
  }
}

function recenterMap() {
  if (STATE.myLocation) {
    STATE.map.flyTo([STATE.myLocation.lat, STATE.myLocation.lng], 16, { duration: 0.8 });
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
  if (STATE.ws) STATE.ws.close();

  const ws = new WebSocket(buildWsUrl());
  STATE.ws = ws;

  ws.onopen = () => {
    STATE.wsReconnectAttempts = 0;
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

    // Send current location immediately
    if (STATE.myLocation) {
      ws.send(JSON.stringify({
        type: 'location',
        room: roomCode,
        userId,
        name,
        lat: STATE.myLocation.lat,
        lng: STATE.myLocation.lng,
        locationType: STATE.myLocation.type,
        accuracy: STATE.myLocation.accuracy || null,
        location: {
          lat: STATE.myLocation.lat,
          lng: STATE.myLocation.lng,
          locType: STATE.myLocation.type,
          accuracy: STATE.myLocation.accuracy || null,
          city: STATE.myLocation.city || null,
          lastUpdated: Date.now()
        }
      }));
    }
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
    if (STATE.wsReconnectAttempts < 5) {
      const delay = Math.min(1000 * 2 ** STATE.wsReconnectAttempts, 15000);
      STATE.wsReconnectAttempts++;
      STATE.wsReconnectTimer = setTimeout(() => {
        connectWs(STATE.roomCode, STATE.myId, STATE.myName);
      }, delay);
    }
  };

  ws.onerror = (e) => {
    console.error('WS error', e);
  };
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'join':
    case 'JOINED':
      updateConnectionStatus('connected');
      showToast(`✅ Connected to room ${msg.roomCode || STATE.roomCode}`, 'success');
      break;

    case 'room_members':
    case 'ROOM_STATE': {
      const members = msg.members || [];
      members.forEach(member => {
        if (member.id === STATE.myId || (member.name && member.name === STATE.myName)) return;
        updateFriend(member.id, member);
      });
      renderFriendsList();
      renderBottomStrip();
      toggleMapEmptyState();
      break;
    }

    case 'joined': {
      if (msg.userId && msg.userId !== STATE.myId && msg.name !== STATE.myName) {
        updateFriend(msg.userId, { id: msg.userId, name: msg.name || 'Friend' });
        renderFriendsList();
        renderBottomStrip();
        toggleMapEmptyState();
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
      }
      break;
    }

    case 'location': {
      if (msg.userId && msg.userId !== STATE.myId) {
        updateFriend(msg.userId, {
          id: msg.userId,
          name: msg.name || 'Friend',
          lat: msg.lat,
          lng: msg.lng,
          locType: msg.locationType || 'gps',
          accuracy: msg.accuracy
        });
        renderFriendsList();
        renderBottomStrip();
        toggleMapEmptyState();
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
          accuracy: msg.location?.accuracy
        });
        renderFriendsList();
        renderBottomStrip();
        toggleMapEmptyState();
      }
      break;

    case 'left':
    case 'FRIEND_LEFT':
      if (STATE.friends[msg.userId]) {
        const leftName = STATE.friends[msg.userId].name;
        removeFriendMarker(msg.userId);
        delete STATE.friends[msg.userId];
        renderFriendsList();
        renderBottomStrip();
        toggleMapEmptyState();
        showToast(`👋 ${leftName} left the room`, 'info');
      }
      break;

    case 'sos':
    case 'SOS_ALERT':
      showSosAlert(msg);
      logSosActivity(msg);
      break;

    case 'ping':
    case 'PING_YOU':
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
      break;
  }
}

function updateFriend(uid, data) {
  if (!STATE.friends[uid]) {
    STATE.friends[uid] = { name: data.name || 'Friend', location: null, marker: null, lastSeen: Date.now() };
  } else {
    STATE.friends[uid].name = data.name || STATE.friends[uid].name;
    STATE.friends[uid].lastSeen = Date.now();
  }
  if (data.lat != null) {
    STATE.friends[uid].location = {
      lat: data.lat, lng: data.lng,
      locType: data.locType || 'unknown',
      accuracy: data.accuracy,
      city: data.city,
      lastUpdated: data.lastUpdated
    };
    addOrUpdateFriendMarker(uid, STATE.friends[uid]);
  }
}

function updateConnectionStatus(status) {
  const dot = document.getElementById('connectionDot');
  const label = document.getElementById('roomStatusLabel');
  if (status === 'connected') {
    dot.className = 'pulsing-dot connected';
    label.textContent = `Room ${STATE.roomCode}`;
  } else {
    dot.className = 'pulsing-dot';
    label.textContent = 'Reconnecting…';
  }
}

// ────────────────────────────────────────────────────────────
// UI Render
// ────────────────────────────────────────────────────────────
function renderFriendsList() {
  const container = document.getElementById('friendsList');
  const noState = document.getElementById('noFriendsState');
  const badge = document.getElementById('memberCountBadge');
  const count = Object.keys(STATE.friends).length;

  badge.textContent = `${count} online`;

  if (count === 0) {
    noState.style.display = 'block';
    container.innerHTML = '';
    container.appendChild(noState);
    return;
  }
  noState.style.display = 'none';

  container.innerHTML = Object.entries(STATE.friends).map(([uid, f]) => {
    const hasLoc = f.location && f.location.lat != null;
    const dist = hasLoc && STATE.myLocation
      ? formatDist(distanceMeters(STATE.myLocation.lat, STATE.myLocation.lng, f.location.lat, f.location.lng))
      : null;
    const locType = f.location?.locType || 'unknown';
    const locLabel = locType === 'gps' ? '📍 GPS' : locType === 'ip' ? '🌐 IP (city-level)' : '❓ No location';
    const locClass = locType === 'gps' ? 'fc-gps' : locType === 'ip' ? 'fc-ip' : 'fc-unknown';
    const color = avatarColor(uid);
    const ago = f.lastSeen ? timeAgo(f.lastSeen) : '';

    return `
      <div class="friend-card" onclick="openFriendDetail('${uid}')">
        <div class="fc-avatar" style="background:${color}">${initial(f.name)}</div>
        <div class="fc-info">
          <h4>${escHtml(f.name)}</h4>
          ${dist ? `<div class="fc-dist">📏 ${dist} away${ago ? ' · ' + ago : ''}</div>` : `<div class="fc-dist">${ago || 'Connected'}</div>`}
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
    const dist = hasLoc && STATE.myLocation
      ? formatDist(distanceMeters(STATE.myLocation.lat, STATE.myLocation.lng, f.location.lat, f.location.lng))
      : '—';
    const color = avatarColor(uid);
    const isGps = f.location?.locType === 'gps';
    const accClass = !hasLoc ? 'acc-none' : isGps ? 'acc-gps' : 'acc-ip';

    return `
      <div class="friend-strip-chip" onclick="focusFriendOnMap('${uid}')">
        <div class="strip-avatar" style="background:${color}">${initial(f.name)}</div>
        <div class="strip-info">
          <h4>${escHtml(f.name)}</h4>
          <p>${dist}</p>
        </div>
        <div class="acc-dot ${accClass}"></div>
      </div>`;
  }).join('');
}

function toggleMapEmptyState() {
  const empty = document.getElementById('mapEmptyState');
  const hasAny = Object.keys(STATE.friends).length > 0;
  empty.classList.toggle('hidden', hasAny);
}

// ────────────────────────────────────────────────────────────
// Friend Detail Bottom Sheet
// ────────────────────────────────────────────────────────────
function openFriendDetail(uid) {
  const f = STATE.friends[uid];
  if (!f) return;

  const hasLoc = f.location && f.location.lat != null;
  const dist = hasLoc && STATE.myLocation
    ? formatDist(distanceMeters(STATE.myLocation.lat, STATE.myLocation.lng, f.location.lat, f.location.lng))
    : '—';
  const locType = f.location?.locType || 'unknown';
  const locLabel = locType === 'gps' ? '📍 GPS (high accuracy)' : locType === 'ip' ? '🌐 IP-based (city level)' : 'No location';
  const locBadgeClass = locType === 'gps' ? 'fc-gps' : locType === 'ip' ? 'fc-ip' : 'fc-unknown';
  const color = avatarColor(uid);
  const coordText = hasLoc
    ? `${f.location.lat.toFixed(5)}, ${f.location.lng.toFixed(5)}`
    : 'Not available';
  const accText = f.location?.accuracy ? `±${f.location.accuracy}m` : f.location?.city ? f.location.city : '—';
  const ago = f.lastSeen ? timeAgo(f.lastSeen) : '—';

  document.getElementById('detailSheetBody').innerHTML = `
    <div class="sheet-profile-row">
      <div class="sheet-avatar" style="background:${color}">${initial(f.name)}</div>
      <div class="sheet-profile-info">
        <h3>${escHtml(f.name)}</h3>
        <p>Last update: ${ago}</p>
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
        <div class="chip-val" style="font-size:10px">${hasLoc ? `${f.location.lat.toFixed(4)}, ${f.location.lng.toFixed(4)}` : '—'}</div>
      </div>
    </div>

    <div class="sheet-actions">
      ${hasLoc ? `
        <button class="sheet-btn sheet-btn-primary" onclick="navigateTo(${f.location.lat},${f.location.lng})">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>
          Navigate to ${escHtml(f.name)}
        </button>
        <button class="sheet-btn sheet-btn-ghost" title="Ping for fresh location" onclick="pingFriend('${uid}')">
          ⚡
        </button>
      ` : `
        <div style="color:var(--muted);font-size:13px;text-align:center;padding:10px 0;">
          📡 Waiting for ${escHtml(f.name)}'s location…<br>
          <span style="font-size:12px">They may have GPS turned off. Ask them to enable location or allow IP fallback.</span>
        </div>
      `}
    </div>
  `;

  openSheet();
}

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

function triggerSOS() {
  if (!STATE.myLocation || !STATE.ws || STATE.ws.readyState !== WebSocket.OPEN) {
    showToast('⚠️ Cannot send SOS — location or connection unavailable', 'error');
    return;
  }
  STATE.ws.send(JSON.stringify({
    type: 'SOS',
    lat: STATE.myLocation.lat,
    lng: STATE.myLocation.lng,
    locType: STATE.myLocation.type
  }));
  showToast('🚨 SOS sent to all friends in the room!', 'error', 5000);
  logSosActivity({ name: STATE.myName, lat: STATE.myLocation.lat, lng: STATE.myLocation.lng, timestamp: Date.now(), self: true });
  document.getElementById('sosPanicBtn').querySelector('#sosBtnText').textContent = 'SOS';
  document.getElementById('sosPanicBtn').classList.remove('held');
}

function showSosAlert(msg) {
  const overlay = document.getElementById('sosAlertOverlay');
  const text = document.getElementById('sosAlertText');
  text.textContent = `${msg.name} is in danger and needs help! Their location has been shared.`;
  overlay.classList.remove('hidden');

  document.getElementById('sosAlertNavigateBtn').onclick = () => {
    navigateTo(msg.lat, msg.lng);
  };
  document.getElementById('sosAlertDismissBtn').onclick = () => {
    overlay.classList.add('hidden');
  };
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
  if (tabId === 'tab-map') setTimeout(() => STATE.map?.invalidateSize(), 100);
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
function enterApp(roomCode, myName) {
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

  // Init map
  initMap();
  initSosButton();

  // Start location tracking
  startLocationTracking();

  // Connect WebSocket
  connectWs(roomCode, STATE.myId, myName);

  // Fetch public tunnel URL for sharing (async, non-blocking)
  fetchPublicUrl();

  // Check URL for pre-filled room
  const params = new URLSearchParams(window.location.search);
  if (!params.has('room')) {
    history.replaceState(null, '', `?room=${roomCode}`);
  }
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
    const rejoinCard = document.getElementById('rejoinCard');
    const rejoinCodeText = document.getElementById('rejoinCodeText');
    if (lastRoom && rejoinCard && rejoinCodeText) {
      rejoinCodeText.textContent = lastRoom;
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

  // ── App Controls ─────────────────────────────────────────
  document.getElementById('backToOnboardBtn').addEventListener('click', () => {
    if (!confirm('Leave the room?')) return;
    if (STATE.ws) STATE.ws.close();
    if (STATE.locationWatchId != null) navigator.geolocation.clearWatch(STATE.locationWatchId);
    if (STATE.wsReconnectTimer) clearTimeout(STATE.wsReconnectTimer);
    Object.values(STATE.friends).forEach(f => { if (f.marker && STATE.map) STATE.map.removeLayer(f.marker); });
    STATE.friends = {};
    document.getElementById('appScreen').classList.remove('active');
    document.getElementById('onboardScreen').classList.add('active');
    history.replaceState(null, '', window.location.pathname);
  });

  document.getElementById('shareRoomBtn')?.addEventListener('click', shareRoom);
  document.getElementById('shareRoomLinkBtn')?.addEventListener('click', shareRoom);
  document.getElementById('copyRoomCodeBtn')?.addEventListener('click', () => {
    navigator.clipboard.writeText(STATE.roomCode).then(() => showToast('📋 Room code copied!', 'success'));
  });
  document.getElementById('shareFromMapBtn')?.addEventListener('click', shareRoom);

  document.getElementById('recenterBtn').addEventListener('click', recenterMap);
  document.getElementById('mapThemeBtn').addEventListener('click', () => {
    setMapTheme(STATE.mapTheme === 'dark' ? 'light' : 'dark');
  });

  // Tab switching
  document.querySelectorAll('.nav-btn[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.getAttribute('data-tab')));
  });

  // Bottom sheet dismiss
  document.getElementById('sheetBackdrop').addEventListener('click', closeSheet);

  // Make invalidateSize work when switching back to map
  document.getElementById('tab-map').addEventListener('focus', () => STATE.map?.invalidateSize(), true);
});
