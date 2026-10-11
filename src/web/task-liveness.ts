import type {ParticipantAPI} from './participant-api.js';
import {TASK_ACTIVITY_POLICY as policy} from '../shared/task-policy.js';
// Actions stay local. A tiny control request renews the task lease at most once
// per minute; transient network failures do not block the UI or lose evidence.
export function taskLiveness(api:ParticipantAPI,interrupt:(reason:string)=>void){
  const events=document;
  let last=performance.now(),lastAck=last,closed=false,inFlight=false;
  const activity=(event:Event)=>{if(event.isTrusted)last=performance.now();};
  const types=['pointerdown','pointermove','pointerup','keydown','input'];
  for(const type of types)events.addEventListener(type,activity,{capture:true,passive:true});
  const stop=()=>{
    if(closed)return;
    closed=true;clearInterval(check);clearInterval(renew);
    for(const type of types)events.removeEventListener(type,activity,true);
  };
  const fail=(reason:string)=>{if(closed)return;stop();interrupt(reason);};
  const check=setInterval(()=>{
    if(performance.now()-last>=policy.idle_timeout_ms)fail('USER_IDLE_TIMEOUT');
    else if(performance.now()-lastAck>=policy.connection_timeout_ms)fail('CONNECTION_TIMEOUT');
  },policy.client_check_interval_ms);
  const renew=setInterval(()=>{
    if(closed||inFlight||performance.now()-last>=policy.idle_timeout_ms)return;
    inFlight=true;
    void fetch(api.path('activity'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(api.fence()),signal:AbortSignal.timeout(policy.request_timeout_ms)}).then(async response=>{
      if(closed)return;
      if(response.ok){
        const value=await response.json() as {status:string};
        if(closed)return;
        if(value.status==='ACTIVE')lastAck=performance.now();else fail('SERVER_TASK_TERMINATED');
      }else if([401,409].includes(response.status))fail('SERVER_TASK_TERMINATED');
    }).catch(()=>{}).finally(()=>{inFlight=false;});
  },policy.renewal_interval_ms);
  return stop;
}
