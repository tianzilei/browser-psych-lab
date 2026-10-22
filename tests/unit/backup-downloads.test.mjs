import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fixture} from '../helpers/lab-fixture.mjs';
import {digest} from '../../src/server/collection-store.ts';
import {listBackupDownloads} from '../../src/server/backup-downloads.ts';
import Fastify from 'fastify';
import {labRoutes} from '../../src/server/lab-routes.ts';

test('backup options contain only published complete files and listing creates no files or jobs',async t=>{
  const f=fixture(t),root=join(f.root,'research-backups'),prepared=randomUUID(),archived=randomUUID(),missing=randomUUID(),failed=randomUUID(),hash=digest('backup bytes'),manifest=digest('manifest');
  await fs.mkdir(join(root,'downloads'),{recursive:true});await fs.mkdir(join(root,'archives'));
  const add=(job,state,result,at)=>f.db.prepare("INSERT INTO lab_jobs VALUES (?,'BACKUP',NULL,?,?, '{}',?,NULL,?,?)").run(job,state,state,JSON.stringify(result),at,at);
  add(prepared,'READY',{manifest_hash:manifest},2000);add(archived,'ARCHIVED',{archived:true,archive:`archives/${archived}.tar.zst`,archive_bytes:12,archive_sha256:hash},1000);add(missing,'READY',{manifest_hash:manifest},3000);add(failed,'FAILED',{},4000);
  await fs.writeFile(join(root,'downloads',prepared+'.tar.zst'),'backup bytes');await fs.writeFile(join(root,'archives',archived+'.tar.zst'),'backup bytes');
  const sidecar=join(root,'downloads',prepared+'.json');await fs.writeFile(sidecar,JSON.stringify({schema:'backup-download-v1',job_id:prepared,manifest_hash:manifest,bytes:12,sha256:hash}));
  await fs.writeFile(join(root,'downloads',missing+'.tar.zst'),'unpublished');await fs.writeFile(join(root,'downloads',prepared+'.tmp'),'temporary');await fs.writeFile(join(root,'archives',randomUUID()+'.tar.zst'),'orphan');
  const rows=f.admin('backup.list').backups,before=f.db.prepare('SELECT * FROM lab_jobs ORDER BY rowid').all(),listing=()=>listBackupDownloads(f.root,rows);
  const result=await listing();assert.deepEqual(result.map(x=>x.job_id),[prepared,archived]);assert.equal(result[0].url,`/api/lab/backups/${prepared}`);assert.equal(result[0].bytes,12);assert.deepEqual(f.db.prepare('SELECT * FROM lab_jobs ORDER BY rowid').all(),before);
  await fs.writeFile(sidecar,'null');assert.deepEqual((await listing()).map(x=>x.job_id),[archived]);
  await fs.writeFile(sidecar,'x'.repeat(20000));assert.deepEqual((await listing()).map(x=>x.job_id),[archived]);
  await fs.unlink(join(root,'archives',archived+'.tar.zst'));await fs.symlink(join(root,'downloads',prepared+'.tar.zst'),join(root,'archives',archived+'.tar.zst'));assert.deepEqual(await listing(),[]);
  assert.throws(()=>f.store.execute({operation:'lab/backup.list',data:{}}),/LOGIN_REQUIRED/);
});
test('authenticated backup routes stream existing bytes and never dispatch backup generation',async t=>{
  const f=fixture(t),job=randomUUID(),folder=join(f.root,'research-backups','archives'),bytes=Buffer.from('existing compressed backup'),hash=digest(bytes);
  await fs.mkdir(folder,{recursive:true});await fs.writeFile(join(folder,job+'.tar.zst'),bytes);
  f.db.prepare("INSERT INTO lab_jobs VALUES (?,'BACKUP',NULL,'ARCHIVED','ARCHIVED','{}',?,NULL,1,1)").run(job,JSON.stringify({archived:true,archive:`archives/${job}.tar.zst`,archive_bytes:bytes.length,archive_sha256:hash}));
  const before=f.db.prepare('SELECT count(*) n FROM lab_jobs').get().n,app=Fastify();let dispatched=0;
  app.setErrorHandler((error,_request,reply)=>reply.code(error.status??500).send({code:error.code}));
  await labRoutes(app,{request:async command=>f.store.execute(command)},{path:f.path,busy:false,run:async()=>{dispatched++;throw new Error('GENERATION_FORBIDDEN');}},f.root);
  try{
    assert.equal((await app.inject({url:'/api/lab/backups'})).statusCode,401);
    assert.equal((await app.inject({url:'/api/lab/backups/'+job})).statusCode,401);
    const headers={cookie:'lab_admin=admin'},list=await app.inject({url:'/api/lab/backups',headers});assert.equal(list.statusCode,200);assert.equal(list.json().backups.length,1);assert.equal(Object.hasOwn(list.json().backups[0],'path'),false);
    const download=await app.inject({url:'/api/lab/backups/'+job,headers});assert.equal(download.statusCode,200);assert.deepEqual(download.rawPayload,bytes);assert.equal(download.headers['x-content-sha256'],hash);
    assert.equal((await app.inject({url:'/api/lab/backups/'+randomUUID(),headers})).statusCode,404);
    assert.equal(dispatched,0);assert.equal(f.db.prepare('SELECT count(*) n FROM lab_jobs').get().n,before);
  }finally{await app.close();}
});
