#!/usr/bin/env node
/* ============================================================================
   Hospitals: the all-India catalogue (CSV) loads with stable ids and labelled
   locations, and the GoldenHour network (what ambulances are matched to)
   starts as exactly the 100 hospitals in data/hospitals/network_hospitals.csv
   — radius queries over it are right, switched-off hospitals are never
   offered, and the administrator can import more from the catalogue.

   The same network module against a real MySQL hospitals table:
   tests/directory.mysql.test.js.
   ========================================================================== */
'use strict';
const assert = require('assert');
const catalogue = require('../src/services/catalogueService');
const directory = require('../src/services/directoryService');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log('  ok   ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + ': ' + e.message); } };
const okAsync = async (n, f) => { try { await f(); pass++; console.log('  ok   ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + ': ' + e.message); } };

async function main() {
  console.log('\nall-India catalogue (CSV)');
  ok('CSV parser handles quotes, commas and doubled quotes', () => {
    const rows = catalogue.parseCsv('a,b,c\n1,"x, y","say ""hi"""\n2,,\n');
    assert.deepStrictEqual(rows[1], ['1', 'x, y', 'say "hi"']);
    assert.deepStrictEqual(rows[2], ['2', '', '']);
  });

  const n = catalogue.load();
  const s = catalogue.summary();
  ok('the national file loads (tens of thousands of hospitals)', () => assert.ok(n > 25000, 'loaded ' + n));
  ok('every state and UT is present', () => assert.ok(s.states >= 35, s.states + ' states'));
  ok('location grades add up', () => assert.strictEqual(s.location_listed + s.location_pincode + s.location_district + s.no_location, s.records));
  ok('ids are the stable government serial numbers', () => {
    const sj = catalogue.get(12179);
    assert.ok(sj && /St John/i.test(sj.name), 'id 12179 should be St John\'s Medical College Hospital');
    assert.strictEqual(sj.coord_source, 'listed');
  });
  ok('radius search returns only hospitals inside the radius, nearest first', () => {
    const hits = catalogue.nearby(12.9716, 77.5946, 3);
    assert.ok(hits.length > 5, 'central Bengaluru should have hospitals within 3 km');
    for (let i = 0; i < hits.length; i++) {
      assert.ok(hits[i].distance_km <= 3);
      if (i) assert.ok(hits[i].distance_km >= hits[i - 1].distance_km);
    }
  });
  ok('search matches every word, optionally within a state', () => {
    assert.ok(catalogue.search('aiims', { limit: 50 }).length >= 1);
    const ka = catalogue.search('victoria', { state: 'Karnataka' });
    assert.ok(ka.every(h => h.state === 'Karnataka'));
  });
  ok('no row carries personal contact fields from the source', () => {
    const h = catalogue.get(12179);
    ['Nodal_Person_Info', 'Hospital_Primary_Email_Id', 'nodal', 'email'].forEach(k => assert.ok(!(k in h)));
  });

  console.log('\nGoldenHour network (memory store)');
  const ids = catalogue.networkIds();
  const loaded = directory.useMemory();
  ok('the starting network is exactly 100 hospitals, all in the catalogue', () => {
    assert.strictEqual(ids.length, 100);
    assert.strictEqual(new Set(ids).size, 100, 'ids must be unique');
    assert.strictEqual(loaded, 100);
  });
  ok('it always includes St John\'s, Bowring, Victoria and Manipal Old Airport Road', () => {
    [12179, 12815, 11880, 100093].forEach(id => assert.ok(directory.get(id), 'missing ' + id));
  });
  ok('every starting hospital is emergency-capable and has a location', () => {
    directory.list().forEach(h => { assert.ok(h.emergency_likely, h.name); assert.ok(h.lat != null && h.lng != null, h.name); });
  });
  ok('it spans the six cities in the national file', () => {
    const states = directory.states().map(x => x.name);
    ['Karnataka', 'Maharashtra', 'Tamil Nadu', 'West Bengal'].forEach(st => assert.ok(states.includes(st), 'no ' + st));
    assert.ok(states.includes('Telangana') || states.includes('Andhra Pradesh'), 'no Hyderabad');
  });
  ok('a hospital outside the network is not in it', () => assert.strictEqual(directory.get(1), null));
  ok('radius search over the network: central Bengaluru finds St John\'s', () => {
    const hits = directory.nearby(12.9350, 77.6200, 3);
    assert.ok(hits.some(h => h.hospital_id === 12179));
    hits.forEach(h => assert.ok(h.distance_km <= 3));
  });
  ok('a point at sea has no hospitals within 10 km', () => assert.strictEqual(directory.nearby(10.0, 70.0, 10).length, 0));

  await okAsync('a switched-off hospital is never offered, but can still be looked up', async () => {
    await directory.setActive(12179, false);
    assert.ok(!directory.nearby(12.9350, 77.6200, 3).some(h => h.hospital_id === 12179));
    assert.ok(!directory.search('st john').some(h => h.hospital_id === 12179));
    assert.ok(directory.search('st john', { includeInactive: true }).some(h => h.hospital_id === 12179));
    assert.strictEqual(directory.get(12179).active, false);
    await directory.setActive(12179, true);
    assert.ok(directory.nearby(12.9350, 77.6200, 3).some(h => h.hospital_id === 12179));
  });
  await okAsync('the admin imports more hospitals from the catalogue; re-importing changes nothing', async () => {
    const aiims = catalogue.search('all india institute of medical sciences', { limit: 1 })[0] || catalogue.search('aiims', { limit: 1 })[0];
    const first = await directory.importFromCatalogue([aiims.hospital_id, 99999999]);
    assert.deepStrictEqual(first.added, [aiims.hospital_id]);
    assert.deepStrictEqual(first.missing, [99999999]);
    assert.strictEqual(directory.count(), 101);
    const again = await directory.importFromCatalogue([aiims.hospital_id, 12179]);
    assert.deepStrictEqual(again.added, []);
    assert.deepStrictEqual(again.already.sort(), [12179, aiims.hospital_id].sort());
    assert.strictEqual(directory.count(), 101);
  });

  console.log(`\n${pass} ok / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.log('HARNESS ERROR', e); process.exit(1); });
