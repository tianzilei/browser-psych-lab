import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import Database from 'better-sqlite3';
import {fixture} from '../helpers/lab-fixture.mjs';
import {businessFingerprint,bundleStructure,baseCovers,fileSha256,verifyBundle} from '../../scripts/lib/backup-integrity.mjs';
import {archiveBackup,prepareBackupDownload} from '../../scripts/lib/backup-archive.mjs';

const toolsAvailable=spawnSync('zstd',['--version']).status===0&&spawnSync('tar',['--version']).status===0;
const archiveTest={skip:toolsAvailable?false:'zstd and tar are required for archive integration tests'};
function addJob(f,job,state='READY',result={}){
  f.db.prepare("INSERT INTO lab_jobs VALUES (?,'BACKUP',NULL,?,?, '{}',?,NULL,?,?)").run(job,state,state,JSON.stringify(result),Date.now(),Date.now());
}
async function bundle(f){
  const job=randomUUID(),backupsRoot=path.join(f.root,'research-backups'),dir=path.join(backupsRoot,job),runner=f.version.runner_hash;
  const runnerDir=path.join(dir,'runners',runner);
  fs.mkdirSync(runnerDir,{recursive:true,mode:0o700});
  await f.db.backup(path.join(dir,'database.sqlite'));
  fs.writeFileSync(path.join(runnerDir,'release.json'),'{}');fs.writeFileSync(path.join(runnerDir,'run.html'),'<html>fixture</html>');
  const files=['database.sqlite',`runners/${runner}/release.json`,`runners/${runner}/run.html`].map(p=>({path:p,hash:fileSha256(path.join(dir,p))}));
  fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({schema:'backup-v1',job_id:job,assets:[],files}));
  addJob(f,job);
  return {job,dir,backupsRoot,runnerDir,manifestHash:fileSha256(path.join(dir,'manifest.json'))};
}
function script(f,name,args=[],extraEnv={}){
  return spawnSync(process.execPath,[`scripts/${name}.mjs`,...args],{encoding:'utf8',env:{...process.env,
    DATABASE_PATH:f.path,STORAGE_ROOT:f.root,BACKUP_RELEASE_ROOT:process.cwd(),
    BACKUP_PASSWORD_FILE:'',BACKUP_ALERT_WEBHOOK:'',BACKUP_HEALTHCHECK_URL:'',BACKUP_ALERT_HEALTHCHECK_FAIL_URL:'',...extraEnv}});
}

test('business fingerprints track reorder, equal-count admission swaps and environment records',t=>{
  const f=fixture(t),second=f.admin('study.create',{request_id:randomUUID()});
  f.admin('study.publish',{request_id:randomUUID(),study_id:second.study_id,revision:1});
  let before=businessFingerprint(f.db);
  const order=f.admin('study.list').studies.map(s=>s.study_id);
  f.admin('study.reorder',{request_id:randomUUID(),expected_order:order,order:[...order].reverse()});
  let after=businessFingerprint(f.db);assert.notEqual(after,before);before=after;
  f.admin('study.admission',{request_id:randomUUID(),study_id:f.study.study_id,paused:true});
  f.admin('study.admission',{request_id:randomUUID(),study_id:second.study_id,paused:false});
  after=businessFingerprint(f.db);assert.notEqual(after,before);before=after;
  f.admin('environment.put',{request_id:randomUUID(),environment_id:randomUUID(),record:Object.fromEntries(
    ['hardware','filesystem','device_matrix','capacity_report','independent_restore_report','backup_target','rpo','rto','operator','verified_at'].map(k=>[k,'verified-test']))});
  assert.notEqual(businessFingerprint(f.db),before);
});

test('business fingerprint covers uploaded assets and asset references',t=>{
  const f=fixture(t),before=businessFingerprint(f.db),asset=randomUUID();
  f.db.prepare("INSERT INTO lab_assets(asset_id,study_id,name,state,hash,bytes,width,height,format,upload_id,created_at) VALUES (?,?,?,'READY',?,?,?,?,?,?,?)")
    .run(asset,f.study.study_id,'new.png','a'.repeat(64),128,8,8,'png',randomUUID(),Date.now());
  assert.notEqual(businessFingerprint(f.db),before);
  const withAsset=businessFingerprint(f.db);
  f.db.prepare("INSERT INTO lab_asset_refs VALUES (?,'DRAFT',?)").run(asset,f.study.study_id);
  assert.notEqual(businessFingerprint(f.db),withAsset);
});

test('backup bookkeeping leaves the shared fingerprint unchanged and readonly computation is stable',t=>{  const f=fixture(t),before=businessFingerprint(f.db);
  addJob(f,randomUUID());
  f.db.prepare('INSERT INTO lab_audit VALUES (?,?,?,?,?,?)').run(randomUUID(),'SYSTEM','backup.test','test','{}',Date.now());
  f.db.prepare("UPDATE lab_meta SET value='backup-test' WHERE key='resource_barrier'").run();
  const readonly=new Database(f.path,{readonly:true,fileMustExist:true});
  try{assert.equal(businessFingerprint(readonly),before);}finally{readonly.close();}
  assert.equal(businessFingerprint(f.db),before);
});

test('backup and snapshot CLI use the same versioned business fingerprint',async t=>{
  const f=fixture(t),b=await bundle(f),fingerprint=businessFingerprint(f.db);
  fs.writeFileSync(path.join(b.backupsRoot,'.last-backup-fingerprint.json'),JSON.stringify({fingerprint,job_id:b.job}));
  fs.writeFileSync(path.join(b.backupsRoot,'.base-bundle.json'),JSON.stringify({job_id:b.job,path:b.job,manifest_hash:b.manifestHash}));
  const full=script(f,'backup-light',['--dry-run']);assert.equal(full.status,0,full.stderr);
  assert.equal(JSON.parse(full.stdout).fingerprint,fingerprint);assert.equal(JSON.parse(full.stdout).needs_backup,false);
  const snap=script(f,'sqlite-snapshot',['--dry-run']);assert.equal(snap.status,0,snap.stderr);
  assert.equal(JSON.parse(snap.stdout).fingerprint,fingerprint);
});

test('base validation rejects a missing runner, changed file, changed manifest and undeclared references',async t=>{
  const f=fixture(t),b=await bundle(f),current=bundleStructure(f.db),expected={manifestHash:b.manifestHash,jobId:b.job};
  assert.equal(baseCovers(Database,b.dir,current,expected),true);
  const run=path.join(b.runnerDir,'run.html'),original=fs.readFileSync(run);
  fs.rmSync(run);assert.equal(baseCovers(Database,b.dir,current,expected),false);
  fs.writeFileSync(run,'corrupt');assert.equal(baseCovers(Database,b.dir,current,expected),false);
  fs.writeFileSync(run,original);
  const manifestPath=path.join(b.dir,'manifest.json'),manifest=fs.readFileSync(manifestPath,'utf8');
  fs.writeFileSync(manifestPath,manifest+'\n');assert.equal(baseCovers(Database,b.dir,current,expected),false);
  const changed=JSON.parse(manifest);changed.files=changed.files.filter(f=>!f.path.endsWith('/run.html'));
  fs.writeFileSync(manifestPath,JSON.stringify(changed));assert.equal(baseCovers(Database,b.dir,current),false);
});

test('snapshot refuses to reuse a damaged base instead of silently skipping unchanged data',async t=>{
  const f=fixture(t),b=await bundle(f),fingerprint=businessFingerprint(f.db);
  fs.writeFileSync(path.join(b.backupsRoot,'.base-bundle.json'),JSON.stringify({job_id:b.job,path:b.job,manifest_hash:b.manifestHash}));
  fs.writeFileSync(path.join(b.backupsRoot,'.last-sqlite-fingerprint.json'),JSON.stringify({fingerprint}));
  fs.rmSync(path.join(b.runnerDir,'run.html'));
  const result=script(f,'sqlite-snapshot');
  assert.notEqual(result.status,0);assert.match(result.stderr,/BASE_STRUCTURE_CHANGED_AND_BACKUP_PASSWORD_FILE_MISSING/);
  assert.ok(!result.stdout.includes('SKIP_NO_DATA_CHANGES'));
});

test('monitor reports damaged base files even when pointers, hashes and systemd timers otherwise agree',archiveTest,async t=>{
  const f=fixture(t),b=await bundle(f),fingerprint=businessFingerprint(f.db),at=new Date().toISOString();
  const snapRoot=path.join(b.backupsRoot,'sqlite-snapshots');fs.mkdirSync(snapRoot);
  const name='sqlite-fixture.sqlite.zst',snapPath=path.join(snapRoot,name);
  assert.equal(spawnSync('zstd',['-q',path.join(b.dir,'database.sqlite'),'-o',snapPath]).status,0);
  const sha256=fileSha256(snapPath);
  fs.writeFileSync(snapPath+'.sha256',sha256+'  '+name+'\n');
  fs.writeFileSync(snapPath.replace(/\.sqlite\.zst$/,'.json'),JSON.stringify({schema:'sqlite-snapshot-v1',created_at:at,sha256,base:{job_id:b.job,manifest_hash:b.manifestHash}}));
  fs.writeFileSync(path.join(b.backupsRoot,'.last-backup-fingerprint.json'),JSON.stringify({fingerprint,job_id:b.job,at}));
  fs.writeFileSync(path.join(b.backupsRoot,'.last-sqlite-fingerprint.json'),JSON.stringify({fingerprint,file:name,base_job:b.job,at}));
  fs.writeFileSync(path.join(b.backupsRoot,'.base-bundle.json'),JSON.stringify({job_id:b.job,path:b.job,manifest_hash:b.manifestHash}));
  const bin=path.join(f.root,'bin');fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin,'systemctl'),'#!/bin/sh\ncase "$1" in is-active) echo active;; is-enabled) echo enabled;; *) echo inactive;; esac\n',{mode:0o700});
  const env={PATH:bin+path.delimiter+process.env.PATH,BACKUP_MIN_FREE_GB:'0',BACKUP_MIN_FREE_PERCENT:'0'};
  const healthy=script(f,'backup-monitor',[],env);assert.equal(healthy.status,0,healthy.stderr);
  fs.rmSync(path.join(b.runnerDir,'run.html'));
  const broken=script(f,'backup-monitor',[],env);assert.equal(broken.status,1,broken.stderr);
  const report=JSON.parse(fs.readFileSync(path.join(f.root,'backup-status.json'),'utf8'));
  assert.equal(report.status,'ALERT');assert.ok(report.alerts.some(c=>c.name==='base_structure'));
  assert.ok(report.alerts.some(c=>c.name==='full_bundle'));
});

test('tar failure preserves the READY source and removes the temporary archive even with a valid zstd stream',archiveTest,async t=>{
  const f=fixture(t),b=await bundle(f),bin=path.join(f.root,'bin');fs.mkdirSync(bin);
  const tar=spawnSync('which',['tar'],{encoding:'utf8'}).stdout.trim();
  fs.writeFileSync(path.join(bin,'tar'),`#!/bin/sh\n'${tar.replaceAll("'","'\\''")}' "$@"\nexit 2\n`,{mode:0o700});
  assert.throws(()=>archiveBackup(f.db,b.dir,{backupsRoot:b.backupsRoot,env:{...process.env,PATH:bin+path.delimiter+process.env.PATH}}),/ARCHIVE_COMMAND_FAILED/);
  assert.equal(f.db.prepare('SELECT state FROM lab_jobs WHERE job_id=?').get(b.job).state,'READY');
  assert.equal(verifyBundle(b.dir).manifestHash,b.manifestHash);
  assert.deepEqual(fs.readdirSync(path.join(b.backupsRoot,'archives')),[]);
});
test('a READY base backup is prepacked once without creating a backup job, moving the base or changing its state',archiveTest,async t=>{
  const f=fixture(t),b=await bundle(f);f.db.prepare('UPDATE lab_jobs SET result=? WHERE job_id=?').run(JSON.stringify({manifest_hash:b.manifestHash}),b.job);
  fs.writeFileSync(path.join(b.dir,'.keep'),'');const before=businessFingerprint(f.db),jobs=f.db.prepare('SELECT count(*) n FROM lab_jobs').get().n;
  assert.equal(archiveBackup(f.db,b.dir,{backupsRoot:b.backupsRoot,latest:b.job}),null);
  const archive=path.join(b.backupsRoot,'downloads',b.job+'.tar.zst'),metadata=JSON.parse(fs.readFileSync(path.join(b.backupsRoot,'downloads',b.job+'.json')));
  assert.equal(metadata.sha256,fileSha256(archive));assert.equal(metadata.manifest_hash,b.manifestHash);assert.equal(fs.existsSync(path.join(b.dir,'.keep')),true);
  fs.utimesSync(archive,1000,1000);const reused=prepareBackupDownload(f.db,b.dir,{backupsRoot:b.backupsRoot});assert.equal(reused.sha256,metadata.sha256);assert.equal(fs.statSync(archive).mtimeMs,1000000);
  assert.equal(f.db.prepare('SELECT state FROM lab_jobs WHERE job_id=?').get(b.job).state,'READY');assert.equal(f.db.prepare('SELECT count(*) n FROM lab_jobs').get().n,jobs);assert.equal(businessFingerprint(f.db),before);
});

test('successful archive replaces a preexisting incomplete stream before deleting the source',archiveTest,async t=>{
  const f=fixture(t),b=await bundle(f),archives=path.join(b.backupsRoot,'archives');fs.mkdirSync(archives);
  const out=path.join(archives,b.job+'.tar.zst');
  const tar=spawnSync('tar',['-C',b.backupsRoot,'-cf','-',b.job+'/manifest.json']);assert.equal(tar.status,0);
  assert.equal(spawnSync('zstd',['-q','-o',out],{input:tar.stdout}).status,0);
  const before=fileSha256(out),result=archiveBackup(f.db,b.dir,{backupsRoot:b.backupsRoot});
  assert.notEqual(result.archive_sha256,before);assert.equal(fs.existsSync(b.dir),false);
  assert.equal(f.db.prepare('SELECT state FROM lab_jobs WHERE job_id=?').get(b.job).state,'ARCHIVED');
  const extracted=path.join(f.root,'extracted');fs.mkdirSync(extracted);
  const plain=spawnSync('zstd',['-dc',out]);assert.equal(plain.status,0);
  assert.equal(spawnSync('tar',['-xf','-','-C',extracted],{input:plain.stdout}).status,0);
  assert.equal(verifyBundle(path.join(extracted,b.job)).manifestHash,b.manifestHash);
});

test('a readable compressed archive missing manifest files is rejected before source deletion',archiveTest,async t=>{
  const f=fixture(t),b=await bundle(f),bin=path.join(f.root,'bin');fs.mkdirSync(bin);
  const tar=spawnSync('which',['tar'],{encoding:'utf8'}).stdout.trim(),quoted=`'${tar.replaceAll("'","'\\''")}'`;
  fs.writeFileSync(path.join(bin,'tar'),`#!/bin/sh\nif [ "$1" = "-C" ]; then exec ${quoted} -C "$2" -cf - "$5/manifest.json" "$5/database.sqlite"; fi\nexec ${quoted} "$@"\n`,{mode:0o700});
  assert.throws(()=>archiveBackup(f.db,b.dir,{backupsRoot:b.backupsRoot,env:{...process.env,PATH:bin+path.delimiter+process.env.PATH}}),/ENOENT/);
  assert.equal(f.db.prepare('SELECT state FROM lab_jobs WHERE job_id=?').get(b.job).state,'READY');
  assert.equal(verifyBundle(b.dir).manifestHash,b.manifestHash);
  assert.deepEqual(fs.readdirSync(path.join(b.backupsRoot,'archives')),[]);
});

test('ARCHIVED leftover cleanup refuses a damaged archive instead of deleting its remaining source',archiveTest,async t=>{
  const f=fixture(t),b=await bundle(f),archiveRoot=path.join(b.backupsRoot,'archives');fs.mkdirSync(archiveRoot);
  const archive=path.join(archiveRoot,b.job+'.tar.zst');fs.writeFileSync(archive,'damaged');
  f.db.prepare("UPDATE lab_jobs SET state='ARCHIVED',result=? WHERE job_id=?").run(JSON.stringify({manifest_hash:b.manifestHash,archive_sha256:fileSha256(archive)}),b.job);
  assert.throws(()=>archiveBackup(f.db,b.dir,{backupsRoot:b.backupsRoot}),/ARCHIVE_COMMAND_FAILED/);
  assert.equal(verifyBundle(b.dir).manifestHash,b.manifestHash);
});

test('sqlite dry-run neither writes the base pointer nor pins the selected bundle',async t=>{
  const f=fixture(t),b=await bundle(f);
  const snap=script(f,'sqlite-snapshot',['--dry-run']);assert.equal(snap.status,0,snap.stderr);
  assert.equal(fs.existsSync(path.join(b.backupsRoot,'.base-bundle.json')),false);
  assert.equal(fs.existsSync(path.join(b.dir,'.keep')),false);
});
