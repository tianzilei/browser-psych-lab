import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readdir,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fixture} from '../helpers/lab-fixture.mjs';
import {cleanLightExports} from '../../scripts/lib/light-export-cleanup.mjs';

async function add(f,{kind='EXPORT',format='answers',state='READY',updated=Date.now()-2*86400000}={}){
  const id=randomUUID();
  f.db.prepare('INSERT INTO lab_jobs VALUES (?,?,?,?,?,?,?,NULL,?,?)').run(id,kind,f.study.study_id,state,state,JSON.stringify({format}),'{}',updated,updated);
  const directory=join(f.root,'research-exports',id);await mkdir(directory,{recursive:true});await writeFile(join(directory,'answers.csv'),'test');return id;
}
const state=(f,id)=>f.db.prepare('SELECT state FROM lab_jobs WHERE job_id=?').get(id).state;
test('daily retention spans all studies, removes only expired terminal light exports, and keeps source data',async t=>{
  const f=fixture(t),expired=await add(f),failed=await add(f,{state:'FAILED'}),fresh=await add(f,{updated:Date.now()}),full=await add(f,{format:'all'}),running=await add(f,{state:'RUNNING'}),backup=await add(f,{kind:'BACKUP'});
  const before=f.db.prepare('SELECT * FROM lab_studies').all();
  const dry=await cleanLightExports(f.db,f.root);assert.equal(dry.jobs,2);assert.equal(dry.bytes,8);assert.equal(state(f,expired),'READY');
  const result=await cleanLightExports(f.db,f.root,{apply:true});assert.equal(result.jobs,2);
  assert.equal(state(f,expired),'PURGED');assert.equal(state(f,failed),'PURGED');
  assert.deepEqual((await readdir(join(f.root,'research-exports'))).sort(),[fresh,full,running,backup].sort());
  assert.deepEqual(f.db.prepare('SELECT * FROM lab_studies').all(),before);
  assert.equal(f.db.prepare("SELECT count(*) n FROM lab_audit WHERE actor='SYSTEM' AND operation='export.snapshot.purge'").get().n,2);
  assert.equal((await cleanLightExports(f.db,f.root,{apply:true})).jobs,0);
  assert.equal((await cleanLightExports(f.db,f.root,{apply:true,retentionMs:0})).jobs,1);
});
test('cleanup refuses symlink entries before touching any terminal export',async t=>{
  const f=fixture(t),id=await add(f);await symlink(join(f.root,'db.sqlite'),join(f.root,'research-exports',id,'unsafe'));
  await assert.rejects(cleanLightExports(f.db,f.root,{apply:true}),/UNSAFE_EXPORT_ENTRY/);assert.equal(state(f,id),'READY');
});
