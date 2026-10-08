import { Scheduler, type ScheduleAudit } from './scheduler.js';
import { stableJSON } from './protocol.js';
import type { GroupPlan, InputRecord, RunRecord } from './lab-contract.js';
export interface TrialResult { instance_id:string;root_id:string;number:number;onset:number;clear:number|null;end:number|null;
  answer:string|null;input_time:number|null;correct:boolean|null;rt_ms:number|null;software_quality:string;actual_gap:number|null }
export class RunReplay {
  readonly scheduler:Scheduler; readonly results=new Map<string,TrialResult>(); readonly obligations=new Set<string>();
  readonly pointers=new Set<number>(); readonly inputAudit:InputRecord[]=[];
  private last=-Infinity; private closed=false;private clockOrigin:number|null=null;
  private corrections=new Set<string>();
  private domOrigin:number|null=null;
  constructor(readonly plan:GroupPlan){this.scheduler=new Scheduler(plan.roots,plan.repeats,plan.start,plan.seed,plan.budget);}
  apply(r:RunRecord) {
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
        const e=s.queue[0];const result=this.results.get(r.instance_id!)!;if(!e||!result||r.at<e.target+e.candidate.image_ms+e.candidate.isi_ms
          ||r.at-e.target-e.candidate.image_ms-e.candidate.isi_ms>this.plan.budget.long_frame_ms)throw new Error('END_TARGET_MISMATCH');
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
    if(!Number.isFinite(r.x)||!Number.isFinite(r.y)||!['mouse','touch','pen'].includes(r.pointer_type))throw new Error('INVALID_POINTER_GEOMETRY');
    if(this.plan.geometry){const hit=this.plan.geometry.buttons.find(b=>r.x>=b.x&&r.x<b.x+b.width&&r.y>=b.y&&r.y<b.y+b.height)?.choice??null;if(hit!==r.choice)throw new Error('INPUT_GEOMETRY_MISMATCH');}
    const can=!this.closed&&this.scheduler.state==='RUNNING'&&!!result&&!held&&!multi&&r.choice!==null&&this.plan.choices.includes(r.choice);
    if(r.valid!==can)throw new Error('INPUT_VALIDITY_MISMATCH');if(!can)return;
    if(result!.input_time!==null&&result!.input_time<=mono)return;
    // An earlier normalized new touch may revise attribution; later correct choices never replace a first answer.
    const wasSatisfied=result!.clear!==null&&result!.answer!==null&&(this.plan.roots.find(t=>t.root_id===result!.root_id)!.correct===null||result!.correct===true);
    result!.answer=r.choice;result!.input_time=mono;result!.rt_ms=mono-result!.onset;
    if(result!.clear!==null){const root=this.plan.roots.find(t=>t.root_id===result!.root_id)!;result!.correct=root.correct===null?null:r.choice===root.correct;
      if(wasSatisfied&&result!.correct===false)throw new Error('EARLIER_INPUT_REVOKES_SATISFACTION');
      if(this.obligations.has(root.root_id)&&(root.correct===null||result!.correct))this.corrections.add(root.root_id);
    }
    if(result!.rt_ms!<0)throw new Error('NEGATIVE_VALID_RT');
  }
  finish(){if(this.scheduler.state!=='GROUP_CLOSING')throw new Error('GROUP_NOT_NORMALLY_CLOSED');return [...this.results.values()];}
}
