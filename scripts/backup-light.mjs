#!/usr/bin/env node
// Low-wear weekly backup wrapper. The existing /api/lab/jobs/backup and
// maintenance worker remain unchanged; this layer skips untouched weeks,
// compresses old raw bundles, and enforces a small local archive window.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const currentRelease=process.env.BACKUP_RELEASE_ROOT??'/opt/browser-psych-lab/current';
const require=createRequire(path.join(currentRelease,'package.json'));
const {businessFingerprint,fileSha256:sha256}=await import(pathToFileURL(path.join(currentRelease,'scripts/lib/backup-integrity.mjs')).href);
const {archiveBackup}=await import(pathToFileURL(path.join(currentRelease,'scripts/lib/backup-archive.mjs')).href);
const Database=require('better-sqlite3');
const args=new Set(process.argv.slice(2));
const dryRun=args.has('--dry-run'),force=args.has('--force');
const database=process.env.DATABASE_PATH,storageRoot=process.env.STORAGE_ROOT;
if(!database||!storageRoot)throw new Error('DATABASE_PATH and STORAGE_ROOT are required');
const backupsRoot=path.join(storageRoot,'research-backups');
const archiveRoot=path.join(backupsRoot,'archives');
const sidecar=path.join(backupsRoot,'.last-backup-fingerprint.json');
const now=()=>new Date().toISOString();
const jobIdPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function open(readonly){const db=new Database(database,{readonly,fileMustExist:true});db.pragma('busy_timeout=15000');return db;}
function latestReady(db){return db.prepare("SELECT job_id,updated_at FROM lab_jobs WHERE kind='BACKUP' AND state='READY' ORDER BY updated_at DESC LIMIT 1").get();}
function manifestOf(dir){const p=path.join(dir,'manifest.json');if(!fs.existsSync(p))return null;return JSON.parse(fs.readFileSync(p,'utf8'));}
function pruneArchives(db){
  if(!fs.existsSync(archiveRoot))return [];
  const files=fs.readdirSync(archiveRoot).filter(n=>n.endsWith('.tar.zst')).map(n=>({name:n,path:path.join(archiveRoot,n),mtime:fs.statSync(path.join(archiveRoot,n)).mtimeMs})).sort((a,b)=>b.mtime-a.mtime);
  const removed=[];
  for(const f of files.slice(2)){
    const job=f.name.slice(0,-'.tar.zst'.length);fs.rmSync(f.path);
    if(jobIdPattern.test(job)){const row=db.prepare('SELECT state,result FROM lab_jobs WHERE job_id=?').get(job);if(row&&row.state==='ARCHIVED'){let prior={};try{prior=JSON.parse(row.result||'{}')}catch{};const detail={...prior,archive_deleted:true,archive_deleted_at:now()};db.prepare("UPDATE lab_jobs SET state='PURGED',phase='PURGED',result=?,updated_at=? WHERE job_id=?").run(JSON.stringify(detail),Date.now(),job);db.prepare('INSERT INTO lab_audit VALUES (?,?,?,?,?,?)').run(randomUUID(),'SYSTEM','backup.archive.prune',job,JSON.stringify(detail),Date.now());}}
    removed.push({archive:f.name});
  }
  return removed;
}

const readDb=open(true);
try{
  const currentFingerprint=businessFingerprint(readDb);
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
      const result=archiveBackup(writeDb,dir,{backupsRoot,latest:latestNow?.job_id});if(result)archived.push(result);
    }
    const pruned=pruneArchives(writeDb);
    console.log(JSON.stringify({action:needsBackup?'BACKUP_AND_MAINTENANCE':'SKIP_BACKUP_MAINTENANCE',archived,pruned,archives:fs.existsSync(archiveRoot)?fs.readdirSync(archiveRoot):[]},null,2));
  }finally{writeDb.close();}
}finally{readDb.close();}
