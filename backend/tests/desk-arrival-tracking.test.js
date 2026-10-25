'use strict';
/* Signed-in desks (DESK_AUTH=jwt) through arrival and live tracking: hospital
   identity from the login, arrival idempotency, GPS validation, live
   distance/ETA, stale detection, MySQL projection and tracking shutdown. */
const assert = require('assert');
process.env.PORT = '5117'; process.env.DB_DRIVER = 'memory'; process.env.DESK_AUTH = 'jwt';
process.env.DEMO_SEED = 'false'; process.env.BCRYPT_ROUNDS = '4'; process.argv.push('--memory');
const { server } = require('../src/server');
const { io } = require('socket.io-client');
const tracking = require('../src/services/trackingService');
const { toDashboardCard } = require('../src/services/broadcastService');
const { getStore, getAccounts } = require('../src/store');
const authService = require('../src/services/authService');
const audit = require('../src/services/auditService');
const base = 'http://127.0.0.1:5117';
/* Two real directory hospitals; desk "1" and "2" in this test. */
const H = { 1: 12179, 2: 12815 };
const tokens = {};
const req = async (path, method='GET', body, id, extra) => {
 const r = await fetch(base+'/api/v1'+path, { method, headers:{ 'Content-Type':'application/json', ...(id ? {Authorization:'Bearer '+tokens[id]} : {}), ...(extra||{}) }, ...(body ? {body:JSON.stringify(body)} : {}) });
 return {status:r.status, body:await r.json()};
};
let socket;
async function run(){
 await new Promise(r=>server.listening?r():server.once('listening',r));
 for (const k of [1,2]) {
  const acct = await getAccounts().create({ username:'er.test'+k, password_hash: await authService.hashPassword('test desk password '+k), role:'HOSPITAL_STAFF', hospital_id:H[k], must_change_password:false });
  tokens[k] = authService.issueToken(acct);
 }
 const {createMysqlStore} = require('../src/store/mysqlStore');
 const row = {case_code:'MYSQL-CASE',status:'ARRIVED',accepted_hospital_id:1,accepted_at:new Date(),arrived_at:new Date(),payload:JSON.stringify({status:'PENDING',accepted_hospital_id:null,arrived_at:null})};
 const mysql = createMysqlStore({query:async(sql)=>sql.includes('broadcast_targets')?[[]]:[[row]]});
 const hydrated = await mysql.getBroadcast('MYSQL-CASE');
 assert.equal(hydrated.status,'ARRIVED');assert.equal(hydrated.accepted_hospital_id,1);assert.ok(hydrated.arrived_at);
 const created = await req('/requests','POST',{case_type_id:16,age:35,gender:'M',origin:{lat:12.9716,lng:77.5946},broadcast_radius_km:15,eta_minutes:8});
 assert.equal(created.status,201); const code=created.body.id; const crew=created.body.crew_token;
 assert.equal((await req('/desk/accept/'+code,'POST',null,1)).status,200);
 socket=io(base,{transports:['websocket'],forceNew:true});
 await new Promise((resolve,reject)=>{socket.on('connect',resolve);socket.on('connect_error',reject);});
 const emit = payload=>new Promise(resolve=>socket.timeout(3000).emit('ambulance:position',{case_code:code,crew_token:crew,...payload},(err,r)=>resolve(err?{success:false}:r)));
 const bad=await emit({lat:999,lng:77}); assert.equal(bad.reason,'INVALID_COORD');
 assert.equal(tracking.get(code),null);
 let firstDistance;
 for(let i=0;i<3;i++){
  if(tracking.get(code)) tracking.get(code).lastUpdateMs=0;
  const ack=await emit({lat:12.965+i*.001,lng:77.59,accuracy_m:10,at:new Date(Date.now()-(2-i)*10000).toISOString()});
  assert.equal(ack.success,true);
  if(i===0)firstDistance=tracking.snapshot(code).distance_km;
 }
 const q=(await req('/desk/queue','GET',null,1)).body.active.find(x=>x.case_code===code);
 assert.equal(q.track.length,3);assert.equal(q.eta_source,'live');assert.ok(Number.isFinite(q.live_eta_minutes));
 assert.notEqual(q.remaining_distance_km,firstDistance);
 const record=await getStore().getBroadcast(code);
 // A detached record simulates MySQL's fresh object on each read.
 const detached=JSON.parse(JSON.stringify(record));delete detached.last_position;delete detached.live_eta_minutes;
 assert.equal(toDashboardCard(detached,H[1]).track.length,3);
 assert.equal(toDashboardCard(record,H[2]).last_position,null);
 assert.equal((await req('/desk/track/'+code,'GET',null,2)).status,403);
 const fresh=tracking.snapshot(code);const stale=tracking.snapshot(code,Date.now()+31000);
 assert.equal(stale.eta_source,'stale');assert.equal(stale.live_eta_minutes,null);assert.ok(fresh.live_eta_minutes);
 assert.equal((await req('/desk/arrived/'+code,'POST')).status,401);
 assert.equal((await req('/desk/arrived/'+code+'?hospital='+H[1],'POST',{hospital_id:H[1]},2,{'X-Hospital-Id':String(H[1])})).status,403);
 const result=await req('/desk/arrived/'+code,'POST',null,1);
 assert.equal(result.status,200);assert.equal(result.body.status,'ARRIVED');
 assert.equal((await req('/requests/'+code,'GET',null,null,{'X-Crew-Token':crew})).body.status,'ARRIVED');
 assert.equal(tracking.get(code),null);
 assert.equal((await req('/desk/arrived/'+code,'POST',null,1)).body.already,true);
 assert.equal((await req('/desk/arrived/MISSING','POST',null,1)).status,404);
 assert.equal((await emit({lat:12.97,lng:77.59})).reason,'NOT_TRACKING');
 assert.equal(audit.list(code).filter(e=>e.event_type==='ARRIVED').length,1);
 assert.equal(audit.list(code).find(e=>e.event_type==='ARRIVED').performed_by,'desk:'+H[1]);
 assert.equal((await req('/desk/queue','GET',null,1)).body.active.some(x=>x.case_code===code),false);
 console.log('PASS: hospital identity, arrival idempotency, GPS validation, live distance/ETA, stale detection, MySQL projection and tracking shutdown');
}
run().then(()=>{socket?.close();server.close();process.exit(0);}).catch(e=>{console.error(e);socket?.close();server.close();process.exit(1);});
