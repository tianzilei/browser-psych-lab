#!/usr/bin/env node
// Daily backup freshness/health monitor. It is intentionally read-only except
// for the status file; an OnFailure hook turns a non-zero exit into an alert.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';

const require=createRequire('/opt/browser-psych-lab/current/package.json');
const Database=require('better-sqlite3');
const database=process.env.DATABASE_PATH,storageRoot=process.env.STORAGE_ROOT;
if(!database||!storageRoot)throw new Error('DATABASE_PATH and STORAGE_ROOT are required');
const backupsRoot=path.join(storageRoot,'research-backups');
const snapshotRoot=path.join(backupsRoot,'sqlite-snapshots');
const statusPath=path.join(storageRoot,'backup-status.json');
const checks=[],alerts=[];
const now=()=>new Date().toISOString();
const check=(name,ok,detail)=>{checks.push({name,ok,detail});if(!ok)alerts.push({name,detail});};
const readJson=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
const ageHours=ms=>(Date.now()-ms)/3600000;
const fingerprint=db=>JSON.stringify(db.prepare(`SELECT
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
  (SELECT count(*) FROM lab_session_queue) AS queue`).get());
const structure=db=>({assets:db.prepare("SELECT asset_id,hash FROM lab_assets WHERE state='READY' ORDER BY asset_id").all(),runners:db.prepare('SELECT DISTINCT runner_hash FROM lab_versions ORDER BY runner_hash').all().map(r=>r.runner_hash)});
function baseCovers(baseDir,current){
  try{
    const db=new Database(path.join(baseDir,'database.sqlite'),{readonly:true,fileMustExist:true});
    try{const s=structure(db),assets=new Set(s.assets.map(a=>`${a.asset_id}:${a.hash}`)),runners=new Set(s.runners);return current.assets.every(a=>assets.has(`${a.asset_id}:${a.hash}`))&&current.runners.every(r=>runners.has(r));}finally{db.close();}
  }catch{return false;}
}
function systemValue(prop,unit){const r=spawnSync('systemctl',[prop,unit],{encoding:'utf8'});return (r.stdout??'').trim();}
function curl(url){const r=spawnSync('curl',['-fsS','-m','10',url],{encoding:'utf8'});return {ok:r.status===0,detail:(r.stderr||r.stdout||'').trim().slice(0,300)};}

const db=new Database(database,{readonly:true,fileMustExist:true});db.pragma('busy_timeout=15000');
try{
  const currentFingerprint=fingerprint(db),currentStructure=structure(db);
  check('database',true,{path:database,fingerprint:currentFingerprint});

  const fullSidecar=readJson(path.join(backupsRoot,'.last-backup-fingerprint.json'));
  const latestFull=db.prepare("SELECT job_id,updated_at FROM lab_jobs WHERE kind='BACKUP' AND state='READY' ORDER BY updated_at DESC LIMIT 1").get();
  const fullDir=latestFull?path.join(backupsRoot,latestFull.job_id):null;
  check('full_bundle',!!latestFull&&!!fullDir&&fs.existsSync(path.join(fullDir,'manifest.json')),latestFull??null);
  check('full_sidecar',!!fullSidecar&&!!latestFull&&fullSidecar.job_id===latestFull.job_id,fullSidecar??null);
  const fullMax=Number(process.env.BACKUP_FULL_MAX_AGE_HOURS??192);
  if(fullSidecar){
    const same=fullSidecar.fingerprint===currentFingerprint,age=fullSidecar.at?ageHours(Date.parse(fullSidecar.at)):Infinity;
    check('full_freshness',same||age<=fullMax,{fingerprint_current:same,age_hours:Number.isFinite(age)?Number(age.toFixed(1)):null,max_hours:fullMax});
  }

  const snapSidecar=readJson(path.join(backupsRoot,'.last-sqlite-fingerprint.json'));
  const snapName=snapSidecar?.file,snapPath=snapName?path.join(snapshotRoot,snapName):null;
  check('snapshot_sidecar',!!snapSidecar,snapSidecar??null);
  check('snapshot_file',!!snapPath&&fs.existsSync(snapPath),snapName??null);
  if(snapPath&&fs.existsSync(snapPath)){
    const shaFile=snapPath+'.sha256',shaLine=fs.existsSync(shaFile)?fs.readFileSync(shaFile,'utf8').trim().split(/\s+/)[0]:'';
    const actual=require('node:crypto').createHash('sha256').update(fs.readFileSync(snapPath)).digest('hex');
    check('snapshot_hash',shaLine===actual,{expected:shaLine,actual});
    const meta=readJson(snapPath.replace(/\.sqlite\.zst$/,'.json'));
    check('snapshot_metadata',!!meta&&meta.schema==='sqlite-snapshot-v1',meta?.created_at??null);
    const basePointer=readJson(path.join(backupsRoot,'.base-bundle.json'));
    check('snapshot_base_pointer',!!basePointer&&!!meta&&meta.base?.manifest_hash===basePointer.manifest_hash,basePointer??null);
    const same=snapSidecar?.fingerprint===currentFingerprint,age=snapSidecar?.at?ageHours(Date.parse(snapSidecar.at)):Infinity,snapMax=Number(process.env.BACKUP_SNAPSHOT_MAX_AGE_HOURS??120);
    check('snapshot_freshness',same||age<=snapMax,{fingerprint_current:same,age_hours:Number.isFinite(age)?Number(age.toFixed(1)):null,max_hours:snapMax});
  }

  const basePointer=readJson(path.join(backupsRoot,'.base-bundle.json'));
  const baseDir=basePointer?path.join(backupsRoot,basePointer.path??basePointer.job_id):null;
  check('base_bundle',!!basePointer&&!!baseDir&&fs.existsSync(path.join(baseDir,'manifest.json')),basePointer??null);
  check('base_structure',!!baseDir&&baseCovers(baseDir,currentStructure),{assets:currentStructure.assets.length,runners:currentStructure.runners.length});

  for(const unit of ['browser-psych-lab-backup.timer','browser-psych-lab-sqlite-snapshot.timer']){
    const active=systemValue('is-active',unit),enabled=systemValue('is-enabled',unit);
    check(`timer_active:${unit}`,active==='active',{active,enabled});
  }
  for(const unit of ['browser-psych-lab-backup.service','browser-psych-lab-sqlite-snapshot.service']){
    const failed=systemValue('is-failed',unit);
    check(`service_failed:${unit}`,failed!=='failed',{failed});
  }

  const st=fs.statfsSync(storageRoot),free=st.bavail*st.bsize,total=st.blocks*st.bsize,freePercent=free/total*100;
  const minFreeGb=Number(process.env.BACKUP_MIN_FREE_GB??8),minFreePercent=Number(process.env.BACKUP_MIN_FREE_PERCENT??20);
  check('disk_free',free>=minFreeGb*1024**3&&freePercent>=minFreePercent,{free_bytes:free,total_bytes:total,free_gb:Number((free/1024**3).toFixed(2)),free_percent:Number(freePercent.toFixed(2)),min_free_gb:minFreeGb,min_free_percent:minFreePercent});

  const report={schema:'backup-status-v1',at:now(),status:alerts.length?'ALERT':'OK',checks,alerts,current_fingerprint:currentFingerprint,latest_full:latestFull??null,latest_snapshot:snapSidecar?{file:snapSidecar.file,at:snapSidecar.at,base_job:snapSidecar.base_job}:null,disk:{free_bytes:free,total_bytes:total,free_percent:Number(freePercent.toFixed(2))}};
  fs.writeFileSync(statusPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});fs.chmodSync(statusPath,0o600);
  if(!alerts.length&&process.env.BACKUP_HEALTHCHECK_URL){
    const ping=curl(process.env.BACKUP_HEALTHCHECK_URL);check('healthcheck_ping',ping.ok,ping.detail);
    if(!ping.ok){report.status='ALERT';report.checks=checks;report.alerts=alerts;fs.writeFileSync(statusPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});}
  }
  console.log(JSON.stringify({at:report.at,status:report.status,alerts:report.alerts,latest_full:report.latest_full,latest_snapshot:report.latest_snapshot,disk:report.disk,healthcheck_configured:!!process.env.BACKUP_HEALTHCHECK_URL},null,2));
  if(alerts.length)process.exitCode=1;
}finally{db.close();}
