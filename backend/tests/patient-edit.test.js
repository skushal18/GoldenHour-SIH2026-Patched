/* ============================================================================
   Phase 2 — patient:update transport-only edit flow.

   Covers spec §26.1 + §26.3:
     - accepted case can have its patient block updated
     - server returns a positive ack to the ambulance
     - server emits patient:updated ONLY to the desk that accepted it
     - server later refuses a patient update once the case has arrived
   ========================================================================== */

'use strict';

const assert = require('assert');

process.env.PORT = process.env.TEST_PORT_PE || '5101';
process.env.DB_DRIVER = 'memory';
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

function waitForListening() {
  return new Promise(resolve => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
}

function laptop(hospitalId) {
  const socket = ioClient(BASE, {
    query: { role: 'hospital', hospital: String(hospitalId) },
    transports: ['websocket'],
    forceNew: true
  });
  const seen = { identity: null, incoming: [], claimed: [], updated: [], arrived: [] };
  socket.on('hospital:identity', d => { seen.identity = d; });
  socket.on('broadcast:new', c => seen.incoming.push(c));
  socket.on('broadcast:claimed', d => seen.claimed.push(d));
  socket.on('patient:updated', d => seen.updated.push(d));
  socket.on('case:arrived', d => seen.arrived.push(d));
  return {
    id: hospitalId,
    socket,
    seen,
    ready: new Promise(resolve => socket.on('connect', resolve)),
    accept: code => fetch(`${BASE}/api/v1/desk/accept/${code}?hospital=${hospitalId}`, { method: 'POST' })
      .then(async r => ({ status: r.status, body: await r.json() })),
    close: () => socket.close()
  };
}

const SAMPLE = {
  case_type_id: 12,
  age: 58, gender: 'M', blood_group: 'O+',
  vitals: { systolic_bp: 110, diastolic_bp: 70, heart_rate: 88, resp_rate: 18, spo2: 96, glucose: null },
  consciousness: 'Conscious',
  origin: { lat: 12.9716, lng: 77.5946, accuracy_m: 18 },
  broadcast_radius_km: 15,
  images: [],
  eta_minutes: 12,
  notes: 'initial note',
  ambulance_id: 'KA01AB1234'
};

async function main() {
  await waitForListening();

  const a = laptop(1);
  const b = laptop(2);
  await Promise.all([a.ready, b.ready]);
  await sleep(120);

  /* ── Setup — broadcast then accept on Hospital 1 ─────────────────── */
  group('Setup: broadcast and accept');
  const cast = await fetch(`${BASE}/api/v1/requests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(SAMPLE)
  }).then(async r => ({ status: r.status, body: await r.json() }));
  check('broadcast returns 201', () => { assert.strictEqual(cast.status, 201); });
  const code = cast.body.id;
  await sleep(120);

  const acceptResult = await a.accept(code);
  check('hospital 1 accepts', () => { assert.strictEqual(acceptResult.status, 200); });
  await sleep(120);

  /* The hospital must have been told it won; the loser must not have any
     patient details yet — we have not edited anyone. */
  check('losing desk has no patient:updated events', () => {
    assert.strictEqual(b.seen.updated.length, 0);
  });

  /* ── Edit flow — connect an ambulance client and edit ────────────── */
  group('patient:update from the ambulance');
  const ambulance = ioClient(BASE, {
    query: { role: 'ambulance' },
    transports: ['websocket'], forceNew: true
  });
  await new Promise(resolve => ambulance.on('connect', resolve));
  ambulance.emit('case:follow', code);
  await sleep(80);

  const patch = {
    age: 60, blood_group: 'A+', consciousness: 'Semi-Conscious',
    vitals: { systolic_bp: 92, diastolic_bp: 60, heart_rate: 118, resp_rate: 22, spo2: 91, glucose: 110 }
  };

  const editAck = await new Promise(resolve => {
    ambulance.emit('patient:update', { case_code: code, patient: patch }, resolve);
  });
  check('server replies with success:true', () => { assert.ok(editAck && editAck.success); });
  await sleep(120);

  check('only the accepting desk receives patient:updated', () => {
    assert.ok(a.seen.updated.some(d => d.case_code === code));
    assert.strictEqual(b.seen.updated.length, 0,
      'Losing desk must NEVER receive patient:updated for a case it does not own.');
  });
  check('patient:updated carries the new patient block', () => {
    const last = a.seen.updated[a.seen.updated.length - 1];
    assert.strictEqual(last.patient.age, 60);
    assert.strictEqual(last.patient.blood_group, 'A+');
    assert.strictEqual(last.patient.vitals.spo2, 91);
  });

  /* ── Persistence — store still holds the updated values ───────────── */
  const afterEdit = await fetch(`${BASE}/api/v1/requests/${code}`).then(r => r.json());
  check('GET /requests reflects edited patient block', () => {
    assert.strictEqual(afterEdit.patient.age, 60);
    assert.strictEqual(afterEdit.patient.vitals.spo2, 91);
  });
  const queue = await fetch(`${BASE}/api/v1/desk/queue?hospital=1`).then(r => r.json());
  check('desk /queue active list also reflects edited values', () => {
    const me = queue.active.find(c => c.case_code === code);
    assert.ok(me, 'Accepting desk must still see the case in active[]');
    assert.strictEqual(me.patient.age, 60);
  });

  /* ── Refusal after arrival  ──────────────────────────────────────── */
  group('Phase 2 §26.3 — refuse post-arrival edits');
  const arrivedAck = await new Promise(resolve =>
    ambulance.emit('ambulance:arrived', { case_code: code, hospital_id: 1 }, resolve)
  );
  check('ambulance:arrived ack is success', () => { assert.ok(arrivedAck && arrivedAck.success); });
  await sleep(120);

  check('case:arrived fires only to the accepting desk', () => {
    assert.ok(a.seen.arrived.some(d => d.case_code === code));
    assert.strictEqual(b.seen.arrived.length, 0);
  });

  const rejected = await new Promise(resolve => {
    ambulance.emit('patient:update', {
      case_code: code, patient: { age: 65, vitals: { spo2: 92 } }
    }, resolve);
  });
  check('post-arrival patient:update is refused', () => {
    assert.ok(rejected && rejected.success === false);
    assert.ok(['NOT_ACTIVE', 'NOT_FOUND'].includes(rejected.reason));
  });

  /* Unknown case codes must also be refused, never silently swallowed. */
  group('Phase 2 §26.2 — reject unknown case_code');
  const ghost = await new Promise(resolve => {
    ambulance.emit('patient:update', {
      case_code: 'GH-1999-9999', patient: { age: 60 }
    }, resolve);
  });
  check('unknown case_code is NOT_FOUND', () => {
    assert.ok(ghost && ghost.success === false);
    assert.strictEqual(ghost.reason, 'NOT_FOUND');
  });

  ambulance.close();
  a.close(); b.close();
  server.close();

  console.log('\n' + (failed === 0 ? 'PASS' : 'FAIL') + ` — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.log('\nHARNESS ERROR: ' + (err && err.stack || err));
  process.exit(1);
});
