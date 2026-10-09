import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from '../helpers/lab-fixture.mjs';
import {sampleProtocol,parseProtocol,pageSnapshot} from '../../src/shared/protocol.ts';
import {digest} from '../../src/server/collection-store.ts';
test('new publication requires personal input purpose and legacy protocol parsing stays exact',t=>{
  const f=fixture(t),p=sampleProtocol();p.pages[0].questions.push({id:'identity',type:'text',title:'姓名',required:true,max_length:100});
  assert.deepEqual(parseProtocol(p),p);
  f.admin('study.save',{request_id:randomUUID(),study_id:f.study.study_id,revision:2,protocol:p});
  assert.throws(()=>f.admin('study.publish',{request_id:randomUUID(),study_id:f.study.study_id,revision:3}),/PERSONAL_INPUT_ONLY/);
  p.pages[0].questions[1].input_purpose='personal';
  f.admin('study.save',{request_id:randomUUID(),study_id:f.study.study_id,revision:3,protocol:p});
  const version=f.admin('study.publish',{request_id:randomUUID(),study_id:f.study.study_id,revision:4});
  assert.equal(version.protocol.pages[0].questions[1].input_purpose,'personal');
  p.pages[0].questions[0].input_purpose='personal';assert.throws(()=>parseProtocol(p),/INVALID_INPUT_PURPOSE/);
});
test('axis endpoints are explicit at publication, legacy scales parse exactly and scores stay discrete',t=>{
  const f=fixture(t),p=sampleProtocol();
  p.pages[0].questions.push({id:'axis',type:'scale',title:'方便程度',required:true,min:-1,max:1});
  assert.deepEqual(parseProtocol(p),p);
  f.admin('study.save',{request_id:randomUUID(),study_id:f.study.study_id,revision:2,protocol:p});
  assert.throws(()=>f.admin('study.publish',{request_id:randomUUID(),study_id:f.study.study_id,revision:3}),/SCALE_ENDPOINTS_REQUIRED/);
  p.pages[0].questions[1].min_label='不方便';p.pages[0].questions[1].max_label=' ';
  f.admin('study.save',{request_id:randomUUID(),study_id:f.study.study_id,revision:3,protocol:p});
  assert.throws(()=>f.admin('study.publish',{request_id:randomUUID(),study_id:f.study.study_id,revision:4}),/SCALE_ENDPOINTS_REQUIRED/);
  p.pages[0].questions[1].max_label='方便';
  f.admin('study.save',{request_id:randomUUID(),study_id:f.study.study_id,revision:4,protocol:p});
  const version=f.admin('study.publish',{request_id:randomUUID(),study_id:f.study.study_id,revision:5});
  assert.equal(version.protocol.pages[0].questions[1].min_label,'不方便');
  assert.equal(pageSnapshot(p.pages[0],{}, {ready:'是',axis:0}).axis.answer,0);
  assert.throws(()=>pageSnapshot(p.pages[0],{}, {ready:'是',axis:0.5}),/INVALID_ANSWER/);
  assert.throws(()=>pageSnapshot(p.pages[0],{}, {ready:'是',axis:null}),/REQUIRED_ANSWER/);
  p.pages[0].questions[1].choices=['不方便','方便'];assert.throws(()=>parseProtocol(p),/SCALE_CHOICES_NOT_ALLOWED/);delete p.pages[0].questions[1].choices;
  p.pages[0].questions[1].min_label='字'.repeat(41);assert.throws(()=>parseProtocol(p),/INVALID_TEXT/);
  delete p.pages[0].questions[1].min_label;p.pages[0].questions[0].min_label='错误题型';assert.throws(()=>parseProtocol(p),/INVALID_SCALE_ENDPOINTS/);
});
test('draft concurrency, frozen versions, CSRF, admission retry and finite conditions',t=>{
  const f=fixture(t),p=sampleProtocol();p.title='Changed';f.admin('study.save',{request_id:randomUUID(),study_id:f.study.study_id,revision:2,protocol:p});assert.equal(f.call('view').frozen.protocol.title,f.version.protocol.title);
  assert.throws(()=>f.admin('study.save',{request_id:randomUUID(),study_id:f.study.study_id,revision:2,protocol:p}),/DRAFT_REVISION_CONFLICT/);
  assert.throws(()=>f.admin('study.admission',{request_id:randomUUID(),study_id:f.study.study_id,paused:true,csrf:'foreign'}),/CSRF/);
  f.admin('study.admission',{request_id:randomUUID(),study_id:f.study.study_id,paused:true});assert.deepEqual(f.store.execute({operation:'lab/participant.create',data:f.admission}),f.created);
  assert.throws(()=>f.store.execute({operation:'lab/participant.create',data:{...f.admission,request_id:randomUUID()}}),/ADMISSION_PAUSED/);
  p.pages[0].questions[0].condition={op:'eq',question:'future',value:'yes'};assert.throws(()=>parseProtocol(p),/CONDITION_REFERENCE/);
});
test('revision history, out-of-order custody, exact page seal, finalization and raw immutability',t=>{
  const f=fixture(t),one=f.wire('welcome','PAGE_REVISION',{question_id:'ready',answer:'否'}),two=f.wire('welcome','PAGE_SNAPSHOT',{answers:{ready:'是'}});
  assert.equal(f.ingest([two]).receipts[0].disposition,'RECEIVED_PENDING');f.ingest([one]);const receipts=f.call('receipts',{events:[one,two]}).receipts;assert.ok(receipts.every(r=>r.disposition==='ACCEPTED'));assert.equal(receipts[1].disposition_version,2);
  assert.equal(f.seal('welcome',[one],['welcome']).status,'WAITING');const seal=f.seal('welcome',[one,two],['welcome']);assert.equal(seal.status,'SEALED');assert.equal(f.call('view').answers.ready,'是');
  const data={request_id:'done',...f.fence,seal_ids:[seal.seal_id]};assert.equal(f.call('finalize',data).status,'COMPLETED');assert.equal(f.call('finalize',data).status,'COMPLETED');assert.throws(()=>f.call('terminate',{request_id:'late',reason:'UNKNOWN_RUN'}),/TERMINAL/);
  assert.throws(()=>f.db.prepare('DELETE FROM lab_raw').run(),/immutable/);assert.equal(f.db.prepare('SELECT raw FROM lab_raw WHERE event_id=?').get(one.event_id).raw.toString(),one.raw);
});
test('conditional skip ignores hidden values and actual path excludes skipped pages',t=>{
  const p=sampleProtocol();p.pages.push({id:'branch',title:'Branch',instruction:'',condition:{op:'eq',question:'ready',value:'否'},questions:[{id:'hidden',title:'Hidden',type:'text',input_purpose:'personal',required:true,max_length:100}]});
  const f=fixture(t,p),event=f.wire('welcome','PAGE_SNAPSHOT',{answers:{ready:'是'}});f.ingest([event]);f.seal('welcome',[event],['welcome']);assert.equal(f.call('view').page_index,2);assert.deepEqual(f.call('view').path,['welcome']);assert.equal(f.call('view').answers.hidden,null);
  assert.equal(pageSnapshot({...p.pages[1],condition:undefined}, {ready:'是'},{hidden:'saved'}).hidden.answer,'saved');
});
test('byte conflict has independent receipt, durable diagnosis and prevents completion',t=>{
  const f=fixture(t),one=f.wire('welcome','PAGE_SNAPSHOT',{answers:{ready:'是'}});const old=f.ingest([one]).receipts[0];const e=JSON.parse(one.raw);e.payload.answers.ready='否';const raw=JSON.stringify(e),conflict={event_id:one.event_id,hash:digest(raw),raw};const r=f.ingest([conflict]).receipts[0];assert.notEqual(r.receipt_id,old.receipt_id);assert.equal(r.reason,'EVENT_ID_HASH_CONFLICT');assert.equal(f.seal('welcome',[one],['welcome']).status,'WAITING');
});
test('terminal historical upload remains raw and reconciliation never enables cleanup',t=>{
  const f=fixture(t),one=f.wire('welcome','PAGE_SNAPSHOT',{answers:{ready:'是'}});f.call('terminate',{request_id:'stop',reason:'UNKNOWN_RUN'});assert.equal(f.ingest([one]).receipts[0].disposition,'RECEIVED_PENDING');const result=f.call('reconcile',{request_id:'reconcile',manifest:{manifest_id:'old',scope:'welcome',path:['welcome'],events:[one]},unknown:['onset']});assert.equal(result.cleanup_allowed,false);assert.throws(()=>f.call('claim',{request_id:'new',writer_id:'other'}),/TERMINAL/);
});
test('resource barrier, immutable history, single maintenance and independent restore gate',t=>{
  const f=fixture(t);f.admin('job.begin',{request_id:'backup',job_id:'backup',kind:'BACKUP',config:{}});assert.throws(()=>f.admin('asset.begin',{request_id:'asset',study_id:f.study.study_id,name:'a'}),/LIFECYCLE_BLOCKED/);assert.throws(()=>f.admin('job.begin',{request_id:'second',job_id:'second',kind:'EXPORT',config:{}}),/MAINTENANCE_BUSY/);
  f.store.execute({operation:'lab/internal.job.interrupted',data:{}});assert.equal(f.admin('job.get',{job_id:'backup'}).state,'RECOVERY_REQUIRED');assert.throws(()=>f.db.prepare('UPDATE lab_audit SET operation=?').run('forged'),/immutable/);
  const record=Object.fromEntries(['hardware','filesystem','device_matrix','capacity_report','independent_restore_report','backup_target','rpo','rto','operator','verified_at'].map(k=>[k,'test fixture']));f.admin('environment.put',{request_id:'env',environment_id:'fixture',record});assert.throws(()=>f.admin('gate.open',{request_id:'gate',environment_id:'fixture'}),/INVALID_ID|RESTORE_REQUIRED/);
});
test('readiness cannot omit storage or geometry, allocation is once, unclosed permits outlive the writer lease',t=>{
  const f=fixture(t),asset=f.admin('asset.begin',{request_id:'image',study_id:f.study.study_id,name:'test.png'});f.store.execute({operation:'lab/internal.asset.ready',data:{asset_id:asset.asset_id,info:{hash:digest('image'),bytes:100,width:32,height:24,format:'png'}}});
  const p=sampleProtocol();p.pages=[];p.groups=[{id:'pictures',title:'Pictures',choices:['left','right'],repeats:2,trials:[{root_id:'root',asset_id:asset.asset_id,image_ms:200,isi_ms:300,correct:'left'}]}];p.variants[0].group_order=['pictures'];p.variants[0].trial_order={pictures:['root']};f.admin('study.save',{request_id:'images',revision:2,study_id:f.study.study_id,protocol:p});const v=f.admin('study.publish',{request_id:'publish',revision:3,study_id:f.study.study_id});
  const credential=digest('participant'),s=f.store.execute({operation:'lab/participant.create',data:{request_id:'new',version_id:v.version_id,credential_hash:credential}}),call=(op,data={})=>f.store.execute({operation:`lab/participant.${op}`,session_id:s.session_id,credential_hash:credential,data});const claimed=call('claim',{request_id:'claim',writer_id:'writer'}),fence={writer_id:'writer',writer_epoch:claimed.writer_epoch};const reservation=call('reserve',{request_id:'reserve',...fence}),readiness={frame_ms:1000/60,commit_ms:5,protocol_hash:v.hash,layout:'portrait',geometry:{viewport:{width:800,height:800,dpr:1},canvas:{x:0,y:0,width:500,height:333},buttons:[{choice:'left',x:0,y:400,width:100,height:60},{choice:'right',x:110,y:400,width:100,height:60}]},assets:{[asset.asset_id]:digest('image')}};
  f.setNow(250000);const renewed=call('reserve',{request_id:'renew',...fence});assert.equal(renewed.reservation_id,reservation.reservation_id);assert.ok(renewed.reserved_until>reservation.reserved_until);f.setNow(350000);
  const preparation=call('preparation',fence);assert.deepEqual(preparation.asset_ids,[asset.asset_id]);assert.throws(()=>call('preparation',{...fence,writer_epoch:99}),/FENCED/);
  const missing={...readiness};delete missing.commit_ms;assert.throws(()=>call('permit',{request_id:'missing',...fence,reservation_id:reservation.reservation_id,readiness:missing}),/ENVIRONMENT_NOT_READY/);assert.equal(call('view').allocation,null);
  const data={request_id:'permit',...fence,reservation_id:reservation.reservation_id,readiness},permit=call('permit',data);assert.deepEqual(call('permit',data),permit);assert.throws(()=>call('preparation',fence),/UNAVAILABLE/);assert.throws(()=>call('reserve',{request_id:'during-run',...fence}),/RUN_LOCKED/);assert.equal(f.db.prepare('SELECT count(*) AS n FROM lab_slots WHERE session_id=? AND allocation_id IS NOT NULL').get(s.session_id).n,1);
  f.setNow(1000000);assert.throws(()=>call('claim',{request_id:'takeover',writer_id:'other'}),/RUN_LOCKED/);assert.throws(()=>f.admin('asset.delete',{request_id:'delete',asset_id:asset.asset_id}),/ASSET_REFERENCED/);
  assert.equal(call('terminate',{request_id:'stop',reason:'UNKNOWN_RUN'}).permit.state,'CLOSED_UNKNOWN');assert.throws(()=>call('permit',{...data,request_id:'again'}),/TERMINAL/);
});
