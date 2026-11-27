'use strict';
/* Ambulance logins: one login per vehicle, a one-time sign-in code, the
   phone it is signed in on, the crew on shift, cases stamped with the
   vehicle, sign-in required in production, and the crew's route endpoint. */
const assert = require('assert');
process.env.PORT = '5127'; process.env.DB_DRIVER = 'memory'; process.env.DESK_AUTH = 'jwt';
process.env.DEMO_SEED = 'false'; process.env.ROUTING = 'off';
process.env.BCRYPT_ROUNDS = '4'; process.argv.push('--memory');
const { server } = require('../src/server');
const { getAccounts, getAmbulances } = require('../src/store');
const authService = require('../src/services/authService');
const ambulances = require('../src/services/ambulanceService');

const base = 'http://127.0.0.1:5127/api/v1';
let passed = 0;
const ok = name => { passed++; console.log('  ok   ' + name); };
const req = async (path, method = 'GET', body, token, extra) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(extra || {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json() };
};
const CASE = { case_type_id: 1, age: 30, gender: 'M', origin: { lat: 12.9166, lng: 77.605 }, broadcast_radius_km: 15 };

async function run() {
  await new Promise(r => server.listening ? r() : server.once('listening', r));
  const admin = await getAccounts().create({ username: 'amb.admin', password_hash: await authService.hashPassword('admin password 12'), role: 'SUPER_ADMIN', must_change_password: false });
  const at = authService.issueToken(admin);
  const desk = await getAccounts().create({ username: 'er.amb', password_hash: await authService.hashPassword('desk password 12'), role: 'HOSPITAL_STAFF', hospital_id: 12179, must_change_password: false });
  const dt = authService.issueToken(desk);

  console.log('\nambulances — administrator');
  assert.equal((await req('/admin/ambulances', 'POST', { registration: 'KA01AB1234' }, dt)).status, 403);
  assert.equal((await req('/admin/ambulances', 'POST', { registration: 'x!' }, at)).body.reason, 'BAD_REGISTRATION');
  let r = await req('/admin/ambulances', 'POST', { registration: 'ka 01 ab 1234', unit_name: '108 Unit 12', operator: 'GVK EMRI', vehicle_type: 'ALS' }, at);
  assert.equal(r.status, 201); assert.equal(r.body.ambulance.registration, 'KA01AB1234'); assert.equal(r.body.ambulance.state, 'WAITING');
  assert.match(r.body.sign_in_code, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
  const row = await getAmbulances().findById(r.body.ambulance.ambulance_id);
  assert.ok(row.code_hash && row.code_hash !== r.body.sign_in_code && !JSON.stringify(r.body.ambulance).includes(row.code_hash));
  assert.equal((await req('/admin/ambulances', 'POST', { registration: 'KA-01-AB-1234'.replace(/-/g, '') }, at)).status, 409);
  assert.equal((await req('/admin/ambulances', 'POST', { registration: 'KA01AB9999', vehicle_type: 'Helicopter' }, at)).body.reason, 'BAD_TYPE');
  ok('only an administrator registers an ambulance; the code is shown once and stored only as a hash; duplicates and bad types are refused');
  const id = r.body.ambulance.ambulance_id, code = r.body.sign_in_code;

  console.log('\nambulances — the phone signs in');
  assert.equal((await req('/auth/ambulance/pair', 'POST', { code: 'AAAA-BBBB-CCCC-DDDD' })).body.reason, 'INVALID_CODE');
  r = await req('/auth/ambulance/pair', 'POST', { code: code.toLowerCase().replace(/-/g, ' '), device: { installation_id: 'inst-1', model: 'SM-A546E', manufacturer: 'Samsung', os: 'Android', os_version: '14', app_version: '7.2.0', battery_pct: 140, junk: 'x' } });
  assert.equal(r.status, 200); assert.ok(r.body.token); assert.equal(r.body.ambulance.state, 'ACTIVE');
  assert.equal(r.body.ambulance.device.model, 'SM-A546E'); assert.equal(r.body.ambulance.device.battery_pct, 100); assert.equal(r.body.ambulance.device.junk, undefined);
  const tok = r.body.token;
  assert.equal((await req('/auth/ambulance/pair', 'POST', { code })).status, 400);
  ok('the code signs the phone in once (case and spaces do not matter), records the phone, and cannot be used again');

  r = await req('/ambulance/heartbeat', 'POST', { device: { model: 'SM-A546E', battery_pct: 64, network: '4g' } }, tok);
  assert.equal(r.body.ambulance.device.battery_pct, 64); assert.equal(r.body.ambulance.device.installation_id, 'inst-1');
  assert.equal(r.body.ambulance.online, true);
  assert.equal((await req('/ambulance/me', 'GET', null, 'not-a-token')).status, 401);
  assert.equal((await req('/ambulance/me', 'GET', null, dt)).status, 401, 'a desk token is not an ambulance token');
  ok('the phone reports itself; a desk token or garbage is not an ambulance login');

  assert.equal((await req('/ambulance/crew', 'PUT', { crew: [{ name: '' }] }, tok)).body.reason, 'BAD_CREW');
  assert.equal((await req('/ambulance/crew', 'PUT', { crew: [{ name: 'A', role: 'Pilot' }] }, tok)).body.reason, 'BAD_CREW');
  assert.equal((await req('/ambulance/crew', 'PUT', { crew: Array(7).fill({ name: 'A', role: 'EMT' }) }, tok)).body.reason, 'BAD_CREW');
  r = await req('/ambulance/crew', 'PUT', { crew: [{ name: 'Ravi Kumar', role: 'Driver', phone: '+91 98450 11111' }, { name: 'Asha Nair', role: 'Paramedic' }] }, tok);
  assert.equal(r.body.ambulance.crew.length, 2);
  ok('the crew on shift is kept with the vehicle; names, roles, phones and size are checked');

  console.log('\nambulances — cases');
  r = await req('/requests', 'POST', Object.assign({ ambulance_id: 'SOMEONE-ELSE' }, CASE), tok);
  assert.equal(r.status, 201);
  const code1 = r.body.id, crew1 = r.body.crew_token;
  const list = (await req('/admin/ambulances', 'GET', null, at)).body;
  const me = list.ambulances.find(a => a.ambulance_id === id);
  assert.equal(me.current_case.case_code, code1);
  const live = (await req('/admin/live', 'GET', null, at)).body.cases.find(c => c.case_code === code1);
  assert.equal(live.ambulance, 'KA01AB1234');
  const queue = (await req('/desk/queue', 'GET', null, dt)).body.pending.find(c => c.case_code === code1);
  assert.equal(queue.ambulance_id, 'KA01AB1234', 'the desk sees the signed-in vehicle, not what the body claimed');
  assert.equal((await req('/requests', 'POST', CASE, 'bad-token')).status, 401);
  assert.equal((await req('/requests', 'POST', CASE)).status, 201, 'development: an unsigned case is still accepted');
  process.env.CREW_AUTH = 'required';
  assert.equal((await req('/requests', 'POST', CASE)).body.reason, 'AMBULANCE_SIGN_IN');
  assert.equal((await req('/requests', 'POST', CASE, tok)).status, 201);
  delete process.env.CREW_AUTH;
  ok('cases carry the signed-in vehicle; a bad token is refused; production requires a signed-in ambulance');

  console.log('\nambulances — the route to the hospital');
  assert.equal((await req('/requests/' + code1 + '/route', 'GET', null, null, { 'X-Crew-Token': crew1 })).body.reason, 'NOT_ACCEPTED');
  assert.equal((await req('/desk/accept/' + code1, 'POST', null, dt)).status, 200);
  assert.equal((await req('/requests/' + code1 + '/route', 'GET', null, null, { 'X-Crew-Token': 'wrong' })).status, 404);
  r = await req('/requests/' + code1 + '/route', 'GET', null, null, { 'X-Crew-Token': crew1 });
  assert.equal(r.status, 200); assert.equal(r.body.route, null, 'routing off: no route is invented');
  assert.equal(r.body.from.source, 'sent-from'); assert.ok(r.body.hospital.lat && r.body.hospital.name);
  assert.ok(/^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=/.test(r.body.navigate_url));
  ok('after acceptance the crew gets the hospital, where they are, a maps link — and no made-up route when routing is off');
  const routing = require('../src/services/routingService');
  assert.equal(routing.instruction({ maneuver: { type: 'turn', modifier: 'left' }, name: 'Hosur Road' }), 'Turn left onto Hosur Road');
  assert.equal(routing.instruction({ maneuver: { type: 'roundabout', exit: 2 }, name: '' }), 'At the roundabout, take exit 2');
  assert.equal(routing.instruction({ maneuver: { type: 'arrive', modifier: 'right' } }), 'Arrive at the hospital, on your right');
  ok('directions read as sentences a driver can act on');

  console.log('\nambulances — signing a phone out');
  r = await req('/admin/ambulances/' + id + '/code', 'POST', null, at);
  assert.equal(r.body.ambulance.state, 'WAITING'); assert.ok(r.body.sign_in_code);
  assert.equal((await req('/ambulance/me', 'GET', null, tok)).status, 401);
  ok('a new code signs the old phone out at once');
  const tok2 = (await req('/auth/ambulance/pair', 'POST', { code: r.body.sign_in_code, device: { model: 'Pixel 8' } })).body.token;
  assert.equal((await req('/admin/ambulances/' + id + '/disable', 'POST', null, at)).body.ambulance.state, 'DISABLED');
  assert.equal((await req('/ambulance/me', 'GET', null, tok2)).status, 401);
  assert.equal((await req('/admin/ambulances/' + id + '/enable', 'POST', null, at)).body.ambulance.state, 'SIGNED_OUT');
  r = await req('/admin/ambulances/' + id, 'PUT', { unit_name: '108 Unit 14', base_location: 'HSR Layout' }, at);
  assert.equal(r.body.ambulance.unit_name, '108 Unit 14');
  ok('switching a vehicle off signs its phone out; switching it on needs a new code; details can be edited');

  const ua = await import('data:text/javascript;base64,' + require('fs').readFileSync(require('path').join(__dirname, '../../app/src/modules/ambulance.js')).toString('base64'));
  const p = ua.parseUserAgent('Mozilla/5.0 (Linux; Android 14; SM-A546E Build/UP1A.231005.007; wv) AppleWebKit/537.36 Chrome/131.0.6778.135 Mobile Safari/537.36');
  assert.deepEqual([p.os, p.os_version, p.model, p.manufacturer], ['Android', '14', 'SM-A546E', 'Samsung']);
  assert.equal(ua.parseUserAgent('Mozilla/5.0 (Linux; Android 10; K) Chrome/120').model, null, 'Chrome hides the model as "K": not a model');
  const steps = [{ type: 'depart', at: { lat: 12.9166, lng: 77.605 }, instruction: 'Head east' }, { type: 'turn', modifier: 'left', at: { lat: 12.9170, lng: 77.6125 }, instruction: 'Turn left' }, { type: 'arrive', at: { lat: 12.93, lng: 77.619 }, instruction: 'Arrive' }];
  assert.equal(ua.nextStep(steps, { lat: 12.9166, lng: 77.6052 }).step.instruction, 'Turn left');
  assert.equal(ua.nextStep(steps, { lat: 12.91701, lng: 77.61251 }).step.instruction, 'Arrive');
  assert.equal(ua.formatDistance(340), '350 m'); assert.equal(ua.formatDistance(2140), '2.1 km');
  ok('the app reads the phone model from its user agent and picks the next turn from where it is');

  const fs = require('fs'), path = require('path');
  assert.equal(fs.readFileSync(path.join(__dirname, '../public/hospital/logo.js'), 'utf8'), fs.readFileSync(path.join(__dirname, '../../app/www/logo.js'), 'utf8'),
    'app/www/logo.js must be a copy of backend/public/hospital/logo.js');
  ok('the app and the web pages draw the same logo');

  console.log('\nPASS — ' + passed + ' passed, 0 failed');
}
run().then(() => { server.close(); process.exit(0); }, err => { console.error('FAIL', err); process.exit(1); });
