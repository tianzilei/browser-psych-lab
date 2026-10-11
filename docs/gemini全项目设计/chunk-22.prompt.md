全项目设计讨论，传输段 22，源码主题：维护、文件生命周期及恢复（源包 8/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

### src/server/maintenance.ts L1–L43

```
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { DatabaseWriter } from './writer.js';
import { ContractError } from '../shared/contract.js';
export class Maintenance {
  private worker:Worker|null=null;
  constructor(readonly writer:DatabaseWriter,readonly path:string,readonly root:string){}
  get busy(){return this.worker!==null;}
  private call(operation:string,data:Record<string,unknown>){return this.writer.request({operation:`lab/internal.${operation}`,data});}
  async run(kind:string,config:Record<string,unknown>,existingJob?:string){
    if(this.worker)throw new ContractError('MAINTENANCE_BUSY',503);const job=existingJob??randomUUID();
    if(!existingJob)await this.call('job.begin',{job_id:job,kind,study_id:config.study_id??null,config});
    const source=import.meta.url.endsWith('.ts');const worker=new Worker(new URL(source?'./maintenance-worker.ts':'./maintenance-worker.js',import.meta.url),{
      workerData:{path:this.path,root:this.root,job,kind,config},...(source?{execArgv:['--import','tsx']}:{})});this.worker=worker;
    let completed=false;
    try{
      const result=await new Promise<unknown>((resolve,reject)=>{
        const timer=setTimeout(()=>{void worker.terminate();reject(new Error('MAINTENANCE_TIMEOUT'));},120000);
        worker.on('message',(message:{phase?:string;data?:unknown;result?:unknown;error?:string;validation_rejected?:boolean})=>{
          if(message.phase){void this.call('job.phase',{job_id:job,phase:message.phase}).then(async()=>{
            if(message.phase==='PIN_REQUIRED'){await this.call('backup.pin',{job_id:job,assets:message.data});worker.postMessage({pinned:true});}
          }).catch(reject);return;}
          clearTimeout(timer);if(message.error)reject(Object.assign(new Error(message.error),{validation_rejected:message.validation_rejected===true}));else resolve(message.result);
        });worker.once('error',error=>{clearTimeout(timer);reject(error);});worker.once('exit',code=>{clearTimeout(timer);if(code!==0)reject(new Error('MAINTENANCE_WORKER_EXITED'));});
      });
      if(kind==='UPLOAD'){const r=result as {asset_id:string;info:unknown};await this.call('asset.ready',{asset_id:r.asset_id,info:r.info});}
      if(kind==='PACKAGE')await this.call('package.ready',{...result as Record<string,unknown>,job_id:job});
      if(kind==='REBUILD')await this.call('projection.publish',{job_id:job,projections:(result as {projections:unknown}).projections});
      if(kind==='DELETE')await this.call('asset.purged',{asset_id:config.asset_id});
      await this.call('job.finish',{job_id:job,state:kind==='RECOVER'?'FAILED':'READY',result,release_verified:kind==='RECOVER'});completed=true;return {job_id:job,result};
    }catch(error){
      const rejected=kind==='PACKAGE'&&(error as {validation_rejected?:boolean}).validation_rejected===true;
      await this.call('job.finish',{job_id:job,state:rejected?'FAILED':'RECOVERY_REQUIRED',release_verified:rejected,error:error instanceof Error?error.message:'FAILED'}).catch(()=>{});
      if(rejected)throw new ContractError('INVALID_IMAGE_PACKAGE',400,{reason:error instanceof Error?error.message:'INVALID_ZIP'});throw error;
    }finally{
      // A replacement cannot start before actual worker exit, even after a timeout.
      await worker.terminate();this.worker=null;if(!completed&&kind==='UPLOAD')await this.call('asset.failed',{asset_id:config.asset_id}).catch(()=>{});
    }
  }
  async recover(job:string,report:string){const original=await this.call('job.get',{job_id:job}) as {state:string;kind:string;config:string};if(original.state!=='RECOVERY_REQUIRED')throw new ContractError('JOB_NOT_RECOVERABLE',409);return this.run('RECOVER',{original_kind:original.kind,original_config:JSON.parse(original.config),report},job);}
  async close(){if(this.worker)await this.worker.terminate();}
}

```

### src/server/maintenance-worker.ts L1–L171

```
import { parentPort,workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import {imageInfo,unpackImages} from './image-package.js';
import { mkdir,unlink,copyFile,readdir,lstat,chmod,readFile } from 'node:fs/promises';
import { join,dirname } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { openSync,writeSync,fsyncSync,closeSync,constants } from 'node:fs';
import { privateRoot,assetPath,fileHash,publishExclusive,writeDurable,syncDirectory,openPrivate } from './private-files.js';
import { digest } from './collection-store.js';
import { stableJSON,pageSnapshot,evaluate,type Protocol,type Answer } from '../shared/protocol.js';
import { RunReplay } from '../shared/run-replay.js';
import { parseLabEvent,type GroupPlan,type RunRecord } from '../shared/lab-contract.js';
import { id,object } from '../shared/contract.js';

const config=workerData as {path:string;root:string;job:string;kind:string;config:Record<string,unknown>};
const phase=(phase:string,data?:unknown)=>parentPort!.postMessage({phase,data});
async function copyChecked(source:string,target:string){const bytes=await openPrivate(source);try{await bytes.close();await copyFile(source,target,constants.COPYFILE_EXCL);const file=await openPrivate(target);try{try{await file.sync();}catch(error){if(process.platform!=='win32'||(error as NodeJS.ErrnoException).code!=='EPERM')throw error;}}finally{await file.close();}}finally{await bytes.close().catch(()=>{});}return fileHash(target);}
async function copyTree(source:string,target:string,files:{path:string;hash:string}[],prefix:string){
  await mkdir(target,{mode:0o700});
  for(const name of await readdir(source)){if(!/^[a-zA-Z0-9._-]+$/.test(name))throw new Error('INVALID_RELEASE_PATH');const from=join(source,name),to=join(target,name);const st=await lstat(from);
    if(st.isSymbolicLink())throw new Error('RELEASE_SYMLINK');if(st.isDirectory())await copyTree(from,to,files,`${prefix}/${name}`);
    else if(st.isFile())files.push({path:`${prefix}/${name}`,hash:await copyChecked(from,to)});else throw new Error('INVALID_RELEASE_OBJECT');}
  await syncDirectory(target);
}
async function run(){
  if(config.kind==='RECOVER'){
    const original=object(config.config.original_config),inventory:{path:string;hash:string;bytes:number}[]=[];let count=0;
    async function inspect(path:string,prefix:string){let entries:string[];try{entries=await readdir(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
      for(const name of entries){if(++count>10000||! /^[a-zA-Z0-9._-]+$/.test(name))throw new Error('RECOVERY_INVENTORY_BUDGET');const next=join(path,name),st=await lstat(next);if(st.isSymbolicLink())throw new Error('RECOVERY_SYMLINK');if(st.isDirectory())await inspect(next,`${prefix}/${name}`);else if(st.isFile())inventory.push({path:`${prefix}/${name}`,hash:await fileHash(next),bytes:st.size});else throw new Error('RECOVERY_UNKNOWN_OBJECT');}}
    if(['BACKUP','EXPORT'].includes(String(config.config.original_kind)))await inspect(join(config.root,config.config.original_kind==='BACKUP'?'research-backups':'research-exports',config.job),'job');
    if(original.asset_id){const asset=id(original.asset_id);try{const path=await assetPath(config.root,asset),st=await lstat(path);inventory.push({path:`asset/${asset}`,hash:await fileHash(path),bytes:st.size});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      const tempdir=join(config.root,'research-assets','.tmp');try{for(const name of await readdir(tempdir))if(name.startsWith(`${asset}-`)){const st=await lstat(join(tempdir,name));inventory.push({path:`temporary/${name}`,hash:await fileHash(join(tempdir,name)),bytes:st.size});}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
    if(original.package_id){const packageId=id(original.package_id),directory=join(config.root,'research-assets','packages',packageId);await inspect(directory,'package');
      let manifest:unknown[]=[];try{manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8')) as unknown[];}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      if(!Array.isArray(manifest)||manifest.length>100)throw new Error('INVALID_PACKAGE_RECOVERY_MANIFEST');
      for(const item of manifest){const asset=id(object(item).asset_id);try{const path=await assetPath(config.root,asset),st=await lstat(path);inventory.push({path:`asset/${asset}`,hash:await fileHash(path),bytes:st.size});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
      const temporary=join(config.root,'research-assets','.tmp');try{for(const name of await readdir(temporary))if(name.startsWith(`${packageId}-`))inventory.push({path:`temporary/${name}`,hash:await fileHash(join(temporary,name)),bytes:(await lstat(join(temporary,name))).size});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    return {verified:true,report:config.config.report,inventory,disposition:'preserved-for-explicit-maintenance',verified_at:new Date().toISOString()};
  }
  if(config.kind==='UPLOAD'){
    const temp=String(config.config.temp),asset=id(config.config.asset_id);const st=await lstat(temp);
    if(!st.isFile()||st.isSymbolicLink()||st.size>8*1024*1024)throw new Error('INVALID_UPLOAD_FILE');
    const meta=imageInfo(await readFile(temp));
    const hash=await publishExclusive(temp,await assetPath(config.root,asset));
    return {asset_id:asset,info:{hash,bytes:st.size,...meta}};
  }
  if(config.kind==='PACKAGE'){
    const temp=String(config.config.temp),packageId=id(config.config.package_id);
    const packed=await readFile(temp);phase('VALIDATING_HEADERS');let images:ReturnType<typeof unpackImages>;
    try{images=unpackImages(packed);}catch(error){await unlink(temp);await syncDirectory(dirname(temp));throw Object.assign(new Error(error instanceof Error?error.message:'INVALID_ZIP'),{validation_rejected:true});}
    const dir=await privateRoot(join(config.root,'research-assets','packages',packageId)),result=images.map(image=>({asset_id:randomUUID(),path:image.path,hash:digest(image.bytes),bytes:image.bytes.length,...image.info}));
    // Write the inventory before publishing anything, so interrupted work is recoverable.
    await writeDurable(join(dir,'manifest.json'),stableJSON(result));
    for(const [index,image] of images.entries()){const asset=result[index]!.asset_id,staged=join(dir,asset);await writeDurable(staged,image.bytes);await publishExclusive(staged,await assetPath(config.root,asset));}
    await unlink(temp);await syncDirectory(dirname(temp));
    return {study_id:config.config.study_id,name:config.config.name,hash:digest(packed),images:result};
  }
  if(config.kind==='DELETE'){
    const path=await assetPath(config.root,id(config.config.asset_id));
    try{const f=await openPrivate(path);await f.close();await unlink(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const temporary=join(config.root,'research-assets','.tmp');let removed=0;try{for(const name of await readdir(temporary))if(name.startsWith(`${id(config.config.asset_id)}-`)){const file=await openPrivate(join(temporary,name));await file.close();await unlink(join(temporary,name));removed++;}await syncDirectory(temporary);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    await syncDirectory(dirname(path));return {asset_id:config.config.asset_id,purged:true,temporary_removed:removed};
  }
  const db=new Database(config.path,{readonly:true,fileMustExist:true});db.pragma('query_only=ON');
  try{
    if(config.kind==='REPLAY'){
      db.exec('BEGIN');const sid=id(config.config.session_id),scope=id(config.config.scope);const started=Date.now();
      const permit=db.prepare('SELECT plan FROM lab_permits WHERE session_id=? AND scope=?').get(sid,scope) as {plan:string}|undefined;
      if(!permit)throw new Error('PERMIT_NOT_FOUND');
      const refs=db.prepare('SELECT event_id,hash,disposition,writer_epoch,kind FROM lab_events WHERE session_id=? AND scope=? ORDER BY sequence').all(sid,scope);
      const replay=new RunReplay(JSON.parse(permit.plan) as GroupPlan);let count=0;
      for(const row of db.prepare('SELECT envelope,disposition FROM lab_events WHERE session_id=? AND scope=? ORDER BY sequence').iterate(sid,scope) as Iterable<{envelope:string;disposition:string}>){
        if(++count>5000||Date.now()-started>30000||row.disposition!=='ACCEPTED')throw new Error('REPLAY_INPUT_OR_BUDGET_INVALID');
        const e=parseLabEvent(row.envelope);if(e.kind==='GROUP_RECORD')replay.apply(object(e.payload.record) as unknown as RunRecord);
      }
      const results=replay.finish();db.exec('COMMIT');return {session_id:sid,scope,source_hash:digest(stableJSON(refs)),valid:true,algorithm:'run-replay-v1',results};
    }
    if(config.kind==='REBUILD'){
      db.exec('BEGIN');const study=id(config.config.study_id),projections:unknown[]=[];const started=Date.now();
      for(const p of db.prepare("SELECT p.session_id,p.scope,p.plan FROM lab_permits p JOIN lab_sessions s USING(session_id) WHERE s.study_id=? AND p.state='CLOSED_NORMAL'").iterate(study) as Iterable<{session_id:string;scope:string;plan:string}>){
        if(projections.length>=1000||Date.now()-started>30000)throw new Error('REBUILD_BUDGET_EXCEEDED');const refs=db.prepare('SELECT event_id,hash,disposition,writer_epoch,kind FROM lab_events WHERE session_id=? AND scope=? ORDER BY sequence').all(p.session_id,p.scope);const replay=new RunReplay(JSON.parse(p.plan));