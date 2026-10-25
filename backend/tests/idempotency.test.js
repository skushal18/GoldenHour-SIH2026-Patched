#!/usr/bin/env node
/* ============================================================================
   X-Client-Request-Id against the real HTTP route.

   The ambulance app's offline outbox can send the same case twice ("flush on
   online" and "flush on socket connect" can fire together). The same id must
   create one case, return it again with 200 and the same crew token, and a
   different id must create a different case. (This file used to contain a
   single check whose body was `() => true`.)
   ========================================================================== */
'use strict';
const assert = require('assert');
process.env.PORT = process.env.TEST_PORT_IDEM || '5098';
process.env.DB_DRIVER = 'memory';
process.env.DESK_AUTH = 'ip';
process.env.DEMO_SEED = 'false';
if (process.argv.indexOf('--memory') === -1) process.argv.push('--memory');

const { server } = require('../src/server');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
let passed = 0, failed = 0;
async function check(n, f) { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + ': ' + e.message); } }

const BODY = { case_type_id: 8, age: 50, gender: 'M', origin: { lat: 12.9716, lng: 77.5946, accuracy_m: 10, source: 'gps' } };
function post(crid, body) {
  return fetch(BASE + '/api/v1/requests', {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, crid ? { 'X-Client-Request-Id': crid } : {}),
    body: JSON.stringify(body || BODY),
  }).then(async r => ({ status: r.status, body: await r.json() }));
}

(async () => {
  await new Promise(r => server.listening ? r() : server.once('listening', r));
  console.log('\nidempotency (HTTP)');
  const first = await post('crid-1');
  const again = await post('crid-1');
  const other = await post('crid-2');
  const none1 = await post(null), none2 = await post(null);

  await check('the first request creates the case (201)', () => assert.strictEqual(first.status, 201));
  await check('a repeat with the same id creates nothing (200, same case)', () => {
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.id, first.body.id);
    assert.strictEqual(again.body.idempotent_replay, true);
  });
  await check('the repeat hands back the same crew token', () => assert.strictEqual(again.body.crew_token, first.body.crew_token));
  await check('a different id is a different case', () => {
    assert.strictEqual(other.status, 201);
    assert.notStrictEqual(other.body.id, first.body.id);
    assert.notStrictEqual(other.body.crew_token, first.body.crew_token);
  });
  await check('requests without an id are never merged', () => {
    assert.strictEqual(none1.status, 201); assert.strictEqual(none2.status, 201);
    assert.notStrictEqual(none1.body.id, none2.body.id);
  });
  const status = await fetch(BASE + '/api/v1/requests/' + first.body.id, { headers: { 'X-Crew-Token': again.body.crew_token } });
  await check('the replayed token opens the case', () => assert.strictEqual(status.status, 200));

  server.close();
  console.log(`\n${passed} ok / ${failed} fail`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
