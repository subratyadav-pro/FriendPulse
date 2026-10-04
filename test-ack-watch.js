// End-to-end test: SOS ack counting, I'm Safe broadcast, auto-SOS flag
const WebSocket = require('ws');

const URL = 'ws://localhost:3000';
const ROOM = 'TESTACK';

function mkClient(userId, name, onMsg) {
  const ws = new WebSocket(URL);
  const inbox = [];
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'join', room: ROOM, roomCode: ROOM, userId, name, deviceType: 'test' }));
  });
  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString());
    inbox.push(msg);
    onMsg && onMsg(msg);
  });
  ws.sendJson = o => ws.send(JSON.stringify(o));
  ws.inbox = inbox;
  return ws;
}

const events = [];
let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
}

const alice = mkClient('alice-1', 'Alice', m => {
  if (m.type === 'SOS_ACK') events.push(['alice:SOS_ACK', m]);
  if (m.type === 'SOS_ALERT') events.push(['alice:SOS_ALERT(should-not-happen)', m]);
});
const bob = mkClient('bob-1', 'Bob', m => {
  if (m.type === 'SOS_ALERT') events.push(['bob:SOS_ALERT', m]);
  if (m.type === 'SAFE_ALERT') events.push(['bob:SAFE_ALERT', m]);
});
const carol = mkClient('carol-1', 'Carol', m => {
  if (m.type === 'SOS_ALERT') events.push(['carol:SOS_ALERT', m]);
  if (m.type === 'SAFE_ALERT') events.push(['carol:SAFE_ALERT', m]);
});

setTimeout(() => {
  console.log('— Step 1: Alice sends SOS —');
  alice.sendJson({ type: 'SOS', room: ROOM, userId: 'alice-1', name: 'Alice', lat: 28.61, lng: 77.20, timestamp: Date.now() });

  setTimeout(() => {
    console.log('— Step 2: Bob & Carol acknowledge —');
    bob.sendJson({ type: 'sos_ack', room: ROOM, userId: 'bob-1', name: 'Bob', targetUserId: 'alice-1' });
    setTimeout(() => {
      carol.sendJson({ type: 'sos_ack', room: ROOM, userId: 'carol-1', name: 'Carol', targetUserId: 'alice-1' });
    }, 300);
  }, 500);

  setTimeout(() => {
    console.log('— Step 3: Alice checks in as safe —');
    alice.sendJson({ type: 'safe', room: ROOM, userId: 'alice-1', name: 'Alice' });
  }, 1800);

  setTimeout(() => {
    console.log('— Step 4: Native-style auto-SOS via HTTP (Safety Watch) —');
    fetch('http://localhost:3000/api/sos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: ROOM, userId: 'alice-1', name: 'Alice', lat: 28.61, lng: 77.20, auto: true })
    }).then(r => r.json()).then(j => console.log('  /api/sos →', JSON.stringify(j))).catch(e => console.log('  ERR', e.message));
  }, 2600);

  setTimeout(() => {
    console.log('\n═══ RESULTS ═══');
    const bobAlert = events.find(e => e[0] === 'bob:SOS_ALERT');
    const carolAlert = events.find(e => e[0] === 'carol:SOS_ALERT');
    check('Bob received SOS_ALERT', !!bobAlert);
    check('Carol received SOS_ALERT', !!carolAlert);
    check('SOS_ALERT does NOT reach sender (alice)', !events.some(e => e[0] === 'alice:SOS_ALERT(should-not-happen)'));

    const acks = events.filter(e => e[0] === 'alice:SOS_ACK').map(e => e[1]);
    check('Alice received 2 SOS_ACK broadcasts', acks.length === 2);
    if (acks.length === 2) {
      check('First ack count=1 (Bob)', acks[0].ackCount === 1 && acks[0].ackName === 'Bob');
      check('Second ack count=2 (Carol)', acks[1].ackCount === 2 && acks[1].ackName === 'Carol');
    }

    const bobSafe = events.find(e => e[0] === 'bob:SAFE_ALERT');
    const carolSafe = events.find(e => e[0] === 'carol:SAFE_ALERT');
    check('Bob received SAFE_ALERT', !!bobSafe && bobSafe[1].name === 'Alice');
    check('Carol received SAFE_ALERT', !!carolSafe && carolSafe[1].name === 'Alice');

    const autoAlerts = events.filter(e => e[0].endsWith(':SOS_ALERT') && e[1].auto === true);
    check('Auto-SOS (HTTP) reached Bob & Carol with auto=true', autoAlerts.length === 2);

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }, 3600);
}, 1200);
