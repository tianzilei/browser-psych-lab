import {request,uid} from './dom.js';
import type {ParticipantAPI} from './participant-api.js';
import type {SessionAdmissionStatus} from '../shared/lab-contract.js';
import {RequestError} from './request-error.js';
export function cancelAdmission(controller:AbortController){const error=new Error('已取消进入，可稍后再进行答题。');error.name='SESSION_WAIT_CANCELED';controller.abort(error);}
export async function awaitSessionAdmission(api:ParticipantAPI,signal:AbortSignal,status:(text:string)=>void,onLost:(error:unknown)=>void){
  const nonce=uid(),url=api.path('admission'),body=(action:string)=>({action,ticket_id:nonce,...api.fence()});
  let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,pending:Promise<void>=Promise.resolve(),failure:unknown;
  const abort=()=>{stopped=true;clearTimeout(timer);};
  const hidden=()=>abort();
  signal.addEventListener('abort',abort,{once:true});window.addEventListener('pagehide',hidden,{once:true});
  const stop=async()=>{stopped=true;clearTimeout(timer);signal.removeEventListener('abort',abort);window.removeEventListener('pagehide',hidden);await pending;};
  try{
    let sent=performance.now(),result=await request<SessionAdmissionStatus>(url,body('join'),undefined,signal);
    if(result.status!=='ACTIVE')throw new RequestError('SESSION_CAPACITY_FULL',409);signal.throwIfAborted();let deadline=sent+result.lease_remaining_ms;
    const renew=()=>{timer=setTimeout(()=>{pending=(async()=>{
      try{const sent=performance.now(),next=await request<SessionAdmissionStatus>(url,body('touch'),undefined,signal);
        if(next.status!=='ACTIVE')throw new RequestError('ADMISSION_EXPIRED',409);deadline=sent+next.lease_remaining_ms;}
      catch(error){failure=error;if(!stopped&&!signal.aborted)onLost(error);}
      finally{if(!stopped&&!signal.aborted&&!failure)renew();}
    })();},60000);};renew();
    return {stop,check:()=>{signal.throwIfAborted();if(failure)throw failure;if(performance.now()>=deadline)throw new RequestError('ADMISSION_EXPIRED',409);}};
  }catch(error){await stop();if(signal.reason instanceof Error&&signal.reason.name==='SESSION_WAIT_CANCELED')await request(url,body('leave')).catch(()=>{});throw error;}
}
