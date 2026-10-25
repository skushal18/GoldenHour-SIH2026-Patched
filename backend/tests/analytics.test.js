#!/usr/bin/env node
/* ============================================================================
   /desk/analytics through the real route: "hospital" scope counts only cases
   offered to this hospital and its own accepts; "network" counts everything.
   (The route used to compute a hospital filter and then ignore it, so both
   scopes returned network-wide figures — and the old test re-implemented a
   median inline instead of calling the route, so it could not notice.)
   ========================================================================== */
'use strict';
const assert = require('assert');
process.env.PORT = process.env.TEST_PORT_AN || '5104';
process.env.DB_DRIVER = 'memory';
process.env.DESK_AUTH = 'ip';
process.env.DEMO_SEED = 'false';
process.env.ACCOUNT_SEED_FILE = '/nonexistent/no-seed.json';   // isolate from backend/seed
process.env.HACKATHON_MODE = 'false';     // real radius matching between the two demo laptops
if (process.argv.indexOf('--memory') === -1) process.argv.push('--memory');

const { server } = require('../src/server');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
let passed = 0, failed = 0;
async function check(n, f) { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + ': ' + e.message); } }
const json = r => r.json();

/* Demo laptops: #1 City Emergency (12.9716, 77.5946), #2 Apollo (12.9121, 77.5956) — ~6.6 km apart. */
function cast(lat, lng, radius) {
  return fetch(BASE + '/api/v1/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ case_type_id: 8, origin: { lat, lng, source: 'gps' }, broadcast_radius_km: radius }) }).then(json);
}
const accept = (code, h) => fetch(`${BASE}/api/v1/desk/accept/${code}?hospital=${h}`, { method: 'POST' }).then(json);
const analytics = (h, scope) => fetch(`${BASE}/api/v1/desk/analytics?scope=${scope}&hospital=${h}`).then(json);

(async () => {
  await new Promise(r => server.listening ? r() : server.once('listening', r));
  console.log('\nanalytics (HTTP)');
  const onlyOne = await cast(12.9716, 77.5946, 2);     // reaches #1 only
  const onlyTwo = await cast(12.9121, 77.5956, 2);     // reaches #2 only
  const both = await cast(12.9420, 77.5950, 5);        // between them: both
  await accept(onlyOne.id, 1);
  await accept(onlyTwo.id, 2);
  await accept(both.id, 2);

  const h1 = await analytics(1, 'hospital');
  const h2 = await analytics(2, 'hospital');
  const net = await analytics(1, 'network');
  await check('the setup reached the right hospitals', () => {
    assert.strictEqual(onlyOne.hospitals_notified, 1);
    assert.strictEqual(onlyTwo.hospitals_notified, 1);
    assert.strictEqual(both.hospitals_notified, 2);
  });
  await check('hospital scope counts only cases offered to that hospital', () => {
    assert.strictEqual(h1.counts.created, 2);    // onlyOne + both
    assert.strictEqual(h2.counts.created, 2);    // onlyTwo + both
  });
  await check('hospital scope counts only its own accepts', () => {
    assert.strictEqual(h1.counts.accepted, 1);
    assert.strictEqual(h2.counts.accepted, 2);
  });
  await check('network scope counts every case', () => {
    assert.strictEqual(net.counts.created, 3);
    assert.strictEqual(net.counts.accepted, 3);
  });
  await check('time-to-accept has one sample per own accept', () => {
    assert.strictEqual(h2.counts.time_to_accept_samples, 2);
    assert.ok(typeof h2.time_to_accept.median === 'number');
  });
  await check('the store is reported so a reader knows if figures reset', () => assert.strictEqual(h1.store, 'memory'));
  server.close();
  console.log(`\n${passed} ok / ${failed} fail`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
