全项目设计讨论，传输段 18，源码主题：研究和参加者事务（源包 6/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

      this.skipPages({...s,page_index:s.page_index+1,answers:stableJSON(answers)},p);
    } else {
      const permit=this.get<{permit_id:string;group_id:string;state:string}>('SELECT * FROM lab_permits WHERE session_id=? AND scope=?',s.session_id,manifest.scope);
      if(!permit||permit.state!=='ISSUED')throw new ContractError('OUTSIDE_PERMIT',409);
      const proof=this.get<{kind:string;state:string;result:string}>('SELECT * FROM lab_jobs WHERE job_id=?',id(d.proof_job_id));
      if(!proof||proof.kind!=='REPLAY'||proof.state!=='READY')throw new ContractError('REPLAY_REQUIRED',409);
      const result=object(JSON.parse(proof.result));const source=digest(stableJSON(refs));
      if(result.session_id!==s.session_id||result.scope!==manifest.scope||result.source_hash!==source||result.valid!==true)throw new ContractError('REPLAY_PROOF_STALE_OR_INVALID',409);
      path.push(permit.group_id);if(stableJSON(manifest.path)!==stableJSON(path))throw new ContractError('GROUP_PATH_MISMATCH');
      this.run("UPDATE lab_permits SET state='CLOSED_NORMAL' WHERE permit_id=?",permit.permit_id);this.run('UPDATE lab_sessions SET group_index=group_index+1,path=? WHERE session_id=?',stableJSON(path),s.session_id);
    }
    const seal:Seal={seal_id:randomUUID(),manifest,manifest_hash:h,algorithm:'exact-set-and-chain-v1',status:'SEALED'};
    this.run('INSERT INTO lab_seals VALUES (?,?,?,?,?)',s.session_id,manifest.scope,seal.seal_id,h,JSON.stringify(seal));return seal;
  }
  beginJob(job:string,kind:string,study:string|null,config:Record<string,unknown>,actor='SYSTEM') {
    if(!['UPLOAD','PACKAGE','DELETE','EXPORT','BACKUP','REPLAY','REBUILD'].includes(kind))throw new ContractError('INVALID_JOB_KIND');
    if(this.get("SELECT 1 FROM lab_jobs WHERE state IN ('RUNNING','RECOVERY_REQUIRED')"))throw new ContractError('MAINTENANCE_BUSY',503);
    this.run("INSERT INTO lab_jobs VALUES (?,?,?,'RUNNING','REGISTERED',?,NULL,NULL,?,?)",job,kind,study,stableJSON(config),this.now(),this.now());
    if(kind==='BACKUP'){this.barrier();this.run("UPDATE lab_meta SET value=? WHERE key='resource_barrier'",job);}
    this.audit(actor,'JOB_BEGIN',job,{kind,study});return {job_id:job,status:'RUNNING'};
  }
  private internal(op:string,d:Record<string,unknown>):unknown {
    switch(op){
      case 'internal.package.ready':{
        this.barrier();const sid=id(d.study_id),name=packageName(d.name);if(!Array.isArray(d.images)||!d.images.length||d.images.length>100)throw new ContractError('INVALID_PACKAGE');
        this.run('INSERT INTO lab_packages VALUES (?,?,?,?)',sid,name,hash(d.hash),id(d.job_id));
        for(const v of d.images){const a=object(v),asset=id(a.asset_id);this.run("INSERT INTO lab_assets VALUES (?,?,?,'READY',?,?,?,?,?,?,?)",asset,sid,`${name}/${a.path}`,hash(a.hash),integer(a.bytes,1),integer(a.width,1),integer(a.height,1),String(a.format),asset,this.now());this.run('INSERT INTO lab_package_images VALUES (?,?,?,?)',sid,name,a.path,asset);this.run("INSERT INTO lab_asset_refs VALUES (?,'PACKAGE',?)",asset,id(d.job_id));}
        return {status:'READY'};
      }
      case 'internal.job.begin':return this.beginJob(id(d.job_id),String(d.kind),d.study_id?id(d.study_id):null,object(d.config??{}));
      case 'internal.job.phase':this.run('UPDATE lab_jobs SET phase=?,updated_at=? WHERE job_id=? AND state=\'RUNNING\'',id(d.phase),this.now(),id(d.job_id));return {status:'ok'};
      case 'internal.job.finish':{
        const job=id(d.job_id);if(!['READY','FAILED','RECOVERY_REQUIRED'].includes(String(d.state)))throw new ContractError('INVALID_JOB_STATE');
        if(!this.get("SELECT 1 FROM lab_jobs WHERE job_id=? AND state IN ('RUNNING','RECOVERY_REQUIRED')",job))throw new ContractError('JOB_TERMINAL',409);
        this.run('UPDATE lab_jobs SET state=?,phase=?,result=?,error=?,updated_at=? WHERE job_id=?',d.state,String(d.state),d.result?stableJSON(d.result):null,d.error?String(d.error).slice(0,300):null,this.now(),job);
        if(d.state==='READY'||(d.state==='FAILED'&&d.release_verified===true)){
          this.run('DELETE FROM lab_pins WHERE job_id=?',job);this.run("UPDATE lab_meta SET value='' WHERE key='resource_barrier' AND value=?",job);
        }return {job_id:job,state:d.state};
      }
      case 'internal.job.interrupted':this.run("UPDATE lab_jobs SET state='RECOVERY_REQUIRED',phase='INTERRUPTED' WHERE state='RUNNING'");return {status:'ok'};
      case 'internal.backup.pin':{
        const job=id(d.job_id);if(this.get<{value:string}>("SELECT value FROM lab_meta WHERE key='resource_barrier'")!.value!==job)throw new ContractError('BACKUP_BARRIER_NOT_HELD');
        if(!Array.isArray(d.assets)||d.assets.length>10000)throw new ContractError('INVALID_BACKUP_MANIFEST');
        for(const x of d.assets){const a=object(x);const current=this.get<{state:string;hash:string}>('SELECT state,hash FROM lab_assets WHERE asset_id=?',id(a.asset_id));
          if(!current||current.state!=='READY'||current.hash!==hash(a.hash))throw new ContractError('BACKUP_ASSET_UNAVAILABLE');this.run('INSERT INTO lab_pins VALUES (?,?)',a.asset_id,job);}
        this.run("UPDATE lab_meta SET value='' WHERE key='resource_barrier' AND value=?",job);return {status:'PINNED'};
      }
      case 'internal.asset.ready':{
        this.barrier();const info=object(d.info);const asset=id(d.asset_id);this.run("UPDATE lab_assets SET state='READY',hash=?,bytes=?,width=?,height=?,format=? WHERE asset_id=? AND state='UPLOADING'",hash(info.hash),integer(info.bytes,1),integer(info.width,1),integer(info.height,1),String(info.format),asset);return {asset_id:asset,status:'READY'};
      }
      case 'internal.asset.failed':this.run("UPDATE lab_assets SET state='FAILED' WHERE asset_id=? AND state='UPLOADING'",id(d.asset_id));return {status:'FAILED'};
      case 'internal.asset.purged':this.run("UPDATE lab_assets SET state='PURGED' WHERE asset_id=? AND state='DELETING'",id(d.asset_id));return {status:'PURGED'};
      case 'internal.projection.publish':{const generation=id(d.job_id);if(!Array.isArray(d.projections))throw new ContractError('INVALID_PROJECTIONS');for(const item of d.projections){const p=object(item);this.run('INSERT INTO lab_projections VALUES (?,?,?,?,?,?)',generation,id(p.session_id),id(p.scope),hash(p.source_hash),'run-replay-v1',stableJSON(p.result));}this.run("INSERT INTO lab_meta VALUES ('active_projection',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",generation);this.audit('SYSTEM','PROJECTION_PUBLISHED',generation,{count:d.projections.length});return {generation};}
      case 'internal.job.get':return this.get('SELECT * FROM lab_jobs WHERE job_id=?',id(d.job_id));
      case 'internal.operations':return {admission:this.admission.stats(),gate:this.get<{value:string}>("SELECT value FROM lab_meta WHERE key='collection_gate'")!.value,barrier:this.get<{value:string}>("SELECT value FROM lab_meta WHERE key='resource_barrier'")!.value,
        sessions:this.all('SELECT state,count(*) AS count FROM lab_sessions GROUP BY state'),dispositions:this.all('SELECT disposition,count(*) AS count FROM lab_events GROUP BY disposition'),open_permits:this.get("SELECT count(*) AS count FROM lab_permits WHERE state='ISSUED'"),jobs:this.all("SELECT job_id,kind,state,phase,error FROM lab_jobs WHERE state IN ('RUNNING','RECOVERY_REQUIRED')"),last_backup:this.get("SELECT job_id,updated_at,result FROM lab_jobs WHERE kind='BACKUP' AND state='READY' ORDER BY updated_at DESC LIMIT 1")??null};
      case 'internal.asset.info':return this.get('SELECT * FROM lab_assets WHERE asset_id=?',id(d.asset_id));
      default:throw new ContractError('UNKNOWN_INTERNAL_OPERATION');
    }
  }
}

```