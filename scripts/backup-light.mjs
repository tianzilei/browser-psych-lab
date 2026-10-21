#!/usr/bin/env node
// Low-wear weekly backup wrapper. The existing /api/lab/jobs/backup and
// maintenance worker remain unchanged; this layer skips untouched weeks,
// compresses old raw bundles, and enforces a small local archive window.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';

const require=createRequire('/opt/browser-psych-lab/current/package.json');
const Database=require('better-sqlite3');
const args=new Set(process.argv.slice(2));
const dryRun=args.has('--dry-run'),force=args.has('--force');
const database=process.env.DATABASE_PATH,storageRoot=process.env.STORAGE_ROOT;
if(!database||!storageRoot)throw new Error('DATABASE_PATH and STORAGE_ROOT are required');
const backupsRoot=path.join(storageRoot,'research-backups');
const archiveRoot=path.join(backupsRoot,'archives');
const sidecar=path.join(backupsRoot,'.last-backup-fingerprint.json');
const currentRelease='/opt/browser-psych-lab/current';
const now=()=>new Date().toISOString();
const jobIdPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function open(readonly){const db=new Database(database,{readonly,fileMustExist:true});db.pragma('busy_timeout=15000');return db;}
function fingerprint(db){
  return db.prepare(`SELECT
    (SELECT count(*) FROM lab_studies) AS studies,
    (SELECT coalesce(sum(revision),0) FROM lab_studies) AS revisions,
    (SELECT coalesce(sum(length(title)),0) FROM lab_studies) AS title_bytes,
    (SELECT count(*) FROM lab_studies WHERE admission='OPEN') AS open_studies,
    (SELECT count(*) FROM lab_versions) AS versions,
    (SELECT count(*) FROM lab_sessions) AS sessions,
    (SELECT count(*) FROM lab_sessions WHERE state='COMPLETED') AS completed,
    (SELECT count(*) FROM lab_sessions WHERE state='TERMINATED') AS terminated,
    (SELECT count(*) FROM lab_sessions WHERE state='ACTIVE') AS active,
    (SELECT count(*) FROM lab_raw) AS raw,
    (SELECT coalesce(max(received_at),0) FROM lab_raw) AS last_raw,
    (SELECT count(*) FROM lab_events) AS events,
    (SELECT count(*) FROM lab_seals) AS seals,
    (SELECT count(*) FROM lab_consents) AS consents,
    (SELECT count(*) FROM lab_covariates) AS covariates,
    (SELECT count(*) FROM lab_assets) AS assets,
    (SELECT coalesce(sum(bytes),0) FROM lab_assets) AS asset_bytes,
    (SELECT count(*) FROM lab_packages) AS packages,
    (SELECT count(*) FROM lab_diagnostics) AS diagnostics,
    (SELECT count(*) FROM lab_marks) AS marks,
    (SELECT count(*) FROM lab_permits) AS permits,
    (SELECT count(*) FROM lab_session_queue) AS queue`).get();
}
function latestReady(db){return db.prepare("SELECT job_id,updated_at FROM lab_jobs WHERE kind='BACKUP' AND state='READY' ORDER BY updated_at DESC LIMIT 1").get();}
function manifestOf(dir){const p=path.join(dir,'manifest.json');if(!fs.existsSync(p))return null;return JSON.parse(fs.readFileSync(p,'utf8'));}
function sha256(file){return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
function dirBytes(dir){let n=0;for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);n+=e.isDirectory()?dirBytes(p):fs.statSync(p).size;}return n;}
function shell(command){const r=spawnSync('/bin/bash',['-c',command],{stdio:'inherit'});if(r.status!==0)throw new Error(`COMMAND_FAILED:${command}`);}
function q(s){return `'${String(s).replaceAll("'","'\\''")}'`;}

function archiveOne(db,dir,latest){
  const job=path.basename(dir);if(!jobIdPattern.test(job)||job===latest)return null;
  if(fs.existsSync(path.join(dir,'.keep')))return null;
  const row=db.prepare('SELECT state,result FROM lab_jobs WHERE job_id=?').get(job);if(!row)return null;
  fs.mkdirSync(archiveRoot,{recursive:true,mode:0o700});
  try{fs.chmodSync(archiveRoot,0o700);}catch{}
  const archive=path.join(archiveRoot,`${job}.tar.zst`),rel=`archives/${job}.tar.zst`;
  if(row.state==='ARCHIVED'&&fs.existsSync(archive)){fs.rmSync(dir,{recursive:true,force:false});return {job_id:job,removed_leftover:true};}
  if(row.state!=='READY')return null;
  const manifest=manifestOf(dir);if(!manifest||manifest.schema!=='backup-v1'||manifest.job_id!==job)throw new Error(`INVALID_MANIFEST:${job}`);
  if(!fs.existsSync(archive))shell(`tar -C ${q(backupsRoot)} -cf - ${q(job)} | zstd -19 -q -o ${q(archive)}`);
  fs.chmodSync(archive,0o600);
  const test=spawnSync('zstd',['-t',archive],{stdio:'ignore'});if(test.status!==0)throw new Error(`ARCHIVE_ZSTD_TEST_FAILED:${job}`);
  shell(`zstd -dc ${q(archive)} | tar -tf - >/dev/null`);
  const originalBytes=dirBytes(dir),archiveBytes=fs.statSync(archive).size,archiveHash=sha256(archive),manifestHash=sha256(path.join(dir,'manifest.json'));
  const detail={archived:true,archive:rel,archive_bytes:archiveBytes,archive_sha256:archiveHash,original_bytes:originalBytes,manifest_hash:manifestHash,archived_at:now()};
  const changed=db.prepare("UPDATE lab_jobs SET state='ARCHIVED',phase='ARCHIVED',result=?,error=NULL,updated_at=? WHERE job_id=? AND state='READY'").run(JSON.stringify(detail),Date.now(),job);
  if(changed.changes!==1)throw new Error(`JOB_STATE_CHANGED:${job}`);
  db.prepare('INSERT INTO lab_audit VALUES (?,?,?,?,?,?)').run(crypto.randomUUID(),'SYSTEM','backup.bundle.archive',job,JSON.stringify(detail),Date.now());
  fs.rmSync(dir,{recursive:true,force:false});
  return {job_id:job,archive:rel,original_bytes:originalBytes,archive_bytes:archiveBytes,archive_sha256:archiveHash};
}
function pruneArchives(db){
  if(!fs.existsSync(archiveRoot))return [];
  const files=fs.readdirSync(archiveRoot).filter(n=>n.endsWith('.tar.zst')).map(n=>({name:n,path:path.join(archiveRoot,n),mtime:fs.statSync(path.join(archiveRoot,n)).mtimeMs})).sort((a,b)=>b.mtime-a.mtime);
  const removed=[];
  for(const f of files.slice(2)){
    const job=f.name.slice(0,-'.tar.zst'.length);fs.rmSync(f.path);
    if(jobIdPattern.test(job)){const row=db.prepare('SELECT state,result FROM lab_jobs WHERE job_id=?').get(job);if(row&&row.state==='ARCHIVED'){let prior={};try{prior=JSON.parse(row.result||'{}')}catch{};const detail={...prior,archive_deleted:true,archive_deleted_at:now()};db.prepare("UPDATE lab_jobs SET state='PURGED',phase='PURGED',result=?,updated_at=? WHERE job_id=?").run(JSON.stringify(detail),Date.now(),job);db.prepare('INSERT INTO lab_audit VALUES (?,?,?,?,?,?)').run(crypto.randomUUID(),'SYSTEM','backup.archive.prune',job,JSON.stringify(detail),Date.now());}}
    removed.push({archive:f.name});
  }
  return removed;
}

const readDb=open(true);
try{
  const currentFingerprint=JSON.stringify(fingerprint(readDb));
  let previous=null;try{previous=JSON.parse(fs.readFileSync(sidecar,'utf8'));}catch{}
  const latest=latestReady(readDb);
  const needsBackup=force||!previous||previous.fingerprint!==currentFingerprint;
  const oldDirs=fs.readdirSync(backupsRoot,{withFileTypes:true}).filter(e=>e.isDirectory()&&e.name!=='archives'&&(!latest||e.name!==latest.job_id)).map(e=>path.join(backupsRoot,e.name)).filter(d=>fs.existsSync(path.join(d,'manifest.json'))&&!fs.existsSync(path.join(d,'.keep')));
  console.log(JSON.stringify({at:now(),mode:dryRun?'dry-run':'apply',needs_backup:needsBackup,previous_job:previous?.job_id??null,latest_ready:latest?.job_id??null,old_bundles:oldDirs.map(d=>path.basename(d)),fingerprint:currentFingerprint},null,2));
  if(dryRun){readDb.close();process.exit(0);}
  if(needsBackup){
    const run=spawnSync(process.execPath,[path.join(currentRelease,'scripts/backup.mjs')],{env:process.env,stdio:'inherit'});
    if(run.status!==0)throw new Error(`BACKUP_FAILED:${run.status}`);
    const after=latestReady(readDb);if(!after)throw new Error('NO_READY_BACKUP');
    const dir=path.join(backupsRoot,after.job_id),manifest=manifestOf(dir);if(!manifest||manifest.job_id!==after.job_id)throw new Error('NEW_BACKUP_MANIFEST_MISSING');
    if(Date.now()-fs.statSync(path.join(dir,'manifest.json')).mtimeMs>15*60*1000)throw new Error('NEW_BACKUP_NOT_FRESH');
    // Store the pre-backup fingerprint. Writes after this point are not in
    // this snapshot, so they must trigger the next backup instead of being
    // marked as already captured.
    const tmp=`${sidecar}.tmp`;
    fs.writeFileSync(tmp,JSON.stringify({fingerprint:currentFingerprint,at:now(),job_id:after.job_id},null,2)+'\n',{mode:0o600});fs.renameSync(tmp,sidecar);
    console.log(JSON.stringify({action:'BACKED_UP',job_id:after.job_id,manifest_hash:sha256(path.join(dir,'manifest.json')),fingerprint:currentFingerprint},null,2));
  }
  const writeDb=open(false);const archived=[];
  try{
    const latestNow=latestReady(writeDb);
    for(const dir of fs.readdirSync(backupsRoot,{withFileTypes:true}).filter(e=>e.isDirectory()&&e.name!=='archives').map(e=>path.join(backupsRoot,e.name))){
      const result=archiveOne(writeDb,dir,latestNow?.job_id);if(result)archived.push(result);
    }
    const pruned=pruneArchives(writeDb);
    console.log(JSON.stringify({action:needsBackup?'BACKUP_AND_MAINTENANCE':'SKIP_BACKUP_MAINTENANCE',archived,pruned,archives:fs.existsSync(archiveRoot)?fs.readdirSync(archiveRoot):[]},null,2));
  }finally{writeDb.close();}
}finally{readDb.close();}
