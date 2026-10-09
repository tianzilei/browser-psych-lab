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
