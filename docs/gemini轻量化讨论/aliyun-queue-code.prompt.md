这是已落实的 1Mbps 准备队列。请只查找真实 bug（并发释放、租约、取消、重入），最多400中文字，无则说明未发现，不要给泛化的参数建议，结尾 QUEUE_CODE_REVIEW_COMPLETE。后端单进程，同步类方法不跨await；DB participant.preparation在事务内核查cookie/session、writer fence、未ISSUEDpermit、当前组和版本，返回session:epoch:group_index:variant键与当前组资产IDs；队列路由join/touch在认证后调用此类，release凭session+nonce精确释放，不要求session仍ACTIVE；图片API每次重查当前组资产授权。入组后不再请求队列/资源。客户端原图下载stream60秒stall、单图byte-budget/组20min时间上限、取消fetch会abortreader，不缓存私有原图跨页面。
这里是实际代码，注意HTTPfinish/close才释放stream占用：
import {ContractError} from '../shared/contract.js';
interface Ticket {key:string;nonce:string;joined:number;seen:number;started:number|null;closing:boolean;streams:Set<()=>void>}
// Ephemeral preparation state only. Formal allocations/events remain in SQLite.
export class PreparationQueue {
  private tickets:Ticket[]=[];
  constructor(private concurrency=1,private now=Date.now,private leaseMs=90000){
    if(!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw new Error('INVALID_PREPARATION_CONCURRENCY');
  }
  private sweep(){
    const time=this.now();
    for(const t of [...this.tickets]){
      if(!t.closing&&((t.started!==null&&time-t.started>=20*60000)||(time-t.seen>=this.leaseMs&&t.streams.size===0))){
        t.closing=true;for(const cancel of t.streams)cancel();
      }
    }
    this.tickets=this.tickets.filter(t=>!t.closing||t.streams.size>0);
    let active=this.tickets.filter(t=>t.started!==null).length;
    for(const t of this.tickets){if(active>=this.concurrency)break;if(t.started===null&&!t.closing){t.started=time;active++;}}
  }
  join(key:string,nonce:string){
    this.sweep();const old=this.tickets.find(t=>t.key===key);
    if(old&&old.nonce!==nonce)throw new ContractError('PREPARATION_ALREADY_QUEUED',409);
    if(!old){if(this.tickets.length>=64)throw new ContractError('PREPARATION_QUEUE_FULL',503);
      this.tickets.push({key,nonce,joined:this.now(),seen:this.now(),started:null,closing:false,streams:new Set()});}
    return this.touch(key,nonce);
  }
  touch(key:string,nonce:string){
    this.sweep();const t=this.tickets.find(t=>t.key===key&&t.nonce===nonce&&!t.closing);
    if(!t)throw new ContractError('PREPARATION_TICKET_EXPIRED',409);t.seen=this.now();
    const position=t.started===null?this.tickets.filter(x=>x.started===null).indexOf(t)+1:0;
    return {ticket_id:t.nonce,status:t.started===null?'QUEUED':'READY',position,poll_ms:t.started!==null?20000:position===1?1000:5000};
  }
  transfer(key:string,nonce:string,cancel:()=>void){
    const result=this.touch(key,nonce);if(result.status!=='READY')throw new ContractError('PREPARATION_NOT_READY',409);
    const t=this.tickets.find(t=>t.key===key&&t.nonce===nonce)!;
    if(t.streams.size)throw new ContractError('PREPARATION_STREAM_BUSY',409);
    t.streams.add(cancel);let ended=false;
    return ()=>{if(ended)return;ended=true;t.streams.delete(cancel);t.seen=this.now();this.sweep();};
  }
  release(key:string,nonce:string){
    const t=this.tickets.find(t=>t.key===key&&t.nonce===nonce);
    if(t&&!t.closing){t.closing=true;for(const cancel of t.streams)cancel();}this.sweep();return {status:'RELEASED'};
  }
  releaseSession(session:string,nonce:string){
    const t=this.tickets.find(t=>t.key.startsWith(`${session}:`)&&t.nonce===nonce);
    return t?this.release(t.key,nonce):{status:'RELEASED'};
  }
  stats(){this.sweep();return {active:this.tickets.filter(t=>t.started!==null).length,queued:this.tickets.filter(t=>t.started===null).length,streams:this.tickets.reduce((n,t)=>n+t.streams.size,0),limit:this.concurrency,capacity:64};}
  close(){for(const t of this.tickets){t.closing=true;for(const cancel of t.streams)cancel();}this.tickets=[];}
}
import {request,uid} from './dom.js';
import {wait} from './wait.js';
import type {ParticipantAPI} from './participant-api.js';
interface Ticket {ticket_id:string;status:'QUEUED'|'READY';position:number;poll_ms:number}
export async function awaitPreparation(api:ParticipantAPI,signal:AbortSignal,status:(text:string)=>void,onFailure:(error:unknown)=>void=()=>{}){
  const ticket=uid(),url=api.path('preparation'),fence=api.fence(),started=performance.now();
  const body=(action:string)=>({action,ticket_id:ticket,...fence});
  let timer:ReturnType<typeof setTimeout>|undefined,pending:Promise<void>=Promise.resolve(),released=false;
  const release=async()=>{if(released)return;released=true;clearTimeout(timer);await pending;
    await request(url,body('release')).catch(()=>{});};
  const hidden=()=>{clearTimeout(timer);void fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body('release')),keepalive:true}).catch(()=>{});};
  window.addEventListener('pagehide',hidden,{once:true});
  try{
    let result=await request<Ticket>(url,body('join'),undefined,signal);
    while(result.status==='QUEUED'){
      if(performance.now()-started>45*60000)throw new Error('排队超过 45 分钟，请稍后重新准备。');
      status(`等待图片准备名额 · 排队第 ${result.position} 位`);
      await wait(result.poll_ms+Math.random()*500,signal);
      result=await request<Ticket>(url,body('touch'),undefined,signal);
    }
    const renew=()=>{timer=setTimeout(()=>{pending=(async()=>{
      try{await request<Ticket>(url,body('touch'),undefined,signal);}
      catch(error){renewalError=error;onFailure(error);}
      finally{if(!released&&!signal.aborted&&!renewalError)renew();}
    })();},20000);};let renewalError:unknown;renew();
    return {headers:{'X-Preparation-Ticket':ticket,'X-Writer-Id':fence.writer_id,'X-Writer-Epoch':String(fence.writer_epoch)},
      check:()=>{if(renewalError)throw renewalError;signal.throwIfAborted();},
      release:async()=>{window.removeEventListener('pagehide',hidden);await release();}};
  }catch(error){window.removeEventListener('pagehide',hidden);await release();throw error;}
}
    }return participant(request,op,data);
  });
  app.get('/api/participate/sessions/:session/assets/:asset',async(request,reply)=>{
    const asset=id((request.params as {asset:string}).asset),nonce=id(request.headers['x-preparation-ticket']);
    const ready=await participant(request,'preparation',{writer_id:id(request.headers['x-writer-id']),writer_epoch:Number(request.headers['x-writer-epoch'])}) as {key:string;asset_ids:string[]};
    if(!ready.asset_ids.includes(asset))throw new ContractError('ASSET_FORBIDDEN',403);
    const info=await participant(request,'asset',{asset_id:asset}) as {format:string;hash:string;state:string};
    if(info.state!=='READY')throw new ContractError('ASSET_NOT_READY',409);
    let stream:Readable|undefined,closed=false;const done=preparation.transfer(ready.key,nonce,()=>{closed=true;stream?.destroy();reply.raw.destroy();});
    const release=()=>{closed=true;stream?.destroy();done();};reply.raw.once('finish',release);reply.raw.once('close',release);
    try{const file=await openPrivate(await assetPath(root,asset));stream=file.createReadStream();
      if(closed||reply.raw.destroyed){stream.destroy();done();throw new ContractError('PREPARATION_TICKET_EXPIRED',409);}stream.once('error',release);
      reply.type(`image/${info.format}`).header('ETag',`"${info.hash}"`).header('Cache-Control','private, no-store, no-transform');return reply.send(stream);
    }catch(error){done();throw error;}
  });

