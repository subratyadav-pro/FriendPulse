'use strict';

const http    = require('http');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const path    = require('path');
const https   = require('https');
const lt      = require('localtunnel');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-memory room store ──────────────────────────────────
// rooms[code] = { [userId]: { ws, data } }
const rooms = {};

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

// ─── Background location from native app (no WS needed) ────
// Native app POSTs here periodically even when app is closed.
app.post('/api/bg-location', (req, res) => {
  const { room, userId, name, lat, lng, locationType, accuracy } = req.body || {};
  if (!room || !userId || lat == null || lng == null) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  const roomCode = String(room).toUpperCase().trim();
  if (!rooms[roomCode]) rooms[roomCode] = {};

  // Store latest location for this user (upsert — no WS socket)
  if (!rooms[roomCode][userId]) {
    rooms[roomCode][userId] = { ws: null, data: {} };
  }
  Object.assign(rooms[roomCode][userId].data, {
    id: userId, name: name || 'Friend', lat, lng,
    locationType: locationType || 'gps',
    accuracy: accuracy || null,
    lastUpdated: Date.now(),
    isBackground: true,
  });

  // Broadcast to all active WebSocket members in the room
  broadcastToRoom(roomCode, userId, {
    type: 'location',
    userId, name: name || 'Friend', lat, lng,
    locationType: locationType || 'gps',
    accuracy: accuracy || null,
    isBackground: true,
  });

  console.log(`[BG] ${name || userId} in room ${roomCode} → ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
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

      // Close previous connection if user is reconnecting
      if (rooms[currentRoom][userId]?.ws && rooms[currentRoom][userId].ws !== ws) {
        try { rooms[currentRoom][userId].ws.close(); } catch {}
      }

      rooms[currentRoom][userId] = {
        ws,
        data: { id: userId, name: userName, roomCode: currentRoom, lastUpdated: Date.now(), deviceType: msg.deviceType || 'mobile' }
      };

      // Send back active room members only
      const activeMembers = Object.values(rooms[currentRoom])
        .filter(p => p.data && p.data.id !== userId && p.ws && p.ws.readyState === WebSocket.OPEN)
        .map(p => p.data);

      ws.send(JSON.stringify({ type: 'JOINED', roomCode: currentRoom, userId }));
      ws.send(JSON.stringify({ type: 'room_members', members: activeMembers }));
      ws.send(JSON.stringify({ type: 'ROOM_STATE', members: activeMembers }));

      broadcastToRoom(currentRoom, userId, { type: 'joined', userId, name: userName, deviceType: msg.deviceType || 'mobile' });
      console.log(`[+] ${userName} (${userId}) → room ${currentRoom} (${Object.keys(rooms[currentRoom]).length} active)`);
    }

    if (msg.type === 'location' && currentRoom && currentUserId) {
      const room = rooms[currentRoom];
      if (room?.[currentUserId]) {
        if (msg.name && msg.name.trim()) {
          room[currentUserId].data.name = msg.name.trim();
        }
        Object.assign(room[currentUserId].data, {
          lat: msg.lat, lng: msg.lng,
          locationType: msg.locationType,
          accuracy: msg.accuracy,
          lastUpdated: Date.now(),
        });
        broadcastToRoom(currentRoom, currentUserId, {
          type: 'location',
          userId: currentUserId,
          name: room[currentUserId].data.name || 'Friend',
          lat: msg.lat, lng: msg.lng,
          locationType: msg.locationType,
          accuracy: msg.accuracy,
        });
      }
    }

    if (msg.type === 'sos' && currentRoom && currentUserId) {
      const name = rooms[currentRoom]?.[currentUserId]?.data?.name || 'A friend';
      broadcastToRoom(currentRoom, currentUserId, {
        type: 'sos', userId: currentUserId, name, lat: msg.lat, lng: msg.lng, timestamp: Date.now()
      });
    }

    if (msg.type === 'ping' && currentRoom) {
      const room = rooms[currentRoom];
      const target = room?.[msg.targetId];
      if (target?.ws?.readyState === WebSocket.OPEN)
        target.ws.send(JSON.stringify({ type: 'ping', fromId: currentUserId }));
    }

    // ── Legacy protocol (backwards compat) ─────────────────
    if (msg.type === 'JOIN_ROOM') {
      const { roomCode, userId, userData } = msg;
      currentRoom = String(roomCode).toUpperCase().trim();
      currentUserId = userId;
      const userName = userData?.name || 'Friend';
      if (!rooms[currentRoom]) rooms[currentRoom] = {};
      rooms[currentRoom][userId] = {
        ws,
        data: { ...userData, id: userId, name: userName, roomCode: currentRoom, lastUpdated: Date.now() }
      };
      ws.send(JSON.stringify({ type: 'JOINED', roomCode: currentRoom, userId }));
      broadcastRoomState(currentRoom);
      console.log(`[+] ${userName} → room ${currentRoom} (${Object.keys(rooms[currentRoom]).length} members)`);
    }
    if (msg.type === 'UPDATE_LOCATION' && currentRoom && currentUserId) {
      const room = rooms[currentRoom];
      if (room?.[currentUserId]) {
        Object.assign(room[currentUserId].data, msg.location, { lastUpdated: Date.now() });
        broadcastToRoom(currentRoom, currentUserId, {
          type: 'FRIEND_LOCATION_UPDATE',
          userId: currentUserId,
          location: { ...msg.location, lastUpdated: Date.now() }
        });
      }
    }
    if (msg.type === 'SOS' && currentRoom && currentUserId) {
      const name = rooms[currentRoom]?.[currentUserId]?.data?.name || 'A friend';
      broadcastToRoom(currentRoom, currentUserId, {
        type: 'SOS_ALERT', userId: currentUserId, name, lat: msg.lat, lng: msg.lng, timestamp: Date.now()
      });
    }
    if (msg.type === 'PING_REQUEST' && currentRoom) {
      const room = rooms[currentRoom];
      const target = room?.[msg.targetId];
      if (target?.ws?.readyState === WebSocket.OPEN)
        target.ws.send(JSON.stringify({ type: 'PING_YOU', fromId: currentUserId }));
    }
  });

  ws.on('close', () => {
    if (!currentRoom || !currentUserId || !rooms[currentRoom]) return;
    const name = rooms[currentRoom][currentUserId]?.data?.name || currentUserId;
    delete rooms[currentRoom][currentUserId];
    if (Object.keys(rooms[currentRoom]).length === 0) {
      delete rooms[currentRoom];
    } else {
      broadcastToRoom(currentRoom, null, { type: 'left', userId: currentUserId });
      broadcastToRoom(currentRoom, null, { type: 'FRIEND_LEFT', userId: currentUserId });
      broadcastRoomState(currentRoom);
    }
    console.log(`[-] ${name} left room ${currentRoom}`);
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
