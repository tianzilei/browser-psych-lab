#!/usr/bin/env node
// Remove interaction/replay trajectory events for selected studies while
// preserving page revisions, page snapshots, seals, consents and covariates.
//
// "Trajectory" here means the INPUT_DIAGNOSTIC scopes written by the interaction
// recorder. Those scopes are separate from page scopes; deleting them does not
// change any page seal or answer. The command refuses mixed scopes and active
// sessions unless explicitly allowed.
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import Database from 'better-sqlite3';

const args=process.argv.slice(2);
const studies=[],studyIds=[];
let database=process.env.DATABASE_PATH,storageRoot=process.env.STORAGE_ROOT,backupDir,apply=false,allowActive=false;
for(let i=0;i<args.length;i++){
  const arg=args[i];
  if(arg==='--apply')apply=true;
  else if(arg==='--allow-active')allowActive=true;
  else if(arg==='--study')studies.push(args[++i]??'');
  else if(arg==='--study-id')studyIds.push(args[++i]??'');
  else if(arg==='--database')database=args[++i];
  else if(arg==='--storage-root')storageRoot=args[++i];
  else if(arg==='--backup-dir')backupDir=args[++i];
  else if(arg==='--help'||arg==='-h'){
    console.log(`Usage: node scripts/purge-interaction-trajectories.mjs --study <title> [--study <title>...] [options]
  --study-id <uuid>       Select by study id instead of title (repeatable)
  --database <path>       SQLite path (default DATABASE_PATH)
  --storage-root <path>   Private storage root (default STORAGE_ROOT)
  --backup-dir <path>     Evidence directory (default <storage-root>/trajectory-purge-<UTC timestamp>)
  --allow-active          Also purge non-terminal sessions (default: refuse)
  --apply                 Perform deletion; without it only prints the plan
The command creates an online backup, drops/recreates the delete-guard triggers
inside one transaction, removes only whole INPUT_DIAGNOSTIC scopes, rebuilds the
replay-index marker, writes an audit row and verifies page/seal counts.`);
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
const ph=(items)=>items.map(()=>'?').join(',');
const ts=()=>new Date().toISOString();
const sha256=(bytes)=>createHash('sha256').update(bytes).digest('hex');

const selected=[];
if(studies.length)for(const title of studies){
  const row=one('SELECT study_id,title FROM lab_studies WHERE title=?',title);
  if(!row)throw new Error(`STUDY_NOT_FOUND:${title}`);
  selected.push(row);
}
for(const id of studyIds){
  const row=one('SELECT study_id,title FROM lab_studies WHERE study_id=?',id);
  if(!row)throw new Error(`STUDY_NOT_FOUND:${id}`);
  selected.push(row);
}
const uniqueStudies=[...new Map(selected.map(s=>[s.study_id,s])).values()];
const ids=uniqueStudies.map(s=>s.study_id);
const sessions=q(`SELECT session_id,study_id,state,created_at FROM lab_sessions WHERE study_id IN (${ph(ids)}) ORDER BY created_at`,...ids);
if(!sessions.length)throw new Error('NO_SESSIONS_FOR_STUDIES');
const nonTerminal=sessions.filter(s=>!['COMPLETED','TERMINATED'].includes(s.state));
if(nonTerminal.length&&!allowActive)throw new Error(`NON_TERMINAL_SESSIONS:${nonTerminal.map(s=>`${s.session_id}:${s.state}`).join(',')}`);
const sessionIds=sessions.map(s=>s.session_id);
const sessionPh=ph(sessionIds);

// Page scopes are answers/evidence and must never be part of this purge.
const pageScopes=new Set();
for(const row of q(`SELECT s.session_id,v.protocol FROM lab_sessions s JOIN lab_versions v ON v.version_id=s.version_id WHERE s.session_id IN (${sessionPh})`,...sessionIds)){
  for(const page of (JSON.parse(row.protocol).pages??[]))pageScopes.add(`${row.session_id}\0${page.id}`);
}
const scopeRows=q(`SELECT r.session_id,r.scope,count(*) events,sum(length(r.raw)) bytes,
  sum(CASE WHEN e.kind='INPUT_DIAGNOSTIC' THEN 1 ELSE 0 END) diagnostics,
  sum(CASE WHEN e.kind<>'INPUT_DIAGNOSTIC' THEN 1 ELSE 0 END) other
  FROM lab_raw r JOIN lab_events e ON e.session_id=r.session_id AND e.event_id=r.event_id AND e.hash=r.hash
  WHERE r.session_id IN (${sessionPh}) GROUP BY r.session_id,r.scope
  HAVING diagnostics>0 ORDER BY bytes DESC`,...sessionIds);
const mixed=scopeRows.filter(s=>s.other>0);
const pageHits=scopeRows.filter(s=>pageScopes.has(`${s.session_id}\0${s.scope}`));
if(mixed.length||pageHits.length)throw new Error(`MIXED_OR_PAGE_SCOPE:${JSON.stringify([...mixed,...pageHits].map(s=>({session_id:s.session_id,scope:s.scope,other:s.other})))}`);
const scopes=scopeRows.map(s=>({session_id:s.session_id,scope:s.scope,events:s.events,bytes:s.bytes}));
if(!scopes.length){console.log(JSON.stringify({purged:false,reason:'NO_INTERACTION_TRAJECTORY',studies:uniqueStudies,sessions:sessions.length},null,2));db.close();process.exit(0);}

const before={sessions:sessions.length,scopes:scopes.length,events:scopes.reduce((n,s)=>n+s.events,0),bytes:scopes.reduce((n,s)=>n+s.bytes,0),
  page_events:one(`SELECT count(*) n FROM lab_events WHERE session_id IN (${sessionPh}) AND kind<>'INPUT_DIAGNOSTIC'`,...sessionIds).n,
  seals:one(`SELECT count(*) n FROM lab_seals WHERE session_id IN (${sessionPh})`,...sessionIds).n,
  consents:one(`SELECT count(*) n FROM lab_consents WHERE session_id IN (${sessionPh})`,...sessionIds).n,
  covariates:one(`SELECT count(*) n FROM lab_covariates WHERE session_id IN (${sessionPh})`,...sessionIds).n,
  replay_index:one(`SELECT count(*) n FROM lab_replay_index WHERE session_id IN (${sessionPh})`,...sessionIds).n};
const plan={purged:false,mode:apply?'apply':'dry-run',studies:uniqueStudies,sessions:sessions.length,scopes:scopes.length,events:before.events,bytes:before.bytes,before,
  scope_sample:scopes.slice(0,10),timestamp:ts()};
console.log(JSON.stringify(plan,null,2));
if(!apply){db.close();process.exit(0);}

const stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\..+/,'').replace('T','-');
const dir=backupDir??join(storageRoot,`trajectory-purge-${stamp}`);
await mkdir(dir,{recursive:true,mode:0o700});
const backupPath=join(dir,'before.sqlite');
await db.backup(backupPath);
const backupBytes=await readFile(backupPath);
const backupDb=new Database(backupPath,{readonly:true,fileMustExist:true});
try{
  if(backupDb.pragma('quick_check',{simple:true})!=='ok'||(backupDb.pragma('foreign_key_check')).length)throw new Error('BACKUP_DATABASE_CHECK_FAILED');
  if(backupDb.prepare('SELECT count(*) n FROM lab_sessions WHERE study_id IN ('+ph(ids)+')').get(...ids).n!==sessions.length)throw new Error('BACKUP_SESSION_SET_MISMATCH');
}finally{backupDb.close();}

const deleteTriggers=q(`SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('lab_raw','lab_events','lab_dispositions') AND sql LIKE '%BEFORE DELETE%'`);
const deleted=db.transaction(()=>{
  db.exec('CREATE TEMP TABLE purge_scopes(session_id TEXT NOT NULL,scope TEXT NOT NULL,PRIMARY KEY(session_id,scope))');
  const insert=db.prepare('INSERT INTO purge_scopes VALUES (?,?)');
  for(const s of scopes)insert.run(s.session_id,s.scope);
  for(const trigger of deleteTriggers)db.exec(`DROP TRIGGER ${trigger.name}`);
  try{
    const dispositions=db.prepare(`DELETE FROM lab_dispositions WHERE receipt_id IN (SELECT r.receipt_id FROM lab_raw r JOIN purge_scopes p ON p.session_id=r.session_id AND p.scope=r.scope)`).run().changes;
    const events=db.prepare(`DELETE FROM lab_events WHERE EXISTS(SELECT 1 FROM purge_scopes p WHERE p.session_id=lab_events.session_id AND p.scope=lab_events.scope)`).run().changes;
    const raw=db.prepare(`DELETE FROM lab_raw WHERE EXISTS(SELECT 1 FROM purge_scopes p WHERE p.session_id=lab_raw.session_id AND p.scope=lab_raw.scope)`).run().changes;
    const usage=db.prepare(`DELETE FROM lab_scope_usage WHERE EXISTS(SELECT 1 FROM purge_scopes p WHERE p.session_id=lab_scope_usage.session_id AND p.scope=lab_scope_usage.scope)`).run().changes;
    const replay=db.prepare(`DELETE FROM lab_replay_index WHERE session_id IN (SELECT session_id FROM lab_sessions WHERE study_id IN (${ph(ids)}))`).run(...ids).changes;
    const maxRow=one('SELECT coalesce(max(rowid),0) n FROM lab_events').n;
    db.prepare("INSERT INTO lab_meta(key,value) VALUES('replay_index',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`valid-screen-v1:${maxRow}`);
    const detail={reason:'OPERATOR_TRAJECTORY_PURGE',studies:uniqueStudies.map(s=>({study_id:s.study_id,title:s.title})),sessions:sessions.length,scopes:scopes.length,events:before.events,bytes:before.bytes,backup:'before.sqlite',backup_sha256:sha256(backupBytes),deleted:{dispositions,events,raw,usage,replay_index:replay}};
    db.prepare('INSERT INTO lab_audit VALUES (?,?,?,?,?,?)').run(randomUUID(),'OPERATOR','trajectory.purge',uniqueStudies.map(s=>s.study_id).join(','),JSON.stringify(detail),Date.now());
    db.exec('DROP TABLE purge_scopes');
    return detail;
  }finally{
    for(const trigger of deleteTriggers)db.exec(trigger.sql);
  }
}).immediate();

const after={page_events:one(`SELECT count(*) n FROM lab_events WHERE session_id IN (${sessionPh}) AND kind<>'INPUT_DIAGNOSTIC'`,...sessionIds).n,
  seals:one(`SELECT count(*) n FROM lab_seals WHERE session_id IN (${sessionPh})`,...sessionIds).n,
  consents:one(`SELECT count(*) n FROM lab_consents WHERE session_id IN (${sessionPh})`,...sessionIds).n,
  covariates:one(`SELECT count(*) n FROM lab_covariates WHERE session_id IN (${sessionPh})`,...sessionIds).n,
  replay_index:one(`SELECT count(*) n FROM lab_replay_index WHERE session_id IN (${sessionPh})`,...sessionIds).n,
  remaining_trajectory_scopes:one(`SELECT count(*) n FROM lab_raw r JOIN lab_events e ON e.session_id=r.session_id AND e.event_id=r.event_id AND e.hash=r.hash WHERE r.session_id IN (${sessionPh}) AND e.kind='INPUT_DIAGNOSTIC'`,...sessionIds).n,
  total_events:one('SELECT count(*) n FROM lab_events').n,total_raw:one('SELECT count(*) n FROM lab_raw').n,
  quick_check:one('PRAGMA quick_check').quick_check,foreign_key_issues:q('PRAGMA foreign_key_check').length};
const mismatched=[];
for(const key of ['page_events','seals','consents','covariates'])if(after[key]!==before[key])mismatched.push({key,before:before[key],after:after[key]});
if(after.remaining_trajectory_scopes!==0||mismatched.length||after.quick_check!=='ok'||after.foreign_key_issues!==0)throw new Error(`PURGE_VERIFICATION_FAILED:${JSON.stringify({after,mismatched})}`);
const report={schema:'trajectory-purge-v1',completed_at:ts(),mode:'apply',studies:uniqueStudies,sessions:sessions.map(s=>({session_id:s.session_id,state:s.state})),scopes:scopes.map(s=>s.scope),deleted,before,after,backup:{path:backupPath,bytes:backupBytes.length,sha256:sha256(backupBytes)},verification:{page_or_answer_evidence_changed:false,mismatched}};
await writeFile(join(dir,'purge-report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({purged:true,directory:dir,deleted,before,after,backup:{path:backupPath,bytes:backupBytes.length,sha256:report.backup.sha256}},null,2));
db.pragma('wal_checkpoint(PASSIVE)');
db.close();
