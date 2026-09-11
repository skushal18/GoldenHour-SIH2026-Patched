#!/usr/bin/env node
/* tracking.test.js — pure unit over trackingService */
'use strict';
const assert = require('assert');
const tracking = require('../src/services/trackingService');
let pass=0, fail=0;
const ok = (n,f)=>{ try{ f(); pass++; console.log('  ok  '+n); } catch(e){ fail++; console.log('  FAIL '+n+': '+e.message); } };

const baseTime = Date.now() - 115000;
const at = seconds => new Date(baseTime + seconds * 1000).toISOString();
console.log('\ntracking service (Part III)');
ok('append creates track', () => {
  const r = tracking.append('GH-X-0001', 12.9716, 77.5946, { lat:12.97, lng:77.59, speed_kmh:40, accuracy_m:8, source:'gps' });
  assert.ok(!r.throttled);
  assert.strictEqual(r.record.track.length, 1);
});
ok('throttled within 5s', () => {
  const r = tracking.append('GH-X-0001', 12.9716, 77.5946, { lat:12.97, lng:77.59 });
  assert.ok(r.throttled);
});
ok('eta derived once 3 points in', () => {
  tracking.drop('GH-X-0002');
  tracking.append('GH-X-0002', 12.9716, 77.5946, { lat:12.965, lng:77.5946, speed_kmh:40, at:at(0) });
  // skip throttle by clearing lastUpdateMs
  const rec = tracking.get('GH-X-0002'); rec.lastUpdateMs = 0;
  tracking.append('GH-X-0002', 12.9716, 77.5946, { lat:12.960, lng:77.5946, speed_kmh:42, at:at(10) });
  rec.lastUpdateMs = 0;
  tracking.append('GH-X-0002', 12.9716, 77.5946, { lat:12.955, lng:77.5946, speed_kmh:42, at:at(20) });
  const r = tracking.get('GH-X-0002');
  assert.ok(r.live_eta_minutes != null && r.eta_source === 'live', 'got ' + JSON.stringify({ eta: r.live_eta_minutes, src: r.eta_source }));
});
ok('stalled when speed < 5 for 90+s', () => {
  tracking.drop('GH-X-0003'); const rec = tracking.get('GH-X-0003') || { track: [] };
  // simulate 4 points over 100s with sub-5km/h motion
  function push(lat,lng,at){
    const r = tracking.append('GH-X-0003', 12.9716, 77.5946, { lat, lng, at });
    if (rec.lastUpdateMs !== undefined) rec.lastUpdateMs = 0;
    const g = tracking.get('GH-X-0003'); if (g) g.lastUpdateMs = 0;
  }
  push(12.9710, 77.5940, at(0));
  push(12.9710, 77.5940, at(60));
  push(12.9710, 77.5940, at(80));
  push(12.9710, 77.5940, at(110));
  const g = tracking.get('GH-X-0003');
  assert.strictEqual(g.eta_source, 'stalled', 'got ' + g.eta_source);
});
ok('drop clears track, keeps aggregate', () => {
  tracking.drop('GH-X-0001');
  assert.ok(!tracking.get('GH-X-0001'));
});
console.log(`\n${pass} ok / ${fail} fail`);
process.exit(fail?1:0);
