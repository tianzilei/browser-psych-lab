import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from '../helpers/lab-fixture.mjs';
import {sampleProtocol} from '../../src/shared/protocol.ts';
import {parsePreparationReport} from '../../src/shared/preparation-report.ts';
import {preparationRows} from '../../src/server/preparation-export.ts';
const report=(budget=40)=>({schema:'preparation-v1',attempt_id:randomUUID(),phase:'group-readiness',outcome:'STORAGE_REJECTED',group_id:null,started_at:'2026-10-16T12:00:00.000Z',elapsed_ms:60001,configured_commit_ms:budget,stages:{session:59000,storage:1001},device:{user_agent:'Mobile WeChat',platform:'Android',language:'zh-CN',cores:4,memory_gb:4,width:390,height:844,dpr:3,network:{online:true}},storage:{commit_ms:113,samples:[113,100,102,101,99,98,97,95,101,110],path:'four-full-envelope-meta-events-outbox-strict-v1',audit_bytes:17524}});
test('failed preparation is immutable, idempotent, linked to the frozen budget, and separate from environment quota',t=>{
 const f=fixture(t),r=report(),data={request_id:randomUUID(),sample_id:r.attempt_id,raw:JSON.stringify(r)};
 const a=f.call('covariates',data);assert.equal(a.status,'PERSISTED');assert.deepEqual(f.call('covariates',data),a);
 assert.equal(f.db.prepare("SELECT count(*) n FROM lab_covariates WHERE source='preparation-reported'").get().n,1);
 assert.throws(()=>f.call('covariates',{...data,request_id:randomUUID(),raw:JSON.stringify({...r,error:'changed'})}),/COVARIATES_CONFLICT/);
 for(const change of [x=>x.configured_commit_ms=1000,x=>x.group_id='foreign',x=>x.storage.samples[0]=200]){
  const bad=report();change(bad);assert.throws(()=>f.call('covariates',{request_id:randomUUID(),sample_id:bad.attempt_id,raw:JSON.stringify(bad)}),/INVALID_PREPARATION_REPORT/);
 }
 for(let i=0;i<50;i++)f.call('covariates',{request_id:randomUUID(),sample_id:randomUUID(),raw:JSON.stringify({schema:'environment-v1',user_agent:'Mobile'})});
 const second=report();assert.equal(f.call('covariates',{request_id:randomUUID(),sample_id:second.attempt_id,raw:JSON.stringify(second)}).status,'PERSISTED');
 assert.throws(()=>f.db.prepare('DELETE FROM lab_covariates WHERE sample_id=?').run(r.attempt_id),/immutable covariates/);
});
test('analysis records retain rejected samples, observed delays, source identities and missing historical values',t=>{
 const f=fixture(t),view=f.call('view'),session={...view,version_id:view.frozen.version_id};let rows=[...preparationRows(f.db,session,session.frozen.protocol)];
 assert.equal(rows[0].configured_commit_ms,40);assert.equal(rows[0].storage_result,'NOT_MEASURED');assert.equal(rows[0].measured_commit_ms,null);assert.equal(rows[0].outcome,'NOT_APPLICABLE');
 const r=report();f.call('covariates',{request_id:randomUUID(),sample_id:r.attempt_id,raw:JSON.stringify(r)});
 rows=[...preparationRows(f.db,session,session.frozen.protocol)];assert.equal(rows.length,1);assert.equal(rows[0].record_source,'client-preparation');assert.equal(rows[0].storage_result,'REJECTED');assert.equal(rows[0].measured_commit_ms,113);assert.equal(rows[0].user_agent,'Mobile WeChat');assert.equal(JSON.parse(rows[0].stages_json).session,59000);assert.deepEqual(JSON.parse(rows[0].samples_json),r.storage.samples);
});
test('reports bound malformed samples and timings before persistence',()=>{
 for(const change of [x=>x.elapsed_ms=-1,x=>x.device.width=0,x=>x.storage.samples=[],x=>x.storage.commit_ms=NaN,x=>x.started_at='bad',x=>x.outcome='PASSED']){const r=report();change(r);assert.throws(()=>parsePreparationReport(r),/INVALID_PREPARATION_REPORT/);}
 const p=report(1000);p.outcome='READY';assert.equal(parsePreparationReport(p).storage.commit_ms,113);
});

test('the same measured device result is evaluated against each frozen questionnaire budget',t=>{
 const p=sampleProtocol();p.budget.commit_ms=1000;const f=fixture(t,p),view=f.call('view'),session={...view,version_id:view.frozen.version_id};
 const r=report(1000);r.outcome='READY';r.device.session_id='forged';r.device.configured_commit_ms=1;
 f.call('covariates',{request_id:randomUUID(),sample_id:r.attempt_id,raw:JSON.stringify(r)});
 const [row]=preparationRows(f.db,session,p);assert.equal(row.configured_commit_ms,1000);assert.equal(row.storage_result,'PASSED');assert.equal(row.measured_commit_ms,113);assert.equal(row.session_id,session.session_id);
});
