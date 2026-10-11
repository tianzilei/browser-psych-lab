全项目设计讨论，传输段 6，源码主题：随机化、动态补测及重放（源包 2/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

  throw new Error('DRAW_BUDGET_EXHAUSTED');
}

```

### src/shared/rating-replay.ts L1–L63

```
﻿import {Scheduler} from './scheduler.js';
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


```

### src/shared/run-replay.ts L1–L113

```
import { Scheduler, type ScheduleAudit } from './scheduler.js';
import { stableJSON } from './protocol.js';
import type { GroupPlan, InputRecord, RunRecord } from './lab-contract.js';
import {RatingReplay} from './rating-replay.js';
export interface TrialResult { instance_id:string;root_id:string;number:number;onset:number;clear:number|null;end:number|null;
  rating?:number;rating_label?:string;ratings?:number[];rating_labels?:string[];asset_id?:string;category?:string;isi_ms?:number;first_rt_ms?:number;submit_rt_ms?:number;change_count?:number;
  rating_item_times?:{item:number;first_rt_ms:number|null;last_rt_ms:number|null;changes:number}[];
  answer:string|null;input_time:number|null;correct:boolean|null;rt_ms:number|null;software_quality:string;actual_gap:number|null }
export class RunReplay {
  readonly scheduler:Scheduler; readonly results=new Map<string,TrialResult>(); readonly obligations=new Set<string>();
  readonly pointers=new Set<number>(); readonly inputAudit:InputRecord[]=[];
  private last=-Infinity; private closed=false;private clockOrigin:number|null=null;
  private corrections=new Set<string>();
  private domOrigin:number|null=null;
  private ratingReplay?:RatingReplay;
  constructor(readonly plan:GroupPlan){if(plan.rating){this.ratingReplay=new RatingReplay(plan);this.scheduler=this.ratingReplay.scheduler;this.results=this.ratingReplay.results;}else this.scheduler=new Scheduler(plan.roots,plan.repeats,plan.start,plan.seed,plan.budget);}
  apply(r:RunRecord) {
    if(this.ratingReplay){this.ratingReplay.apply(r);return;}
    if(!Number.isFinite(r.at)||r.at<this.last)throw new Error('NONMONOTONIC_TRACE');this.last=r.at;
    if(this.plan.budget.environment_id!=='TEST_ONLY'&&(typeof r.clock_origin!=='number'||!Number.isFinite(r.clock_origin)||r.clock_origin<0))throw new Error('MISSING_GROUP_CLOCK_DOMAIN');
    if(r.clock_origin!==undefined){if(this.clockOrigin!==null&&r.clock_origin!==this.clockOrigin)throw new Error('GROUP_CLOCK_ORIGIN_CHANGED');this.clockOrigin=r.clock_origin;}
    if(r.type==='ONSET'||r.type==='WINDOW'){
      if(this.plan.budget.environment_id!=='TEST_ONLY'&&r.raf_time===undefined)throw new Error('MISSING_FRAME_OBSERVATION');
      if(typeof r.draw_time!=='number'||!Number.isFinite(r.draw_time)||r.draw_time<r.at||r.draw_time-r.at>this.plan.budget.activate_ms)throw new Error('INVALID_DRAW_OBSERVATION');
      if(r.raf_time!==undefined&&(!Number.isFinite(r.raf_time)||r.raf_time>r.at+1||r.at-r.raf_time>this.plan.budget.long_frame_ms))throw new Error('INVALID_FRAME_OBSERVATION');
    }
    const s=this.scheduler;
    if(this.closed&&r.type!=='INPUT')throw new Error('GROUP_ALREADY_CLOSING');
    switch(r.type){
      case 'OP':{
        const op=r.operation!;if(!op||!op.evidence)throw new Error('MISSING_SCHEDULE_OPERATION');let expected:ScheduleAudit|null;
        if(op.type==='INTENT')expected=s.stage(op.op_id,r.at,op.evidence);
        else if(op.type==='INSERT'){
          const c=s.candidates.find(c=>c.instance_id===op.instance_id);if(!c||!this.obligations.has(c.root_id))throw new Error('UNJUSTIFIED_REPEAT');
          expected=s.proposeRepeat(c.root_id,op.proposal_id!,op.op_id,r.at,op.evidence);
        }else expected=s.cancel(op.proposal_id!,op.op_id,r.at,op.evidence);
        if(stableJSON(expected)!==stableJSON(op))throw new Error('SCHEDULE_REPLAY_MISMATCH');break;
      }
      case 'COMMIT':s.acknowledge(r.op_id!,r.at);break;
      case 'ONSET':{
        const entry=s.queue[0];if(!entry||entry.candidate.instance_id!==r.instance_id||r.at<entry.target
          ||r.at-entry.target>this.plan.budget.long_frame_ms)throw new Error('ONSET_TARGET_MISMATCH');
        s.onset(r.instance_id!);const c=entry.candidate;const last=[...this.results.values()].filter(v=>v.root_id===c.root_id).at(-1);
        this.results.set(c.instance_id,{instance_id:c.instance_id,root_id:c.root_id,number:c.number,onset:r.draw_time??r.at,clear:null,end:null,
          answer:null,input_time:null,correct:null,rt_ms:null,software_quality:'SOFTWARE_ONLY',actual_gap:last?s.observed.length-1-s.observed.lastIndexOf(c.root_id,s.observed.length-2)-1:null});break;
      }
      case 'INPUT':this.input(r as InputRecord);break;
      case 'WINDOW':{
        const result=this.results.get(r.instance_id!)!;const entry=s.queue[0];if(!result||!entry||entry.candidate.instance_id!==r.instance_id
          ||r.at<entry.target+entry.candidate.image_ms||r.at-entry.target-entry.candidate.image_ms>this.plan.budget.long_frame_ms)
          throw new Error('CLEAR_TARGET_MISMATCH');
        result.clear=r.draw_time??r.at;s.windowClosed(r.instance_id!);
        if(r.processed_watermark!==this.inputAudit.length)throw new Error('INPUT_WATERMARK_MISMATCH');
        if((r.answer??null)!==result.answer)throw new Error('WINDOW_ANSWER_SNAPSHOT_MISMATCH');
        const root=this.plan.roots.find(t=>t.root_id===result.root_id)!;
        result.correct=root.correct===null?null:result.answer===root.correct;
        if(result.answer===null||result.correct===false){if(!s.satisfied.has(root.root_id))this.obligations.add(root.root_id);}
        else {this.obligations.delete(root.root_id);s.satisfied.add(root.root_id);}break;
      }
      case 'END':{
        const e=s.queue[0];const result=this.results.get(r.instance_id!)!;if(!e||!result||r.at<e.target+e.candidate.image_ms+(e.candidate.feedback_ms??0)+e.candidate.isi_ms
          ||r.at-e.target-e.candidate.image_ms-(e.candidate.feedback_ms??0)-e.candidate.isi_ms>this.plan.budget.long_frame_ms)throw new Error('END_TARGET_MISMATCH');
        result.end=r.at;s.ended(r.instance_id!);
        if(result.number===this.plan.repeats+1)this.obligations.delete(result.root_id);break;
      }
      case 'CORRECTION':{
        const root=r.root_id!;const result=[...this.results.values()].find(v=>v.root_id===root&&v.clear!==null&&v.answer!==null&&(this.plan.roots.find(t=>t.root_id===root)!.correct===null||v.correct===true));
        const definition=this.plan.roots.find(t=>t.root_id===root);
        if(!this.corrections.delete(root)||!result||!definition||(definition.correct!==null&&result.answer!==definition.correct))throw new Error('UNJUSTIFIED_CORRECTION');
        const op=s.correctRoot(root,r.at,r.op_id!,r.evidence!);if(stableJSON(op)!==stableJSON(r.operation??null))throw new Error('CORRECTION_CANCEL_MISMATCH');
        this.obligations.delete(root);break;
      }
      case 'CLOSING':{
        const unresolved=[...this.obligations].some(root=>s.candidates.some(c=>c.root_id===root&&s.executions.get(c.instance_id)==='UNSTARTED'));
        if(r.unresolved!==unresolved)throw new Error('TAIL_OBLIGATION_MISMATCH');s.closing(unresolved);this.closed=true;break;
      }
      case 'ABORT':s.interrupt(r.reason==='BEFORE_ONSET');break;
      default:throw new Error('UNKNOWN_RUN_RECORD');
    }
  }
  private input(r:InputRecord) {
    if(!Number.isSafeInteger(r.pointer_id)||!Number.isFinite(r.input_time)||!Number.isFinite(r.raw_timestamp)
      ||!Number.isFinite(r.time_origin)||!['down','up','cancel'].includes(r.action))throw new Error('INVALID_INPUT_RECORD');
    if(this.domOrigin!==null&&this.domOrigin!==r.time_origin)throw new Error('INPUT_TIME_ORIGIN_CHANGED');this.domOrigin=r.time_origin;
    const origin=r.clock_origin??0;const mono=r.raw_timestamp<=r.at+origin+1&&r.raw_timestamp>=0?r.raw_timestamp-origin:r.raw_timestamp-r.time_origin-origin;
    if(!Number.isFinite(mono)||Math.abs(mono-r.input_time!)>.01||mono<0||mono>r.at+1)throw new Error('INPUT_CLOCK_AMBIGUITY');
    const held=this.pointers.has(r.pointer_id!);const multi=this.pointers.size>0&&!held;
    if(r.action==='down')this.pointers.add(r.pointer_id!);else this.pointers.delete(r.pointer_id!);
    this.inputAudit.push(r);
    if(r.action!=='down') {if(r.valid)throw new Error('RELEASE_CANNOT_ANSWER');return;}
    const result=[...this.results.values()].find(v=>mono>=v.onset&&(v.clear===null||mono<v.clear));
    if(r.pointer_type==='keyboard'){
      const codes=this.plan.choices.map(choice=>this.plan.response_keys?.[choice]),index=r.key_code===undefined?-1:codes.indexOf(r.key_code);