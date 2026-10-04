'use strict';

const http    = require('http');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const path    = require('path');
const https   = require('https');
const lt      = require('localtunnel');
const webpush = require('web-push');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

// ─── Web Push / VAPID Configuration ────────────────────────
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BP6E5qYE2ElmEasJ11gvp-8iG-hOb7uxjQMIpas8_xj4nSb2Ez1R8TG6mrqqexxCwQxmuY4g4Lr3yHIkKI16un8';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'Q620f6OCgYUZTmCT4k_hcavGVk3bSXKsyVmWIifpgWc';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@friendpulse.app';

try {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log('[PUSH] Web Push VAPID initialized successfully');
} catch (err) {
  console.warn('[PUSH] VAPID init error:', err.message);
}

// pushSubscriptions[roomCode] = { [userId]: { subscription, name, updatedAt } }
const pushSubscriptions = {};

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-memory room store ──────────────────────────────────
// rooms[code] = { [userId]: { ws, data } }
const rooms = {};

function sendSosPushNotifications(roomCode, senderUserId, sosData) {
  const roomCodeNorm = String(roomCode).toUpperCase().trim();
  const subs = pushSubscriptions[roomCodeNorm];
  if (!subs) return;

  const senderName = sosData.name || rooms[roomCodeNorm]?.[senderUserId]?.data?.name || 'A friend';
  const lat = sosData.lat != null ? Number(sosData.lat) : null;
  const lng = sosData.lng != null ? Number(sosData.lng) : null;

  const payload = JSON.stringify({
    type: 'SOS_ALERT',
    title: `🚨 EMERGENCY SOS: ${senderName}!`,
    body: `${senderName} pressed SOS! Tap to view live location & rescue.`,
    name: senderName,
    room: roomCodeNorm,
    lat,
    lng,
    locType: sosData.locType || 'gps',
    timestamp: sosData.timestamp || Date.now()
  });

  const options = {
    urgency: 'high',
    TTL: 3600 // 1 hour validity
  };

  const recipientIds = Object.keys(subs).filter(uid => uid !== senderUserId);
  console.log(`[PUSH-DISPATCH] Sending SOS Web Push to ${recipientIds.length} members in room ${roomCodeNorm}`);

  recipientIds.forEach(targetId => {
    const subRecord = subs[targetId];
    if (!subRecord || !subRecord.subscription) return;

    webpush.sendNotification(subRecord.subscription, payload, options).catch(err => {
      console.warn(`[PUSH-FAIL] User ${targetId} push failed (${err.statusCode || err.message})`);
      if (err.statusCode === 410 || err.statusCode === 404) {
        delete subs[targetId];
      }
    });
  });
}

function broadcastToRoom(roomCode, excludeId, message) {
  const room = rooms[roomCode];
  if (!room) return;
  const raw = JSON.stringify(message);
  Object.entries(room).forEach(([uid, peer]) => {
    if (uid !== excludeId && peer.ws.readyState === WebSocket.OPEN)
      peer.ws.send(raw);
  });
}

function broadcastRoomState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  const members = Object.values(room).map(p => p.data).filter(Boolean);
  const raw = JSON.stringify({ type: 'ROOM_STATE', members });
  Object.values(room).forEach(peer => {
    if (peer.ws.readyState === WebSocket.OPEN) peer.ws.send(raw);
  });
}

// ─── IP Geolocation fallback ───────────────────────────────
app.get('/api/ip-location', (req, res) => {
  const clientIp =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress ||
    '';

  const isPrivate =
    !clientIp ||
    clientIp === '127.0.0.1' || clientIp === '::1' ||
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(clientIp);

  if (isPrivate) {
    return res.json({
      success: false,
      reason: 'private_ip',
      message: 'Device is on a private/local network — IP geolocation unavailable. Please enable GPS on your phone.'
    });
  }

  function tryIpApi(ip, cb) {
    const url = `http://ip-api.com/json/${ip}?fields=status,message,lat,lon,city,regionName,country,isp`;
    http.get(url, r => {
      let body = '';
      r.on('data', d => body += d);
      r.on('end', () => {
        try {
          const d = JSON.parse(body);
          if (d.status === 'success') return cb(null, d);
          cb(new Error(d.message));
        } catch(e) { cb(e); }
      });
    }).on('error', cb);
  }

  function tryIpApiCo(ip, cb) {
    const options = {
      hostname: 'ipapi.co',
      path: `/${ip}/json/`,
      headers: { 'User-Agent': 'friendpulse/1.0' }
    };
    https.get(options, r => {
      let body = '';
      r.on('data', d => body += d);
      r.on('end', () => {
        try {
          const d = JSON.parse(body);
          if (d.latitude) return cb(null, { lat: d.latitude, lon: d.longitude, city: d.city, country: d.country_name });
          cb(new Error('no coords'));
        } catch(e) { cb(e); }
      });
    }).on('error', cb);
  }

  tryIpApi(clientIp, (err, d) => {
    if (!err) {
      return res.json({ success: true, latitude: d.lat, longitude: d.lon, city: d.city, region: d.regionName, country: d.country, accuracy: 'city-level', ip: clientIp });
    }
    tryIpApiCo(clientIp, (err2, d2) => {
      if (!err2) {
        return res.json({ success: true, latitude: d2.lat, longitude: d2.lon, city: d2.city, country: d2.country, accuracy: 'city-level', ip: clientIp });
      }
      res.json({ success: false, reason: 'all_apis_failed' });
    });
  });
});

// ─── Expose current public URL so clients can read it ──────
let PUBLIC_URL = null;
app.get('/api/public-url', (_req, res) => {
  res.json({ url: PUBLIC_URL });
});

// ─── Background / Last location endpoints ──────────────────
// Native app POSTs or browser sendBeacon on unload/hide
app.post('/api/bg-location', (req, res) => {
  const { room, userId, name, lat, lng, locationType, accuracy } = req.body || {};
  if (!room || !userId || lat == null || lng == null) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  const roomCode = String(room).toUpperCase().trim();
  if (!rooms[roomCode]) rooms[roomCode] = {};

  if (!rooms[roomCode][userId]) {
    rooms[roomCode][userId] = { ws: null, isOnline: true, data: {} };
  }
  Object.assign(rooms[roomCode][userId].data, {
    id: userId, name: name || 'Friend',
    lat: Number(lat), lng: Number(lng),
    locationType: locationType || 'gps',
    accuracy: accuracy || null,
    lastUpdated: Date.now(),
    isBackground: true,
    isOnline: true
  });

  broadcastToRoom(roomCode, userId, {
    type: 'location',
    userId, name: name || 'Friend',
    lat: Number(lat), lng: Number(lng),
    locationType: locationType || 'gps',
    accuracy: accuracy || null,
    isBackground: true,
    isOnline: true
  });

  console.log(`[BG] ${name || userId} in room ${roomCode} → ${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}`);
  res.json({ ok: true });
});

// Force sync / snap friend location (e.g. PC using ISP location snapped to mobile GPS)
app.post('/api/sync-friend-location', (req, res) => {
  const { room, targetUserId, lat, lng } = req.body || {};
  if (!room || !targetUserId || lat == null || lng == null) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  const roomCode = String(room).toUpperCase().trim();
  if (rooms[roomCode] && rooms[roomCode][targetUserId]) {
    const member = rooms[roomCode][targetUserId];
    member.data.lat = Number(lat);
    member.data.lng = Number(lng);
    member.data.locationType = 'gps';
    member.data.accuracy = 1;
    member.data.lastUpdated = Date.now();
    broadcastToRoom(roomCode, null, {
      type: 'location',
      userId: targetUserId,
      name: member.data.name || 'Friend',
      lat: Number(lat),
      lng: Number(lng),
      locationType: 'gps',
      accuracy: 1,
      isOnline: member.isOnline
    });
    console.log(`[SNAP] Synced ${member.data.name || targetUserId} to ${lat}, ${lng} in room ${roomCode}`);
  }
  res.json({ ok: true });
});

// Browser beacon on tab close / background: stores last known location
app.post('/api/last-location', (req, res) => {
  const { room, userId, name, lat, lng, locationType, accuracy } = req.body || {};
  if (!room || !userId) return res.status(400).json({ error: 'Missing fields' });
  const roomCode = String(room).toUpperCase().trim();
  if (!rooms[roomCode]) rooms[roomCode] = {};

  if (!rooms[roomCode][userId]) {
    rooms[roomCode][userId] = { ws: null, isOnline: false, data: {} };
  }
  const member = rooms[roomCode][userId];
  member.isOnline = false;

  if (lat != null && lng != null) {
    Object.assign(member.data, {
      id: userId,
      name: name || member.data.name || 'Friend',
      lat: Number(lat),
      lng: Number(lng),
      locationType: locationType || member.data.locationType || 'gps',
      accuracy: accuracy || member.data.accuracy || null,
      lastUpdated: Date.now(),
      lastSeen: Date.now(),
      isOnline: false
    });
  } else {
    member.data.isOnline = false;
    member.data.lastSeen = Date.now();
  }

  broadcastToRoom(roomCode, userId, {
    type: 'member_status',
    userId,
    name: member.data.name || 'Friend',
    isOnline: false,
    lastSeen: Date.now(),
    lat: member.data.lat,
    lng: member.data.lng,
    locationType: member.data.locationType,
    accuracy: member.data.accuracy
  });

  console.log(`[LAST_LOC] ${member.data.name || userId} closed app/tab in ${roomCode}, location saved`);
  res.json({ ok: true });
});

// ─── Web Push Subscription Endpoints ──────────────────────
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/push-subscribe', (req, res) => {
  const { room, userId, subscription, name } = req.body || {};
  if (!room || !userId || !subscription) {
    return res.status(400).json({ error: 'Missing room, userId or subscription' });
  }
  const roomCode = String(room).toUpperCase().trim();
  if (!pushSubscriptions[roomCode]) pushSubscriptions[roomCode] = {};
  pushSubscriptions[roomCode][userId] = {
    subscription,
    name: name || 'Friend',
    updatedAt: Date.now()
  };
  console.log(`[PUSH-REGISTER] Registered push for ${name || userId} in room ${roomCode}`);
  res.json({ ok: true });
});

// HTTP SOS fallback — works even if client's WS is closed/paused
app.post('/api/sos', (req, res) => {
  const { room, userId, name, lat, lng, locType, timestamp } = req.body || {};
  if (!room || !userId) return res.status(400).json({ error: 'Missing fields' });
  const roomCode = String(room).toUpperCase().trim();
  const senderName = name || rooms[roomCode]?.[userId]?.data?.name || 'A friend';

  console.log(`[SOS-HTTP] ${senderName} in room ${roomCode} → ${lat}, ${lng}`);

  const sosPayload = {
    type: 'SOS_ALERT',
    userId,
    name: senderName,
    lat: lat ? Number(lat) : null,
    lng: lng ? Number(lng) : null,
    locType: locType || 'gps',
    timestamp: timestamp || Date.now()
  };

  // 1. Broadcast to all active WebSocket connections in room
  broadcastToRoom(roomCode, userId, sosPayload);

  // 2. Dispatch high-urgency Web Push to ring phones even if browser/app is closed!
  sendSosPushNotifications(roomCode, userId, sosPayload);

  res.json({ ok: true, broadcast: true, push: true });
});

// Explicit permanent leave endpoint (erases user from room)
app.post('/api/leave-room', (req, res) => {
  const { room, userId } = req.body || {};
  if (!room || !userId) return res.status(400).json({ error: 'Missing fields' });
  const roomCode = String(room).toUpperCase().trim();
  if (rooms[roomCode] && rooms[roomCode][userId]) {
    const leftName = rooms[roomCode][userId]?.data?.name || 'Friend';
    delete rooms[roomCode][userId];
    if (Object.keys(rooms[roomCode]).length === 0) {
      delete rooms[roomCode];
    } else {
      broadcastToRoom(roomCode, userId, {
        type: 'member_left_permanent',
        userId,
        name: leftName
      });
      broadcastRoomState(roomCode);
    }
    console.log(`[PERMANENT EXIT] ${leftName} (${userId}) permanently left room ${roomCode}`);
  }
  res.json({ ok: true });
});

// ─── WebSocket rooms ───────────────────────────────────────
wss.on('connection', (ws) => {
  let currentRoom = null;
  let currentUserId = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // ── Simple protocol (web app + native app) ──────────────
    if (msg.type === 'join') {
      const { room, userId, name } = msg;
      currentRoom = String(room).toUpperCase().trim();
      currentUserId = userId;

      const userName = (name && name.trim()) ? name.trim() : 'Friend';

      if (!rooms[currentRoom]) rooms[currentRoom] = {};

      // Deduplicate: If someone joins with the same name as an old/offline entry
      // (e.g. user moved from PC tab to phone or reconnected with new userId),
      // remove the old ghost entry so it doesn't leave an overlapping ghost marker!
      Object.entries(rooms[currentRoom]).forEach(([existingUid, peer]) => {
        if (existingUid !== userId && peer.data?.name && peer.data.name.toLowerCase() === userName.toLowerCase()) {
          console.log(`[DEDUP] Removing stale duplicate for ${userName} (${existingUid})`);
          if (peer.ws && peer.ws !== ws) {
            try { peer.ws.close(); } catch (_) {}
          }
          delete rooms[currentRoom][existingUid];
          broadcastToRoom(currentRoom, null, { type: 'member_left_permanent', userId: existingUid });
        }
      });

      // Close previous connection if user is reconnecting with same userId
      if (rooms[currentRoom][userId]?.ws && rooms[currentRoom][userId].ws !== ws) {
        try { rooms[currentRoom][userId].ws.close(); } catch {}
      }

      // Preserve any previously cached location if reconnecting
      const prevData = rooms[currentRoom][userId]?.data || {};
      rooms[currentRoom][userId] = {
        ws,
        isOnline: true,
        data: {
          ...prevData,
          id: userId,
          name: userName,
          roomCode: currentRoom,
          lastUpdated: Date.now(),
          lastSeen: Date.now(),
          isOnline: true,
          deviceType: msg.deviceType || 'mobile'
        }
      };

      // Send back ALL members in room (including temporarily offline friends with their last known locations)
      const allMembers = Object.values(rooms[currentRoom])
        .filter(p => p.data && p.data.id !== userId)
        .map(p => ({
          ...p.data,
          isOnline: !!(p.ws && p.ws.readyState === WebSocket.OPEN && p.isOnline !== false)
        }));

      ws.send(JSON.stringify({ type: 'JOINED', roomCode: currentRoom, userId }));
      ws.send(JSON.stringify({ type: 'room_members', members: allMembers }));
      ws.send(JSON.stringify({ type: 'ROOM_STATE', members: allMembers }));

      broadcastToRoom(currentRoom, userId, {
        type: 'joined',
        userId,
        name: userName,
        isOnline: true,
        deviceType: msg.deviceType || 'mobile'
      });
      console.log(`[+] ${userName} (${userId}) → room ${currentRoom} (${Object.keys(rooms[currentRoom]).length} total members)`);
    }

    if (msg.type === 'location' && currentRoom && currentUserId) {
      const room = rooms[currentRoom];
      if (room?.[currentUserId]) {
        if (msg.name && msg.name.trim()) {
          room[currentUserId].data.name = msg.name.trim();
        }
        Object.assign(room[currentUserId].data, {
          lat: Number(msg.lat),
          lng: Number(msg.lng),
          locationType: msg.locationType || 'gps',
          accuracy: msg.accuracy,
          lastUpdated: Date.now(),
          lastSeen: Date.now(),
          isOnline: true
        });
        broadcastToRoom(currentRoom, currentUserId, {
          type: 'location',
          userId: currentUserId,
          name: room[currentUserId].data.name || 'Friend',
          lat: Number(msg.lat),
          lng: Number(msg.lng),
          locationType: msg.locationType || 'gps',
          accuracy: msg.accuracy,
          isOnline: true
        });
      }
    }

    if (msg.type === 'sos' && currentRoom && currentUserId) {
      const name = rooms[currentRoom]?.[currentUserId]?.data?.name || 'A friend';
      const sosData = {
        type: 'sos',
        userId: currentUserId,
        name,
        lat: msg.lat,
        lng: msg.lng,
        timestamp: Date.now()
      };
      broadcastToRoom(currentRoom, currentUserId, sosData);
      sendSosPushNotifications(currentRoom, currentUserId, sosData);
    }

    if (msg.type === 'ping' && currentRoom) {
      const room = rooms[currentRoom];
      const target = room?.[msg.targetId];
      if (target?.ws?.readyState === WebSocket.OPEN)
        target.ws.send(JSON.stringify({ type: 'ping', fromId: currentUserId }));
    }

    if (msg.type === 'SYNC_FRIEND_LOCATION' && currentRoom) {
      const { targetUserId, lat, lng } = msg;
      if (rooms[currentRoom]?.[targetUserId]) {
        const member = rooms[currentRoom][targetUserId];
        member.data.lat = Number(lat);
        member.data.lng = Number(lng);
        member.data.locationType = 'gps';
        member.data.accuracy = 1;
        member.data.lastUpdated = Date.now();
        broadcastToRoom(currentRoom, null, {
          type: 'location',
          userId: targetUserId,
          name: member.data.name || 'Friend',
          lat: Number(lat),
          lng: Number(lng),
          locationType: 'gps',
          accuracy: 1,
          isOnline: member.isOnline
        });
      }
    }

    // ── Permanent leave message from client ────────────────
    if (msg.type === 'leave_permanent' || msg.type === 'LEAVE_PERMANENT') {
      const roomCode = String(msg.room || currentRoom).toUpperCase().trim();
      const uid = msg.userId || currentUserId;
      if (roomCode && rooms[roomCode] && rooms[roomCode][uid]) {
        const leftName = rooms[roomCode][uid]?.data?.name || 'Friend';
        delete rooms[roomCode][uid];
        if (Object.keys(rooms[roomCode]).length === 0) {
          delete rooms[roomCode];
        } else {
          broadcastToRoom(roomCode, uid, {
            type: 'member_left_permanent',
            userId: uid,
            name: leftName
          });
          broadcastRoomState(roomCode);
        }
        console.log(`[PERMANENT EXIT] ${leftName} (${uid}) permanently left room ${roomCode}`);
      }
    }

    // ── Legacy protocol (backwards compat) ─────────────────
    if (msg.type === 'JOIN_ROOM') {
      const { roomCode, userId, userData } = msg;
      currentRoom = String(roomCode).toUpperCase().trim();
      currentUserId = userId;
      const userName = userData?.name || 'Friend';
      if (!rooms[currentRoom]) rooms[currentRoom] = {};
      const prevData = rooms[currentRoom][userId]?.data || {};
      rooms[currentRoom][userId] = {
        ws,
        isOnline: true,
        data: { ...prevData, ...userData, id: userId, name: userName, roomCode: currentRoom, lastUpdated: Date.now(), isOnline: true }
      };
      ws.send(JSON.stringify({ type: 'JOINED', roomCode: currentRoom, userId }));
      broadcastRoomState(currentRoom);
      console.log(`[+] ${userName} → room ${currentRoom} (${Object.keys(rooms[currentRoom]).length} members)`);
    }
    if (msg.type === 'UPDATE_LOCATION' && currentRoom && currentUserId) {
      const room = rooms[currentRoom];
      if (room?.[currentUserId]) {
        Object.assign(room[currentUserId].data, msg.location, { lastUpdated: Date.now(), isOnline: true });
        broadcastToRoom(currentRoom, currentUserId, {
          type: 'FRIEND_LOCATION_UPDATE',
          userId: currentUserId,
          location: { ...msg.location, lastUpdated: Date.now(), isOnline: true }
        });
      }
    }
    if (msg.type === 'SOS' && currentRoom && currentUserId) {
      const name = rooms[currentRoom]?.[currentUserId]?.data?.name || 'A friend';
      const sosData = {
        type: 'SOS_ALERT',
        userId: currentUserId,
        name,
        lat: msg.lat,
        lng: msg.lng,
        timestamp: Date.now()
      };
      broadcastToRoom(currentRoom, currentUserId, sosData);
      sendSosPushNotifications(currentRoom, currentUserId, sosData);
    }
    if (msg.type === 'PING_REQUEST' && currentRoom) {
      const room = rooms[currentRoom];
      const target = room?.[msg.targetId];
      if (target?.ws?.readyState === WebSocket.OPEN)
        target.ws.send(JSON.stringify({ type: 'PING_YOU', fromId: currentUserId }));
    }
  });

  // When connection closes temporarily (tab closed, backgrounded, network change)
  ws.on('close', () => {
    if (!currentRoom || !currentUserId || !rooms[currentRoom]) return;
    const member = rooms[currentRoom][currentUserId];
    if (!member) return;
    const name = member.data?.name || currentUserId;

    // DO NOT DELETE USER: Mark as temporarily offline/away and retain last known location!
    member.ws = null;
    member.isOnline = false;
    if (member.data) {
      member.data.isOnline = false;
      member.data.lastSeen = Date.now();
    }

    // Broadcast member status so friends see them as offline/away, with marker still visible
    broadcastToRoom(currentRoom, currentUserId, {
      type: 'member_status',
      userId: currentUserId,
      name,
      isOnline: false,
      lastSeen: Date.now(),
      lat: member.data?.lat,
      lng: member.data?.lng,
      locationType: member.data?.locationType
    });

    console.log(`[AWAY] ${name} disconnected temporarily from room ${currentRoom} (location preserved)`);
  });
});

app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// ─── Start server + localtunnel ────────────────────────────
const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', async () => {
  console.log('\n🛰️  FriendPulse Radar');
  console.log(`   Local:   http://localhost:${PORT}`);

  // Try to open a public tunnel
  console.log('\n🌍 Opening public tunnel (localtunnel)…');
  try {
    const tunnel = await lt({ port: PORT });
    PUBLIC_URL = tunnel.url;

    console.log('');
    console.log('═══════════════════════════════════════════════════');
    console.log('  ✅  PUBLIC URL (share this with your friends):');
    console.log('');
    console.log(`      ${tunnel.url}`);
    console.log('');
    console.log('  Anyone on ANY network or phone can now join!');
    console.log('═══════════════════════════════════════════════════');
    console.log('');
    console.log('  NOTE: First visit may ask you to click "Continue"');
    console.log('  on the localtunnel landing page. That is normal.');
    console.log('═══════════════════════════════════════════════════\n');

    tunnel.on('close', () => {
      console.log('⚠️  Tunnel closed. Restart the server to get a new URL.');
    });

    tunnel.on('error', err => {
      console.error('Tunnel error:', err.message);
    });

  } catch (err) {
    console.warn(`⚠️  Could not open public tunnel: ${err.message}`);
    console.warn('   Friends must be on the same Wi-Fi or you need internet access.');
    console.warn(`   Local-only access: http://localhost:${PORT}\n`);
  }
});
