#!/usr/bin/env node
// SQLite-only snapshots for the hybrid backup model. The 160 MB base bundle
// carries immutable assets/runners; this script captures only the database,
// using SQLite's online backup API into /dev/shm and zstd -19 on the way out.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const currentRelease=process.env.BACKUP_RELEASE_ROOT??'/opt/browser-psych-lab/current';
const require=createRequire(path.join(currentRelease,'package.json'));
const {businessFingerprint:fingerprint,bundleStructure:structure,baseCovers:verifiedBaseCovers,fileSha256:sha256,validBasePointer}=await import(pathToFileURL(path.join(currentRelease,'scripts/lib/backup-integrity.mjs')).href);
const Database=require('better-sqlite3');
const {verifyEvidence}=await import(pathToFileURL(path.join(currentRelease,'dist/server/evidence-storage.js')).href);
const args=new Set(process.argv.slice(2));
const dryRun=args.has('--dry-run'),force=args.has('--force');
const database=process.env.DATABASE_PATH,storageRoot=process.env.STORAGE_ROOT;
if(!database||!storageRoot)throw new Error('DATABASE_PATH and STORAGE_ROOT are required');
const backupsRoot=path.join(storageRoot,'research-backups');
const snapshotRoot=path.join(backupsRoot,'sqlite-snapshots');
const basePointer=path.join(backupsRoot,'.base-bundle.json');
const sidecar=path.join(backupsRoot,'.last-sqlite-fingerprint.json');
const now=()=>new Date().toISOString();
const jobIdPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function open(file,readonly=true){const db=new Database(file,{readonly,fileMustExist:true});db.pragma('busy_timeout=15000');return db;}
function counts(db){
  return db.prepare(`SELECT
    (SELECT count(*) FROM lab_studies) AS studies,
    (SELECT count(*) FROM lab_versions) AS versions,
    (SELECT count(*) FROM lab_sessions) AS sessions,
    (SELECT count(*) FROM lab_raw) AS raw,
    (SELECT count(*) FROM lab_events) AS events,
    (SELECT count(*) FROM lab_seals) AS seals,
    (SELECT count(*) FROM lab_consents) AS consents,
    (SELECT count(*) FROM lab_covariates) AS covariates,
    (SELECT count(*) FROM lab_assets WHERE state='READY') AS assets,
    (SELECT count(DISTINCT runner_hash) FROM lab_versions) AS runners`).get();
}
const baseCovers=(dir,current,expected={})=>verifiedBaseCovers(Database,dir,current,expected);
function keepBase(dir){
  fs.writeFileSync(path.join(dir,'.keep'),'',{flag:'a',mode:0o600});
  fs.chmodSync(path.join(dir,'.keep'),0o600);
}
function writeBase(jobId,dir){
  // Pin the bundle before publishing the pointer. A crash after the pin is
  // harmless; a pointer without the pin lets the wrapper archive the base.
  keepBase(dir);
  const manifestHash=sha256(path.join(dir,'manifest.json'));
  fs.writeFileSync(basePointer,JSON.stringify({job_id:jobId,manifest_hash:manifestHash,path:jobId,updated_at:now()},null,2)+'\n',{mode:0o600});
  return manifestHash;
}
function selectedBase(job,dir,persist){
  return persist?{job_id:job,manifest_hash:writeBase(job,dir),dir}:{job_id:job,manifest_hash:sha256(path.join(dir,'manifest.json')),dir};
}
function latestReadyFull(db){return db.prepare("SELECT job_id FROM lab_jobs WHERE kind='BACKUP' AND state='READY' ORDER BY updated_at DESC").all();}
function ensureBase(db,current,{refresh=true,persist=true}={}){
  if(fs.existsSync(basePointer)){
    try{const p=JSON.parse(fs.readFileSync(basePointer,'utf8'));if(validBasePointer(p)){const dir=path.join(backupsRoot,p.job_id);if(baseCovers(dir,current,{manifestHash:p.manifest_hash,jobId:p.job_id})){if(persist)keepBase(dir);return {job_id:p.job_id,manifest_hash:p.manifest_hash,dir};}}}catch{}
  }
  for(const {job_id:job} of latestReadyFull(db)){if(!jobIdPattern.test(job))continue;const dir=path.join(backupsRoot,job);if(baseCovers(dir,current,{jobId:job}))return selectedBase(job,dir,persist);}
  if(!refresh)throw new Error('BASE_REFRESH_REQUIRED');
  if(!process.env.BACKUP_PASSWORD_FILE)throw new Error('BASE_STRUCTURE_CHANGED_AND_BACKUP_PASSWORD_FILE_MISSING');
  const run=spawnSync(process.execPath,['/usr/local/bin/psychlab-light-backup.mjs','--force'],{env:process.env,stdio:'inherit'});
  if(run.status!==0)throw new Error(`BASE_REFRESH_FAILED:${run.status}`);
  for(const {job_id:job} of latestReadyFull(db)){if(!jobIdPattern.test(job))continue;const dir=path.join(backupsRoot,job);if(baseCovers(dir,current,{jobId:job}))return selectedBase(job,dir,persist);}
  throw new Error('NO_BASE_BUNDLE_COVERS_CURRENT_STRUCTURE');
}
function physicalTemp(){
  const shm='/dev/shm';
  try{const st=fs.statfsSync(shm);if(st.bavail*st.bsize>256*1024*1024)return shm;}catch{}
  const fallback=path.join(storageRoot,'tmp');fs.mkdirSync(fallback,{recursive:true,mode:0o700});return fallback;
}
function retention(){
  const files=fs.readdirSync(snapshotRoot).filter(n=>n.endsWith('.sqlite.zst')).map(n=>({name:n,path:path.join(snapshotRoot,n),mtime:fs.statSync(path.join(snapshotRoot,n)).mtimeMs})).sort((a,b)=>b.mtime-a.mtime);
  const removed=[];
  for(const f of files.slice(5)){
    const base=f.name.slice(0,-'.sqlite.zst'.length);
    for(const suffix of ['.sqlite.zst','.json','.sha256']){const p=path.join(snapshotRoot,base+suffix);if(fs.existsSync(p))fs.rmSync(p);}
    removed.push(f.name);
  }
  return removed;
}

const db=open(database,true);
try{
  const currentFingerprint=fingerprint(db),currentStructure=structure(db),currentCounts=counts(db);
  let previous=null;try{previous=JSON.parse(fs.readFileSync(sidecar,'utf8'));}catch{}
  const needsSnapshot=force||!previous||previous.fingerprint!==currentFingerprint;
  let base;
  try{base=ensureBase(db,currentStructure,{refresh:!dryRun,persist:!dryRun});}catch(error){if(dryRun&&error.message==='BASE_REFRESH_REQUIRED'){console.log(JSON.stringify({at:now(),mode:'dry-run',base_refresh_required:true,fingerprint:currentFingerprint,counts:currentCounts},null,2));db.close();process.exit(0);}throw error;}
  console.log(JSON.stringify({at:now(),mode:dryRun?'dry-run':'apply',needs_snapshot:needsSnapshot,previous_snapshot:previous?.file??null,base_job:base.job_id,base_manifest:base.manifest_hash,fingerprint:currentFingerprint,counts:currentCounts},null,2));
  if(dryRun){db.close();process.exit(0);}
  if(!needsSnapshot){db.close();console.log(JSON.stringify({action:'SKIP_NO_DATA_CHANGES',fingerprint:currentFingerprint,base_job:base.job_id},null,2));process.exit(0);}
  const tempRoot=physicalTemp(),temp=path.join(tempRoot,`psychlab-snap-${crypto.randomUUID()}.sqlite`);
  fs.mkdirSync(snapshotRoot,{recursive:true,mode:0o700});try{fs.chmodSync(snapshotRoot,0o700);}catch{}
  try{
    const source=open(database,true);try{await source.backup(temp);}finally{source.close();}
    const snap=open(temp,true);let check;
    try{
      const integrity=snap.pragma('integrity_check',{simple:true}),fk=snap.pragma('foreign_key_check').length;
      if(integrity!=='ok'||fk!==0)throw new Error(`SNAPSHOT_DB_CHECK_FAILED:${integrity}:${fk}`);
      const evidence=verifyEvidence(snap);const snapStructure=structure(snap);
      if(!baseCovers(base.dir,snapStructure,{manifestHash:base.manifest_hash,jobId:base.job_id}))throw new Error('SNAPSHOT_STRUCTURE_NOT_COVERED_BY_BASE');
      check={integrity,foreign_key_issues:fk,evidence,counts:counts(snap)};
    }finally{snap.close();}
    for(const suffix of ['-wal','-shm']){const p=temp+suffix;if(fs.existsSync(p))fs.rmSync(p);}
    const stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\..+/,'').replace('T','-');
    const name=`sqlite-${stamp}.sqlite.zst`,out=path.join(snapshotRoot,name),metaPath=path.join(snapshotRoot,`sqlite-${stamp}.json`),shaPath=out+'.sha256';
    const z=spawnSync('zstd',['-19','-q','-f',temp,'-o',out],{stdio:'inherit'});if(z.status!==0)throw new Error(`ZSTD_FAILED:${z.status}`);
    const t=spawnSync('zstd',['-t',out],{stdio:'ignore'});if(t.status!==0)throw new Error('SNAPSHOT_ZSTD_TEST_FAILED');
    fs.chmodSync(out,0o600);const digest=sha256(out),bytes=fs.statSync(out).size;
    const meta={schema:'sqlite-snapshot-v1',created_at:now(),file:name,bytes,sha256:digest,source_db:database,base:{job_id:base.job_id,manifest_hash:base.manifest_hash},app_revision:fs.readFileSync(path.join(currentRelease,'REVISION'),'utf8').trim(),fingerprint:currentFingerprint,check};
    fs.writeFileSync(metaPath,JSON.stringify(meta,null,2)+'\n',{mode:0o600});
    fs.writeFileSync(shaPath,`${digest}  ${name}\n`,{mode:0o600});
    fs.writeFileSync(sidecar,JSON.stringify({fingerprint:currentFingerprint,at:now(),file:name,base_job:base.job_id},null,2)+'\n',{mode:0o600});
    const removed=retention();
    console.log(JSON.stringify({action:'SNAPSHOT_CREATED',file:name,bytes,sha256:digest,base_job:base.job_id,counts:check.counts,evidence:check.evidence,removed},null,2));
  }finally{if(fs.existsSync(temp))fs.rmSync(temp);for(const suffix of ['-wal','-shm']){const p=temp+suffix;if(fs.existsSync(p))fs.rmSync(p);}}
}finally{db.close();}
