#!/usr/bin/env node
// Restore a base bundle (assets + runners) and then replace its database with
// a SQLite-only snapshot. The same safety resets as restore.ts are applied.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const require=createRequire('/opt/browser-psych-lab/current/package.json');
const Database=require('better-sqlite3');
const {restoreBackup}=await import(pathToFileURL('/opt/browser-psych-lab/current/dist/server/restore.js').href);
const {verifyEvidence}=await import(pathToFileURL('/opt/browser-psych-lab/current/dist/server/evidence-storage.js').href);
const [baseBundle,snapshot,destination]=process.argv.slice(2);
if(!baseBundle||!snapshot||!destination)throw new Error('Usage: node restore-hybrid.mjs BASE_BUNDLE SNAPSHOT NEW_STORAGE_ROOT');
const sha256=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const metaPath=snapshot.replace(/\.sqlite\.zst$/,'.json');
const meta=JSON.parse(fs.readFileSync(metaPath,'utf8'));
if(meta.schema!=='sqlite-snapshot-v1')throw new Error('INVALID_SNAPSHOT_METADATA');
if(sha256(snapshot)!==meta.sha256)throw new Error('SNAPSHOT_HASH_MISMATCH');
const baseManifestRaw=fs.readFileSync(path.join(baseBundle,'manifest.json'),'utf8'),baseManifest=JSON.parse(baseManifestRaw);
if(baseManifest.schema!=='backup-v1')throw new Error('INVALID_BASE_MANIFEST');
if(sha256(path.join(baseBundle,'manifest.json'))!==meta.base.manifest_hash)throw new Error('BASE_MANIFEST_MISMATCH');
const baseFiles=new Map(baseManifest.files.map(f=>[f.path,f.hash]));
const base=await restoreBackup(baseBundle,destination);
const dbPath=path.join(destination,'database/browser-psych-lab.sqlite');
for(const p of [dbPath,`${dbPath}-wal`,`${dbPath}-shm`])if(fs.existsSync(p))fs.rmSync(p);
const z=spawnSync('/bin/bash',['-c',`zstd -dc '${snapshot.replaceAll("'","'\\''")}' > '${dbPath.replaceAll("'","'\\''")}'`],{stdio:'inherit'});
if(z.status!==0)throw new Error(`SNAPSHOT_DECOMPRESS_FAILED:${z.status}`);
fs.chmodSync(dbPath,0o600);
const db=new Database(dbPath);db.pragma('busy_timeout=15000');db.pragma('foreign_keys=ON');db.pragma('journal_mode=WAL');db.pragma('synchronous=FULL');
try{
  const integrity=db.pragma('integrity_check',{simple:true}),fk=db.pragma('foreign_key_check').length;
  if(integrity!=='ok'||fk!==0)throw new Error(`RESTORED_DB_CHECK_FAILED:${integrity}:${fk}`);
  const evidence=verifyEvidence(db);
  for(const a of db.prepare("SELECT asset_id,hash FROM lab_assets WHERE state='READY'").all()){
    if(baseFiles.get(`assets/${a.asset_id}.bin`)!==a.hash)throw new Error(`SNAPSHOT_ASSET_NOT_IN_BASE:${a.asset_id}`);
  }
  for(const v of db.prepare('SELECT DISTINCT runner_hash FROM lab_versions').all()){
    if(!baseFiles.has(`runners/${v.runner_hash}/release.json`)||!baseFiles.has(`runners/${v.runner_hash}/run.html`))throw new Error(`SNAPSHOT_RUNNER_NOT_IN_BASE:${v.runner_hash}`);
  }
  const counts=db.prepare(`SELECT
    (SELECT count(*) FROM lab_studies) AS studies,
    (SELECT count(*) FROM lab_versions) AS versions,
    (SELECT count(*) FROM lab_sessions) AS sessions,
    (SELECT count(*) FROM lab_raw) AS raw,
    (SELECT count(*) FROM lab_assets) AS assets,
    (SELECT count(*) FROM lab_seals) AS seals`).get();
  db.transaction(()=>{
    db.prepare("UPDATE lab_meta SET value='CLOSED' WHERE key='collection_gate'").run();
    db.prepare('DELETE FROM lab_admin_tokens').run();
    db.prepare("UPDATE lab_jobs SET state='RECOVERY_REQUIRED',phase='RESTORED_UNRESOLVED' WHERE state='RUNNING'").run();
    db.prepare("DELETE FROM p0_meta WHERE key='app_instance'").run();
  }).immediate();
  db.pragma('wal_checkpoint(TRUNCATE)');
  const report={schema:'hybrid-restore-report-v1',completed_at:new Date().toISOString(),base:{job_id:meta.base.job_id,manifest_hash:meta.base.manifest_hash},snapshot:{file:path.basename(snapshot),sha256:meta.sha256,bytes:meta.bytes},destination,counts,integrity,foreign_key_issues:fk,evidence,gate:'CLOSED',admin_tokens:'deleted',independent_restore_claim:'operator-verification-required'};
  fs.writeFileSync(path.join(destination,'hybrid-restore-report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({base,report},null,2));
}finally{db.close();}
