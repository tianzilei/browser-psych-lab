import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {fixture} from '../helpers/lab-fixture.mjs';
import {trace} from '../helpers/run-trace.mjs';
import {sampleProtocol,parseProtocol,stableJSON,pageSnapshot} from '../../src/shared/protocol.ts';
import {compileQuestionnaire} from '../../src/shared/questionnaire-json.ts';
import {snapshotEventBytes} from '../../src/shared/snapshot-budget.ts';
import {digest} from '../../src/server/collection-store.ts';
import {Maintenance} from '../../src/server/maintenance.ts';
import {labRoutes} from '../../src/server/lab-routes.ts';
import {RunReplay} from '../../src/shared/run-replay.ts';

function taskProtocol(groups=1){
  const p=sampleProtocol();p.pages=[];p.layout.orientation='portrait';
  p.groups=Array.from({length:groups},(_,i)=>({id:`task${i}`,title:'Task',choices:['left','right'],repeats:0,
    trials:[{root_id:`root${i}`,text:'X',image_ms:200,isi_ms:300,correct:null}]}));
  p.variants[0].group_order=p.groups.map(g=>g.id);p.variants[0].trial_order=Object.fromEntries(p.groups.map(g=>[g.id,g.trials.map(t=>t.root_id)]));return p;
}
function permit(f){
  const reservation=f.call('reserve',{request_id:randomUUID(),...f.fence});
  return f.call('permit',{request_id:randomUUID(),...f.fence,reservation_id:reservation.reservation_id,readiness:{
    activity_policy:'idle120-offline300-v1',frame_ms:10,commit_ms:5,protocol_hash:f.version.hash,layout:'portrait',assets:{},
    geometry:{viewport:{width:800,height:800,dpr:1},canvas:{x:0,y:0,width:600,height:400},
      buttons:[{choice:'left',x:0,y:500,width:100,height:60},{choice:'right',x:110,y:500,width:100,height:60}]}}});
}
function closingEvents(f,run){
  return trace(run.plan,()=>null).records.map((record,index)=>f.wire(run.scope,'GROUP_RECORD',{record},index===0?{sequence:0,previous:null}:{}));
}

test('g- questionnaire scopes seal over HTTP without creating a replay job, including a lost-response retry',async t=>{
  const p=compileQuestionnaire({schema:'questionnaire-v1',title:'Prefix regression',orientation:'portrait',
    pages:[{id:'g-survey',questions:[{id:'q',type:'single',title:'Q',choices:['yes','no']}]}]});
  const f=fixture(t,p),secret='a'.repeat(64),s=f.store.execute({operation:'lab/participant.create',
    data:{request_id:randomUUID(),version_id:f.version.version_id,credential_hash:digest(secret)}});
  const call=(op,data={})=>f.store.execute({operation:`lab/participant.${op}`,session_id:s.session_id,credential_hash:digest(secret),data});
  const claimed=call('claim',{request_id:randomUUID(),writer_id:'prefix-writer'}),fence={writer_id:'prefix-writer',writer_epoch:claimed.writer_epoch};
  const event={event_schema_version:'lab-events-v1',event_id:randomUUID(),session_id:s.session_id,version_id:f.version.version_id,
    protocol_hash:f.version.hash,...fence,scope:'g-survey',sequence:0,previous:null,clock_epoch:'clock',time_ms:1,
    kind:'PAGE_SNAPSHOT',payload:{answers:{q:'yes'}}};
  const raw=JSON.stringify(event),ref={event_id:event.event_id,hash:digest(raw)};
  assert.equal(call('ingest',{events:[{...ref,raw}]}).receipts[0].disposition,'ACCEPTED');
  const adapter={request:async command=>f.store.execute(command)},maintenance=new Maintenance(adapter,f.path,f.root),app=Fastify();
  app.setErrorHandler((error,_request,reply)=>reply.code(error.status??500).send({code:error.code??error.message}));
  await labRoutes(app,adapter,maintenance,f.root);
  try{
    const payload={request_id:randomUUID(),...fence,manifest:{manifest_id:randomUUID(),scope:'g-survey',path:['g-survey'],events:[ref]}};
    const send=body=>app.inject({method:'POST',url:`/api/participate/sessions/${s.session_id}/seal`,
      headers:{origin:process.env.PUBLIC_ORIGIN??'http://localhost:80',cookie:`lab_${s.session_id}=${secret}`},payload:body});
    const first=await send(payload);assert.equal(first.statusCode,200,first.body);assert.equal(first.json().status,'SEALED');
    assert.deepEqual((await send(payload)).json(),first.json());assert.equal(call('view').page_index,1);
    assert.equal(f.db.prepare('SELECT count(*) n FROM lab_jobs').get().n,0);
    const invalid=await send({...payload,request_id:randomUUID(),manifest:{...payload.manifest,scope:'g-not-a-permit'}});
    assert.equal(invalid.statusCode,409);assert.equal(invalid.json().code,'OUTSIDE_PERMIT');
    assert.equal(f.db.prepare('SELECT count(*) n FROM lab_jobs').get().n,0);
  }finally{await app.close();await maintenance.close();}
});

for(const groups of [1,2])test(`normal seal stops task expiry with ${groups===1?'final saving':'another group remaining'}`,async t=>{
  const f=fixture(t,taskProtocol(groups)),run=permit(f),events=closingEvents(f,run);
  assert.ok(f.ingest(events).receipts.every(r=>r.disposition==='ACCEPTED'));
  const maintenance=new Maintenance({request:async command=>f.store.execute(command)},f.path,f.root);
  try{
    const proof=await maintenance.run('REPLAY',{session_id:f.created.session_id,scope:run.scope});
    const seal=f.call('seal',{request_id:randomUUID(),...f.fence,manifest:{manifest_id:randomUUID(),scope:run.scope,
      path:['task0'],events:events.map(({event_id,hash})=>({event_id,hash}))},proof_job_id:proof.job_id});
    assert.equal(seal.status,'SEALED');assert.equal(f.call('view').task_activity,null);
    // A stale row left by an older server must also be harmless after upgrade.
    f.db.prepare('INSERT INTO lab_task_activity VALUES (?,?,?)').run(f.created.session_id,f.fence.writer_epoch,1000);
    const ticket=f.call('view').admission.ticket_id;
    for(const now of [61000,121000,181000,241000,301001]){
      f.setNow(now);assert.equal(f.call('admission',{action:'touch',ticket_id:ticket,...f.fence}).status,'ACTIVE');
    }
    assert.equal(f.store.expireTaskActivity(),0);assert.equal(f.call('view').state,'ACTIVE');
    assert.equal(f.call('view').task_activity,null);assert.deepEqual(f.call('view').diagnostics,[]);
    if(groups===1)assert.equal(f.call('finalize',{request_id:randomUUID(),...f.fence,seal_ids:[seal.seal_id]}).status,'COMPLETED');
    else {const next=permit(f);assert.equal(next.group_id,'task1');assert.ok(f.call('view').task_activity);}
  }finally{await maintenance.close();}
});

test('saving admission renews a pending group without accepting another writer as liveness',t=>{
  const f=fixture(t,taskProtocol()),run=permit(f),events=closingEvents(f,run);
  assert.ok(f.ingest(events).receipts.every(r=>r.disposition==='ACCEPTED'));
  const ticket=f.call('view').admission.ticket_id;
  for(const now of [61000,121000,181000,241000,301001]){
    f.setNow(now);f.call('admission',{action:'touch',ticket_id:ticket,...f.fence});assert.equal(f.store.expireTaskActivity(),0);
  }
  assert.equal(f.call('view').state,'ACTIVE');
  f.setNow(601002);f.call('admission',{action:'touch',ticket_id:ticket,writer_id:'foreign',writer_epoch:f.fence.writer_epoch});
  assert.equal(f.store.expireTaskActivity(),1);assert.equal(f.call('view').state,'TERMINATED');
});

const longSource=()=>({schema:'questionnaire-v1',title:'Long answers',questionnaire_layout:'adaptive',orientation:'auto',
  pages:[{id:'survey',title:'Section',instruction:'Only once',questions:Array.from({length:12},(_,i)=>({
    id:`q${i}`,type:'text',title:`个人信息 ${i}`,input_purpose:'personal',required:true,max_length:4000}))}]});
test('snapshot bound includes maximum identities, escaped answers and long decimal clock tokens',()=>{
  const long='x'.repeat(100),page={id:long,questions:[{id:long,type:'text',max_length:4000}]};
  const raw=JSON.stringify({event_schema_version:'lab-events-v1',event_id:long,session_id:long,version_id:long,protocol_hash:'a'.repeat(64),
    writer_id:long,writer_epoch:Number.MAX_SAFE_INTEGER,scope:long,sequence:4999,previous:{event_id:long,hash:'a'.repeat(64)},
    clock_epoch:long,time_ms:0.0000012345678901234567,kind:'PAGE_SNAPSHOT',payload:{answers:{[long]:'\u0000'.repeat(4000)}}});
  assert.ok(Buffer.byteLength(raw)<=snapshotEventBytes(page));
});
for(const character of ['中','\u0000','"','\\'])test(`automatic segments seal worst long answers containing ${JSON.stringify(character)}`,t=>{
  const source=longSource(),p=compileQuestionnaire(source),f=fixture(t,p);assert.ok(p.pages.length>1);
  assert.deepEqual(p.pages.map(page=>page.id),['survey_part_1','survey_part_2','survey_part_3']);
  assert.equal(p.pages[0].instruction,'Only once');assert.ok(p.pages.slice(1).every(page=>!page.title&&!page.instruction));
  assert.deepEqual(p.pages.flatMap(page=>page.questions.map(q=>q.id)),source.pages[0].questions.map(q=>q.id));
  for(const page of p.pages){
    const answers=Object.fromEntries(page.questions.map(q=>[q.id,character.repeat(4000)]));
    assert.doesNotThrow(()=>pageSnapshot(page,{},answers));
    const wire=f.wire(page.id,'PAGE_SNAPSHOT',{answers},{sequence:0,previous:null});
    assert.ok(Buffer.byteLength(wire.raw)<=snapshotEventBytes(page));assert.ok(snapshotEventBytes(page)<=128*1024);
    assert.equal(f.ingest([wire]).receipts[0].disposition,'ACCEPTED');
    assert.equal(f.seal(page.id,[wire],[...f.call('view').path,page.id]).status,'SEALED');
  }
  const view=f.call('view');assert.equal(f.call('finalize',{request_id:randomUUID(),...f.fence,seal_ids:view.seals.map(s=>s.seal_id)}).status,'COMPLETED');
});

test('oversized explicit pages fail new publication, while historical protocols remain parseable and unchanged',t=>{
  const source=longSource(),p=sampleProtocol();p.pages=[{...source.pages[0],questions:source.pages[0].questions}];
  const historical=parseProtocol(p),identity=digest(stableJSON(historical));
  assert.throws(()=>compileQuestionnaire({...source,questionnaire_layout:'single',orientation:'portrait'}),/PAGE_SNAPSHOT_BUDGET_EXCEEDED/);
  assert.throws(()=>compileQuestionnaire({...historical,layout:{...historical.layout,orientation:'portrait'}}),/PAGE_SNAPSHOT_BUDGET_EXCEEDED/);
  assert.equal(digest(stableJSON(parseProtocol(historical))),identity);
  const f=fixture(t),saved=f.admin('study.save',{request_id:randomUUID(),study_id:f.study.study_id,revision:2,protocol:historical});
  assert.throws(()=>f.admin('study.publish',{request_id:randomUUID(),study_id:f.study.study_id,revision:saved.revision}),/PAGE_SNAPSHOT_BUDGET_EXCEEDED/);
  assert.equal(f.store.frozen(f.version.version_id).hash,f.version.hash);
});

test('byte-based segmentation validates suffix lengths and retains cross-segment branch references',()=>{
  const source=longSource();source.pages[0].id='x'.repeat(93);
  source.pages[0].questions[6].condition={op:'eq',question:'q0',value:'shown'};
  const p=compileQuestionnaire(source);assert.ok(p.pages.every(page=>page.id.length===100));
  assert.deepEqual(p.pages.flatMap(page=>page.questions).find(q=>q.id==='q6').condition,source.pages[0].questions[6].condition);
  source.pages[0].id+='x';assert.throws(()=>compileQuestionnaire(source),/QUESTIONNAIRE_SEGMENT_ID_TOO_LONG/);
});

for(const selections of [[1,2,3],[2,2,2]])test(`first selections ${selections} do not count as changes`,()=>{
  const p=sampleProtocol(),plan={group_id:'ratings',scope:'g-rating',seed:[1,2,3,4],
    roots:[{root_id:'r',asset_id:'asset',image_ms:1,isi_ms:0,correct:null}],choices:['1','2','3'],repeats:0,start:1000,frame_ms:10,
    layout:'portrait',budget:p.budget,rating:{prompt:'score',items:['A','B','C'],labels:['low','mid','high']}};
  const r=new RunReplay(plan),instance_id='r:1';
  for(const record of [{type:'RATING_INTENT',at:0,instance_id},{type:'ONSET',at:1000,draw_time:1000,raf_time:1000,instance_id},
    ...selections.map((value,item)=>({type:'RATING_CHANGE',at:1100+item*100,instance_id,item,value})),
    {type:'RATING',at:1500,draw_time:1500,raf_time:1500,input_time:1490,instance_id,values:selections}])r.apply(record);
  const result=r.results.get(instance_id);assert.deepEqual(result.rating_item_times.map(x=>x.changes),[0,0,0]);assert.equal(result.change_count,0);
});
