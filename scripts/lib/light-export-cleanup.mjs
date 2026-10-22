import {lstat,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {purgeExportSnapshots,recoverExportPurges} from './export-purge.mjs';

// Only terminal, derived result exports expire. Neither active exports nor
// source answers, raw events, assets or backups are part of this plan.
export async function cleanLightExports(db,root,{now=Date.now(),retentionMs=86400000,apply=false}={}){
  if(!Number.isSafeInteger(retentionMs)||retentionMs<0)throw new Error('INVALID_EXPORT_RETENTION');
  const studies=db.prepare('SELECT study_id FROM lab_studies').all().map(row=>row.study_id);
  await recoverExportPurges(db,root,studies,{apply});
  const jobs=db.prepare("SELECT job_id,study_id,state,config,updated_at FROM lab_jobs WHERE kind='EXPORT' AND state IN ('READY','FAILED') AND updated_at<=? ORDER BY updated_at").all(now-retentionMs);
  const plan=[];
  for(const job of jobs){
    if(JSON.parse(job.config).format!=='answers')continue;
    if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(job.job_id))throw new Error('INVALID_EXPORT_ID');
    const dir=join(root,'research-exports',job.job_id);
    const info=await lstat(dir).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    const entry={job_id:job.job_id,study_id:job.study_id,state:job.state,missing:!info,files:[],bytes:0};
    if(info){
      if(!info.isDirectory()||info.isSymbolicLink())throw new Error('UNSAFE_EXPORT_DIRECTORY');
      for(const file of await readdir(dir,{withFileTypes:true})){
        if(!file.isFile()||file.isSymbolicLink())throw new Error('UNSAFE_EXPORT_ENTRY');
        const size=(await lstat(join(dir,file.name))).size;
        entry.files.push({name:file.name,bytes:size});entry.bytes+=size;
      }
    }
    plan.push(entry);
  }
  if(apply)await purgeExportSnapshots(db,root,plan,randomUUID(),undefined,{reason:'LIGHT_EXPORT_RETENTION_EXPIRED',actor:'SYSTEM'});
  return {mode:apply?'apply':'dry-run',retention_hours:retentionMs/3600000,cutoff:new Date(now-retentionMs).toISOString(),jobs:plan.length,bytes:plan.reduce((sum,job)=>sum+job.bytes,0)};
}
