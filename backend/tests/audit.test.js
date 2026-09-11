#!/usr/bin/env node
'use strict';
const assert = require('assert');
const audit = require('../src/services/auditService');
const tracking = require('../src/services/trackingService');
let pass=0, fail=0;
const ok = (n,f)=>{ try{ f(); pass++; console.log('  ok  '+n); } catch(e){ fail++; console.log('  FAIL '+n+': '+e.message); } };

console.log('\naudit (Part V §4.15)');
audit.reset();
audit.record('GH-X-0001', 'ACCEPTED', { hospital_id:1 }, { kind:'desk', hospital_id:1 });
audit.record('GH-X-0001', 'ARRIVED',   { hospital_id:1 }, { kind:'crew' });

ok('list returns events for case', () => {
  const ev = audit.list('GH-X-0001');
  assert.strictEqual(ev.length, 2);
});
ok('ARRAY is append-only (no update path)', () => {
  audit.reset();
  audit.record('GH-X-0009','ACCEPTED',{},{});
  audit.record('GH-X-0009','ARRIVED',{},{});
  // there is no update method intentionally — a re-record adds a row, never replaces one.
  audit.record('GH-X-0009','CANCELLED',{},{});
  assert.strictEqual(audit.list('GH-X-0009').length, 3);
});
console.log(`\n${pass} ok / ${fail} fail`);
process.exit(fail?1:0);
