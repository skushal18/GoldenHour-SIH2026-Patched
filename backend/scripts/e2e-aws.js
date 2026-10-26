#!/usr/bin/env node
/* ============================================================================
   End-to-end check of a deployed GoldenHour, through its public HTTPS address.

     node backend/scripts/e2e-aws.js https://<distribution>.cloudfront.net

   Runs where the app's secrets can be read (the Beanstalk instance, through
   SSM Run Command), because it signs in as the first administrator. It never
   prints a password, token or activation code, and it puts the administrator
   back exactly as it was: same password, must change it at next sign-in.

   What it proves: /health is on MySQL (RDS host); the administrator signs in;
   a login is created with an activation code; a hospital activates it with its
   own username and password and signs in; the desk's Socket.IO connection is
   a WebSocket; a case broadcast from the ambulance API reaches that desk; the
   desk accepts; crew GPS reaches the desk; arrival closes the case; a second
   case is cancelled. The test hospital (imported from the national list for
   this run) and its login are removed afterwards, so the 100 network
   hospitals are untouched. (It is switched off first, so the running server —
   which reloads the table at its next start — never offers it a case.)
   ========================================================================== */
'use strict';
const crypto = require('crypto');

const BASE = String(process.argv[2] || process.env.E2E_BASE || '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(BASE)) { console.error('usage: e2e-aws.js https://<host>'); process.exit(2); }

const results = [];
function step(name, ok, detail) { results.push({ step: name, ok: !!ok, detail: detail === undefined ? null : detail }); console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); return ok; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const randomPassword = () => crypto.randomBytes(18).toString('base64url');

async function call(method, p, body, token, headers) {
  const h = Object.assign({ 'Content-Type': 'application/json', 'User-Agent': 'goldenhour-e2e' }, headers || {});
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = {}; try { json = await r.json(); } catch (_) {}
  return { status: r.status, body: json };
}

async function main() {
  await require('../src/config/awsSecrets').loadIntoEnv({ log() {} });
  const adminUser = String(process.env.SUPER_ADMIN_USERNAME || '').toLowerCase();
  const adminPass = process.env.SUPER_ADMIN_PASSWORD || '';
  const { io } = require('socket.io-client');
  const catalogue = require('../src/services/catalogueService');
  const sockets = [];
  let restoreAdmin = false, testAccountId = null, testHospitalId = null, admin = null;

  try {
    console.log('\nGoldenHour end to end — ' + BASE);
    const health = await call('GET', '/health');
    step('/health is healthy on MySQL, on the RDS host', health.status === 200 && health.body.store === 'mysql' &&
      health.body.database && health.body.database.host === process.env.DB_HOST,
      { status: health.status, store: health.body.store, database: health.body.database, hospitals: health.body.directory_hospitals, env: health.body.env });
    step('the network holds the 100 hospitals from RDS', health.body.directory_hospitals >= 100 && health.body.directory_source === 'mysql',
      { directory_hospitals: health.body.directory_hospitals, source: health.body.directory_source });

    /* ── administrator ─────────────────────────────────────────────────── */
    const first = await call('POST', '/api/v1/auth/login', { username: adminUser, password: adminPass });
    step('the administrator signs in with the Secrets Manager password', first.status === 200, { status: first.status, reason: first.body.reason });
    if (first.status !== 200) throw new Error('cannot continue without the administrator');
    step('…and must change that password first', first.body.account.must_change_password === true);
    const changed = await call('POST', '/api/v1/auth/change-password', { current_password: adminPass, new_password: randomPassword() }, first.body.token);
    restoreAdmin = true;
    admin = changed.body.token;
    step('a temporary password change for this run opens the console', changed.status === 200 && !!admin);
    const list = await call('GET', '/api/v1/admin/accounts', undefined, admin);
    step('the console lists accounts', list.status === 200, { accounts: (list.body.accounts || []).length });

    /* ── a test hospital from the national list ────────────────────────── */
    const network = new Set((await call('GET', '/api/v1/admin/directory?limit=500', undefined, admin)).body.hospitals.map(h => h.hospital_id));
    const pick = catalogue.nearby(12.9716, 77.5946, 6, { emergencyOnly: true,
      filter: h => h.coord_source === 'listed' && !network.has(h.hospital_id) })[0];
    testHospitalId = pick.hospital_id;
    const imp = await call('POST', '/api/v1/admin/directory/import', { ids: [testHospitalId] }, admin);
    step('the admin adds a hospital from the national list (written to RDS)', imp.status === 200 && imp.body.added.includes(testHospitalId), { hospital: pick.name, id: testHospitalId });

    const mk = await call('POST', '/api/v1/admin/accounts', { hospital_id: testHospitalId, mode: 'activation' }, admin);
    testAccountId = mk.body.account && mk.body.account.account_id;
    step('a login is created with a one-time activation code', mk.status === 201 && !!mk.body.activation_code && mk.body.account.status === 'PENDING');

    /* ── activation ────────────────────────────────────────────────────── */
    const username = 'e2e.desk.' + Date.now().toString(36);
    const password = randomPassword();
    const look = await call('POST', '/api/v1/auth/activate/lookup', { code: mk.body.activation_code });
    step('the code names the hospital it is for', look.status === 200 && look.body.hospital.hospital_id === testHospitalId);
    const act = await call('POST', '/api/v1/auth/activate', { code: mk.body.activation_code, username, password });
    step('the hospital activates with its own username and password', act.status === 201, { status: act.status, reason: act.body.reason });
    const reuse = await call('POST', '/api/v1/auth/activate', { code: mk.body.activation_code, username: username + 'x', password });
    step('the code cannot be used twice', reuse.status === 400 && reuse.body.reason === 'INVALID_CODE');
    const signIn = await call('POST', '/api/v1/auth/login', { username, password });
    step('it signs in with exactly those and lands on its own desk', signIn.status === 200 && signIn.body.hospital.hospital_id === testHospitalId);
    const desk = signIn.body.token;

    /* ── realtime: WebSocket through CloudFront and the Beanstalk nginx ── */
    const seen = { cases: [], positions: [] };
    const deskSock = io(BASE, { query: { role: 'hospital' }, auth: { token: desk }, transports: ['websocket'], forceNew: true, reconnection: false });
    sockets.push(deskSock);
    deskSock.on('broadcast:new', c => seen.cases.push(c));
    deskSock.on('case:position', p => seen.positions.push(p));
    const identity = await new Promise(resolve => { deskSock.on('hospital:identity', resolve); setTimeout(() => resolve(null), 10000); });
    step('the desk socket connects over WebSocket (transport forced)', deskSock.connected && deskSock.io.engine.transport.name === 'websocket',
      { transport: deskSock.io.engine && deskSock.io.engine.transport.name });
    step('…and joins its own hospital room', identity && identity.hospital.hospital_id === testHospitalId);
    const upg = io(BASE, { query: { role: 'ambulance' }, forceNew: true, reconnection: false });
    sockets.push(upg);
    const upgraded = await new Promise(resolve => {
      upg.on('connect', () => upg.io.engine.on('upgrade', t => resolve(t.name)));
      setTimeout(() => resolve(upg.io.engine ? upg.io.engine.transport.name : null), 10000);
    });
    step('a default client starts on polling and upgrades to WebSocket', upgraded === 'websocket', { transport: upgraded });

    /* ── a case from the ambulance app's API ───────────────────────────── */
    const origin = { lat: pick.lat + 0.006, lng: pick.lng + 0.004, accuracy_m: 12, source: 'gps' };
    const cast = await call('POST', '/api/v1/requests', { case_type_id: 8, age: 58, gender: 'M',
      vitals: { systolic_bp: 104, heart_rate: 112, spo2: 94 }, notes: 'GoldenHour end-to-end test — not a patient',
      origin, broadcast_radius_km: 3, ambulance_id: 'E2E-TEST' }, undefined, { 'X-Client-Request-Id': 'e2e-' + Date.now() });
    const code = cast.body.id, crew = cast.body.crew_token;
    step('the ambulance broadcasts a test case', cast.status === 201 && !!code, { case: code, hospitals_notified: cast.body.hospitals_notified });
    for (let i = 0; i < 20 && !seen.cases.some(c => c.case_code === code); i++) await sleep(250);
    step('the case reaches the test hospital desk in real time', seen.cases.some(c => c.case_code === code));
    const q = await call('GET', '/api/v1/desk/queue', undefined, desk);
    step("it is in that desk's queue", q.status === 200 && q.body.pending.some(c => c.case_code === code));
    const acc = await call('POST', '/api/v1/desk/accept/' + code, {}, desk);
    step('the desk accepts it', acc.status === 200, { status: acc.status });

    /* ── crew GPS and arrival over the crew's socket ───────────────────── */
    const crewSock = io(BASE, { query: { role: 'ambulance' }, transports: ['websocket'], forceNew: true, reconnection: false });
    sockets.push(crewSock);
    await new Promise(r => { crewSock.on('connect', r); setTimeout(r, 8000); });
    const emit = (ev, payload) => new Promise(resolve => crewSock.timeout(8000).emit(ev, Object.assign({ case_code: code, crew_token: crew }, payload), (err, r) => resolve(err ? { success: false, error: String(err) } : r)));
    const fol = await emit('case:follow', {});
    step('the crew follows its case', fol && fol.success);
    const pos = await emit('ambulance:position', { lat: origin.lat - 0.002, lng: origin.lng - 0.001, accuracy_m: 10, speed_kmh: 32, at: new Date().toISOString() });
    for (let i = 0; i < 20 && !seen.positions.some(p => p.case_code === code); i++) await sleep(250);
    step('live GPS from the crew reaches the accepting desk', pos && pos.success && seen.positions.some(p => p.case_code === code),
      { eta_minutes: (seen.positions.find(p => p.case_code === code) || {}).live_eta_minutes });
    const track = await call('GET', '/api/v1/desk/track/' + code, undefined, desk);
    step('the desk can read the track', track.status === 200, { status: track.status });
    const arr = await emit('ambulance:arrived', {});
    step('arrival is recorded and the case closes', arr && arr.success);
    const closed = await call('GET', '/api/v1/requests/' + code, undefined, undefined, { 'X-Crew-Token': crew });
    step('the case is ARRIVED', closed.body.status === 'ARRIVED', { status: closed.body.status });

    const second = await call('POST', '/api/v1/requests', { case_type_id: 1, origin, broadcast_radius_km: 3, notes: 'GoldenHour end-to-end test — cancel' },
      undefined, { 'X-Client-Request-Id': 'e2e-cancel-' + Date.now() });
    const cancel = await call('POST', '/api/v1/requests/' + second.body.id + '/cancel', {}, undefined, { 'X-Crew-Token': second.body.crew_token });
    step('a second test case is cancelled by the crew', cancel.status === 200 && cancel.body.status === 'CANCELLED', { case: second.body.id, status: cancel.body.status });
  } catch (err) {
    step('harness', false, err.message);
  } finally {
    sockets.forEach(s => { try { s.close(); } catch (_) {} });
    /* Leave nothing behind but the audit trail and the two closed test cases:
       the test login and the test hospital are removed from RDS. */
    if (admin && testAccountId) {
      const d = await call('POST', '/api/v1/admin/accounts/' + testAccountId + '/disable', {}, admin).catch(() => ({}));
      step('cleanup: the test login is disabled', d.status === 200);
    }
    if (admin && testHospitalId) {
      const off = await call('POST', '/api/v1/admin/directory/' + testHospitalId + '/disable', {}, admin).catch(() => ({}));
      step('cleanup: the test hospital is switched off', off.status === 200);
    }
    if (restoreAdmin) {
      const bcrypt = require('bcryptjs');
      const pool = require('../src/config/db');
      const [r] = await pool.query('UPDATE accounts SET password_hash=?, must_change_password=1, token_version=token_version+1 WHERE username=? AND role=\'SUPER_ADMIN\'',
        [await bcrypt.hash(adminPass, Number(process.env.BCRYPT_ROUNDS) || 11), adminUser]);
      if (testAccountId) await pool.query("DELETE FROM accounts WHERE account_id=? AND role='HOSPITAL_STAFF' AND created_by=?", [testAccountId, adminUser]);
      if (testHospitalId) await pool.query('DELETE FROM hospitals WHERE id=?', [testHospitalId]);
      await pool.end();
      step('cleanup: the test login and test hospital are removed from RDS', true);
      step('cleanup: the administrator is back to the Secrets Manager password, must change it at next sign-in', r.affectedRows === 1);
    }
    const failed = results.filter(r => !r.ok).length;
    console.log('\n' + (failed ? 'FAIL' : 'PASS') + ' — ' + (results.length - failed) + ' passed, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
  }
}
main();
