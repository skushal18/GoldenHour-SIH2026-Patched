'use strict';
/* The live map's server side: the desk's own location as the hospital end
   (and when it is refused), the HTTP fallback for crew GPS, rough fixes kept
   but marked approximate and kept out of speed, duplicates, the estimate ETA,
   and the admin network map's data. */
const assert = require('assert');
process.env.PORT = '5121'; process.env.DB_DRIVER = 'memory'; process.env.DESK_AUTH = 'jwt';
process.env.DEMO_SEED = 'false'; process.env.TRACK_MIN_INTERVAL_MS = '0';
process.env.BCRYPT_ROUNDS = '4'; process.argv.push('--memory');
const { server } = require('../src/server');
const { getAccounts } = require('../src/store');
const authService = require('../src/services/authService');
const deskLocation = require('../src/services/deskLocationService');
const tracking = require('../src/services/trackingService');

const base = 'http://127.0.0.1:5121';
const ST_JOHNS = 12179;                 // directory point 12.930979, 77.619961
const tokens = {};
let passed = 0;
const ok = name => { passed++; console.log('  ok   ' + name); };
const req = async (path, method = 'GET', body, bearer, extra) => {
  const r = await fetch(base + '/api/v1' + path, { method, headers: { 'Content-Type': 'application/json',
    ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}), ...(extra || {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json() };
};
const ago = s => new Date(Date.now() - s * 1000).toISOString();

async function run() {
  await new Promise(r => server.listening ? r() : server.once('listening', r));
  const desk = await getAccounts().create({ username: 'er.map', password_hash: await authService.hashPassword('map desk password 1'),
    role: 'HOSPITAL_STAFF', hospital_id: ST_JOHNS, must_change_password: false });
  tokens.desk = authService.issueToken(desk);
  const admin = await getAccounts().create({ username: 'map.admin', password_hash: await authService.hashPassword('map admin password 1'),
    role: 'SUPER_ADMIN', must_change_password: false });
  tokens.admin = authService.issueToken(admin);

  console.log('\nlive map — desk location');
  let me = await req('/desk/me', 'GET', null, tokens.desk);
  assert.equal(me.body.location.source, 'directory');
  assert.equal(me.body.location.reason, 'NO_DESK_FIX');
  ok('before the desk reports, the hospital end is the directory address');

  assert.equal((await req('/desk/location', 'PUT', { lat: 0, lng: 0 }, tokens.desk)).status, 400);
  assert.equal((await req('/desk/location', 'PUT', { lat: 'x', lng: 77 }, tokens.desk)).status, 400);
  assert.equal((await req('/desk/location', 'PUT', { lat: 12.93, lng: 77.62 })).status, 401);
  ok('junk coordinates are refused, and only a signed-in desk may report');

  let r = await req('/desk/location', 'PUT', { lat: 12.9304, lng: 77.6191, accuracy_m: 2400 }, tokens.desk);
  assert.equal(r.body.location.source, 'directory'); assert.equal(r.body.location.reason, 'DESK_FIX_ROUGH');
  r = await req('/desk/location', 'PUT', { lat: 13.6, lng: 78.4, accuracy_m: 20 }, tokens.desk);
  assert.equal(r.body.location.source, 'directory'); assert.equal(r.body.location.reason, 'DESK_FIX_FAR');
  ok('a fix rougher than 1 km, or over 50 km from the address, is not used — and the reason is given');

  r = await req('/desk/location', 'PUT', { lat: 12.93035, lng: 77.61905, accuracy_m: 35 }, tokens.desk);
  assert.equal(r.status, 200); assert.equal(r.body.location.source, 'desk');
  assert.equal(r.body.location.lat, 12.93035); assert.equal(r.body.location.accuracy_m, 35);
  me = await req('/desk/me', 'GET', null, tokens.desk);
  assert.equal(me.body.location.source, 'desk');
  ok('a usable desk fix becomes the hospital end');

  console.log('\nlive map — crew GPS over HTTP');
  const created = await req('/requests', 'POST', { case_type_id: 1, age: 30, gender: 'F', origin: { lat: 12.9166, lng: 77.6050, accuracy_m: 15 }, broadcast_radius_km: 15 });
  const code = created.body.id, crew = created.body.crew_token;
  const pos = (body, token) => req('/requests/' + code + '/position', 'POST', body, null, { 'X-Crew-Token': token === undefined ? crew : token });

  assert.equal((await pos({ lat: 12.917, lng: 77.61, at: ago(1) })).status, 409);
  ok('no position is taken before a hospital accepts');
  assert.equal((await req('/desk/accept/' + code, 'POST', null, tokens.desk)).status, 200);
  assert.equal((await pos({ lat: 12.917, lng: 77.61, at: ago(1) }, 'wrong-token')).status, 404);
  assert.equal((await pos({ lat: 12.917, lng: 77.61, at: ago(1) }, '')).status, 404);
  ok('the HTTP fallback needs the crew token, like every crew action');

  const first = { lat: 12.9166, lng: 77.6050, accuracy_m: 12, at: ago(50) };
  r = await pos(first);
  assert.equal(r.status, 200); assert.equal(r.body.approximate, false);
  let live = tracking.snapshot(code);
  const toDesk = tracking.haversine(12.9166, 77.6050, 12.93035, 77.61905);
  assert.ok(Math.abs(live.distance_km - toDesk) < 0.01, 'distance is measured to the desk, not the address');
  assert.ok(live.est_eta_minutes >= 1 && live.live_eta_minutes == null, 'one fix: an estimate, not a live ETA');
  ok('a fix over HTTP is recorded; distance runs to the desk; the first ETA is an estimate');

  assert.equal((await pos(first)).body.message, 'duplicate');
  ok('the same fix sent again (socket, then HTTP) is accepted as a duplicate, not an error');

  r = await pos({ lat: 12.9168, lng: 77.6085, accuracy_m: 650, at: ago(40) });
  assert.equal(r.status, 200); assert.equal(r.body.approximate, true);
  assert.equal((await pos({ lat: 12.9169, lng: 77.6095, accuracy_m: 2500, at: ago(35) })).body.reason, 'INACCURATE_POSITION');
  ok('a ±650 m fix is kept and marked approximate; over 2 km is refused');

  await pos({ lat: 12.9170, lng: 77.6060, accuracy_m: 10, at: ago(30) });
  await pos({ lat: 12.9172, lng: 77.6070, accuracy_m: 10, at: ago(20) });
  await pos({ lat: 12.9176, lng: 77.6080, accuracy_m: 10, at: ago(10) });
  live = tracking.snapshot(code);
  assert.equal(live.eta_source, 'live'); assert.ok(live.live_eta_minutes >= 1);
  assert.ok(live.moving_kmh > 10 && live.moving_kmh < 60, 'speed from precise fixes only, got ' + live.moving_kmh);
  ok('with three precise fixes the ETA is live, and the rough fix does not distort the speed');

  const card = (await req('/desk/queue', 'GET', null, tokens.desk)).body.active.find(c => c.case_code === code);
  assert.equal(card.tracking_hospital.source, 'desk');
  assert.ok(card.est_eta_minutes >= 1 && card.moving_kmh != null && card.last_position.approximate === false);
  ok('the desk card carries the hospital end, the estimate and the speed');

  r = await req('/desk/location', 'PUT', { lat: 12.9310, lng: 77.6200, accuracy_m: 20 }, tokens.desk);
  assert.equal(r.body.live_cases_updated, 1);
  live = tracking.snapshot(code);
  assert.ok(Math.abs(live.distance_km - tracking.haversine(12.9176, 77.6080, 12.9310, 77.6200)) < 0.01);
  ok('when the desk moves, its live cases are re-measured at once');

  console.log('\nlive map — admin network map');
  const fresh = await req('/requests', 'POST', { case_type_id: 2, age: 50, gender: 'M', origin: { lat: 12.95, lng: 77.6 }, broadcast_radius_km: 15 });
  const adm = await req('/admin/live', 'GET', null, tokens.admin);
  assert.equal(adm.status, 200);
  const a = adm.body.cases.find(c => c.case_code === code);
  assert.equal(a.position.lat, 12.9176); assert.equal(a.destination.source, 'desk'); assert.equal(a.destination.hospital_id, ST_JOHNS);
  assert.ok(a.remaining_distance_km != null);
  const p = adm.body.cases.find(c => c.case_code === fresh.body.id);
  assert.deepEqual(p.origin, { lat: 12.95, lng: 77.6 }); assert.equal(p.position, undefined);
  assert.ok(adm.body.hospitals.some(h => h.hospital_id === ST_JOHNS && h.source === 'desk'));
  assert.ok(!('patient' in a) && !('notes' in a), 'no patient details on the network map');
  assert.equal((await req('/admin/live', 'GET', null, tokens.desk)).status, 403);
  ok('admin live: ambulance position, destination, waiting origins, receiving hospitals — no patient details, admins only');

  deskLocation._reset();
  console.log('\nPASS — ' + passed + ' passed, 0 failed');
}

run().then(() => { server.close(); process.exit(0); }, err => { console.error('FAIL', err); process.exit(1); });
