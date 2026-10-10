import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from '../helpers/lab-fixture.mjs';
import {sampleProtocol} from '../../src/shared/protocol.ts';
import {digest} from '../../src/server/collection-store.ts';
test('more than 64 pure questionnaires admit immediately without taking timed task slots',t=>{
  const f=fixture(t,undefined,{sessionConcurrency:1});for(let i=0;i<70;i++){const credential=digest(randomUUID()),s=f.store.execute({operation:'lab/participant.create',data:{request_id:randomUUID(),version_id:f.version.version_id,credential_hash:credential}});const result=f.store.execute({operation:'lab/participant.admission',session_id:s.session_id,credential_hash:credential,data:{action:'join',ticket_id:randomUUID()}});assert.equal(result.status,'ACTIVE');assert.equal(result.limit,null);}assert.equal(f.store.admission.stats().limited_active,0);
});
test('reanswer keeps original evidence, creates one linked marked session and retries with the same credential',t=>{
  const f=fixture(t),event=f.wire('welcome','PAGE_REVISION',{question_id:'ready',answer:'是'});f.ingest([event]);assert.throws(()=>f.call('reanswer',{request_id:'early',credential_hash:digest('next')}),/NOT_TERMINATED/);f.call('terminate',{request_id:'stop',reason:'TEST_ONLY_END'});
  const data={request_id:'restart',credential_hash:digest('next')},s=f.call('reanswer',data);assert.equal(s.state,'CREATED');assert.equal(s.page_index,0);assert.deepEqual(s.answers,{});assert.equal(s.reanswer.old_session_id,f.created.session_id);assert.deepEqual(f.call('reanswer',data),s);assert.throws(()=>f.call('reanswer',{request_id:'other',credential_hash:digest('different')}),/ALREADY_CREATED/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM lab_raw').get().n,1);assert.equal(f.db.prepare('SELECT state FROM lab_sessions WHERE session_id=?').get(f.created.session_id).state,'TERMINATED');assert.equal(f.admin('session.detail',{session_id:s.session_id}).marks[0].type,'REANSWER');assert.throws(()=>f.db.prepare('DELETE FROM lab_reanswer_links').run(),/immutable/);
});
test('screen and action batches retain coordinates and RT separately from page seals',t=>{
  const f=fixture(t),batch={schema:'interaction-v1',time_origin:100000,samples:[{type:'pointerdown',at:123,raw_timestamp:123,rt_ms:23,context:{page_id:'welcome',question_id:'ready'},target:'#choice',box:{x:0,y:10,width:100,height:50},x:42,y:35,pointer_id:1,pointer_type:'touch',trusted:true}]};const e=f.wire('d-ui-clock-0','INPUT_DIAGNOSTIC',{interaction:batch});assert.equal(f.ingest([e]).receipts[0].disposition,'ACCEPTED');const result=f.admin('session.actions',{session_id:f.created.session_id});assert.deepEqual(result.batches[0].samples,batch.samples);assert.equal(result.batches[0].time_origin,100000);
});
