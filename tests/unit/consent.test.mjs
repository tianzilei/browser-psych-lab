import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {compileQuestionnaire,questionnaireTemplate} from '../../src/shared/questionnaire-json.ts';
import {parseProtocol,sampleProtocol,stableJSON} from '../../src/shared/protocol.ts';
import {digest} from '../../src/server/collection-store.ts';
import {fixture} from '../helpers/lab-fixture.mjs';

test('consent is bounded plain text, strict and absent from historical frozen shapes',()=>{
  const input=questionnaireTemplate(),p=compileQuestionnaire(input);assert.deepEqual(p.consent,input.consent);
  assert.deepEqual(parseProtocol(sampleProtocol()),sampleProtocol());assert.equal('consent' in parseProtocol(sampleProtocol()),false);
  for(const consent of [null,{title:'',text:'x'},{title:'x',text:' '},{title:'x',text:'x'.repeat(8001)},{title:'x',text:'x',html:'x'}])assert.throws(()=>compileQuestionnaire({...input,consent}));
  const plain=compileQuestionnaire({...input,consent:{title:'<b>标题</b>',text:'<script>alert(1)</script>'}});assert.equal(plain.consent.text,'<script>alert(1)</script>');
  const legacy=sampleProtocol();assert.equal(digest(stableJSON(parseProtocol(legacy))),digest(stableJSON(legacy)));
});
test('server requires explicit agreement to the frozen document before session and covariates, preserves idempotency and immutable consent',t=>{
  const f=fixture(t),s=f.admin('study.create',{request_id:randomUUID()}),input=questionnaireTemplate();
  const {frozen}=f.admin('study.import',{request_id:randomUUID(),study_id:s.study_id,revision:1,source:JSON.stringify(input)});
  f.admin('study.admission',{request_id:randomUUID(),study_id:s.study_id,paused:false});
  const info=f.store.execute({operation:'lab/version.consent',data:{version_id:frozen.version_id}});
  assert.deepEqual(info.document,input.consent);assert.equal(info.document_hash,digest(stableJSON(input.consent)));
  const base={version_id:frozen.version_id,credential_hash:digest('participant-consent'),server_covariates:{ip:'test-ip'}},create=data=>f.store.execute({operation:'lab/participant.create',data});
  for(const consent of [undefined,{accepted:false,document_hash:info.document_hash},{accepted:true,document_hash:digest('different')},{accepted:true,document_hash:info.document_hash,extra:true}])assert.throws(()=>create({...base,request_id:randomUUID(),...(consent?{consent}:{})}),/CONSENT_REQUIRED/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM lab_sessions WHERE version_id=?').get(frozen.version_id).n,0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM lab_covariates').get().n,0);
  f.setNow(5000);const request={...base,request_id:randomUUID(),consent:{accepted:true,document_hash:info.document_hash}},session=create(request);
  f.setNow(9000);assert.equal(create({...request,server_covariates:{ip:'retry-ip'}}).session_id,session.session_id);
  assert.deepEqual(f.db.prepare('SELECT * FROM lab_consents WHERE session_id=?').get(session.session_id),{session_id:session.session_id,document_hash:info.document_hash,accepted_at:5000});
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM lab_covariates').get().n,1);
  assert.throws(()=>f.db.prepare('UPDATE lab_consents SET accepted_at=1').run(),/immutable consent/);assert.throws(()=>f.db.prepare('DELETE FROM lab_consents').run(),/immutable consent/);
  assert.throws(()=>create({...request,consent:{accepted:false,document_hash:info.document_hash}}),/IDEMPOTENCY_CONFLICT/);
  assert.equal(f.store.execute({operation:'lab/version.consent',data:{version_id:f.version.version_id}}),null);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM lab_consents WHERE session_id=?').get(f.created.session_id).n,0);
});
