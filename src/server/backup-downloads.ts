import {lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {openPrivate} from './private-files.js';
import type {ServerBackup} from '../shared/storage.js';

export interface BackupJob {job_id:string;state:string;created_at:number;result:string|null}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash=/^[0-9a-f]{64}$/;
async function directory(path:string){try{const st=await lstat(path);return st.isDirectory()&&!st.isSymbolicLink();}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}}
async function metadata(path:string){
  const file=await openPrivate(path);
  try{if((await file.stat()).size>16384)throw new Error('BACKUP_METADATA_TOO_LARGE');const value:unknown=JSON.parse(await file.readFile('utf8'));return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}finally{await file.close();}
}
/** Only published, precompressed files are selectable. This never creates a backup or an archive. */
export async function listBackupDownloads(root:string,jobs:BackupJob[]):Promise<(ServerBackup&{path:string})[]>{
  const base=join(root,'research-backups'),backups:(ServerBackup&{path:string})[]=[];
  if(!await directory(base))return backups;
  for(const job of jobs){
    if(!uuid.test(job.job_id)||!Number.isFinite(job.created_at)||!['READY','ARCHIVED'].includes(job.state))continue;
    const bucket=job.state==='ARCHIVED'?'archives':'downloads',folder=join(base,bucket);
    if(!await directory(folder))continue;
    try{
      const parsed:unknown=JSON.parse(job.result??'{}'),filename=`${job.job_id}.tar.zst`;
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))continue;const result=parsed as Record<string,unknown>;
      let bytes:unknown,sha256:unknown;
      if(job.state==='ARCHIVED'){
        if(result.archived!==true||result.archive!==`archives/${filename}`)continue;
        bytes=result.archive_bytes;sha256=result.archive_sha256;
      }else{
        const prepared=await metadata(join(folder,`${job.job_id}.json`));
        if(prepared.schema!=='backup-download-v1'||prepared.job_id!==job.job_id||prepared.manifest_hash!==result.manifest_hash)continue;
        bytes=prepared.bytes;sha256=prepared.sha256;
      }
      if(typeof bytes!=='number'||!Number.isSafeInteger(bytes)||bytes<=0||typeof sha256!=='string'||!hash.test(sha256))continue;
      const path=join(folder,filename),st=await lstat(path);
      if(!st.isFile()||st.isSymbolicLink()||st.size!==bytes)continue;
      backups.push({job_id:job.job_id,created_at:job.created_at,bytes,sha256,filename,url:`/api/lab/backups/${job.job_id}`,path});
    }catch(error){if(!['ENOENT','ELOOP'].includes((error as NodeJS.ErrnoException).code??'')&&!(error instanceof SyntaxError))throw error;}
  }
  return backups.sort((a,b)=>b.created_at-a.created_at||a.job_id.localeCompare(b.job_id));
}
