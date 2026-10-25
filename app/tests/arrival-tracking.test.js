const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readModule = p => import('data:text/javascript;base64,'+fs.readFileSync(path.join(__dirname,p)).toString('base64'));
(async()=>{
 const {recordArrival}=await readModule('../src/modules/arrival.js');
 const opts={apiRoot:'https://test.invalid/api/v1',caseCode:'GH-TEST',timeoutMs:5};
 for(const status of [404,409,500]) await assert.rejects(recordArrival({...opts,fetch:async()=>({ok:false,json:async()=>({success:false})})}));
 await assert.rejects(recordArrival({...opts,socket:{connected:true,emit:(e,p,ack)=>ack({success:false})}}));
 const good=async()=>({ok:true,json:async()=>({success:true,status:'ARRIVED'})});
 assert.equal((await recordArrival({...opts,socket:{connected:true,emit:()=>{}},fetch:good})).status,'ARRIVED');
 assert.equal((await recordArrival({...opts,socket:{connected:true,emit:(e,p,ack)=>ack({success:true})}})).success,true);
 const {watchPosition}=await readModule('../src/modules/position-watch.js');
 let resolveWatch, cleared=[], updates=0;
 const plugin={requestPermissions:async()=>({location:'granted'}),watchPosition:()=>new Promise(r=>resolveWatch=r),clearWatch:async({id})=>cleared.push(id)};
 const stop=watchPosition({native:true,plugin,onPosition:()=>updates++,onError:e=>{throw e;}});
 await new Promise(r=>setTimeout(r,0));stop();resolveWatch('native-123');await new Promise(r=>setTimeout(r,0));
 assert.deepEqual(cleared,['native-123']);
 let callback;const stopBrowser=watchPosition({native:false,geolocation:{watchPosition:f=>{callback=f;return 42;},clearWatch:id=>cleared.push(id)},onPosition:()=>updates++,onError:e=>{throw e;}});
 callback({});stopBrowser();callback({});assert.equal(updates,1);assert.equal(cleared[1],42);
 /* The crew token rides on both the socket event and the HTTP fallback. */
 let sent=null, hdr=null;
 await recordArrival({...opts,crewToken:'tok-123',socket:{connected:true,emit:(e,p,ack)=>{sent=p;ack({success:true});}}});
 assert.equal(sent.crew_token,'tok-123');
 await recordArrival({...opts,crewToken:'tok-123',fetch:async(u,o)=>{hdr=o.headers;return {ok:true,json:async()=>({success:true,status:'ARRIVED'})};}});
 assert.equal(hdr['X-Crew-Token'],'tok-123');
 console.log('PASS: arrival failure/timeout handling, crew token on socket and HTTP, native and browser watch cancellation');
})().catch(e=>{console.error(e);process.exitCode=1;});
