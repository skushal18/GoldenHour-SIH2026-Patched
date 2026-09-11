const assert=require('assert'), fs=require('fs'), path=require('path');
const {JSDOM,VirtualConsole}=require('jsdom');
const root=path.join(__dirname,'../../backend/public/hospital');
const delay=()=>new Promise(r=>setTimeout(r,10));
(async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{url:'https://desk.test/hospital/?hospital=1',runScripts:'outside-only',virtualConsole:new VirtualConsole()});
 const w=dom.window; let mode='404', calls=0, interval;
 const card={case_code:'GH-TEST',status:'ACCEPTED',priority:'GREEN',patient:{},notes:'',eta_minutes:8,accepted_hospital_id:1,accepted_at:new Date().toISOString(),distance_km:2,track:[]};
 w.confirm=()=>true;w.setInterval=fn=>{interval=fn;return 1;};
 w.fetch=async(url,opts)=>{
  if(url.includes('/desk/arrived/')){
   calls++;assert.ok(url.endsWith('/desk/arrived/GH-TEST?hospital=1'));
   if(mode==='offline')throw new Error('offline');
   return {ok:mode==='success',json:async()=>mode==='success'?{success:true,status:'ARRIVED',arrived_at:new Date().toISOString()}:{success:false,reason:'NOT_FOUND'}};
  }
  return {ok:true,json:async()=>url.includes('/desk/me')?{hospital:{hospital_id:1,name:'Test ER'},capacity:{}}:url.includes('/desk/queue')?{pending:[],active:[{...card}]}:{capacity:[]}};
 };
 w.eval(fs.readFileSync(path.join(root,'dashboard.js'),'utf8'));await delay();
 const toggle=()=>w.document.querySelector('[role="switch"]');
 assert.ok(toggle().textContent.includes('Arrived at hospital'));assert.equal(toggle().getAttribute('aria-checked'),'false');
 toggle().click();toggle().click();await delay();assert.equal(calls,1);assert.equal(toggle().getAttribute('aria-checked'),'false');
 mode='offline';toggle().click();await delay();assert.equal(toggle().getAttribute('aria-checked'),'false');assert.equal(toggle().disabled,false);
 mode='success';toggle().click();await delay();assert.equal(toggle().getAttribute('aria-checked'),'true');assert.equal(toggle().disabled,true);
 assert.equal(w.document.getElementById('cntActive').textContent,'0');
 await interval();assert.equal(toggle().getAttribute('aria-checked'),'true','a delayed queue must not resurrect an arrived case');
 dom.window.close();console.log('PASS: dashboard arrival switch, 404/offline handling, duplicate clicks and delayed queue race');
})().catch(e=>{console.error(e);process.exitCode=1;});
