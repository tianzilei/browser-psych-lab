import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import Database from 'better-sqlite3';
import {DatabaseWriter} from '../../src/server/writer.ts';
import {Maintenance} from '../../src/server/maintenance.ts';
import {retainRelease} from '../../src/server/release.ts';
import {RunnerAssetPolicy} from '../../src/server/runner-asset-policy.ts';
import {restoreBackup} from '../../src/server/restore.ts';
import {privateRoot,writeDurable,publishExclusive,fileHash,openPrivate} from '../../src/server/private-files.ts';
import {stableJSON} from '../../src/shared/protocol.ts';
import {digest} from '../../src/server/collection-store.ts';
test('exclusive durable publication refuses different bytes and symlinks',async t=>{
  const root=await mkdtemp(join(tmpdir(),'bpl-files-'));t.after(()=>rm(root,{recursive:true,force:true}));await privateRoot(root);
  await writeDurable(join(root,'temp-a'),'first');await publishExclusive(join(root,'temp-a'),join(root,'asset'));assert.equal(await fileHash(join(root,'asset')),digest('first'));
  await writeDurable(join(root,'temp-b'),'second');await assert.rejects(publishExclusive(join(root,'temp-b'),join(root,'asset')));assert.equal(await fileHash(join(root,'asset')),digest('first'));
  await symlink(join(root,'asset'),join(root,'linked'));await assert.rejects(openPrivate(join(root,'linked')));
});
test('header validation, blocked recovery, snapshot CSV, joint backup and closed-gate restore preserve exact files',async t=>{
  const root=await mkdtemp(join(tmpdir(),'bpl-maintenance-')),dbPath=join(root,'db.sqlite');const hash=await retainRelease(root),writer=new DatabaseWriter(dbPath,{workerData:{runnerHash:hash}});await writer.start();const maintenance=new Maintenance(writer,dbPath,root);
  t.after(async()=>{await maintenance.close();await writer.close();await rm(root,{recursive:true,force:true});});
  const call=(op,data={})=>writer.request({operation:`lab/${op}`,data});const token=digest('admin'),csrf=randomUUID();await call('admin.issue',{token_hash:token,csrf});
  const admin=(op,data={})=>writer.request({operation:`lab/${op}`,credential_hash:token,data:{...data,csrf}});
  const study=await admin('study.create',{request_id:randomUUID()});const version=await admin('study.publish',{request_id:randomUUID(),study_id:study.study_id,revision:1});assert.equal(version.runner_hash,hash);
  const asset=await admin('asset.begin',{request_id:randomUUID(),study_id:study.study_id,name:'verified.png'});await mkdir(join(root,'research-assets','.tmp'),{recursive:true,mode:0o700});const temp=join(root,'research-assets','.tmp',`${asset.asset_id}-fixture`);const png=await sharp({create:{width:32,height:24,channels:3,background:'#123456'}}).png().toBuffer();await writeDurable(temp,png);const uploaded=await maintenance.run('UPLOAD',{asset_id:asset.asset_id,temp});assert.equal(uploaded.result.info.hash,digest(png));assert.equal(uploaded.result.info.width,32);
  const bad=await admin('asset.begin',{request_id:randomUUID(),study_id:study.study_id,name:'broken.png'}),badPath=join(root,'research-assets','.tmp',`${bad.asset_id}-fixture`);await writeDurable(badPath,png.subarray(0,40));await assert.rejects(maintenance.run('UPLOAD',{asset_id:bad.asset_id,temp:badPath}));const job=(await admin('job.list')).jobs.find(j=>j.state==='RECOVERY_REQUIRED');assert.ok(job);await assert.rejects(maintenance.run('EXPORT',{study_id:study.study_id}),/MAINTENANCE_BUSY/);const recovered=await maintenance.recover(job.job_id,'Full file inventory reviewed by test operator');assert.equal(recovered.result.verified,true);assert.equal((await admin('job.get',{job_id:job.job_id})).state,'FAILED');
  const badPackage=randomUUID(),badZip=join(root,'research-assets','.tmp',`${badPackage}-zip`);await writeDurable(badZip,'invalid zip');await assert.rejects(maintenance.run('PACKAGE',{study_id:study.study_id,name:'bad.zip',package_id:badPackage,temp:badZip}),/INVALID_IMAGE_PACKAGE/);assert.equal((await admin('job.list')).jobs.some(j=>j.state==='RECOVERY_REQUIRED'),false);
  const packageId=randomUUID(),packageTemp=join(root,'research-assets','.tmp',`${packageId}-zip`);await writeDurable(packageTemp,await readFile('examples/stimuli/mobile-stimuli.zip'));const packed=await maintenance.run('PACKAGE',{study_id:study.study_id,name:'mobile-stimuli.zip',package_id:packageId,temp:packageTemp});assert.equal(packed.result.images[0].width,1080);
  const imported=await admin('study.import',{request_id:randomUUID(),study_id:study.study_id,revision:1,source:await readFile('examples/questionnaires/with-images.json','utf8')});await admin('study.admission',{request_id:randomUUID(),study_id:study.study_id,paused:false});
  const credential=digest('participant-env'),create={request_id:randomUUID(),version_id:imported.frozen.version_id,credential_hash:credential,consent:{accepted:true,document_hash:digest(stableJSON(imported.frozen.protocol.consent))}};const session=await call('participant.create',{...create,server_covariates:{user_agent:'server-test',observed_at:'first'}});assert.equal((await call('participant.create',{...create,server_covariates:{user_agent:'changed',observed_at:'second'}})).session_id,session.session_id);
  const raw=JSON.stringify({schema:'environment-v1',user_agent:'test-browser',viewport:{width:390,height:844}}),sample={request_id:randomUUID(),sample_id:randomUUID(),raw};const client=(data)=>writer.request({operation:'lab/participant.covariates',session_id:session.session_id,credential_hash:credential,data});const ack=await client(sample);assert.equal(ack.hash,digest(raw));assert.deepEqual(await client(sample),ack);await assert.rejects(client({...sample,raw:raw+' '}),/IDEMPOTENCY_CONFLICT/);
  const exported=await maintenance.run('EXPORT',{study_id:study.study_id});const csv=await readFile(join(root,'research-exports',exported.job_id,'data.csv'),'utf8');assert.ok(csv.includes('versions'));assert.ok(csv.includes('covariates'));assert.ok(csv.includes('test-browser'));assert.ok(csv.includes('mobile-stimuli.zip'));const em=JSON.parse(await readFile(join(root,'research-exports',exported.job_id,'manifest.json'),'utf8'));assert.equal(em.csv_hash,await fileHash(join(root,'research-exports',exported.job_id,'data.csv')));assert.equal(em.tables.covariates,2);assert.equal(em.tables.consents,1);assert.ok(csv.includes('consents'));assert.ok(csv.includes(create.consent.document_hash));
  const rebuilt=await maintenance.run('REBUILD',{study_id:study.study_id});assert.deepEqual(rebuilt.result.projections,[]);const state=new Database(dbPath,{readonly:true});try{assert.equal(state.prepare("SELECT value FROM lab_meta WHERE key='active_projection'").get().value,rebuilt.job_id);}finally{state.close();}
  const backup=await maintenance.run('BACKUP',{});assert.equal(backup.result.independent,false);const bundle=join(root,'research-backups',backup.job_id),destination=join(root,'restored');const report=await restoreBackup(bundle,destination);assert.equal(report.gate,'CLOSED');assert.equal(await fileHash(join(destination,'research-assets',`${asset.asset_id}.bin`)),digest(png));
  const runner=JSON.parse(await readFile(join(root,'research-assets/runners',hash,'release.json'),'utf8'));
  assert.equal(await new RunnerAssetPolicy(destination).get(hash),'ticket');
  for(const variant of runner.representations??[])assert.equal(await fileHash(join(destination,'research-assets/runners',hash,variant.path)),variant.hash);
  const restored=new Database(join(destination,'database/browser-psych-lab.sqlite'),{readonly:true});try{assert.equal(restored.prepare("SELECT value FROM lab_meta WHERE key='collection_gate'").get().value,'CLOSED');assert.equal(restored.prepare('SELECT count(*) AS n FROM lab_admin_tokens').get().n,0);assert.equal(restored.prepare('SELECT hash FROM lab_versions').get().hash,version.hash);assert.equal(restored.pragma('integrity_check',{simple:true}),'ok');assert.equal(restored.prepare("SELECT count(*) AS n FROM lab_jobs WHERE state='RECOVERY_REQUIRED'").get().n,1);}finally{restored.close();}
  await assert.rejects(restoreBackup(bundle,destination),/MUST_NOT_EXIST/);const manifest=JSON.parse(await readFile(join(bundle,'manifest.json'),'utf8'));manifest.files[0].hash=digest('wrong');await writeFile(join(bundle,'manifest.json'),JSON.stringify(manifest));await assert.rejects(restoreBackup(bundle,join(root,'corrupt-restore')),/HASH_MISMATCH/);
});
