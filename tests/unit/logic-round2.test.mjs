import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from '../helpers/lab-fixture.mjs';
import {digest} from '../../src/server/collection-store.ts';
import {sampleProtocol} from '../../src/shared/protocol.ts';

test('terminal reconciliation waits for missing custody and refreshes even an old cached success',t=>{
  const f=fixture(t),event=f.wire('welcome','PAGE_REVISION',{question_id:'ready',answer:'是'});
  f.call('terminate',{request_id:randomUUID(),reason:'UNKNOWN_RUN'});
  const data={request_id:randomUUID(),manifest:{manifest_id:randomUUID(),scope:'welcome',path:[],events:[{event_id:event.event_id,hash:event.hash}]},unknown:['unfinished']};
  const first=f.call('reconcile',data);assert.equal(first.status,'WAITING');assert.deepEqual(first.receipts,[null]);
  // Simulate the immutable request result written by the old server.
  f.db.prepare('UPDATE lab_requests SET response=? WHERE subject=? AND operation=? AND request_id=?')
    .run(JSON.stringify({...first,status:'RECONCILED'}),f.created.session_id,'participant.reconcile',data.request_id);
  assert.equal(f.call('reconcile',data).status,'WAITING');
  const receipt=f.ingest([event]).receipts[0];assert.equal(receipt.custody,'PERSISTED');
  const recovered=f.call('reconcile',data);assert.equal(recovered.status,'RECONCILED');assert.deepEqual(recovered.receipts,[receipt]);
  assert.equal(recovered.cleanup_allowed,false);assert.equal(f.call('view').state,'TERMINATED');
  assert.throws(()=>f.call('reconcile',{...data,unknown:[]}),/IDEMPOTENCY_CONFLICT/);
});

const interaction={interaction:{schema:'interaction-v1',time_origin:1000,samples:[{type:'pointerdown',at:2,context:{page_id:'welcome'}}]}};
for(const valid of [true,false])test(`out-of-order diagnostic ${valid?'can complete after its predecessor arrives':'quarantine blocks completion regardless of arrival order'}`,t=>{
  const f=fixture(t),page=f.wire('welcome','PAGE_SNAPSHOT',{answers:{ready:'是'}});f.ingest([page]);const seal=f.seal('welcome',[page],['welcome']);
  const parent=f.wire('d-ui-order','INPUT_DIAGNOSTIC',interaction,{sequence:0,previous:null,time_ms:2});
  const child=f.wire('d-ui-order','INPUT_DIAGNOSTIC',interaction,{sequence:1,previous:{event_id:parent.event_id,hash:valid?parent.hash:digest('wrong')},time_ms:3});
  assert.equal(f.ingest([child]).receipts[0].disposition,'RECEIVED_PENDING');
  const completion={request_id:randomUUID(),...f.fence,seal_ids:[seal.seal_id]};
  assert.equal(f.call('finalize',completion).status,'WAITING');assert.deepEqual(f.call('view').diagnostics,[]);
  assert.equal(f.ingest([parent]).receipts[0].disposition,'ACCEPTED');
  assert.equal(f.ingest([child]).receipts[0].disposition,valid?'ACCEPTED':'QUARANTINED');
  const diagnostics=f.call('view').diagnostics;
  assert.deepEqual(diagnostics,valid?[]:[{code:'INVALID_PREDECESSOR_OR_CLOCK',scope:'d-ui-order'}]);
  assert.equal(f.call('finalize',completion).status,valid?'COMPLETED':'WAITING');
  assert.equal(f.db.prepare('SELECT count(*) n FROM lab_raw').get().n,3);
});

function publishTask(f){
  const p=sampleProtocol();p.pages=[];p.layout.orientation='landscape';
  p.groups=[{id:'task',title:'Task',choices:['left','right'],repeats:0,trials:[{root_id:'root',text:'X',image_ms:200,isi_ms:300,correct:null}]}];
  p.variants[0].group_order=['task'];p.variants[0].trial_order={task:['root']};
  const saved=f.admin('study.save',{request_id:randomUUID(),study_id:f.study.study_id,revision:2,protocol:p});
  return f.admin('study.publish',{request_id:randomUUID(),study_id:f.study.study_id,revision:saved.revision});
}
for(const capability of ['legacy-client','legacy-runner','verified','stale'])test(`cross-version task reanswer requires a compatible entry: ${capability}`,t=>{
  const f=fixture(t),next=publishTask(f);f.call('terminate',{request_id:randomUUID(),reason:'UNKNOWN_RUN'});
  const data={request_id:randomUUID(),credential_hash:digest('next'),...(capability==='legacy-client'?{}:{entry_version:f.version.version_id}),
    ...(capability==='verified'?{upgrade_runner_hash:next.runner_hash}:capability==='stale'?{upgrade_runner_hash:digest('another-release')}:{})};
  const result=f.call('reanswer',data);
  assert.equal(result.frozen.version_id,capability==='verified'?next.version_id:f.version.version_id);
  assert.equal(result.reanswer.old_session_id,f.created.session_id);
  // Capability checks may race a publication or change after deployment; they
  // never change the identity of an already committed reanswer request.
  assert.equal(f.call('reanswer',{...data,upgrade_runner_hash:digest('later-release')}).session_id,result.session_id);
});

test('a reanswer entry cannot refer to another study',t=>{
  const f=fixture(t);f.call('terminate',{request_id:randomUUID(),reason:'UNKNOWN_RUN'});
  // Import a valid published identity from another study into this same store.
  const study=f.admin('study.create',{request_id:randomUUID()});
  const saved=f.admin('study.save',{request_id:randomUUID(),study_id:study.study_id,revision:1,protocol:sampleProtocol()});
  const v=f.admin('study.publish',{request_id:randomUUID(),study_id:study.study_id,revision:saved.revision});
  assert.throws(()=>f.call('reanswer',{request_id:randomUUID(),credential_hash:digest('next'),entry_version:v.version_id}),/INVALID_REANSWER_ENTRY/);
});
