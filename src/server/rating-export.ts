import type {Protocol,AssetInfo} from '../shared/protocol.js';
import {photoIdentity} from '../shared/photo-identity.js';
import type {GroupPlan} from '../shared/lab-contract.js';
import type {TrialResult} from '../shared/run-replay.js';
export const RATING_LAYOUT='one-photo-per-row-v2';
export function ratingLayout(versions:{version_id:string;protocol:Protocol}[]){
  const definitions=versions.flatMap(v=>v.protocol.groups.filter(g=>g.rating).map(g=>({version_id:v.version_id,group_id:g.id,items:g.rating!.items??[g.rating!.prompt],labels:g.rating!.labels,familiarity:g.rating!.familiarity??null,age_prompt:g.rating!.age_prompt??null})));
  const count=Math.max(0,...definitions.map(d=>d.items.length)),items=Array.from({length:count},(_,i)=>({value:`rating_${i+1} | ${definitions.find(d=>d.items[i])!.items[i]}`,label:`rating_${i+1}_label`}));
  const columns=['snapshot_id','study_id','study_title','session_id','version_id','session_state','compensation_phone','group_id','scope','photo_order','photo_id','photo_filename','photo_path','photo_category','asset_id','photo_hash','answer_state','permit_state','replay_error',...items.flatMap(i=>[i.value,i.label]),'familiarity','familiarity_label','estimated_age','photo_onset_ms','photo_clear_ms','trial_end_ms','submit_rt_ms','familiarity_rt_ms'];
  return {enabled:definitions.length>0,columns,items,definitions};
}
export function* ratingRows(layout:ReturnType<typeof ratingLayout>,plan:GroupPlan,results:TrialResult[],permitState:string,replayError:string|null,assets:ReadonlyMap<string,Pick<AssetInfo,'name'|'hash'>>=new Map()){
  if(!plan.rating)return;const found=new Map(results.map(r=>[r.root_id,r])),rating=plan.rating,count=rating.items?.length??1;
  for(const [i,root]of plan.roots.entries()){
    const result=found.get(root.root_id),values=result?.ratings;
    const state=replayError?'REPLAY_ERROR':!result?'NOT_REACHED':!values?'UNANSWERED':permitState==='CLOSED_NORMAL'?'ANSWERED':'UNCONFIRMED';
    const row:Record<string,unknown>={...photoIdentity(plan,i,assets),scope:plan.scope,answer_state:state,permit_state:permitState,replay_error:replayError,
      familiarity:result?.familiarity,familiarity_label:result?.familiarity_label,estimated_age:rating.age_prompt?values?.[count]:null,photo_onset_ms:result?.onset,photo_clear_ms:result?.clear,trial_end_ms:result?.end,submit_rt_ms:result?.submit_rt_ms,familiarity_rt_ms:result?.familiarity_rt_ms};
    for(const [item,field]of layout.items.entries()){row[field.value]=item<count?values?.[item]:null;row[field.label]=item<count&&values?.[item]!==undefined?rating.labels[values[item]!-1]:null;}
    yield row;
  }
}
