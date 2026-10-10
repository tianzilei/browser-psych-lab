import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from '../helpers/lab-fixture.mjs';
import {digest} from '../../src/server/collection-store.ts';
import {sampleProtocol} from '../../src/shared/protocol.ts';
import {LabStore} from '../../src/server/lab-store.ts';
import {openDatabase} from '../../src/server/database.ts';
function limitedProtocol(){const p=sampleProtocol();p.groups=[{id:'text-task',title:'Task',choices:['yes','no'],repeats:0,trials:[{root_id:'one',text:'Task',image_ms:200,isi_ms:300,correct:null}]}];p.variants[0].group_order=['text-task'];p.variants[0].trial_order={'text-task':['one']};return p;}
function session(f,version=f.version){
 const credential=digest(randomUUID()),created=f.store.execute({operation:'lab/participant.create',data:{request_id:randomUUID(),version_id:version.version_id,credential_hash:credential}}),ticket_id=randomUUID();
 const call=(op,data={})=>f.store.execute({operation:'lab/participant.'+op,session_id:created.session_id,credential_hash:credential,data});
 return {created,credential,ticket_id,call,join:()=>call('admission',{action:'join',ticket_id})};
}
const full=e=>e.code==='SESSION_CAPACITY_FULL'&&e.status===409&&e.details.retry_after_seconds===1800;
test('task sessions reject at limit without a waiting ticket; direct starts also reject',t=>{
 const f=fixture(t,limitedProtocol()),b=session(f),c=session(f),d=session(f);assert.equal(b.join().status,'ACTIVE');assert.throws(c.join,full);assert.throws(d.join,full);
 assert.equal(f.db.prepare('SELECT count(*) n FROM lab_session_queue WHERE session_id IN (?,?)').get(c.created.session_id,d.created.session_id).n,0);
 for(const op of ['claim','reserve','permit','seal','finalize','preparation'])assert.throws(()=>c.call(op,{request_id:randomUUID(),writer_id:'c',writer_epoch:1}),full);
 assert.equal(c.call('view').writer_epoch,0);assert.equal(f.store.admission.stats().queued,0);
 f.call('terminate',{request_id:'initial-stop',reason:'TEST_ONLY_END'});assert.equal(c.call('view').admission.status,'LEFT');assert.equal(c.join().status,'ACTIVE');assert.throws(d.join,full);
 b.call('terminate',{request_id:'stop',reason:'TEST_ONLY_END'});assert.equal(d.join().status,'ACTIVE');
 assert.throws(()=>f.store.execute({operation:'lab/participant.admission',session_id:c.created.session_id,credential_hash:d.credential,data:{action:'leave',ticket_id:c.ticket_id}}),/UNAUTHORIZED/);
});
test('nonce fences stale cancellation and active renewals coalesce',t=>{
 const f=fixture(t,limitedProtocol(),{sessionConcurrency:1}),b=session(f);assert.throws(b.join,full);
 const initial=f.call('view').admission,replacement=randomUUID();f.call('admission',{action:'join',ticket_id:replacement});f.call('admission',{action:'leave',ticket_id:initial.ticket_id});
 assert.equal(f.call('view').admission.status,'ACTIVE');assert.throws(()=>f.call('admission',{action:'touch',ticket_id:initial.ticket_id}),/QUEUE_FENCED/);
 const before=f.db.prepare('SELECT total_changes() AS n').get().n;for(let i=0;i<20;i++)f.call('admission',{action:'touch',ticket_id:replacement});assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n,before);
 f.call('admission',{action:'leave',ticket_id:replacement});assert.equal(b.join().status,'ACTIVE');
});
test('restart retires legacy waiting entries and expiry preserves answer history',t=>{
 const f=fixture(t,limitedProtocol(),{sessionConcurrency:1}),b=session(f);f.db.prepare("INSERT INTO lab_session_queue(session_id,ticket_id,status,lease_until) VALUES (?,?,'QUEUED',?)").run(b.created.session_id,b.ticket_id,301000);f.db.close();
 const db=openDatabase(f.path);try{let now=1000;const store=new LabStore(db,digest('TEST_ONLY-runner'),()=>now,1),call=(op,data)=>store.execute({operation:'lab/participant.'+op,session_id:b.created.session_id,credential_hash:b.credential,data});
 assert.equal(store.admission.stats().queued,0);assert.equal(store.view(b.created.session_id).admission.status,'LEFT');assert.throws(()=>call('admission',{action:'join',ticket_id:b.ticket_id}),full);
 now=301001;assert.equal(call('admission',{action:'join',ticket_id:b.ticket_id}).status,'ACTIVE');assert.equal(store.view(f.created.session_id).state,'ACTIVE');assert.equal(store.view(f.created.session_id).writer_epoch,f.fence.writer_epoch);
 }finally{db.close();}
});
test('activity lease tolerates transient loss, expires after five minutes and releases a pinned run',t=>{
 const p=sampleProtocol(),f=fixture(t,p,{sessionConcurrency:1});f.call('terminate',{request_id:'initial-stop',reason:'TEST_ONLY_END'});p.pages=[];
 const asset=f.admin('asset.begin',{request_id:'image',study_id:f.study.study_id,name:'test.png'});f.store.execute({operation:'lab/internal.asset.ready',data:{asset_id:asset.asset_id,info:{hash:digest('image'),bytes:100,width:32,height:24,format:'png'}}});
 p.groups=[{id:'images',title:'Images',choices:['left','right'],repeats:0,trials:[{root_id:'one',asset_id:asset.asset_id,image_ms:200,isi_ms:300,correct:null}]}];p.variants[0].group_order=['images'];p.variants[0].trial_order={images:['one']};
 f.admin('study.save',{request_id:'save-images',study_id:f.study.study_id,revision:2,protocol:p});const v=f.admin('study.publish',{request_id:'publish-images',study_id:f.study.study_id,revision:3});
 const running=session(f,v);running.join();const claimed=running.call('claim',{request_id:'claim',writer_id:'run'}),fence={writer_id:'run',writer_epoch:claimed.writer_epoch},reservation=running.call('reserve',{request_id:'reserve',...fence});
 running.call('permit',{request_id:'permit',...fence,reservation_id:reservation.reservation_id,readiness:{activity_policy:'idle120-offline300-v1',frame_ms:1000/60,commit_ms:5,protocol_hash:v.hash,layout:'portrait',geometry:{viewport:{width:800,height:800,dpr:1},canvas:{x:0,y:0,width:500,height:333},buttons:[{choice:'left',x:0,y:400,width:100,height:60},{choice:'right',x:110,y:400,width:100,height:60}]},assets:{[asset.asset_id]:digest('image')}}});
 const retry=session(f,v);f.setNow(120999);assert.throws(retry.join,full);assert.equal(running.call('activity',fence).status,'ACTIVE');f.setNow(300999);assert.equal(f.store.expireTaskActivity(),0);assert.throws(retry.join,full);
 f.setNow(420999);assert.equal(f.store.expireTaskActivity(),1);assert.equal(running.call('view').state,'TERMINATED');assert.equal(running.call('view').permit.state,'CLOSED_UNKNOWN');assert.equal(running.call('activity',fence).status,'TERMINATED');assert.equal(retry.join().status,'ACTIVE');
});
test('measured limits above two work; excess offers never accumulate',t=>{
 const f=fixture(t,limitedProtocol(),{sessionConcurrency:8});for(let i=0;i<7;i++)assert.equal(session(f).join().status,'ACTIVE');for(let i=0;i<70;i++)assert.throws(session(f).join,full);
 assert.equal(f.store.admission.stats().active,8);assert.equal(f.store.admission.stats().queued,0);for(const limit of [0,10001,1.5,NaN])assert.throws(()=>new LabStore(f.db,digest('test'),Date.now,limit),/INVALID_SESSION_CONCURRENCY/);
});
