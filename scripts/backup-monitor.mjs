#!/usr/bin/env node
// Daily backup freshness/health monitor. It is intentionally read-only except
// for the status file; an OnFailure hook turns a non-zero exit into an alert.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const currentRelease=process.env.BACKUP_RELEASE_ROOT??'/opt/browser-psych-lab/current';
const require=createRequire(path.join(currentRelease,'package.json'));
const {businessFingerprint:fingerprint,bundleStructure:structure,baseCovers,fileSha256,verifyBundle,validBasePointer}=await import(pathToFileURL(path.join(currentRelease,'scripts/lib/backup-integrity.mjs')).href);
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
function systemValue(prop,unit){const r=spawnSync('systemctl',[prop,unit],{encoding:'utf8'});return (r.stdout??'').trim();}
function curl(url){const r=spawnSync('curl',['-fsS','-m','10',url],{encoding:'utf8'});return {ok:r.status===0,detail:(r.stderr||r.stdout||'').trim().slice(0,300)};}

const db=new Database(database,{readonly:true,fileMustExist:true});db.pragma('busy_timeout=15000');
try{
  const currentFingerprint=fingerprint(db),currentStructure=structure(db);
  check('database',true,{path:database,fingerprint:currentFingerprint});

  const fullSidecar=readJson(path.join(backupsRoot,'.last-backup-fingerprint.json'));
  const latestFull=db.prepare("SELECT job_id,updated_at FROM lab_jobs WHERE kind='BACKUP' AND state='READY' ORDER BY updated_at DESC LIMIT 1").get();
  const fullDir=latestFull?path.join(backupsRoot,latestFull.job_id):null;
  let fullValid=false;
  try{if(fullDir){verifyBundle(fullDir,{jobId:latestFull.job_id});fullValid=true;}}catch{}
  check('full_bundle',fullValid,latestFull??null);
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
    const actual=fileSha256(snapPath);
    check('snapshot_hash',shaLine===actual,{expected:shaLine,actual});
    const meta=readJson(snapPath.replace(/\.sqlite\.zst$/,'.json'));
    check('snapshot_metadata',!!meta&&meta.schema==='sqlite-snapshot-v1'&&meta.sha256===actual,meta?.created_at??null);
    const basePointer=readJson(path.join(backupsRoot,'.base-bundle.json'));
    check('snapshot_base_pointer',validBasePointer(basePointer)&&!!meta&&meta.base?.manifest_hash===basePointer.manifest_hash&&meta.base?.job_id===basePointer.job_id,basePointer??null);
    const same=snapSidecar?.fingerprint===currentFingerprint,age=snapSidecar?.at?ageHours(Date.parse(snapSidecar.at)):Infinity,snapMax=Number(process.env.BACKUP_SNAPSHOT_MAX_AGE_HOURS??120);
    check('snapshot_freshness',same||age<=snapMax,{fingerprint_current:same,age_hours:Number.isFinite(age)?Number(age.toFixed(1)):null,max_hours:snapMax});
  }

  const basePointer=readJson(path.join(backupsRoot,'.base-bundle.json'));
  const baseDir=validBasePointer(basePointer)?path.join(backupsRoot,basePointer.job_id):null;
  check('base_bundle',!!basePointer&&!!baseDir&&fs.existsSync(path.join(baseDir,'manifest.json')),basePointer??null);
  check('base_structure',!!baseDir&&baseCovers(Database,baseDir,currentStructure,{manifestHash:basePointer.manifest_hash,jobId:basePointer.job_id}),{assets:currentStructure.assets.length,runners:currentStructure.runners.length});

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
