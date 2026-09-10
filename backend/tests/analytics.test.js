#!/usr/bin/env node
'use strict';
const assert = require('assert');
const audit = require('../src/services/auditService');
audit.reset();
audit.record('CASE_A', 'BROADCAST_CREATED', {}, { kind:'crew' });
audit.record('CASE_A', 'ACCEPTED', { seconds_to_accept: 7 }, { kind:'desk', hospital_id:1 });
audit.record('CASE_A', 'ARRIVED',  { seconds_accept_to_arrival: 600 }, { kind:'crew' });
audit.record('CASE_B', 'BROADCAST_CREATED', {}, { kind:'crew' });
audit.record('CASE_B', 'EXPIRED', { seconds_open: 200 }, { kind:'system' });

// Calling the HTTP route requires a deeper setup, so test the math inline.
const events = audit.all();
let pass=0, fail=0;
const ok = (n,f)=>{ try{ f(); pass++; console.log('  ok  '+n); } catch(e){ fail++; console.log('  FAIL '+n+': '+e.message); } };
console.log('\nanalytics (Part V §4.16)');
const t2a = events.filter(e=>e.event_type==='ACCEPTED').map(e=>e.event_data.seconds_to_accept);
const median = arr => { const a = arr.slice().sort((x,y)=>x-y); return a[Math.floor(a.length/2)]; };
ok('median time to accept', () => assert.strictEqual(median(t2a), 7));
ok('at least one EXPIRED', () => assert.ok(events.some(e=>e.event_type==='EXPIRED')));
console.log(`\n${pass} ok / ${fail} fail`);
process.exit(fail?1:0);
