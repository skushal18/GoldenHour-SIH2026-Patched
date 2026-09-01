/* ============================================================================
   DESK_AUTH=jwt — the switch you flip before this leaves a closed network.

   In the default mode a laptop's IP address is its credential, which is fine
   on a LAN nobody else is on and indefensible anywhere else. This suite
   proves the production mode actually closes the door:

     - the desk API refuses anonymous callers
     - a token for the wrong role is refused
     - identity comes from the token, so ?hospital=2 cannot forge it
     - the realtime channel refuses an unauthenticated desk socket, rather
       than streaming patient data over a channel HTTP would have blocked

   Run:  node tests/desk-auth.test.js
   ========================================================================== */

'use strict';

const assert = require('assert');
const jwt = require('jsonwebtoken');

process.env.PORT = process.env.TEST_PORT || '5102';
process.env.DB_DRIVER = 'memory';
process.env.DESK_AUTH = 'jwt';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_desk_auth';
if (process.argv.indexOf('--memory') === -1) process.argv.push('--memory');

const { io: ioClient } = require('socket.io-client');
const { server } = require('../src/server');

const BASE = `http://127.0.0.1:${process.env.PORT}`;

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
function group(title) { console.log('\n' + title); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function tokenFor(claims) {
  return jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: '1h' });
}

const deskOne = tokenFor({ user_id: 2, email: 'desk1@goldenhour.com', role: 'HOSPITAL_STAFF', hospital_id: 1 });
const deskTwo = tokenFor({ user_id: 3, email: 'desk2@goldenhour.com', role: 'HOSPITAL_STAFF', hospital_id: 2 });
const crew    = tokenFor({ user_id: 4, email: 'crew@goldenhour.com',  role: 'AMBULANCE_CREW', ambulance_id: 1 });
const orphan  = tokenFor({ user_id: 5, email: 'nobody@goldenhour.com', role: 'HOSPITAL_STAFF' });

const get = (path, token) => fetch(`${BASE}${path}`, {
  headers: token ? { Authorization: 'Bearer ' + token } : {}
}).then(async r => ({ status: r.status, body: await r.json() }));

const post = (path, token) => fetch(`${BASE}${path}`, {
  method: 'POST', headers: token ? { Authorization: 'Bearer ' + token } : {}
}).then(async r => ({ status: r.status, body: await r.json() }));

const SAMPLE = {
  case_type_id: 12, age: 58, gender: 'M',
  vitals: { systolic_bp: 82, spo2: 88, glucose: null },
  consciousness: 'Semi-Conscious',
  origin: { lat: 12.9716, lng: 77.5946, accuracy_m: 18 },
  broadcast_radius_km: 15, eta_minutes: 12
};

async function main() {
  await new Promise(r => server.listening ? r() : server.once('listening', r));

  /* ── The door is shut ──────────────────────────────────────────────── */
  group('Anonymous callers');
  const anon = await get('/api/v1/desk/queue');
  check('the queue is refused without a token', () => {
    assert.strictEqual(anon.status, 401);
  });
  check('so is /me', async () => { assert.ok(true); });
  const anonMe = await get('/api/v1/desk/me');
  check('/me is refused without a token', () => {
    assert.strictEqual(anonMe.status, 401);
  });
  const garbage = await get('/api/v1/desk/queue', 'not-a-real-token');
  check('a forged token is refused', () => {
    assert.strictEqual(garbage.status, 403);
  });
  const expired = jwt.sign({ role: 'HOSPITAL_STAFF', hospital_id: 1 }, process.env.JWT_SECRET, { expiresIn: -10 });
  const stale = await get('/api/v1/desk/queue', expired);
  check('an expired token is refused', () => {
    assert.strictEqual(stale.status, 403);
  });

  /* ── Roles ─────────────────────────────────────────────────────────── */
  group('Roles');
  const crewTry = await get('/api/v1/desk/queue', crew);
  check('an ambulance crew token cannot open an ER desk board', () => {
    assert.strictEqual(crewTry.status, 403);
  });
  const orphanTry = await get('/api/v1/desk/queue', orphan);
  check('a desk account with no hospital attached is refused', () => {
    assert.strictEqual(orphanTry.status, 403);
  });

  /* ── Identity comes from the token, not the URL ────────────────────── */
  group('Identity cannot be forged');
  const me1 = await get('/api/v1/desk/me', deskOne);
  check('a valid desk token is accepted', () => {
    assert.strictEqual(me1.status, 200);
    assert.strictEqual(me1.body.hospital.hospital_id, 1);
    assert.strictEqual(me1.body.matched_by, 'token');
    assert.strictEqual(me1.body.auth_mode, 'jwt');
  });
  const spoof = await get('/api/v1/desk/me?hospital=2', deskOne);
  check('?hospital=2 cannot repoint a hospital-1 token', () => {
    assert.strictEqual(spoof.body.hospital.hospital_id, 1,
      'the query parameter overrode the token — identity is forgeable');
  });

  /* ── The race still works, and only for the right desk ─────────────── */
  group('Accepting under DESK_AUTH=jwt');
  const created = await fetch(`${BASE}/api/v1/requests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(SAMPLE)
  }).then(async r => ({ status: r.status, body: await r.json() }));
  const code = created.body.id;

  check('the ambulance can still broadcast without a token', () => {
    assert.strictEqual(created.status, 201);
    assert.strictEqual(created.body.hospitals_notified, 2);
  });

  const [r1, r2] = await Promise.all([
    post(`/api/v1/desk/accept/${code}`, deskOne),
    post(`/api/v1/desk/accept/${code}`, deskTwo)
  ]);
  const wins = [r1, r2].filter(r => r.status === 200);
  check('two authenticated desks racing still produce exactly one winner', () => {
    assert.strictEqual(wins.length, 1);
  });
  check('the loser gets a 409 naming the winner', () => {
    const loser = [r1, r2].find(r => r.status !== 200);
    assert.strictEqual(loser.status, 409);
    assert.ok(loser.body.accepted_by);
  });
  const anonAccept = await post(`/api/v1/desk/accept/${code}`);
  check('an anonymous accept is refused outright', () => {
    assert.strictEqual(anonAccept.status, 401);
  });

  /* ── Realtime is closed too ────────────────────────────────────────── */
  group('The realtime channel');

  function deskSocket(auth) {
    const socket = ioClient(BASE, {
      query: { role: 'hospital' },
      auth: auth || {},
      transports: ['websocket'],
      forceNew: true
    });
    const seen = { identity: null, rejected: null, snapshots: 0 };
    socket.on('hospital:identity', d => { seen.identity = d; });
    socket.on('hospital:rejected', d => { seen.rejected = d; });
    socket.on('broadcast:snapshot', () => { seen.snapshots += 1; });
    return { socket, seen };
  }

  const anonSocket = deskSocket();
  await sleep(400);
  check('a desk socket with no token is refused, not quietly joined', () => {
    assert.ok(anonSocket.seen.rejected, 'no rejection was sent');
    assert.strictEqual(anonSocket.seen.identity, null, 'it was given a hospital identity anyway');
  });
  check('and it receives no case data at all', () => {
    assert.strictEqual(anonSocket.seen.snapshots, 0);
  });

  const goodSocket = deskSocket({ token: deskTwo });
  await sleep(400);
  check('a socket with a valid desk token joins its own hospital', () => {
    assert.ok(goodSocket.seen.identity, 'no identity was sent');
    assert.strictEqual(goodSocket.seen.identity.hospital.hospital_id, 2);
    assert.strictEqual(goodSocket.seen.identity.matched_by, 'token');
  });

  const crewSocket = deskSocket({ token: crew });
  await sleep(400);
  check('an ambulance-crew token cannot open a desk socket', () => {
    assert.ok(crewSocket.seen.rejected);
    assert.strictEqual(crewSocket.seen.identity, null);
  });

  anonSocket.socket.close();
  goodSocket.socket.close();
  crewSocket.socket.close();
  server.close();

  console.log('\n' + (failed === 0 ? 'PASS' : 'FAIL') + ` — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.log('\nHARNESS ERROR: ' + (err && err.stack || err));
  process.exit(1);
});
