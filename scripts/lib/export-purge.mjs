import {lstat,readdir,rename,rm,rmdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

// Recover either side of a process interruption: before the DB commit the
// original READY/FAILED directory is restored; after it, deletion is resumed.
export async function recoverExportPurges(db,storageRoot,studyIds,{apply=false}={}){
  const root=join(storageRoot,'research-exports'),selected=new Set(studyIds),recovered=[];
  const entries=await readdir(root,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  for(const entry of entries){
    const match=entry.name.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.purging-.+$/i);
    if(!match)continue;
    const job=db.prepare("SELECT study_id,state FROM lab_jobs WHERE job_id=? AND kind='EXPORT'").get(match[1]);
    if(!job||!selected.has(job.study_id))continue;
    if(!entry.isDirectory()||entry.isSymbolicLink())throw new Error(`UNSAFE_EXPORT_DIRECTORY:${entry.name}`);
    if(!apply)throw new Error(`EXPORT_PURGE_RECOVERY_REQUIRED:${match[1]}`);
    const from=join(root,entry.name),to=join(root,match[1]);
    if(job.state==='PURGED')await rm(from,{recursive:true,force:false});
    else if(['READY','FAILED'].includes(job.state)){
      const info=await lstat(to).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      // A download may have recreated an empty canonical directory. Never
      // replace a populated directory or follow a symlink during recovery.
      if(info){
        if(!info.isDirectory()||info.isSymbolicLink()||(await readdir(to)).length)throw new Error(`EXPORT_PURGE_RECOVERY_CONFLICT:${match[1]}`);
        await rmdir(to);
      }
      await rename(from,to);
    }else throw new Error(`EXPORT_PURGE_RECOVERY_STATE:${match[1]}:${job.state}`);
    recovered.push({job_id:match[1],state:job.state});
  }
  return recovered;
}

export async function purgeExportSnapshots(db,storageRoot,plan,stamp,io={rename,rm},options={}){
  const moved=[],purged=[];
  try{
    for(const job of plan){
      if(job.missing)continue;
      const from=join(storageRoot,'research-exports',job.job_id),to=`${from}.purging-${stamp}`;
      await io.rename(from,to);moved.push({from,to});
    }
    db.transaction(()=>{
      for(const job of plan){
        const detail={reason:options.reason??'OPERATOR_EXPORT_SNAPSHOT_PURGE',study_id:job.study_id,state:job.state,files:job.files.length,bytes:job.bytes,missing:job.missing,answer_evidence:'retained-in-live-database',...(options.reason?{}:{inventory:'inventory-before.json'})};
        const result=JSON.stringify(detail);
        const changed=db.prepare("UPDATE lab_jobs SET state='PURGED',phase='PURGED',result=?,error=NULL,updated_at=? WHERE job_id=? AND state IN ('READY','FAILED')").run(result,Date.now(),job.job_id);
        if(changed.changes!==1)throw new Error(`JOB_STATE_CHANGED:${job.job_id}`);
        db.prepare('INSERT INTO lab_audit VALUES (?,?,?,?,?,?)').run(randomUUID(),options.actor??'OPERATOR','export.snapshot.purge',job.job_id,result,Date.now());
        purged.push({job_id:job.job_id,study_id:job.study_id,state:job.state,files:job.files.length,bytes:job.bytes,missing:job.missing});
      }
    }).immediate();
  }catch(error){
    const failures=[];
    for(const {from,to} of moved.reverse())try{await io.rename(to,from);}catch(rollbackError){failures.push(rollbackError);}
    if(failures.length)throw new AggregateError([error,...failures],'EXPORT_PURGE_ROLLBACK_FAILED',{cause:error});
    throw error;
  }
  for(const {to} of moved)await io.rm(to,{recursive:true,force:false});
  return purged;
}
