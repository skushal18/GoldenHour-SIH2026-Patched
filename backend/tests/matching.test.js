#!/usr/bin/env node
'use strict';
const assert = require('assert');
const match = require('../src/services/matchService');
let pass=0, fail=0;
const ok = (n,f)=>{ try{ f(); pass++; console.log('  ok  '+n); } catch(e){ fail++; console.log('  FAIL '+n+': '+e.message); } };

console.log('\nmatching (Part IV §4.10)');
const record = {
  case_category: 'STROKE', critical_flags: { low_gcs:true, hypoxia:true, shock:false },
  patient:{}, targets:[]
};

ok('closer wins over farther', () => {
  const near = { hospital_id:1, distance_km:1 }, far = { hospital_id:2, distance_km:14 };
  const s1 = match.scoreFor(record, near, null);
  const s2 = match.scoreFor(record, far, null);
  assert.ok(s1 > s2, 'near '+s1+' far '+s2);
});
ok('no-ventilator costs 25 when needed', () => {
  const hs = { hospital_id:1, distance_km:3 };
  const capOK     = { ventilators_available:2 };
  const capNoVent = { ventilators_available:0 };
  const okScore    = match.scoreFor(record, hs, capOK);
  const noVentScore= match.scoreFor(record, hs, capNoVent);
  assert.ok(noVentScore < okScore, 'ok='+okScore+' novent='+noVentScore);
});
ok('diversion cost 40', () => {
  const hs = { hospital_id:1, distance_km:3 };
  const okCap = { ventilators_available:2, ct_available:true, blood_available:true, ot_available:true, cathlab_available:true };
  const divCap = Object.assign({}, okCap, { diversion_active:true });
  const sOk = match.scoreFor(record, hs, okCap);
  const sDiv = match.scoreFor(record, hs, divCap);
  assert.ok(sDiv < sOk - 30, 'ok='+sOk+' div='+sDiv);
});
ok('unknown capacity penalises but does not zero the score', () => {
  const hs = { hospital_id:1, distance_km:5 };
  const s = match.scoreFor(record, hs, null);
  assert.ok(s > 20 && s < 95, 'got '+s);
});
ok('reasons are human-readable', () => {
  const rs = match.reasonsFor(record, { hospital_id:1, distance_km:4 }, { ventilators_available:0, diversion_active:false, ct_available:true, blood_available:true, ot_available:true, cathlab_available:true });
  assert.ok(rs.includes('no ventilator available'));
  assert.ok(rs.includes('4.0 km away'));
});
console.log(`\n${pass} ok / ${fail} fail`);
process.exit(fail?1:0);
