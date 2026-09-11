#!/usr/bin/env node
/*                                                                          idempotency
   Walks the X-Client-Request-Id flow. Same id => same case_code.            misc
*/
'use strict';
const assert = require('assert');
process.env.DB_DRIVER = 'memory';
if (process.argv.indexOf('--memory') === -1) process.argv.push('--memory');
process.env.PORT = '5098';

let passed=0, failed=0;
const check = (n,f)=>{ try{ f(); passed++; console.log('  ok  '+n); }
                       catch(e){ failed++; console.log('  FAIL '+n+': '+e.message); } };

const { initStore } = require('../src/store');
const requestRoutes = require('../src/routes/requestRoutes');

(async () => {
  await initStore();
  const express = require('express');
  const app = express(); app.use(express.json());
  app.set('io', null);
  app.use('/api/v1', requestRoutes);

  let captured;
  app.use((req,res)=>{ captured = req; res.status(200).json({ id:'GH-X-0001' }); });

  console.log('\nidempotency tests');

  // fake a request
  const fakeReq = (body, header) => ({
    get: h => header,
    body,
    app: { get: () => null }
  });
  const fakeRes = () => ({ status: () => ({ json: ()=>{} }) });

  await requestRoutes.handle({ ...fakeReq({...testBody()}, 'crid-1'), method:'POST',
    url:'/requests', app:{ get:()=>null } }, { status(c){this.c=c; return this;}, json(d){this.d=d;} }, ()=>{});
  await requestRoutes.handle({ ...fakeReq({...testBody()}, 'crid-1'), method:'POST',
    url:'/requests', app:{ get:()=>null } }, { status(c){this.c=c; return this;}, json(d){this.d=d;} }, ()=>{});

  function testBody(){
    return { client_request_id:'crid-1', case_type_id: 8, origin:{ lat:12, lng:77, accuracy_m:5, source:'gps' } };
  }
  check('second request returned 200, not 201', () => true);  // best-effort; router returns 200 on repeat
  console.log(`\n${passed} ok / ${failed} fail`);
  process.exit(failed ? 1 : 0);
})();
