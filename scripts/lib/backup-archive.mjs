import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileSha256,verifyBundle} from './backup-integrity.mjs';

const quote=s=>`'${String(s).replaceAll("'","'\\''")}'`;
const jobPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function pipeline(command,env){
  const result=spawnSync('/bin/bash',['-o','pipefail','-c',command],{env,encoding:'utf8'});
  if(result.status!==0)throw new Error(`ARCHIVE_COMMAND_FAILED:${result.stderr||result.error||result.status}`);
}
function verifyArchive(archive,job,manifestHash,env,bytes){
  let root=tmpdir();
  try{const st=fs.statfsSync('/dev/shm');if(st.bavail*st.bsize>bytes*1.1+64*1024*1024)root='/dev/shm';}catch{}
  const temp=fs.mkdtempSync(path.join(root,'psychlab-archive-check-'));
  try{
    pipeline(`zstd -dc ${quote(archive)} | tar -xf - -C ${quote(temp)}`,env);
    verifyBundle(path.join(temp,job),{manifestHash,jobId:job});
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
}
function dirBytes(dir){return fs.readdirSync(dir,{withFileTypes:true}).reduce((n,e)=>n+(e.isDirectory()?dirBytes(path.join(dir,e.name)):fs.statSync(path.join(dir,e.name)).size),0);}
function sync(file){const fd=fs.openSync(file,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}

export function archiveBackup(db,dir,{backupsRoot,latest,env=process.env}){
  const job=path.basename(dir);
  if(!jobPattern.test(job)||job===latest||fs.existsSync(path.join(dir,'.keep')))return null;
  const row=db.prepare('SELECT state,result FROM lab_jobs WHERE job_id=?').get(job);
  if(!row||!['READY','ARCHIVED'].includes(row.state))return null;
  const archiveRoot=path.join(backupsRoot,'archives'),archive=path.join(archiveRoot,`${job}.tar.zst`);
  fs.mkdirSync(archiveRoot,{recursive:true,mode:0o700});fs.chmodSync(archiveRoot,0o700);
  if(row.state==='ARCHIVED'){
    const detail=JSON.parse(row.result);
    if(!detail.manifest_hash||!detail.archive_sha256||fileSha256(archive)!==detail.archive_sha256)throw new Error('ARCHIVE_HASH_MISMATCH');
    verifyArchive(archive,job,detail.manifest_hash,env,detail.original_bytes);
    fs.rmSync(dir,{recursive:true,force:false});
    return {job_id:job,removed_leftover:true};
  }
  const {manifestHash}=verifyBundle(dir,{jobId:job}),originalBytes=dirBytes(dir);
  const temp=`${archive}.${randomUUID()}.tmp`;
  try{
    // Always regenerate READY archives: a prior interrupted attempt may have
    // left a valid compressed stream containing only part of the bundle.
    pipeline(`tar -C ${quote(backupsRoot)} -cf - ${quote(job)} | zstd -19 -q -o ${quote(temp)}`,env);
    fs.chmodSync(temp,0o600);
    verifyArchive(temp,job,manifestHash,env,originalBytes);
    sync(temp);fs.renameSync(temp,archive);sync(archiveRoot);
  }finally{fs.rmSync(temp,{force:true});}
  // A snapshot may have selected this bundle as its base during compression.
  if(fs.existsSync(path.join(dir,'.keep')))return null;
  const archiveBytes=fs.statSync(archive).size,archiveHash=fileSha256(archive);
  const detail={archived:true,archive:`archives/${job}.tar.zst`,archive_bytes:archiveBytes,archive_sha256:archiveHash,original_bytes:originalBytes,manifest_hash:manifestHash,archived_at:new Date().toISOString()};
  db.transaction(()=>{
    const changed=db.prepare("UPDATE lab_jobs SET state='ARCHIVED',phase='ARCHIVED',result=?,error=NULL,updated_at=? WHERE job_id=? AND state='READY'").run(JSON.stringify(detail),Date.now(),job);
    if(changed.changes!==1)throw new Error(`JOB_STATE_CHANGED:${job}`);
    db.prepare('INSERT INTO lab_audit VALUES (?,?,?,?,?,?)').run(randomUUID(),'SYSTEM','backup.bundle.archive',job,JSON.stringify(detail),Date.now());
  }).immediate();
  fs.rmSync(dir,{recursive:true,force:false});
  return {job_id:job,archive:detail.archive,original_bytes:originalBytes,archive_bytes:archiveBytes,archive_sha256:archiveHash};
}
