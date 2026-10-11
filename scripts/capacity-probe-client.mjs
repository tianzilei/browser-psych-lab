// External HTTPS load client; never points at the production API/database.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
const fixture=JSON.parse(await readFile('.local/capacity-fixture.json','utf8'));
const origin='https://example.invalid',base=origin+'/__capacity_probe__';
const digest=v=>createHash('sha256').update(v).digest('hex'),delay=ms=>new Promise(r=>setTimeout(r,ms));
let cookie='',csrf='',metrics=[],retries=[],members=[];
const output=process.argv[2]??'.local/ecs-capacity.json';
async function call(path,data,c=cookie,admin=true){
  const started=performance.now();
  for(let attempt=0;;attempt++){
    const response=await fetch(base+path,{method:data===undefined?'GET':'POST',headers:{Origin:origin,Cookie:c,...(admin?{'X-CSRF-Token':csrf}:{}),...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)}),signal:AbortSignal.timeout(45000)});
    const value=await response.json();
    if([429,503].includes(response.status)&&attempt<100&&performance.now()-started<90000){retries.push({path,code:value.code});await delay(value.code==='MAINTENANCE_BUSY'?150+Math.random()*300:300+Math.random()*500);continue;}
    metrics.push({path,ms:performance.now()-started,status:response.status});
    if(!response.ok)throw new Error(`${path}: ${response.status} ${value.code}`);
    return {value,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
}
const login=await call('/api/auth/login',{password:fixture.password},'',false);cookie=login.cookie;csrf=login.value.csrf;
const assetMap=new Map(fixture.assets.map(a=>[a.asset_id,a]));
async function create(){
  const created=await call('/api/participate/sessions',{request_id:randomUUID(),version_id:fixture.version.version_id,credential:digest(randomUUID())},'',false);
  const sid=created.value.session_id,c=created.cookie,path=`/api/participate/sessions/${sid}`;
  const member={sid,path,c},run=async(op,data)=>(await call(`${path}/${op}`,data,c,false)).value;member.run=run;members.push(member);
  await run('admission',{action:'join',ticket_id:randomUUID()});
  const writer_id=randomUUID(),session=await run('claim',{request_id:randomUUID(),writer_id}),fence={writer_id,writer_epoch:session.writer_epoch};member.fence=fence;member.session=session;
  const reservation=await run('reserve',{request_id:randomUUID(),...fence});member.reservation=reservation;
  const ticket_id=randomUUID();await run('preparation',{action:'join',ticket_id,...fence});
  const started=performance.now();let bytes=0;
  for(const root of reservation.selection.roots){const asset=assetMap.get(root.asset_id);
    for(let attempt=0;;attempt++){
      const response=await fetch(`${base}${path}/assets/${root.asset_id}`,{headers:{Cookie:c,'X-Preparation-Ticket':ticket_id,'X-Writer-Id':writer_id,'X-Writer-Epoch':String(session.writer_epoch)},signal:AbortSignal.timeout(120000)});
      if([429,503].includes(response.status)&&attempt<100){const value=await response.json();retries.push({path:'/assets',code:value.code});await delay(300+Math.random()*500);continue;}
      if(!response.ok)throw new Error(`asset HTTP ${response.status}`);
      const data=Buffer.from(await response.arrayBuffer());if(data.length!==asset.bytes||digest(data)!==asset.hash)throw new Error('IMAGE_HASH_MISMATCH');bytes+=data.length;break;
    }
  }
  member.preparation_ms=performance.now()-started;member.image_bytes=bytes;
  await run('preparation',{action:'release',ticket_id});
  const choices=session.frozen.protocol.groups[0].choices;
  member.permit=await run('permit',{request_id:randomUUID(),...fence,reservation_id:reservation.reservation_id,readiness:{frame_ms:1000/60,commit_ms:5,protocol_hash:fixture.version.hash,layout:'portrait',assets:Object.fromEntries(reservation.selection.roots.map(t=>[t.asset_id,assetMap.get(t.asset_id).hash])),geometry:{viewport:{width:390,height:844,dpr:1},canvas:{x:0,y:0,width:300,height:300/session.frozen.protocol.layout.aspect},buttons:choices.map((choice,i)=>({choice,x:i*40,y:600,width:40,height:48}))}}});
  return member;
}
function evidence(member){
  const plan=member.permit.plan,records=[];let at=plan.start;
  for(const root of plan.roots){const id=root.root_id+':1';records.push({type:'RATING_INTENT',at:at-1,instance_id:id},{type:'ONSET',at,draw_time:at,raf_time:at,instance_id:id});
    const count=plan.rating.items.length;for(let item=0;item<count;item++)records.push({type:'RATING_CHANGE',at:at+200+item*1000,instance_id:id,item,value:5});
    at+=10000;records.push({type:'RATING',at,draw_time:at,raf_time:at,input_time:at-1,instance_id:id,values:[...Array(count).fill(5),40]});at+=root.isi_ms;records.push({type:'END',at,instance_id:id});at+=10;
  }
  records.push({type:'CLOSING',at,unresolved:false});
  const rows=records.map((record,sequence)=>{const event={event_schema_version:'lab-events-v1',event_id:randomUUID(),session_id:member.sid,version_id:fixture.version.version_id,protocol_hash:fixture.version.hash,...member.fence,scope:plan.scope,sequence,previous:null,clock_epoch:'capacity-synthetic',time_ms:record.at,kind:'GROUP_RECORD',payload:{record}};return {event,sequence};});
  let previous=null;const wire=rows.map(({event})=>{event.previous=previous;const raw=JSON.stringify(event),row={event_id:event.event_id,hash:digest(raw),raw};previous={event_id:row.event_id,hash:row.hash};return row;});
  const diagnostics=[];
  for(let chunk=0;chunk<80;chunk++){
    const samples=Array.from({length:64},(_,i)=>({type:'pointermove',at:chunk*100+i,raw_timestamp:chunk*100+i,rt_ms:i,context:{instance_id:plan.roots[chunk%32].root_id+':1',item:chunk%6,phase:'rating',asset_id:plan.roots[chunk%32].asset_id},target:'#rating-axis',box:{x:16,y:680,width:358,height:48},x:30+i*4,y:700,pointer_id:1,pointer_type:'touch',button:0,buttons:1,pressure:.5,trusted:false}));
    const event={event_schema_version:'lab-events-v1',event_id:randomUUID(),session_id:member.sid,version_id:fixture.version.version_id,protocol_hash:fixture.version.hash,...member.fence,scope:`d-ui-capacity-${chunk}`,sequence:0,previous:null,clock_epoch:'capacity-synthetic',time_ms:chunk*100,kind:'INPUT_DIAGNOSTIC',payload:{interaction:{schema:'interaction-v1',time_origin:Date.now(),samples}}};const raw=JSON.stringify(event);diagnostics.push({event_id:event.event_id,hash:digest(raw),raw});
  }
  return {wire,diagnostics};
}
const percentile=(v,q)=>[...v].sort((a,b)=>a-b)[Math.max(0,Math.ceil(v.length*q)-1)]??0;
async function wave(concurrency){
  metrics=[];retries=[];members=[];const started=performance.now();console.log(JSON.stringify({stage:'wave-start',concurrency}));
  const errors=[];const users=await Promise.allSettled(Array.from({length:concurrency},create));
  for(const result of users)if(result.status==='rejected')errors.push(String(result.reason));
  const prepared=users.filter(r=>r.status==='fulfilled').map(r=>r.value);
  console.log(JSON.stringify({stage:'download-complete',concurrency,prepared:prepared.length,elapsed_ms:performance.now()-started}));
  const results=await Promise.allSettled(prepared.map(async member=>{
    const {wire,diagnostics}=evidence(member);member.raw_bytes=[...wire,...diagnostics].reduce((n,e)=>n+Buffer.byteLength(e.raw),0);
    for(let i=0;i<diagnostics.length;i+=4)await member.run('ingest',{batch_id:randomUUID(),events:diagnostics.slice(i,i+4)});
    for(let i=0;i<wire.length;i+=32)await member.run('ingest',{batch_id:randomUUID(),events:wire.slice(i,i+32)});
    const start=performance.now(),seal=await member.run('seal',{request_id:randomUUID(),...member.fence,manifest:{manifest_id:randomUUID(),scope:member.permit.scope,path:[member.permit.plan.group_id],events:wire.map(({event_id,hash})=>({event_id,hash}))}});
    member.seal_ms=performance.now()-start;if(seal.status!=='SEALED')throw new Error('SEAL_NOT_COMPLETE');
    const done=await member.run('finalize',{request_id:randomUUID(),...member.fence,seal_ids:[seal.seal_id]});if(done.status!=='COMPLETED')throw new Error('SESSION_NOT_COMPLETE');
    return done;
  }));
  for(const result of results)if(result.status==='rejected')errors.push(String(result.reason));
  const stats=(await call('/api/lab/operations')).value,control=metrics.filter(r=>!r.path.endsWith('/seal')).map(r=>r.ms),overload=retries.filter(r=>r.code!=='MAINTENANCE_BUSY');
  const result={concurrency,completed:results.filter(r=>r.status==='fulfilled').length,elapsed_ms:performance.now()-started,preparation_p95_ms:percentile(prepared.map(m=>m.preparation_ms),.95),control_p95_ms:percentile(control,.95),seal_p95_ms:percentile(prepared.map(m=>m.seal_ms??90000),.95),requests:metrics.length,retry_count:retries.length,overload_count:overload.length,overload_fraction:overload.length/(metrics.length+retries.length),image_bytes:prepared.reduce((n,m)=>n+m.image_bytes,0),raw_bytes:prepared.reduce((n,m)=>n+(m.raw_bytes??0),0),server_memory_bytes:stats.process.rss,errors};
  result.pass=!errors.length&&result.completed===concurrency&&result.preparation_p95_ms<60000&&result.control_p95_ms<2000&&result.seal_p95_ms<30000&&result.overload_fraction<.01&&stats.process.rss<500*1024*1024;
  for(const member of members)await member.run('terminate',{request_id:randomUUID(),reason:'TEST_ONLY_CAPACITY_PROBE'}).catch(()=>{});
  console.log(JSON.stringify(result));return result;
}
const report={schema:'ecs-capacity-v1',mode:'TEST_ONLY',measured_at:new Date().toISOString(),scope:'External HTTPS to isolated ECS process/database, same production code/settings and 102 private images; 32 image downloads + 32 synthetic six-item rating trials + 5120 recorded actions per session. Does not measure physical rendering or real users.',criteria:{preparation_p95_ms:60000,control_p95_ms:2000,seal_p95_ms:30000,max_overload_fraction:.01,max_rss_bytes:500*1024*1024},waves:[]};
try{
  let passed=0,failed=null;
  for(const n of [1,2,4,8,16,24,32,48,64,96,128]){const result=await wave(n);report.waves.push(result);await writeFile(output,JSON.stringify(report,null,2));if(result.pass)passed=n;else{failed=n;break;}await delay(2500);}
  if(failed){while(failed-passed>1){const n=Math.floor((failed+passed)/2);await delay(2500);const result=await wave(n);report.waves.push(result);if(result.pass)passed=n;else failed=n;await writeFile(output,JSON.stringify(report,null,2));}}
  // Confirm the last stable size and the 80% operating size independently.
  await delay(2500);const confirm=await wave(passed);report.waves.push(confirm);
  if(!confirm.pass){passed=Math.max(1,Math.floor(passed*.8));await delay(2500);const fallback=await wave(passed);report.waves.push(fallback);if(!fallback.pass)throw new Error('Capacity confirmation unstable');}
  report.measured_stable_concurrency=passed;report.first_unstable_concurrency=failed;report.operating_concurrency=Math.max(1,Math.floor(passed*.8));
  await delay(2500);const operating=await wave(report.operating_concurrency);report.waves.push(operating);if(!operating.pass)throw new Error('Operating size verification failed');report.verified=true;
  await writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify({stable:passed,operating:report.operating_concurrency,first_unstable:failed}));
}finally{for(const member of members)await member.run('terminate',{request_id:randomUUID(),reason:'TEST_ONLY_CAPACITY_TEARDOWN'}).catch(()=>{});}
