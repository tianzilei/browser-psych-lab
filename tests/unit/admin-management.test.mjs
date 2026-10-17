import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from '../helpers/lab-fixture.mjs';
import {LabStore} from '../../src/server/lab-store.ts';
import {csvCell} from '../../src/server/export-csv.ts';

test('rename changes display metadata with optimistic concurrency and preserves frozen evidence',t=>{
  const f=fixture(t),before=f.admin('study.get',{study_id:f.study.study_id}),revision=before.revision;
  const request={request_id:randomUUID(),study_id:f.study.study_id,revision,title:'  新的问卷名称  '};
  const renamed=f.admin('study.rename',request);assert.equal(renamed.title,'新的问卷名称');assert.equal(renamed.revision,revision+1);
  assert.deepEqual(f.admin('study.rename',request),renamed);
  assert.throws(()=>f.admin('study.rename',{...request,request_id:randomUUID(),title:'过时修改'}),/DRAFT_REVISION_CONFLICT/);
  assert.throws(()=>f.admin('study.rename',{...request,title:'不同内容'}),/IDEMPOTENCY_CONFLICT/);
  for(const title of ['', '  ', 'a'.repeat(201),12])assert.throws(()=>f.admin('study.rename',{...request,request_id:randomUUID(),revision:renamed.revision,title}),/INVALID_STUDY_TITLE/);
  assert.throws(()=>f.admin('study.rename',{...request,request_id:randomUUID(),csrf:'wrong'}),/CSRF_REJECTED/);
  const after=f.admin('study.get',{study_id:f.study.study_id});assert.deepEqual(after.draft,before.draft);assert.equal(after.source,before.source);assert.deepEqual(after.versions,before.versions);
  assert.deepEqual(f.store.frozen(f.version.version_id),f.version);
  assert.equal(f.store.execute({operation:'lab/questionnaires.public',data:{}}).questionnaires[0].title,'新的问卷名称');
  assert.equal(f.admin('study.list').studies[0].protocol_title,f.version.protocol.title);
  assert.equal(f.db.prepare("SELECT count(*) n FROM lab_audit WHERE operation='study.rename'").get().n,1);
});

test('full list ordering is persistent, atomic, shared with public list and rejects stale or incomplete snapshots',t=>{
  const f=fixture(t),other=f.admin('study.create',{request_id:randomUUID()});
  f.admin('study.publish',{request_id:randomUUID(),study_id:other.study_id,revision:1});f.admin('study.admission',{request_id:randomUUID(),study_id:other.study_id,paused:false});
  const order=()=>f.admin('study.list').studies.map(s=>s.study_id),expected=order(),reversed=[...expected].reverse();
  const request={request_id:randomUUID(),order:reversed,expected_order:expected};f.admin('study.reorder',request);assert.deepEqual(order(),reversed);assert.deepEqual(f.admin('study.reorder',request),{order:reversed});
  assert.throws(()=>f.admin('study.reorder',{...request,request_id:randomUUID()}),/STUDY_ORDER_CONFLICT/);
  for(const invalid of [[reversed[0]], [reversed[0],reversed[0]], [reversed[0],randomUUID()]])assert.throws(()=>f.admin('study.reorder',{request_id:randomUUID(),expected_order:reversed,order:invalid}),/INVALID_STUDY_ORDER/);
  assert.deepEqual(order(),reversed);
  assert.deepEqual(f.store.execute({operation:'lab/questionnaires.public',data:{}}).questionnaires.map(q=>q.version_id),[f.admin('study.get',{study_id:other.study_id}).versions[0].version_id,f.version.version_id]);
  new LabStore(f.db);assert.deepEqual(order(),reversed);
  f.admin('study.admission',{request_id:randomUUID(),study_id:other.study_id,paused:true});assert.equal(f.store.execute({operation:'lab/questionnaires.public',data:{}}).questionnaires.length,1);
  f.admin('study.admission',{request_id:randomUUID(),study_id:other.study_id,paused:false});assert.deepEqual(order(),reversed);
  assert.throws(()=>f.admin('study.delete',{request_id:randomUUID(),study_id:other.study_id}),/QUESTIONNAIRE_DELETION_DISABLED/);f.db.prepare('INSERT INTO lab_archived_studies VALUES (?,?)').run(other.study_id,1000);assert.throws(()=>f.admin('study.reorder',{request_id:randomUUID(),expected_order:reversed,order:expected}),/STUDY_ORDER_CONFLICT/);
  assert.throws(()=>f.admin('study.rename',{request_id:randomUUID(),study_id:other.study_id,revision:1,title:'deleted'}),/STUDY_NOT_FOUND/);
});

test('legacy order seeds rowid descending once and lists beyond the previous 100-study cap',t=>{
  const f=fixture(t);for(let i=0;i<103;i++)f.admin('study.create',{request_id:randomUUID()});
  const legacy=f.db.prepare('SELECT study_id FROM lab_studies ORDER BY rowid DESC').all().map(s=>s.study_id);f.db.exec('DROP TABLE lab_study_order');
  new LabStore(f.db);assert.deepEqual(f.admin('study.list').studies.map(s=>s.study_id),legacy);assert.equal(legacy.length,104);
  const order=[...legacy].reverse();f.admin('study.reorder',{request_id:randomUUID(),expected_order:legacy,order});new LabStore(f.db);assert.deepEqual(f.admin('study.list').studies.map(s=>s.study_id),order);
  const next=f.admin('study.create',{request_id:randomUUID()});assert.equal(f.admin('study.list').studies.at(-1).study_id,next.study_id);
});

test('hidden questionnaires block new sessions while current session can seal and finish',t=>{
  const f=fixture(t);f.admin('study.admission',{request_id:randomUUID(),study_id:f.study.study_id,paused:true});
  assert.throws(()=>f.store.execute({operation:'lab/participant.create',data:{...f.admission,request_id:randomUUID()}}),/ADMISSION_PAUSED/);
  const page=f.version.protocol.pages[0],row=f.wire(page.id,'PAGE_SNAPSHOT',{answers:{ready:'是'}});f.ingest([row]);const seal=f.seal(page.id,[row],[page.id]);
  assert.equal(f.call('finalize',{request_id:randomUUID(),...f.fence,seal_ids:[seal.seal_id]}).status,'COMPLETED');
  const unpublished=f.admin('study.create',{request_id:randomUUID()});assert.throws(()=>f.admin('study.admission',{request_id:randomUUID(),study_id:unpublished.study_id,paused:false}),/VERSION_REQUIRED/);
  assert.throws(()=>f.admin('study.admission',{request_id:randomUUID(),study_id:randomUUID(),paused:true}),/STUDY_NOT_FOUND/);
  const offset=f.admin('session.list',{study_id:f.study.study_id,limit:'100',offset:'0'});assert.equal(offset.sessions.length,1);
  assert.equal(f.admin('session.list',{study_id:f.study.study_id,limit:'100',offset:'1'}).sessions.length,0);
});

test('CSV escaping prevents text formulas without changing numeric negatives or exact JSON',()=>{
  assert.equal(csvCell(-1),'"-1"');assert.equal(csvCell(' =SUM(1,2)'),`"' =SUM(1,2)"`);assert.equal(csvCell('\t=1'),`"'\t=1"`);
  assert.equal(csvCell('你好,"引号"\n下一行'),'"你好,""引号""\n下一行"');assert.equal(csvCell(null),'""');
  assert.equal(csvCell(JSON.stringify({value:'=1'})),'"{""value"":""=1""}"');
});
