import {request,uid} from './dom.js';
import {wait} from './wait.js';
import type {ParticipantAPI} from './participant-api.js';
import type {SessionAdmissionStatus} from '../shared/lab-contract.js';
export function cancelAdmission(controller:AbortController){const error=new Error('已退出等待，可稍后重新排队。');error.name='SESSION_WAIT_CANCELED';controller.abort(error);}
export async function awaitSessionAdmission(api:ParticipantAPI,signal:AbortSignal,status:(text:string)=>void,onLost:(error:unknown)=>void){
  const nonce=uid(),url=api.path('admission'),body=(action:string)=>({action,ticket_id:nonce,...api.fence()});
  let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,pending:Promise<void>=Promise.resolve(),failure:unknown;
  const abort=()=>{stopped=true;clearTimeout(timer);};
  const hidden=()=>abort();
  signal.addEventListener('abort',abort,{once:true});window.addEventListener('pagehide',hidden,{once:true});
  const stop=async()=>{stopped=true;clearTimeout(timer);signal.removeEventListener('abort',abort);window.removeEventListener('pagehide',hidden);await pending;};
  try{
    let sent=performance.now(),result=await request<SessionAdmissionStatus>(url,body('join'),undefined,signal);
    while(result.status==='QUEUED'){
      status(`等待参加名额 · 排队第 ${result.position} 位`);
      await wait(result.poll_ms+Math.random()*500,signal);
      sent=performance.now();result=await request<SessionAdmissionStatus>(url,body('touch'),undefined,signal);
      if(result.status==='EXPIRED'){sent=performance.now();result=await request<SessionAdmissionStatus>(url,body('join'),undefined,signal);}
    }
    if(result.status!=='ACTIVE')throw new Error('参加名额已失效，请重新排队。');signal.throwIfAborted();let deadline=sent+result.lease_remaining_ms;
    const renew=()=>{timer=setTimeout(()=>{pending=(async()=>{
      try{const sent=performance.now(),next=await request<SessionAdmissionStatus>(url,body('touch'),undefined,signal);
        if(next.status!=='ACTIVE')throw new Error('参加名额已失效，已保存的记录保留，请重新排队。');deadline=sent+next.lease_remaining_ms;}
      catch(error){failure=error;if(!stopped&&!signal.aborted)onLost(error);}
      finally{if(!stopped&&!signal.aborted&&!failure)renew();}
    })();},60000);};renew();
    return {stop,check:()=>{signal.throwIfAborted();if(failure)throw failure;if(performance.now()>=deadline)throw new Error('参加名额已失效，请重新排队。');}};
  }catch(error){await stop();if(signal.reason instanceof Error&&signal.reason.name==='SESSION_WAIT_CANCELED')await request(url,body('leave')).catch(()=>{});throw error;}
}
