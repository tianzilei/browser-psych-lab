import {Scheduler} from './scheduler.js';
import type {GroupPlan,RunRecord} from './lab-contract.js';
import type {TrialResult} from './run-replay.js';
export class RatingReplay {
  readonly scheduler:Scheduler;readonly results=new Map<string,TrialResult>();
  private last=-Infinity;private origin:number|undefined;private closed=false;private intent:string|null=null;
  private earliest:number;
  readonly changes:{instance_id:string;item:number;value:number;at:number}[]=[];
  constructor(readonly plan:GroupPlan){
    if(!plan.rating||plan.repeats!==0||plan.choices.length!==plan.rating.labels.length)throw new Error('INVALID_RATING_PLAN');
    this.scheduler=new Scheduler(plan.roots,0,plan.start,plan.seed,plan.budget);this.earliest=plan.start;
  }
  apply(r:RunRecord){
    if(!Number.isFinite(r.at)||r.at<this.last||r.at<0||this.closed)throw new Error('INVALID_RATING_TRACE');this.last=r.at;
    if(r.clock_origin!==undefined){if(!Number.isFinite(r.clock_origin)||r.clock_origin<0||(this.origin!==undefined&&this.origin!==r.clock_origin))throw new Error('GROUP_CLOCK_ORIGIN_CHANGED');this.origin=r.clock_origin;}
    else if(this.plan.budget.environment_id!=='TEST_ONLY')throw new Error('MISSING_GROUP_CLOCK_DOMAIN');
    const s=this.scheduler,e=s.queue[0],id=e?.candidate.instance_id,root=this.plan.roots.find(t=>t.root_id===e?.candidate.root_id),result=id?this.results.get(id):undefined;
    if(r.type==='ABORT'){s.interrupt(false);this.closed=true;return;}
    if(s.state!=='RUNNING')throw new Error('RATING_NOT_RUNNING');
    if(r.type==='CLOSING'){
      if(s.queue.length||r.unresolved!==false||this.results.size!==this.plan.roots.length)throw new Error('RATING_INCOMPLETE');
      s.state='GROUP_CLOSING';this.closed=true;return;
    }
    if(!e||r.instance_id!==id)throw new Error('RATING_TRIAL_ORDER_MISMATCH');
    if(r.type==='RATING_INTENT'){
      if(this.intent||result)throw new Error('DUPLICATE_RATING_INTENT');this.intent=id!;s.executions.set(id!,'STAGED');return;
    }
    if(r.type==='ONSET'||r.type==='RATING'){
      if(typeof r.draw_time!=='number'||!Number.isFinite(r.draw_time)||r.draw_time<r.at||r.draw_time-r.at>this.plan.budget.activate_ms)throw new Error('INVALID_DRAW_OBSERVATION');
      if(typeof r.raf_time!=='number'||!Number.isFinite(r.raf_time)||r.raf_time>r.at+1||r.at-r.raf_time>this.plan.budget.long_frame_ms)throw new Error('INVALID_FRAME_OBSERVATION');
    }
    if(r.type==='ONSET'){
      if(this.intent!==id||result||r.at<this.earliest)throw new Error('INVALID_RATING_ONSET');
      this.intent=null;s.observed.push(root!.root_id);s.executions.set(id!,'ONSET_OBSERVED');
      this.results.set(id!,{instance_id:id!,root_id:root!.root_id,number:1,onset:r.draw_time!,clear:null,end:null,answer:null,input_time:null,correct:null,rt_ms:null,software_quality:'SOFTWARE_ONLY',actual_gap:null,...(root!.asset_id?{asset_id:root!.asset_id}:{}),...(root!.category?{category:root!.category}:{})});return;
    }
    if(r.type==='RATING_CHANGE'){
      const item=r.item??0,count=this.plan.rating!.items?.length??1;
      if(!result||result.clear!==null||!Number.isInteger(item)||item<0||item>=count||!Number.isInteger(r.value)||r.value!<1||r.value!>this.plan.choices.length||r.at<result.onset)throw new Error('INVALID_RATING_CHANGE');
      this.changes.push({instance_id:id!,item,value:r.value!,at:r.at});return;
    }
    if(r.type==='RATING'){
      const coreCount=this.plan.rating!.items?.length??1,count=coreCount+(this.plan.rating!.age_prompt?1:0),values=r.values??(r.value===undefined?undefined:[r.value]);
      if(!result||result.clear!==null||!values||values.length!==count||values.slice(0,coreCount).some(v=>!Number.isInteger(v)||v<1||v>this.plan.choices.length)||(this.plan.rating!.age_prompt!==undefined&&(values.at(-1)!<this.plan.rating!.age_min!||values.at(-1)!>this.plan.rating!.age_max!||!Number.isInteger(values.at(-1))))||typeof r.input_time!=='number'||!Number.isFinite(r.input_time)||r.input_time<result.onset||r.input_time>r.at)throw new Error('INVALID_RATING_ANSWER');
      const prior=this.changes.filter(c=>c.instance_id===id);
      if(prior.length)for(let i=0;i<coreCount;i++){const last=prior.filter(c=>c.item===i).at(-1);if(!last||last.value!==values[i]||last.at>r.input_time)throw new Error('RATING_SELECTION_MISMATCH');}
      result.ratings=[...values];result.rating=values[0]!;result.rating_label=this.plan.rating!.labels[values[0]!-1]!;result.rating_labels=values.slice(0,coreCount).map(v=>this.plan.rating!.labels[v-1]!);result.answer=JSON.stringify(values);result.input_time=r.input_time;
      result.rt_ms=r.input_time-result.onset;result.submit_rt_ms=result.rt_ms;
      if(prior.length)result.first_rt_ms=Math.min(...prior.map(c=>c.at))-result.onset;
      result.rating_item_times=Array.from({length:coreCount},(_,item)=>{const changes=prior.filter(c=>c.item===item);return {item,first_rt_ms:changes[0]?changes[0].at-result.onset:null,last_rt_ms:changes.at(-1)?changes.at(-1)!.at-result.onset:null,changes:changes.filter((c,i)=>i>0&&c.value!==changes[i-1]!.value).length};});
      result.change_count=prior.filter((c,i)=>i>0&&c.value!==prior[i-1]!.value).length;
      result.clear=r.draw_time!;s.executions.set(id!,'WINDOW_CLOSED');return;
    }
    if(r.type==='END'){
      if(!result||result.clear===null||result.end!==null||r.at<result.clear+root!.isi_ms)throw new Error('RATING_ISI_TOO_SHORT');
      result.end=r.at;result.isi_ms=r.at-result.clear;s.executions.set(id!,'ENDED_OBSERVED');s.queue.shift();this.earliest=r.at;return;
    }
    throw new Error('INVALID_RATING_RECORD');
  }
  finish(){if(this.scheduler.state!=='GROUP_CLOSING')throw new Error('GROUP_NOT_NORMALLY_CLOSED');return [...this.results.values()];}
}

