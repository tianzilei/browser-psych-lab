import {ContractError} from '../shared/contract.js';
import {randomUUID} from 'node:crypto';
interface Ticket {key:string;nonce:string;joined:number;seen:number;started:number|null;closing:boolean;streams:Set<()=>void>}
// Ephemeral preparation state only. Formal allocations/events remain in SQLite.
export class PreparationQueue {
  private tickets:Ticket[]=[];
  constructor(private concurrency=1,private now=Date.now,private leaseMs=90000){
    if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>10000)throw new Error('INVALID_PREPARATION_CONCURRENCY');
  }
  private sweep(){
    const time=this.now();
    for(const t of [...this.tickets]){
      if(!t.closing&&((t.started!==null&&time-t.started>=20*60000)||(time-t.seen>=this.leaseMs&&t.streams.size===0))){
        t.closing=true;for(const cancel of t.streams)cancel();
      }
    }
    this.tickets=this.tickets.filter(t=>!t.closing||t.streams.size>0);
  }
  join(key:string,nonce:string){
    this.sweep();const old=this.tickets.find(t=>t.key===key);
    if(old&&old.nonce!==nonce)throw new ContractError('PREPARATION_ALREADY_ACTIVE',409);
    if(!old){if(this.tickets.length>=this.concurrency)throw new ContractError('PREPARATION_CAPACITY_FULL',409,{retry_after_seconds:1800});
      this.tickets.push({key,nonce,joined:this.now(),seen:this.now(),started:this.now(),closing:false,streams:new Set()});}
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
  async legacyTransfer(session:string,signal:AbortSignal,cancel:()=>void){
    signal.throwIfAborted();const nonce=randomUUID(),key=`${session}:legacy:${nonce}`;
    try{
      this.join(key,nonce);
      signal.throwIfAborted();const done=this.transfer(key,nonce,cancel);
      return ()=>{done();this.release(key,nonce);};
    }catch(error){this.release(key,nonce);throw error;}
  }
  stats(){this.sweep();return {active:this.tickets.length,queued:0,streams:this.tickets.reduce((n,t)=>n+t.streams.size,0),limit:this.concurrency,capacity:this.concurrency};}
  close(){for(const t of this.tickets){t.closing=true;for(const cancel of t.streams)cancel();}this.tickets=[];}
}
