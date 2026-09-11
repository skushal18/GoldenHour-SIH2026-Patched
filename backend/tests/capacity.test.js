#!/usr/bin/env node
'use strict';
const assert = require('assert');
const cap = require('../src/services/capacityService');
let pass=0, fail=0;
const ok = (n,f)=>{ try{ f(); pass++; console.log('  ok  '+n); } catch(e){ fail++; console.log('  FAIL '+n+': '+e.message); } };

console.log('\ncapacity service (Part IV)');
cap.upsert(1, { resus_bays_available: 3, ventilators_available: 1 });
cap.upsert(2, { resus_bays_available: 0, ventilators_available: 0, diversion_active: true });

ok('upsert persists', () => {
  const c = cap.get(1); assert.ok(c.resus_bays_available === 3);
  assert.ok(c.updated_at);
});
ok('minutesSince returns age', () => {
  assert.ok(Number.isFinite(cap.minutesSince(cap.get(1).updated_at)));
});
ok('sticky diversion', () => {
  assert.strictEqual(cap.get(2).diversion_active, true);
});
ok('all() returns both hospitals', () => {
  const all = cap.all(); assert.ok(all.length >= 2);
});
console.log(`\n${pass} ok / ${fail} fail`);
process.exit(fail?1:0);
