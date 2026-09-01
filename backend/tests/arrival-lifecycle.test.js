/* ============================================================================
   Phase 2 — arrival lifecycle & page-refresh persistence.

   Covers spec §27:
     - After Accept, the case must appear in Active (queue.active[]) and NOT in
       Recently Handled (queue.pending[]) on a fresh GET /queue.
     - After ambulance:arrived, the case moves out of Active and into the
       resolved outcome on the dashboard.
     - A page refresh AFTER arrival must still show the case as ARRIVED.
       It must NOT bounce back into Active.
     - A page refresh BEFORE arrival must show the case as Active.
   ========================================================================== */

'use strict';

const assert = require('assert');

process.env.PORT = process.env.TEST_PORT_AL || '5103';
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

const SAMPLE = {
  case_type_id: 16,                    // breathlessness
  age: 70, gender: 'F', blood_group: 'B+',
  vitals: { systolic_bp: 110, diastolic_bp: 70, heart_rate: 100, resp_rate: 24, spo2: 92, glucose: null },
  consciousness: 'Conscious',
  origin: { lat: 12.9716, lng: 77.5946, accuracy_m: 20 },
  broadcast_radius_km: 15,
  images: [],
  eta_minutes: 8,
  notes: 'begin transport',
  ambulance_id: 'KA01AB1234'
};

async function main() {
  await waitForListening();

  group('Broadcast + Accept — case must be in Active, NOT Recently Handled');
  const created = await fetch(`${BASE}/api/v1/requests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(SAMPLE)
  }).then(async r => ({ status: r.status, body: await r.json() }));
  check('broadcast returns 201', () => { assert.strictEqual(created.status, 201); });
  const code = created.body.id;
  await sleep(50);

  const accept = await fetch(`${BASE}/api/v1/desk/accept/${code}?hospital=1`, { method: 'POST' })
    .then(async r => ({ status: r.status, body: await r.json() }));
  check('hospital 1 accepts', () => { assert.strictEqual(accept.status, 200); });
  await sleep(50);

  /* Server response must put it in `active[]`, not pending[] or history. */
  const q1 = await fetch(`${BASE}/api/v1/desk/queue?hospital=1`).then(r => r.json());
  check('immediately after accept the case appears in active[]', () => {
    assert.ok(q1.active.some(c => c.case_code === code),
      'Accept must put the case in active[], not Recently Handled');
  });
  check('the case does NOT appear in incoming pending[]', () => {
    assert.strictEqual(q1.pending.some(c => c.case_code === code), false);
  });
  check('the case carries SERVER-derived lifecycle=active', () => {
    const me = q1.active.find(c => c.case_code === code);
    assert.ok(me, 'must be present');
    assert.strictEqual(me.lifecycle, 'active');
    assert.strictEqual(me.status, 'ACCEPTED');
  });

  /* Refresh simulation: hitting /queue again mid-transport must still show
     the case in active[] — the dashboard's initial page load must survive
     a socket outage while the ambulance is travelling. */
  group('Refresh BEFORE arrival — case stays in Active');
  const q2 = await fetch(`${BASE}/api/v1/desk/queue?hospital=1`).then(r => r.json());
  check('refresh keeps case in active[] before arrival', () => {
    assert.ok(q2.active.some(c => c.case_code === code));
    assert.strictEqual(q2.pending.some(c => c.case_code === code), false);
  });

  /* The server stores status ACCEPTED with no arrived_at yet. */
  group('Persistence: arrived_at is NULL before the ambulance arrives');
  const middleware = await fetch(`${BASE}/api/v1/requests/${code}`).then(r => r.json());
  check('status reads ACCEPTED before arrival', () => {
    assert.strictEqual(middleware.status, 'ACCEPTED');
  });
  check('arrived_at is null before arrival', () => {
    assert.ok(middleware.arrived_at === null || middleware.arrived_at === undefined);
  });

  /* ── Phase 2 §12 — ambulance reports arrival  ─────────────────────── */
  group('Phase 2 §27 arrival — move Active → Recently Handled');
  const socket = ioClient(BASE, { query: { role: 'ambulance' }, transports: ['websocket'], forceNew: true });
  await new Promise(resolve => socket.on('connect', resolve));
  socket.emit('case:follow', code);
  await sleep(50);

  const arrivedAck = await new Promise(resolve =>
    socket.emit('ambulance:arrived', { case_code: code, hospital_id: 1 }, resolve)
  );
  check('ambulance:arrived ack is success', () => { assert.ok(arrivedAck && arrivedAck.success); });
  await sleep(80);

  /* After arrival the store must record ARRIVED + arrived_at.
     /queue.active[] must no longer include the case;
     Recent/now we need a fresh /history call but the dashboard merges
     history onto the same hard state, so the lifecycle is "resolved". */
  const q3 = await fetch(`${BASE}/api/v1/desk/queue?hospital=1`).then(r => r.json());
  check('after arrival the case is gone from active[]', () => {
    assert.strictEqual(q3.active.some(c => c.case_code === code), false,
      'Recently Handled = stored state. Stale active[] means the store still says ACCEPTED.');
  });

  /* Refresh AFTER arrival — must NOT bounce back into Active. */
  group('Refresh AFTER arrival — case must NOT bounce to Active');
  const q4 = await fetch(`${BASE}/api/v1/desk/queue?hospital=1`).then(r => r.json());
  check('refresh keeps the case out of active[]', () => {
    assert.strictEqual(q4.active.some(c => c.case_code === code), false);
  });
  const postArrival = await fetch(`${BASE}/api/v1/requests/${code}`).then(r => r.json());
  check('status now reads ARRIVED', () => { assert.strictEqual(postArrival.status, 'ARRIVED'); });
  check('arrived_at is now set', () => {
    assert.ok(postArrival.arrived_at, 'arrived_at must be persisted by the server');
  });

  /* Idempotent arrival — repeating ambulance:arrived must not crash,
     must report success (already: true path is server-side). */
  group('Idempotency — a second ambulance:arrived is a no-op');
  const second = await new Promise(resolve =>
    socket.emit('ambulance:arrived', { case_code: code, hospital_id: 1 }, resolve)
  );
  check('second ambulance:arrived reports success', () => { assert.ok(second && second.success); });

  /* Wrong hospital reports arrival — must be refused. */
  group('Wrong-hospital arrival — refuse');
  const wrong = await new Promise(resolve =>
    socket.emit('ambulance:arrived', { case_code: code, hospital_id: 99 }, resolve)
  );
  check('arrival with wrong hospital_id is refused', () => {
    assert.ok(wrong && wrong.success === false);
    assert.ok(['NOT_ACCEPTED', 'WRONG_HOSPITAL', 'NOT_FOUND'].includes(wrong.reason));
  });

  socket.close();
  server.close();
  console.log('\n' + (failed === 0 ? 'PASS' : 'FAIL') + ` — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.log('\nHARNESS ERROR: ' + (err && err.stack || err));
  process.exit(1);
});
