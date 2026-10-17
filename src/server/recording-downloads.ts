import {Worker} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,rm} from 'node:fs/promises';
import {privateRoot} from './private-files.js';
import {ContractError} from '../shared/contract.js';
import {cleanRecordingDownloads} from './clean-recording-downloads.js';

export class RecordingDownloads {
  private active=false;
  private worker:Worker|null=null;
  private closed=false;
  constructor(private database:string,private root:string){}
  async build(session:string,signal?:AbortSignal,format:'json'|'html'='json'){
    if(this.active||this.closed)throw new ContractError('TRAJECTORY_EXPORT_BUSY',503);
    this.active=true;let directory:string|undefined;
    try{
      const root=await privateRoot(join(this.root,'research-recording-downloads'));
      // Only our expired temporary export directories are eligible for cleanup.
      await cleanRecordingDownloads(this.root,Date.now()-86400000);
      directory=join(root,randomUUID());await mkdir(directory,{mode:0o700});const path=join(directory,'trajectory.json.gz');
      if(this.closed||signal?.aborted)throw new Error('TRAJECTORY_EXPORT_ABORTED');
      const source=import.meta.url.endsWith('.ts'),worker=new Worker(new URL(source?'./recording-export-worker.ts':'./recording-export-worker.js',import.meta.url),{
        workerData:{database:this.database,session,path,format,root:this.root,playerPath:fileURLToPath(new URL(source?'../../dist/server/offline/offline-replay.js':'./offline/offline-replay.js',import.meta.url))},...(source?{execArgv:['--import','tsx']}:{})});this.worker=worker;
      const result=await new Promise<{path:string;hash:string;records:number;uncompressed_bytes:number}>((resolve,reject)=>{
        const timer=setTimeout(()=>{void worker.terminate();reject(new Error('TRAJECTORY_EXPORT_TIMEOUT'));},120000);
        const abort=()=>{void worker.terminate();reject(new Error('TRAJECTORY_EXPORT_ABORTED'));};signal?.addEventListener('abort',abort,{once:true});
        const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
        worker.on('message',(message:{result?:{path:string;hash:string;records:number;uncompressed_bytes:number};error?:string})=>{done();if(message.result)resolve(message.result);else reject(new Error(message.error??'TRAJECTORY_EXPORT_FAILED'));});
        worker.once('error',error=>{done();reject(error);});worker.once('exit',()=>{done();reject(new Error('TRAJECTORY_EXPORT_EXITED'));});
      });
      await worker.terminate();this.worker=null;const cleanup=()=>rm(directory!,{recursive:true,force:true});return {...result,cleanup};
    }catch(error){if(this.worker)await this.worker.terminate();this.worker=null;if(directory)await rm(directory,{recursive:true,force:true});if(error instanceof Error&&error.message==='TRAJECTORY_EXPORT_TOO_LARGE')throw new ContractError(error.message,413);throw error;}
    finally{this.active=false;}
  }
  async close(){this.closed=true;if(this.worker)await this.worker.terminate();}
}
