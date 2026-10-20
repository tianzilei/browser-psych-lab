#!/usr/bin/env node
// Delete historical EXPORT job directories for selected studies while keeping
// the live answer evidence in SQLite. The job row is retained as PURGED so the
// admin page regenerates a fresh export instead of offering a missing file.
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,lstat,readdir,rename,rm,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import Database from 'better-sqlite3';

const args=process.argv.slice(2);
const studies=[],studyIds=[];
let database=process.env.DATABASE_PATH,storageRoot=process.env.STORAGE_ROOT,evidenceDir,apply=false,includeFailed=false;
for(let i=0;i<args.length;i++){
  const arg=args[i];
  if(arg==='--apply')apply=true;
  else if(arg==='--include-failed')includeFailed=true;
  else if(arg==='--study')studies.push(args[++i]??'');
  else if(arg==='--study-id')studyIds.push(args[++i]??'');
  else if(arg==='--database')database=args[++i];
  else if(arg==='--storage-root')storageRoot=args[++i];
  else if(arg==='--evidence-dir')evidenceDir=args[++i];
  else if(arg==='--help'||arg==='-h'){
    console.log(`Usage: node scripts/purge-export-snapshots.mjs --study <title> [--study <title>...] [options]
  --study-id <uuid>       Select by study id instead of title (repeatable)
  --database <path>       SQLite path (default DATABASE_PATH)
  --storage-root <path>   Private storage root (default STORAGE_ROOT)
  --evidence-dir <path>   Report/inventory directory
  --include-failed        Also purge FAILED export partials (default: READY only)
  --apply                 Perform deletion; without it only prints the plan
The live lab_seals/page evidence is checked first. Each READY export directory
is renamed to a .purging-* name, its job row is marked PURGED, then the renamed
directory is removed. Missing job files never leave a READY link behind.`);
    process.exit(0);
  } else throw new Error(`UNKNOWN_ARGUMENT:${arg}`);
}
if(!studies.length&&!studyIds.length)throw new Error('At least one --study or --study-id is required.');
if(!database)throw new Error('Set DATABASE_PATH or pass --database.');
if(!storageRoot)throw new Error('Set STORAGE_ROOT or pass --storage-root.');

const db=new Database(database,{fileMustExist:true});
db.pragma('busy_timeout=15000');
db.pragma('foreign_keys=ON');
const q=(sql,...params)=>db.prepare(sql).all(...params);
const one=(sql,...params)=>db.prepare(sql).get(...params);
const ph=items=>items.map(()=>'?').join(',');
const ts=()=>new Date().toISOString();
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fileHash=path=>new Promise((resolve,reject)=>{const hash=createHash('sha256'),stream=createReadStream(path);stream.on('data',chunk=>hash.update(chunk));stream.on('end',()=>resolve(hash.digest('hex')));stream.on('error',reject);});

const selected=[];
for(const title of studies){const row=one('SELECT study_id,title FROM lab_studies WHERE title=?',title);if(!row)throw new Error(`STUDY_NOT_FOUND:${title}`);selected.push(row);}
for(const id of studyIds){const row=one('SELECT study_id,title FROM lab_studies WHERE study_id=?',id);if(!row)throw new Error(`STUDY_NOT_FOUND:${id}`);selected.push(row);}
const uniqueStudies=[...new Map(selected.map(s=>[s.study_id,s])).values()],ids=uniqueStudies.map(s=>s.study_id),sph=ph(ids);

const evidence={};
for(const id of ids){const sessions=one(`SELECT count(*) n FROM lab_sessions WHERE study_id=?`,id).n,seals=one(`SELECT count(*) n FROM lab_seals s JOIN lab_sessions x USING(session_id) WHERE x.study_id=?`,id).n,
  pageEvents=one(`SELECT count(*) n FROM lab_events e JOIN lab_sessions x USING(session_id) WHERE x.study_id=? AND e.kind<>'INPUT_DIAGNOSTIC'`,id).n,
  snapshots=one(`SELECT count(*) n FROM lab_events e JOIN lab_sessions x USING(session_id) WHERE x.study_id=? AND e.kind='PAGE_SNAPSHOT'`,id).n;
  if(!seals||!snapshots)throw new Error(`ANSWER_EVIDENCE_MISSING:${id}:seals=${seals}:snapshots=${snapshots}`);
  evidence[id]={sessions,seals,page_events:pageEvents,snapshots};}
const states=includeFailed?['READY','FAILED']:['READY'];
const jobs=q(`SELECT job_id,study_id,state,created_at,result FROM lab_jobs WHERE kind='EXPORT' AND study_id IN (${sph}) AND state IN (${ph(states)}) ORDER BY created_at`,...ids,...states);
if(!jobs.length){console.log(JSON.stringify({purged:false,reason:'NO_EXPORT_SNAPSHOTS',studies:uniqueStudies,evidence},null,2));db.close();process.exit(0);}

const plan=[];
for(const job of jobs){
  if(!uuid.test(job.job_id))throw new Error(`INVALID_JOB_ID:${job.job_id}`);
  const dir=join(storageRoot,'research-exports',job.job_id),info=await lstat(dir).catch(()=>null);
  if(!info){plan.push({job_id:job.job_id,study_id:job.study_id,state:job.state,missing:true,files:[],bytes:0});continue;}
  if(!info.isDirectory()||info.isSymbolicLink())throw new Error(`UNSAFE_EXPORT_DIRECTORY:${job.job_id}`);
  const files=[];let bytes=0;
  for(const entry of await readdir(dir,{withFileTypes:true})){
    if(!entry.isFile())throw new Error(`UNEXPECTED_EXPORT_ENTRY:${job.job_id}:${entry.name}`);
    const path=join(dir,entry.name),size=(await stat(path)).size;bytes+=size;files.push({name:entry.name,bytes:size,sha256:await fileHash(path)});
  }
  plan.push({job_id:job.job_id,study_id:job.study_id,state:job.state,missing:false,files,bytes});
}
const summary={purged:false,mode:apply?'apply':'dry-run',studies:uniqueStudies,evidence,jobs:plan.length,bytes:plan.reduce((n,j)=>n+j.bytes,0),plan,timestamp:ts()};
console.log(JSON.stringify({...summary,plan:plan.map(j=>({job_id:j.job_id,state:j.state,missing:j.missing,bytes:j.bytes,files:j.files.map(f=>f.name)}))},null,2));
if(!apply){db.close();process.exit(0);}

const stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\..+/,'').replace('T','-');
const dir=evidenceDir??join(storageRoot,`export-snapshot-purge-${stamp}`);
await mkdir(dir,{recursive:true,mode:0o700});
const beforePath=join(dir,'before.sqlite');
await db.backup(beforePath);
await writeFile(join(dir,'inventory-before.json'),JSON.stringify(summary,null,2));
const moved=[],purged=[];
for(const job of plan){
  if(job.missing)continue;
  const from=join(storageRoot,'research-exports',job.job_id),to=`${from}.purging-${stamp}`;
  await rename(from,to);moved.push({job,from,to});
}
try{
  db.transaction(()=>{
    for(const job of plan){
      const detail={reason:'OPERATOR_EXPORT_SNAPSHOT_PURGE',study_id:job.study_id,state:job.state,files:job.files.length,bytes:job.bytes,missing:job.missing,answer_evidence:'retained-in-live-database',inventory:'inventory-before.json'};
      const result=JSON.stringify(detail);
      const changed=db.prepare("UPDATE lab_jobs SET state='PURGED',phase='PURGED',result=?,error=NULL,updated_at=? WHERE job_id=? AND state IN ('READY','FAILED')").run(result,Date.now(),job.job_id);
      if(changed.changes!==1)throw new Error(`JOB_STATE_CHANGED:${job.job_id}`);
      db.prepare('INSERT INTO lab_audit VALUES (?,?,?,?,?,?)').run(randomUUID(),'OPERATOR','export.snapshot.purge',job.job_id,result,Date.now());
      purged.push({job_id:job.job_id,study_id:job.study_id,state:job.state,files:job.files.length,bytes:job.bytes,missing:job.missing});
    }
  }).immediate();
}catch(error){
  // Restore directory names if the database could not record the purge.
  for(const {from,to} of moved.reverse())await rename(to,from).catch(()=>{});
  throw error;
}
for(const {to} of moved)await rm(to,{recursive:true,force:false});
const report={schema:'export-snapshot-purge-v1',completed_at:ts(),mode:'apply',studies:uniqueStudies,evidence,purged,bytes:purged.reduce((n,j)=>n+j.bytes,0),backup:{path:beforePath,bytes:(await stat(beforePath)).size},inventory:join(dir,'inventory-before.json')};
await writeFile(join(dir,'purge-report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
db.pragma('wal_checkpoint(PASSIVE)');
db.close();
