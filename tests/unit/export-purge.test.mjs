import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fixture} from '../helpers/lab-fixture.mjs';
import {purgeExportSnapshots,recoverExportPurges} from '../../scripts/lib/export-purge.mjs';

async function exportsFixture(t){
  const f=fixture(t),plan=[];
  for(let i=0;i<2;i++){
    const job=randomUUID();
    f.db.prepare("INSERT INTO lab_jobs VALUES (?,'EXPORT',?,'READY','READY','{}','{}',NULL,?,?)").run(job,f.study.study_id,Date.now(),Date.now());
    const dir=join(f.root,'research-exports',job);await fs.mkdir(dir,{recursive:true});await fs.writeFile(join(dir,'answers.csv'),'preserved answers');
    plan.push({job_id:job,study_id:f.study.study_id,state:'READY',files:[{name:'answers.csv'}],bytes:17,missing:false});
  }
  return {...f,plan};
}
const jobState=(f,job)=>f.db.prepare('SELECT state FROM lab_jobs WHERE job_id=?').get(job).state;

test('a second rename failure rolls back earlier directories and leaves export jobs READY',async t=>{
  const f=await exportsFixture(t);let calls=0;
  await assert.rejects(purgeExportSnapshots(f.db,f.root,f.plan,'test',{
    rename:async(from,to)=>{if(++calls===2)throw new Error('RENAME_FAILED');await fs.rename(from,to);},rm:fs.rm,
  }),/RENAME_FAILED/);
  for(const p of f.plan){assert.equal(jobState(f,p.job_id),'READY');assert.equal(await fs.readFile(join(f.root,'research-exports',p.job_id,'answers.csv'),'utf8'),'preserved answers');}
  assert.equal(f.db.prepare("SELECT count(*) n FROM lab_audit WHERE operation='export.snapshot.purge'").get().n,0);
});

test('a database failure rolls back both export state and all directory renames',async t=>{
  const f=await exportsFixture(t);
  f.db.exec("CREATE TRIGGER fail_purge BEFORE INSERT ON lab_audit WHEN NEW.operation='export.snapshot.purge' BEGIN SELECT RAISE(ABORT,'AUDIT_FAILED'); END");
  await assert.rejects(purgeExportSnapshots(f.db,f.root,f.plan,'test'),/AUDIT_FAILED/);
  for(const p of f.plan){assert.equal(jobState(f,p.job_id),'READY');await fs.access(join(f.root,'research-exports',p.job_id,'answers.csv'));}
});

test('interrupted pre-commit renames are recovered, including an empty directory recreated by downloads',async t=>{
  const f=await exportsFixture(t),p=f.plan[0],dir=join(f.root,'research-exports',p.job_id);
  await fs.rename(dir,dir+'.purging-interrupted');await fs.mkdir(dir);
  await assert.rejects(recoverExportPurges(f.db,f.root,[f.study.study_id]),/RECOVERY_REQUIRED/);
  await recoverExportPurges(f.db,f.root,[f.study.study_id],{apply:true});
  assert.equal(await fs.readFile(join(dir,'answers.csv'),'utf8'),'preserved answers');assert.equal(jobState(f,p.job_id),'READY');
  const purged=await purgeExportSnapshots(f.db,f.root,f.plan,'retry');assert.equal(purged.length,2);
  for(const job of f.plan){assert.equal(jobState(f,job.job_id),'PURGED');await assert.rejects(fs.access(join(f.root,'research-exports',job.job_id)));}
});

test('post-commit deletion failure resumes cleanup without changing other studies',async t=>{
  const f=await exportsFixture(t);
  await assert.rejects(purgeExportSnapshots(f.db,f.root,f.plan,'test',{rename:fs.rename,rm:async()=>{throw new Error('REMOVE_FAILED');}}),/REMOVE_FAILED/);
  for(const p of f.plan)assert.equal(jobState(f,p.job_id),'PURGED');
  assert.deepEqual(await recoverExportPurges(f.db,f.root,[randomUUID()],{apply:true}),[]);
  const recovered=await recoverExportPurges(f.db,f.root,[f.study.study_id],{apply:true});assert.equal(recovered.length,2);
  assert.deepEqual(await fs.readdir(join(f.root,'research-exports')),[]);
});

test('recovery refuses to overwrite an existing populated export directory',async t=>{
  const f=await exportsFixture(t),dir=join(f.root,'research-exports',f.plan[0].job_id);
  await fs.rename(dir,dir+'.purging-interrupted');await fs.mkdir(dir);await fs.writeFile(join(dir,'other.csv'),'keep');
  await assert.rejects(recoverExportPurges(f.db,f.root,[f.study.study_id],{apply:true}),/RECOVERY_CONFLICT/);
  assert.equal(await fs.readFile(join(dir,'other.csv'),'utf8'),'keep');
  assert.equal(await fs.readFile(join(dir+'.purging-interrupted','answers.csv'),'utf8'),'preserved answers');
});
