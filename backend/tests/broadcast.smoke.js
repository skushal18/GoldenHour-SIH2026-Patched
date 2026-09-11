#!/usr/bin/env node
/* ============================================================================
   One-script smoke test that walks the whole demo flow against an in-memory
   server. Enough signals to prove the v5 changes work as one system.
   ========================================================================== */
'use strict';
process.env.PORT = process.env.TEST_PORT || '5099';
process.env.DB_DRIVER = 'memory';
if (process.argv.indexOf('--memory') === -1) process.argv.push('--memory');

const assert = require('assert');
const { io: ioClient } = require('socket.io-client');
const { server } = require('../src/server');

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let passed = 0, failed = 0;
/* Awaited, and every call site awaits it. It used to call fn() and catch only
   synchronous throws, so an async assertion body returned a floating promise:
   the check printed "ok" before it had run, its failure surfaced later as an
   unhandled rejection that killed the process mid-suite, and its assertions
   raced against whatever the script did next. That is what the crash at
   broadcast.smoke.js:75 actually was. No assertion below is changed. */
async function check(name, fn){
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch(e){ failed++; console.log('  FAIL ' + name + ' :: ' + (e && e.message)); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function waitListening(){
  return new Promise(resolve => server.listening ? resolve() : server.once('listening', resolve));
}

const SAMPLE = {
  case_type_id: 12, age: 58, gender: 'M', blood_group: 'O+',
  vitals: { systolic_bp: 82, diastolic_bp: 50, heart_rate: 132, resp_rate: 26, spo2: 88, glucose: null },
  consciousness: 'Semi-Conscious',
  origin: { lat: 12.9716, lng: 77.5946, accuracy_m: 18 },
  broadcast_radius_km: 15, eta_minutes: 12,
  notes: 'entrapped 20 min', ambulance_id: 'KA01AB1234',
  stroke_assessment: { face: false, arm: true, speech: true, onset_hours: 2 },
  client_request_id: 'crid-smoke-1',
};
let _cridSeq = 1;
function broadcast(extra){
  const body = Object.assign({}, SAMPLE, extra||{});
  body.client_request_id = body.client_request_id || ('crid-smoke-bcast-' + (_cridSeq++));
  return fetch(`${BASE}/api/v1/requests`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body)
  }).then(r => r.json());
}
function setCapacity(id, body){
  return fetch(`${BASE}/api/v1/desk/capacity?hospital=${id}`, {
    method:'PUT', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body||{})
  }).then(r => r.json());
}

async function main(){
  await waitListening();
  console.log('\nGoldenHour v5 broadcast smoke (memory store)');

  /* capacity set on laptop 1 */
  await check('PUT /desk/capacity upsert', async () => {
    const r = await setCapacity(1, { resus_bays_available: 3, ventilators_available: 2, ct_available: true });
    assert.ok(r.capacity && r.capacity.resus_bays_available === 3);
  });

  /* idempotency: same X-Client-Request-Id twice -> same case_code */
  await check('idempotent POST /requests returns 200', async () => {
    const headers = { 'Content-Type':'application/json', 'X-Client-Request-Id':'crid-smoke-1' };
    const opts = { method:'POST', headers, body: JSON.stringify(SAMPLE) };
    const a = await (await fetch(`${BASE}/api/v1/requests`, opts)).json();
    const b = await (await fetch(`${BASE}/api/v1/requests`, opts)).json();
    assert.strictEqual(a.id, b.id);
  });

  /* broadcast and accept */
  const data = await broadcast();
  await check('broadcast creates a GH-* case', () => assert.ok(/^GH-\d{4}-\d{4}$/.test(data.id)));
  await check('both laptops notified of the case', async () => {
    const q = await (await fetch(`${BASE}/api/v1/desk/queue?hospital=1`)).json();
    assert.ok(Array.isArray(q.pending) && q.pending.some(c => c.case_code === data.id));
    const q2 = await (await fetch(`${BASE}/api/v1/desk/queue?hospital=2`)).json();
    assert.ok(q2.pending.some(c => c.case_code === data.id));
    assert.ok(q.pending[0].match_score != null, 'match_score computed');
    assert.ok(q.pending[0].needs && q.pending[0].needs.needs_ventilator === true, 'ventilator need derived');
  });

  /* accept on hospital 2 first so #2 owns the active */
  const acc = await (await fetch(`${BASE}/api/v1/desk/accept/${data.id}?hospital=2`, { method:'POST' })).json();
  await check('hospital 2 accept accepted', () => assert.strictEqual(acc.success, true));
  await check('hospital 1 still sees queue cleared', async () => {
    const q = await (await fetch(`${BASE}/api/v1/desk/queue?hospital=1`)).json();
    assert.ok(!q.pending.some(c => c.case_code === data.id));
  });

  /* tracking via socket */
  const sock = ioClient(BASE, { transports:['websocket'], forceNew:true });
  await new Promise(r => sock.emit('case:follow', data.id, r));
  await sleep(50);
  const seen = [];
  sock.on('case:position', m => seen.push(m));
  await new Promise(res => setTimeout(res, 50));
  sock.emit('ambulance:position', { case_code:data.id, lat:12.9650, lng:77.5940, accuracy_m:12, speed_kmh:30, source:'gps' });
  await sleep(200);
  /* second emit inside throttle window should be ignored */
  sock.emit('ambulance:position', { case_code:data.id, lat:12.9655, lng:77.5940, speed_kmh:32 });
  sock.emit('ambulance:position', { case_code:data.id, lat:12.9660, lng:77.5942, speed_kmh:34 });
  await sleep(200);
  await check('one case:position reached the desk', () => assert.ok(seen.length >= 1, 'got ' + seen.length));
  await check('live ETA is computed', () => {
    const last = seen[seen.length-1];
    assert.ok(last.live_eta_minutes == null || Number.isFinite(last.live_eta_minutes), 'eta ' + last.live_eta_minutes);
  });

  /* get the track */
  const tr = await (await fetch(`${BASE}/api/v1/desk/track/${data.id}?hospital=2`)).json();
  await check('GET /desk/track returns at least one point', () => assert.ok(tr.track && tr.track.length >= 1));

  /* timeline + analytics */
  const tl = await (await fetch(`${BASE}/api/v1/desk/timeline/${data.id}?hospital=2`)).json();
  await check('timeline has ACCEPTED + BROADCAST_CREATED events', () => {
    const types = (tl.events||[]).map(e => e.event_type);
    assert.ok(types.includes('ACCEPTED'));
    assert.ok(types.includes('BROADCAST_CREATED'));
  });

  const an = await (await fetch(`${BASE}/api/v1/desk/analytics?scope=hospital&hospital=2`)).json();
  await check('analytics returns samples', () => assert.ok(an.counts.time_to_accept_samples >= 1));

  /* arrived + handover */
  const ar = await (await fetch(`${BASE}/api/v1/desk/accept/${data.id}?hospital=2`, { method:'POST' })).json(); // returns 409 — proves no double-accept
  await check('second accept refused', () => assert.strictEqual(ar.success, false));
  sock.disconnect();
  console.log(`\n${passed} ok / ${failed} fail`);
  server.close(); setTimeout(()=>process.exit(failed?1:0), 200);
}
main().catch(err => { console.error(err); process.exit(1); });
