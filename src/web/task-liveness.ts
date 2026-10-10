import type {ParticipantAPI} from './participant-api.js';
// Actions stay local. A tiny control request renews the task lease at most once
// per minute; transient network failures do not block the UI or lose evidence.
export function taskLiveness(api:ParticipantAPI,interrupt:(reason:string)=>void){
  const events=document;
  let last=performance.now(),lastAck=last,closed=false,inFlight=false;
  const activity=(event:Event)=>{if(event.isTrusted)last=performance.now();};
  const types=['pointerdown','pointermove','pointerup','keydown','input'];
  for(const type of types)events.addEventListener(type,activity,{capture:true,passive:true});
  const check=setInterval(()=>{if(performance.now()-last>=120000)interrupt('USER_IDLE_TIMEOUT');else if(performance.now()-lastAck>=300000)interrupt('CONNECTION_TIMEOUT');},1000);
  const renew=setInterval(()=>{if(closed||inFlight||performance.now()-last>=120000)return;inFlight=true;
    void fetch(api.path('activity'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(api.fence()),signal:AbortSignal.timeout(10000)}).then(async response=>{
      if(response.ok){const value=await response.json() as {status:string};if(value.status==='ACTIVE')lastAck=performance.now();else interrupt('SERVER_TASK_TERMINATED');}
      else if([401,409].includes(response.status))interrupt('SERVER_TASK_TERMINATED');
    }).catch(()=>{}).finally(()=>{inFlight=false;});
  },60000);
  return ()=>{closed=true;clearInterval(check);clearInterval(renew);for(const type of types)events.removeEventListener(type,activity,true);};
}
