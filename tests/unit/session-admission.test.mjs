import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from '../helpers/lab-fixture.mjs';
import {digest} from '../../src/server/collection-store.ts';
import {sampleProtocol} from '../../src/shared/protocol.ts';
import {LabStore} from '../../src/server/lab-store.ts';
import {openDatabase} from '../../src/server/database.ts';
function session(f,version=f.version){
  const credential=digest(randomUUID()),created=f.store.execute({operation:'lab/participant.create',data:{request_id:randomUUID(),version_id:version.version_id,credential_hash:credential}}),ticket_id=randomUUID();
  const call=(op,data={})=>f.store.execute({operation:`lab/participant.${op}`,session_id:created.session_id,credential_hash:credential,data});
  return {created,credential,ticket_id,call,join:()=>call('admission',{action:'join',ticket_id})};
}
test('whole sessions admit two globally, gate direct starts and advance FIFO on completion or termination',t=>{
  const f=fixture(t),b=session(f),c=session(f),d=session(f);
  assert.equal(b.join().status,'ACTIVE');assert.equal(c.join().position,1);assert.equal(d.join().position,2);
  for(const op of ['claim','reserve','permit','seal','finalize','preparation'])assert.throws(()=>c.call(op,{request_id:randomUUID(),writer_id:'c',writer_epoch:1}),e=>e.code==='SESSION_WAITING'&&e.status===409);
  assert.equal(c.call('view').writer_epoch,0);assert.equal(f.store.admission.stats().active,2);
  const event=f.wire('welcome','PAGE_SNAPSHOT',{answers:{ready:'是'}});f.ingest([event]);const seal=f.seal('welcome',[event],['welcome']);
  assert.equal(f.call('finalize',{request_id:'done',...f.fence,seal_ids:[seal.seal_id]}).status,'COMPLETED');assert.equal(c.join().status,'ACTIVE');assert.equal(d.join().position,1);
  b.call('terminate',{request_id:'stop',reason:'TEST_ONLY_END'});assert.equal(d.join().status,'ACTIVE');assert.equal(f.store.admission.stats().active,2);
  assert.throws(()=>f.store.execute({operation:'lab/participant.admission',session_id:c.created.session_id,credential_hash:d.credential,data:{action:'leave',ticket_id:c.ticket_id}}),/UNAUTHORIZED/);
});
test('one-slot limit, exact cancellation, page refresh nonce and coalesced renewal preserve fairness',t=>{
  const f=fixture(t,undefined,{sessionConcurrency:1}),b=session(f),c=session(f);assert.equal(b.join().position,1);assert.equal(c.join().position,2);
  const replacement=randomUUID();assert.equal(b.call('admission',{action:'join',ticket_id:replacement}).position,1);
  b.call('admission',{action:'leave',ticket_id:b.ticket_id});assert.equal(b.call('view').admission.status,'QUEUED');
  assert.throws(()=>b.call('admission',{action:'touch',ticket_id:b.ticket_id}),/QUEUE_FENCED/);
  const before=f.db.prepare('SELECT total_changes() AS n').get().n;
  for(let i=0;i<20;i++)b.call('admission',{action:'touch',ticket_id:replacement});assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n,before);
  b.call('admission',{action:'leave',ticket_id:replacement});assert.equal(c.join().position,1);assert.equal(b.join().position,2);
  f.call('terminate',{request_id:'stop',reason:'TEST_ONLY_END'});assert.equal(c.join().status,'ACTIVE');assert.equal(b.join().position,1);
});
test('SQLite reopen keeps FIFO; idle entries expire without losing local/formal session history',t=>{
  const f=fixture(t,undefined,{sessionConcurrency:1}),b=session(f),c=session(f);b.join();c.join();f.db.close();
  const db=openDatabase(f.path);try{
    let now=1000;const store=new LabStore(db,digest('TEST_ONLY-runner'),()=>now,1),call=(s,op,data)=>store.execute({operation:`lab/participant.${op}`,session_id:s.created.session_id,credential_hash:s.credential,data});
    assert.equal(call(b,'admission',{action:'touch',ticket_id:b.ticket_id}).position,1);assert.equal(call(c,'admission',{action:'touch',ticket_id:c.ticket_id}).position,2);
    now=250000;call(b,'admission',{action:'touch',ticket_id:b.ticket_id});call(c,'admission',{action:'touch',ticket_id:c.ticket_id});now=301001;
    assert.equal(call(b,'admission',{action:'touch',ticket_id:b.ticket_id}).status,'ACTIVE');assert.equal(call(c,'admission',{action:'touch',ticket_id:c.ticket_id}).position,1);
    assert.equal(store.view(f.created.session_id).state,'ACTIVE');assert.equal(store.view(f.created.session_id).writer_epoch,f.fence.writer_epoch);
  }finally{db.close();}
});
test('unclosed permit pins a slot across lease expiry and restart until explicit UNKNOWN termination',t=>{
  const p=sampleProtocol(),f=fixture(t,p,{sessionConcurrency:1});f.call('terminate',{request_id:'initial-stop',reason:'TEST_ONLY_END'});p.pages=[];
  const asset=f.admin('asset.begin',{request_id:'image',study_id:f.study.study_id,name:'test.png'});f.store.execute({operation:'lab/internal.asset.ready',data:{asset_id:asset.asset_id,info:{hash:digest('image'),bytes:100,width:32,height:24,format:'png'}}});
  p.groups=[{id:'images',title:'Images',choices:['left','right'],repeats:0,trials:[{root_id:'one',asset_id:asset.asset_id,image_ms:200,isi_ms:300,correct:null}]}];p.variants[0].group_order=['images'];p.variants[0].trial_order={images:['one']};
  f.admin('study.save',{request_id:'save-images',study_id:f.study.study_id,revision:2,protocol:p});const v=f.admin('study.publish',{request_id:'publish-images',study_id:f.study.study_id,revision:3});
  const running=session(f,v);running.join();const claimed=running.call('claim',{request_id:'claim',writer_id:'run'}),fence={writer_id:'run',writer_epoch:claimed.writer_epoch},reservation=running.call('reserve',{request_id:'reserve',...fence});
  running.call('permit',{request_id:'permit',...fence,reservation_id:reservation.reservation_id,readiness:{frame_ms:1000/60,commit_ms:5,protocol_hash:v.hash,layout:'portrait',geometry:{viewport:{width:800,height:800,dpr:1},canvas:{x:0,y:0,width:500,height:333},buttons:[{choice:'left',x:0,y:400,width:100,height:60},{choice:'right',x:110,y:400,width:100,height:60}]},assets:{[asset.asset_id]:digest('image')}}});
  const waiting=session(f,v);waiting.join();for(let now=121000;now<1500000;now+=120000){f.setNow(now);assert.equal(waiting.call('admission',{action:'touch',ticket_id:waiting.ticket_id}).status,'QUEUED');}
  assert.throws(()=>running.call('admission',{action:'leave',ticket_id:running.ticket_id}),/RUN_LOCKED/);
  f.db.prepare('DELETE FROM lab_session_queue WHERE session_id=?').run(running.created.session_id);
  const upgraded=new LabStore(f.db,digest('TEST_ONLY-runner'),()=>1441000,1);assert.equal(upgraded.admission.stats().pinned,1);assert.equal(upgraded.admission.stats().active,1);
  running.call('terminate',{request_id:'unknown',reason:'UNKNOWN_RUN'});assert.equal(waiting.join().status,'ACTIVE');assert.equal(running.call('view').permit.state,'CLOSED_UNKNOWN');
});
test('session waiting capacity is finite and invalid limits fail closed',t=>{
  const f=fixture(t,undefined,{sessionConcurrency:1});for(let i=0;i<63;i++)assert.equal(session(f).join().status,'QUEUED');const excess=session(f);assert.throws(()=>excess.join(),/SESSION_QUEUE_FULL/);
  for(const limit of [0,3,1.5,NaN])assert.throws(()=>new LabStore(f.db,digest('test'),Date.now,limit),/INVALID_SESSION_CONCURRENCY/);
});
