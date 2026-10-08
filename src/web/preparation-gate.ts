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
