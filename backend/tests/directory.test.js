#!/usr/bin/env node
/* ============================================================================
   The all-India hospital directory: the data file loads, ids are stable and
   unique, radius queries are right, and approximate locations stay labelled.
   ========================================================================== */
'use strict';
const assert = require('assert');
const directory = require('../src/services/directoryService');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log('  ok   ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + ': ' + e.message); } };

console.log('\nhospital directory');
ok('CSV parser handles quotes, commas and doubled quotes', () => {
  const rows = directory.parseCsv('a,b,c\n1,"x, y","say ""hi"""\n2,,\n');
  assert.deepStrictEqual(rows[1], ['1', 'x, y', 'say "hi"']);
  assert.deepStrictEqual(rows[2], ['2', '', '']);
});

const n = directory.load();
const s = directory.summary();
ok('the national file loads (tens of thousands of hospitals)', () => assert.ok(n > 25000, 'loaded ' + n));
ok('every state and UT is present', () => assert.ok(s.states >= 35, s.states + ' states'));
ok('location grades add up', () => assert.strictEqual(s.location_listed + s.location_pincode + s.location_district + s.no_location, s.records));
ok('ids are the stable government serial numbers', () => {
  const sj = directory.get(12179);
  assert.ok(sj && /St John/i.test(sj.name), 'id 12179 should be St John\'s Medical College Hospital');
  assert.strictEqual(sj.coord_source, 'listed');
});
ok('radius search returns only hospitals inside the radius, nearest first', () => {
  const hits = directory.nearby(12.9716, 77.5946, 3);
  assert.ok(hits.length > 5, 'central Bengaluru should have hospitals within 3 km');
  for (let i = 0; i < hits.length; i++) {
    assert.ok(hits[i].distance_km <= 3);
    if (i) assert.ok(hits[i].distance_km >= hits[i - 1].distance_km);
  }
});
ok('a point at sea has no hospitals within 10 km', () => assert.strictEqual(directory.nearby(10.0, 70.0, 10).length, 0));
ok('emergency-only filter and limit work', () => {
  const hits = directory.nearby(19.0760, 72.8777, 10, { emergencyOnly: true, limit: 5 });
  assert.ok(hits.length > 0 && hits.length <= 5);
  assert.ok(hits.every(h => h.emergency_likely));
});
ok('search matches every word, optionally within a state', () => {
  const hits = directory.search('aiims', { limit: 50 });
  assert.ok(hits.length >= 1);
  const ka = directory.search('victoria', { state: 'Karnataka' });
  assert.ok(ka.every(h => h.state === 'Karnataka'));
});
ok('no row carries personal contact fields from the source', () => {
  const h = directory.get(12179);
  ['Nodal_Person_Info', 'Hospital_Primary_Email_Id', 'nodal', 'email'].forEach(k => assert.ok(!(k in h)));
});

console.log(`\n${pass} ok / ${fail} fail`);
process.exit(fail ? 1 : 0);
