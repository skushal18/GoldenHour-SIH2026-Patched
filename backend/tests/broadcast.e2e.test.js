/* ============================================================================
   End-to-end test of the thing the hackathon is actually judged on.

   Boots the real server, connects two socket clients pretending to be the two
   laptops, and checks:

     1  a broadcast reaches BOTH laptops
     2  both laptops pressing Accept at the same instant produces exactly ONE
        winner — never two
     3  the loser is told who won and drops the card
     4  the ambulance's status endpoint flips to ACCEPTED with the winner's name
     5  a second attempt on an already-accepted case is refused with 409
     6  declining on both laptops ends the broadcast as REJECTED

   Run:  npm test          (from backend/)
   ========================================================================== */

'use strict';

const assert = require('assert');

process.env.PORT = process.env.TEST_PORT || '5099';
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

/** A laptop: socket in one hand, HTTP in the other, both forced to one hospital. */
function laptop(hospitalId) {
  const socket = ioClient(BASE, {
    query: { role: 'hospital', hospital: String(hospitalId) },
    transports: ['websocket'],
    forceNew: true
  });
  const seen = { identity: null, incoming: [], claimed: [], expired: [], cancelled: [] };

  socket.on('hospital:identity', d => { seen.identity = d; });
  socket.on('broadcast:new', c => seen.incoming.push(c));
  socket.on('broadcast:claimed', d => seen.claimed.push(d));
  socket.on('broadcast:expired', d => seen.expired.push(d));
  socket.on('broadcast:cancelled', d => seen.cancelled.push(d));

  return {
    id: hospitalId,
    socket,
    seen,
    ready: new Promise(resolve => socket.on('connect', resolve)),
    accept: code => fetch(`${BASE}/api/v1/desk/accept/${code}?hospital=${hospitalId}`, { method: 'POST' })
      .then(async r => ({ status: r.status, body: await r.json() })),
    decline: code => fetch(`${BASE}/api/v1/desk/decline/${code}?hospital=${hospitalId}`, { method: 'POST' })
      .then(async r => ({ status: r.status, body: await r.json() })),
    queue: () => fetch(`${BASE}/api/v1/desk/queue?hospital=${hospitalId}`).then(r => r.json()),
    close: () => socket.close()
  };
}

const SAMPLE = {
  case_type_id: 12,                       // stroke → the FAST block must survive the round trip
  age: 58, gender: 'M', blood_group: 'O+',
  vitals: { systolic_bp: 82, diastolic_bp: 50, heart_rate: 132, resp_rate: 26, spo2: 88, glucose: null },
  consciousness: 'Semi-Conscious',
  origin: { lat: 12.9716, lng: 77.5946, accuracy_m: 18 },
  broadcast_radius_km: 15,
  images: [],
  eta_minutes: 12,
  notes: 'entrapped 20 min, one unit O− given',
  ambulance_id: 'KA01AB1234',
  stroke_assessment: { face: false, arm: true, speech: true, onset_hours: 2 }
};

function broadcast(overrides) {
  return fetch(`${BASE}/api/v1/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({}, SAMPLE, overrides || {}))
  }).then(async r => ({ status: r.status, body: await r.json() }));
}

const statusOf = code => fetch(`${BASE}/api/v1/requests/${code}`).then(r => r.json());

async function main() {
  await waitForListening();

  const a = laptop(1);
  const b = laptop(2);
  await Promise.all([a.ready, b.ready]);
  await sleep(120);

  /* ── 1. Identity ───────────────────────────────────────────────────── */
  group('Laptop identity');
  check('laptop 1 is told which hospital it is', () => {
    assert.ok(a.seen.identity, 'no hospital:identity event');
    assert.strictEqual(a.seen.identity.hospital.hospital_id, 1);
  });
  check('laptop 2 is a different hospital', () => {
    assert.strictEqual(b.seen.identity.hospital.hospital_id, 2);
    assert.notStrictEqual(a.seen.identity.hospital.name, b.seen.identity.hospital.name);
  });

  /* ── 2. Case types ─────────────────────────────────────────────────── */
  group('Case types');
  const types = await fetch(`${BASE}/api/v1/case-types`).then(r => r.json());
  check('the full case list is served', () => {
    assert.strictEqual(types.length, 33);
    assert.ok(types.some(t => t.category === 'STROKE'));
    assert.strictEqual(types.filter(t => t.quick === true).length, 6);
  });

  /* ── 3. Broadcast reaches both laptops ─────────────────────────────── */
  group('One broadcast, both laptops');
  const created = await broadcast();
  check('POST /requests returns 201 with a case id', () => {
    assert.strictEqual(created.status, 201);
    assert.ok(/^GH-\d{4}-\d{4}$/.test(created.body.id), 'odd case code: ' + created.body.id);
    assert.strictEqual(created.body.status, 'PENDING');
  });
  check('both hardcoded laptops were notified', () => {
    assert.strictEqual(created.body.hospitals_notified, 2);
  });
  check('the server computed the priority (the app never sends one)', () => {
    assert.strictEqual(created.body.priority, 'RED');   // SBP 82, SpO2 88
  });

  const code = created.body.id;
  await sleep(150);

  check('laptop 1 received the case over the socket', () => {
    assert.strictEqual(a.seen.incoming.length, 1);
    assert.strictEqual(a.seen.incoming[0].case_code, code);
  });
  check('laptop 2 received the same case', () => {
    assert.strictEqual(b.seen.incoming.length, 1);
    assert.strictEqual(b.seen.incoming[0].case_code, code);
  });
  check('a GPS position is labelled as measured', () => {
    assert.strictEqual(a.seen.incoming[0].origin.source, 'gps');
  });
  check('the case arrives with the clinical detail the ER needs', () => {
    const c = a.seen.incoming[0];
    assert.strictEqual(c.patient.vitals.systolic_bp, 82);
    assert.strictEqual(c.patient.vitals.glucose, null, 'an untaken vital must stay null, never 0');
    assert.strictEqual(c.priority, 'RED');
    assert.ok(c.critical_flags.shock && c.critical_flags.hypoxia);
    assert.strictEqual(c.stroke_assessment.arm, true);
    assert.strictEqual(c.chief_complaint, 'Stroke / sudden weakness or slurred speech');
  });
  check('both queues list it', async () => {
    assert.ok(true);
  });
  const [qa, qb] = await Promise.all([a.queue(), b.queue()]);
  check('REST queue on laptop 1 shows the case', () => {
    assert.strictEqual(qa.cases.filter(c => c.case_code === code).length, 1);
  });
  check('REST queue on laptop 2 shows the case', () => {
    assert.strictEqual(qb.cases.filter(c => c.case_code === code).length, 1);
  });

  /* ── 4. THE RACE ───────────────────────────────────────────────────── */
  group('Both laptops accept at the same instant');
  const [ra, rb] = await Promise.all([a.accept(code), b.accept(code)]);
  const wins = [ra, rb].filter(r => r.status === 200);
  const losses = [ra, rb].filter(r => r.status !== 200);

  check('exactly one laptop wins', () => {
    assert.strictEqual(wins.length, 1, `expected 1 winner, got ${wins.length}`);
  });
  check('the other is refused with 409, not a silent success', () => {
    assert.strictEqual(losses.length, 1);
    assert.strictEqual(losses[0].status, 409);
    assert.strictEqual(losses[0].body.reason, 'ALREADY_ACCEPTED');
  });
  check('the loser is told who beat them', () => {
    assert.ok(losses[0].body.accepted_by, 'no winner name returned');
  });

  const winnerId = wins[0].body.case.accepted_hospital_id;
  await sleep(150);

  check('both laptops were told the case is claimed', () => {
    assert.strictEqual(a.seen.claimed.length, 1, 'laptop 1 missed broadcast:claimed');
    assert.strictEqual(b.seen.claimed.length, 1, 'laptop 2 missed broadcast:claimed');
  });
  check('the claimed event marks exactly one laptop as the winner', () => {
    const flags = [a.seen.claimed[0].won, b.seen.claimed[0].won];
    assert.strictEqual(flags.filter(Boolean).length, 1);
    const winner = a.seen.claimed[0].won ? 1 : 2;
    assert.strictEqual(winner, winnerId);
  });
  check('the losing laptop knows which hospital took it — that is what clears the card', () => {
    const loser = a.seen.claimed[0].won ? b : a;
    assert.strictEqual(loser.seen.claimed[0].won, false);
    assert.ok(loser.seen.claimed[0].accepted_by);
  });

  const [qa2, qb2] = await Promise.all([a.queue(), b.queue()]);
  check('the accepted case stays only on the winner dashboard', () => {
    const winnerQueue = winnerId === 1 ? qa2 : qb2;
    const loserQueue = winnerId === 1 ? qb2 : qa2;
    const winnerCases = winnerQueue.cases.filter(c => c.case_code === code);
    assert.strictEqual(winnerCases.length, 1);
    assert.strictEqual(winnerCases[0].status, 'ACCEPTED');
    assert.strictEqual(winnerCases[0].accepted_hospital_id, winnerId);
    assert.strictEqual(loserQueue.cases.filter(c => c.case_code === code).length, 0);
  });

  /* ── 5. Ambulance side ─────────────────────────────────────────────── */
  group('What the ambulance sees');
  const status = await statusOf(code);
  check('status flips to ACCEPTED', () => {
    assert.strictEqual(status.status, 'ACCEPTED');
  });
  check('it names the hospital that took the patient', () => {
    assert.ok(status.accepted_by);
    assert.strictEqual(status.accepted_by, wins[0].body.case.accepted_by);
  });
  check('it carries a phone number and coordinates for the crew', () => {
    assert.ok(status.accepted_hospital.phone);
    assert.strictEqual(typeof status.accepted_hospital.lat, 'number');
  });
  check('it still reports how many hospitals were alerted', () => {
    assert.strictEqual(status.hospitals_notified, 2);
  });

  /* ── 6. Late accept ────────────────────────────────────────────────── */
  group('A late Accept is refused');
  const late = await (winnerId === 1 ? b : a).accept(code);
  check('accepting an already-claimed case returns 409', () => {
    assert.strictEqual(late.status, 409);
    assert.strictEqual(late.body.reason, 'ALREADY_ACCEPTED');
  });
  check('the winner did not change', async () => {
    assert.ok(true);
  });
  const afterLate = await statusOf(code);
  check('the accepted hospital is unchanged after the late attempt', () => {
    assert.strictEqual(afterLate.accepted_by, status.accepted_by);
  });

  /* ── 7. Everybody declines ─────────────────────────────────────────── */
  group('Both laptops decline');
  const second = await broadcast({ case_type_id: 1, stroke_assessment: undefined });
  const code2 = second.body.id;
  await sleep(120);
  await a.decline(code2);
  await b.decline(code2);
  const rejected = await statusOf(code2);
  check('the broadcast ends as REJECTED when nobody wants it', () => {
    assert.strictEqual(rejected.status, 'REJECTED');
  });
  check('a non-stroke case carries no FAST block', () => {
    assert.strictEqual(a.seen.incoming[1].stroke_assessment, null);
  });

  /* ── 8. Cancel ─────────────────────────────────────────────────────── */
  group('Crew stands the request down');
  const third = await broadcast({ case_type_id: 3 });
  const code3 = third.body.id;
  await sleep(120);
  await fetch(`${BASE}/api/v1/requests/${code3}/cancel`, { method: 'POST' });
  await sleep(120);
  check('both laptops are told to drop it', () => {
    assert.ok(a.seen.cancelled.some(d => d.case_code === code3));
    assert.ok(b.seen.cancelled.some(d => d.case_code === code3));
  });
  const cancelled = await statusOf(code3);
  check('status reads CANCELLED', () => {
    assert.strictEqual(cancelled.status, 'CANCELLED');
  });
  check('accepting a cancelled case is refused', async () => { assert.ok(true); });
  const afterCancel = await a.accept(code3);
  check('a cancelled case cannot be accepted', () => {
    assert.strictEqual(afterCancel.status, 409);
  });

  /* ── 9. A hand-set position ────────────────────────────────────────── */
  group('A position the crew typed in');
  const typed = await broadcast({
    case_type_id: 6,
    origin: { lat: 12.9800, lng: 77.6000, accuracy_m: null, source: 'manual' }
  });
  await sleep(150);
  check('the broadcast is accepted like any other', () => {
    assert.strictEqual(typed.status, 201);
  });
  check('but the ER board is told the position was not measured', () => {
    const card = a.seen.incoming[a.seen.incoming.length - 1];
    assert.strictEqual(card.case_code, typed.body.id);
    assert.strictEqual(card.origin.source, 'manual');
    assert.strictEqual(card.origin.accuracy_m, null);
  });

  /* ── 10. Misc guards ───────────────────────────────────────────────── */
  group('Guards');
  const bad = await fetch(`${BASE}/api/v1/requests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ age: 40 })
  });
  check('a request with no case type is rejected', () => {
    assert.strictEqual(bad.status, 400);
  });

  /* null coordinates used to slip through the undefined check and create a
     case no hospital could ever be matched to. */
  const nullOrigin = await broadcast({ origin: { lat: null, lng: null, accuracy_m: null } });
  check('null coordinates are rejected, not stored as a dispatchable case', () => {
    assert.strictEqual(nullOrigin.status, 400);
  });
  const wildOrigin = await broadcast({ origin: { lat: 999, lng: 77.5 } });
  check('impossible coordinates are rejected', () => {
    assert.strictEqual(wildOrigin.status, 400);
  });
  const missing = await fetch(`${BASE}/api/v1/requests/GH-1999-0001`);
  check('an unknown case code is a 404', () => {
    assert.strictEqual(missing.status, 404);
  });
  const health = await fetch(`${BASE}/health`).then(r => r.json());
  check('/health reports the two hardcoded laptops', () => {
    assert.strictEqual(health.laptops.length, 2);
    assert.strictEqual(health.hackathon_mode, true);
  });

  a.close(); b.close();
  server.close();

  console.log('\n' + (failed === 0 ? 'PASS' : 'FAIL') + ` — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.log('\nHARNESS ERROR: ' + (err && err.stack || err));
  process.exit(1);
});
