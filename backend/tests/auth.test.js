/* ============================================================================
   Central sign-in, end to end, against the real server (memory store).

   The idea being tested: one central server holds every hospital's login;
   signing in with a hospital's username and password opens that hospital's
   ER desk — and only that hospital's.

     - an administrator creates a login for a hospital from the directory
     - the temporary password must be changed before the desk opens
     - a hospital login sees its own cases and nothing addressed elsewhere
     - ?hospital=, X-Hospital-Id and the IP cannot change which hospital
     - wrong passwords lock the login; disabling or resetting signs it out
     - the realtime channel follows the same rules
     - hospital logins cannot use the admin API

   Run:  node tests/auth.test.js
   ========================================================================== */
'use strict';

const assert = require('assert');

process.env.PORT = process.env.TEST_PORT_AUTH || '5121';
process.env.DB_DRIVER = 'memory';
process.env.DESK_AUTH = 'jwt';
process.env.DEMO_SEED = 'false';
process.env.ACCOUNT_SEED_FILE = '/nonexistent/no-seed.json';   // isolate from backend/seed
process.env.SUPER_ADMIN_USERNAME = 'root.admin';
process.env.SUPER_ADMIN_PASSWORD = 'correct horse battery staple';
process.env.BCRYPT_ROUNDS = '4';
process.env.HACKATHON_MODE = 'false';
if (process.argv.indexOf('--memory') === -1) process.argv.push('--memory');

const { io: ioClient } = require('socket.io-client');
const { server } = require('../src/server');

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
function group(t) { console.log('\n' + t); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(method, path, body, token, extraHeaders) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {});
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = {}; try { json = await r.json(); } catch (_) {}
  return { status: r.status, body: json };
}
const login = (u, p) => call('POST', '/api/v1/auth/login', { username: u, password: p });

/* Two Bengaluru hospitals with listed coordinates ~6 km apart, and one in Mumbai. */
const ST_JOHNS = 12179, BOWRING = 12815;

async function main() {
  await new Promise(r => server.listening ? r() : server.once('listening', r));

  group('Administrator bootstrap');
  const first = await login('root.admin', 'correct horse battery staple');
  await check('the bootstrap administrator can sign in', () => assert.strictEqual(first.status, 200));
  await check('…but must change the bootstrap password first', () => assert.strictEqual(first.body.account.must_change_password, true));
  const blocked = await call('GET', '/api/v1/admin/accounts', undefined, first.body.token);
  await check('the admin API is closed until the password is changed', () => {
    assert.strictEqual(blocked.status, 403); assert.strictEqual(blocked.body.reason, 'PASSWORD_CHANGE_REQUIRED');
  });
  const weak = await call('POST', '/api/v1/auth/change-password', { current_password: 'correct horse battery staple', new_password: 'short' }, first.body.token);
  await check('a weak new password is refused', () => assert.strictEqual(weak.status, 400));
  const changed = await call('POST', '/api/v1/auth/change-password', { current_password: 'correct horse battery staple', new_password: 'admin pass for tests 2026' }, first.body.token);
  await check('the password change returns a fresh session', () => { assert.strictEqual(changed.status, 200); assert.ok(changed.body.token); });
  const oldToken = await call('GET', '/api/v1/auth/me', undefined, first.body.token);
  await check('the token from before the change no longer works', () => assert.strictEqual(oldToken.status, 401));
  const admin = changed.body.token;

  group('Creating hospital logins from the national directory');
  const dir = await call('GET', '/api/v1/admin/directory?q=st%20john%27s%20medical%20college&state=Karnataka', undefined, admin);
  await check('the directory search finds the hospital', () => assert.ok(dir.body.hospitals.some(h => h.hospital_id === ST_JOHNS)));
  const mkA = await call('POST', '/api/v1/admin/accounts', { hospital_id: ST_JOHNS, username: 'er.stjohns' }, admin);
  const mkB = await call('POST', '/api/v1/admin/accounts', { hospital_id: BOWRING, username: 'er.bowring' }, admin);
  await check('logins are created with a one-time temporary password', () => {
    assert.strictEqual(mkA.status, 201); assert.strictEqual(mkB.status, 201);
    assert.ok(/^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/.test(mkA.body.temporary_password));
    assert.strictEqual(mkA.body.account.must_change_password, true);
    assert.ok(!('password_hash' in mkA.body.account), 'never return the hash');
  });
  const dup = await call('POST', '/api/v1/admin/accounts', { hospital_id: BOWRING, username: 'er.stjohns' }, admin);
  await check('a username can only be used once', () => assert.strictEqual(dup.status, 409));
  const noHosp = await call('POST', '/api/v1/admin/accounts', { hospital_id: 99999999, username: 'er.ghost' }, admin);
  await check('a login must point at a real directory hospital', () => assert.strictEqual(noHosp.status, 400));

  /* Each hospital sets its own password. */
  async function firstSignIn(username, temp, next) {
    const s = await login(username, temp);
    const c = await call('POST', '/api/v1/auth/change-password', { current_password: temp, new_password: next }, s.body.token);
    return c.body;
  }
  const a = await firstSignIn('er.stjohns', mkA.body.temporary_password, 'st johns er desk 2026');
  const b = await firstSignIn('er.bowring', mkB.body.temporary_password, 'bowring er desk 2026');

  group('A hospital login opens that hospital — and only that hospital');
  const meA = await call('GET', '/api/v1/desk/me', undefined, a.token);
  await check('the desk identity comes from the login', () => {
    assert.strictEqual(meA.status, 200);
    assert.strictEqual(meA.body.hospital.hospital_id, ST_JOHNS);
    assert.strictEqual(meA.body.matched_by, 'account');
  });
  const spoof = await call('GET', '/api/v1/desk/me?hospital=' + BOWRING, undefined, a.token, { 'X-Hospital-Id': String(BOWRING), 'X-Forwarded-For': '10.0.0.2' });
  await check('?hospital=, X-Hospital-Id and the IP cannot repoint it', () => assert.strictEqual(spoof.body.hospital.hospital_id, ST_JOHNS));
  const anon = await call('GET', '/api/v1/desk/queue');
  await check('the desk API refuses anyone not signed in', () => assert.strictEqual(anon.status, 401));
  const forged = await call('GET', '/api/v1/desk/queue', undefined, a.token.slice(0, -4) + 'AAAA');
  await check('a tampered token is refused', () => assert.strictEqual(forged.status, 401));
  const hospAdmin = await call('GET', '/api/v1/admin/accounts', undefined, a.token);
  await check('a hospital login cannot use the admin API', () => assert.strictEqual(hospAdmin.status, 403));
  const adminDesk = await call('GET', '/api/v1/desk/queue', undefined, admin);
  await check('the administrator login is not an ER desk', () => assert.strictEqual(adminDesk.status, 403));

  group('Cases reach only hospitals with a login, near the ambulance');
  const sockA = ioClient(BASE, { query: { role: 'hospital' }, auth: { token: a.token }, transports: ['websocket'], forceNew: true });
  const sockB = ioClient(BASE, { query: { role: 'hospital' }, auth: { token: b.token }, transports: ['websocket'], forceNew: true });
  const sockAnon = ioClient(BASE, { query: { role: 'hospital', hospital: String(ST_JOHNS) }, transports: ['websocket'], forceNew: true });
  const seenA = [], seenB = [], seenAnon = [];
  let anonRejected = null, idA = null;
  sockA.on('hospital:identity', d => { idA = d; });
  sockA.on('broadcast:new', c => seenA.push(c));
  sockB.on('broadcast:new', c => seenB.push(c));
  sockAnon.on('broadcast:new', c => seenAnon.push(c));
  sockAnon.on('hospital:rejected', d => { anonRejected = d; });
  await sleep(300);
  await check('a desk socket joins the room of its own login', () => assert.strictEqual(idA && idA.hospital.hospital_id, ST_JOHNS));
  await check('a desk socket with no token is refused and disconnected', () => {
    assert.ok(anonRejected, 'no hospital:rejected'); assert.strictEqual(sockAnon.connected, false);
  });

  /* Ambulance near St John's (Koramangala); radius 3 km excludes Bowring (~6 km). */
  const cast = await call('POST', '/api/v1/requests', {
    case_type_id: 8, age: 52, gender: 'M', vitals: { systolic_bp: 100, heart_rate: 110, spo2: 95 },
    origin: { lat: 12.9350, lng: 77.6200, accuracy_m: 15, source: 'gps' }, broadcast_radius_km: 3,
  });
  await sleep(200);
  await check('the case went only to the hospital with a login inside the radius', () => {
    assert.strictEqual(cast.status, 201);
    assert.strictEqual(cast.body.hospitals_notified, 1);
    assert.strictEqual(seenA.length, 1);
    assert.strictEqual(seenB.length, 0);
    assert.strictEqual(seenAnon.length, 0);
  });
  await check('the crew also gets nearby hospitals NOT on GoldenHour to call', () => {
    assert.ok(Array.isArray(cast.body.call_ahead));
    assert.ok(cast.body.call_ahead.every(h => h.hospital_id !== ST_JOHNS && h.hospital_id !== BOWRING && h.phone));
  });
  const qB = await call('GET', '/api/v1/desk/queue', undefined, b.token);
  await check("another hospital's queue does not contain the case", () => assert.ok(!qB.body.cases.some(c => c.case_code === cast.body.id)));
  const stealB = await call('POST', '/api/v1/desk/accept/' + cast.body.id, {}, b.token);
  await check('a hospital that was not offered the case cannot accept it', () => assert.strictEqual(stealB.status, 409));
  const takeA = await call('POST', '/api/v1/desk/accept/' + cast.body.id, {}, a.token);
  await check('the offered hospital accepts', () => assert.strictEqual(takeA.status, 200));
  const trackB = await call('GET', '/api/v1/desk/track/' + cast.body.id, undefined, b.token);
  await check('only the accepting hospital can read the ambulance track', () => assert.strictEqual(trackB.status, 403));

  const nowhere = await call('POST', '/api/v1/requests', {
    case_type_id: 1, origin: { lat: 19.0760, lng: 72.8777, source: 'gps' }, broadcast_radius_km: 10,
  });
  await check('a case where no hospital has a login is told so, with hospitals to call', () => {
    assert.strictEqual(nowhere.status, 201);
    assert.strictEqual(nowhere.body.hospitals_notified, 0);
    assert.ok(nowhere.body.call_ahead.length > 0, 'Mumbai should have directory hospitals nearby');
  });

  group('Lockout, disable and reset');
  for (let i = 0; i < 4; i++) await login('er.bowring', 'wrong password ' + i);
  const fifth = await login('er.bowring', 'wrong password 5');
  await check('five wrong passwords lock the login', () => assert.strictEqual(fifth.status, 423));
  const evenRight = await login('er.bowring', 'bowring er desk 2026');
  await check('even the right password waits out the lock', () => assert.strictEqual(evenRight.status, 423));
  const unknown = await login('er.nobody', 'whatever whatever');
  await check('an unknown username gets the same answer as a wrong password', () => {
    assert.strictEqual(unknown.status, 401); assert.strictEqual(unknown.body.reason, 'INVALID');
  });

  const accounts = await call('GET', '/api/v1/admin/accounts?q=stjohns', undefined, admin);
  const accA = accounts.body.accounts.find(x => x.username === 'er.stjohns');
  const dis = await call('POST', '/api/v1/admin/accounts/' + accA.account_id + '/disable', {}, admin);
  await check('the administrator can disable a login', () => assert.strictEqual(dis.status, 200));
  const afterDisable = await call('GET', '/api/v1/desk/queue', undefined, a.token);
  await check('a disabled login is signed out on its very next request', () => assert.ok([401, 403].includes(afterDisable.status)));
  const loginDisabled = await login('er.stjohns', 'st johns er desk 2026');
  await check('…and cannot sign in again', () => assert.strictEqual(loginDisabled.status, 403));
  await call('POST', '/api/v1/admin/accounts/' + accA.account_id + '/enable', {}, admin);
  const reset = await call('POST', '/api/v1/admin/accounts/' + accA.account_id + '/reset-password', {}, admin);
  const oldPw = await login('er.stjohns', 'st johns er desk 2026');
  const tempPw = await login('er.stjohns', reset.body.temporary_password);
  await check('a reset replaces the password and forces a change again', () => {
    assert.strictEqual(oldPw.status, 401);
    assert.strictEqual(tempPw.status, 200);
    assert.strictEqual(tempPw.body.account.must_change_password, true);
  });

  const audit = await call('GET', '/api/v1/admin/audit', undefined, admin);
  await check('sign-ins and account changes are in the audit log', () => {
    const types = audit.body.events.map(e => e.event_type);
    ['SIGNED_IN', 'SIGN_IN_FAILED', 'ACCOUNT_CREATED', 'ACCOUNT_DISABLED', 'PASSWORD_RESET'].forEach(t => assert.ok(types.includes(t), 'missing ' + t));
    assert.ok(!JSON.stringify(audit.body).includes('st johns er desk 2026'), 'a password must never reach the audit log');
  });

  sockA.close(); sockB.close(); sockAnon.close();
  server.close();
  console.log('\n' + (failed === 0 ? 'PASS' : 'FAIL') + ` — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => { console.log('\nHARNESS ERROR: ' + (err && err.stack || err)); process.exit(1); });
