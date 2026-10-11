当前交互源码第 11 段。连续片段，请与前后段拼接阅读。本阶段只回复 ACK_INTERACTION_11。
g.sampling!==undefined?200:100).map(value => {
      const t = object(value); fields(t, ['root_id', 'asset_id', 'image_ms', 'isi_ms', 'correct','text','category','timing','feedback_ms','timing_general']);
      const timing=t.timing===undefined?{}:parseTimingDefaults(t.timing);
      const inherited=t.timing_general===undefined?[]:list(t.timing_general,3).map(v=>{
        if(!['stimulus_ms','isi_ms','feedback_ms'].includes(String(v)))throw new ContractError('INVALID_TIMING_SOURCE');return v as keyof TimingDefaults;});
      for(const [phase,field] of [['stimulus_ms','image_ms'],['isi_ms','isi_ms'],['feedback_ms','feedback_ms']] as const){
        if(inherited.includes(phase)){if(!defaults?.[phase]||timing[phase]||t[field]!==defaults[phase]!.base)throw new ContractError('INVALID_TIMING_SOURCE');continue;}
        if(t[field]!==undefined){if(timing[phase]){if(t[field]!==timing[phase]!.base)throw new ContractError('AMBIGUOUS_TRIAL_TIMING');continue;}
          if(defaults?.[phase]||typeof t[field]!=='number')timing[phase]=parseTiming(t[field]);}
        else if(defaults?.[phase]&&!timing[phase])inherited.push(phase);
      }
      const stimulus=timing.stimulus_ms??defaults?.stimulus_ms,interval=timing.isi_ms??defaults?.isi_ms,feedbackTime=timing.feedback_ms??defaults?.feedback_ms;
      const image_ms = number(stimulus?.base??t.image_ms, 1, 60000); const isi_ms = number(interval?.base??t.isi_ms, 0, 60000);
      if(stimulus&&stimulus.base-stimulus.jitter<1)throw new ContractError('INVALID_STIMULUS_DURATION');
      if (t.correct !== null && !choices.includes(String(t.correct))) throw new ContractError('INVALID_CORRECT_ANSWER');
      if (repeats && isi_ms-(interval?.jitter??0) < budget.commit_ms + budget.activate_ms + budget.margin_ms) throw new ContractError('DYNAMIC_ISI_BUDGET_INSUFFICIENT');
      if((t.text===undefined)===(t.asset_id===undefined))throw new ContractError('ONE_STIMULUS_REQUIRED');
      const result:Trial={ root_id: unique(t.root_id), ...(t.text!==undefined?{text:text(t.text,200)}:{asset_id:id(t.asset_id)}), image_ms, isi_ms, correct: t.correct as string | null };
      if(result.text!==undefined&&!result.text.trim())throw new ContractError('INVALID_TEXT_STIMULUS');
      if(t.category!==undefined)result.category=id(t.category);
      if(Object.keys(timing).length)result.timing=timing;
      if(inherited.length)result.timing_general=inherited;
      if(feedbackTime||t.feedback_ms!==undefined)result.feedback_ms=number(feedbackTime?.base??t.feedback_ms,0,60000);
      return result;
    });
    const maxTime=(t:Trial,phase:keyof TimingDefaults,base:number)=>{const spec=t.timing?.[phase]??defaults?.[phase];return spec?spec.base+spec.jitter:base;};
    if (!trials.length || trials.reduce((n, t) => n + (maxTime(t,'stimulus_ms',t.image_ms)+maxTime(t,'isi_ms',t.isi_ms)+maxTime(t,'feedback_ms',t.feedback_ms??0)) * (repeats + 1), 0) > budget.max_group_ms)
      throw new ContractError('GROUP_TIME_BUDGET_EXCEEDED');
    const group:Group={ id: unique(g.id), title: text(g.title, TEXT_LIMITS.title), choices, repeats, trials };
    if(g.rating!==undefined){
      const r=object(g.rating);fields(r,['prompt','labels','items','age_prompt','age_min','age_max']);const prompt=text(r.prompt,TEXT_LIMITS.question),labels=strings(r.labels,choices.length,choices.length),items=r.items===undefined?undefined:strings(r.items,1,20);
      const age_prompt=r.age_prompt===undefined?undefined:text(r.age_prompt,TEXT_LIMITS.question), age_min=r.age_min===undefined?0:number(r.age_min,0,120,true), age_max=r.age_max===undefined?120:number(r.age_max,0,120,true);
      if(age_min>age_max||(age_prompt===undefined&&(r.age_min!==undefined||r.age_max!==undefined))||(age_prompt!==undefined&&age_min===age_max))throw new ContractError('INVALID_RATING_AGE');
      if(!prompt.trim()||choices.some((c,i)=>c!==String(i+1))||repeats!==0||defaults||g.ordering!==undefined||g.response_keys!==undefined||g.feedback!==undefined||trials.some(t=>t.correct!==null||!t.asset_id||t.timing||t.feedback_ms||t.image_ms!==1)||new Set(trials.map(t=>t.asset_id)).size!==trials.length)throw new ContractError('INVALID_SELF_PACED_RATING');
      group.rating={prompt,labels,...(items?{items}:{}),...(age_prompt?{age_prompt,age_min,age_max}:{})};
    }
    if(g.sampling!==undefined){if(!group.rating)throw new ContractError('SAMPLING_REQUIRES_RATING');group.sampling=parseSampling(g.sampling,trials);}
    if(defaults)group.timing_defaults=defaults;
    if(g.ordering!==undefined){group.ordering=parseOrdering(g.ordering);orderTrials(trials,group.ordering,[1,2,3,4]);}
    if(g.response_keys!==undefined){const keys=object(g.response_keys);if(Object.keys(keys).length!==choices.length||Object.keys(keys).some(k=>!choices.includes(k))
      ||new Set(Object.values(keys)).size!==choices.length||Object.values(keys).some(k=>typeof k!=='string'||! /^(Key[A-Z]|Digit[0-9]|Arrow(Left|Right|Up|Down)|Space|Enter)$/.test(k)))throw new ContractError('INVALID_RESPONSE_KEYS');
      group.response_keys=keys as Record<string,string>;}
    if(g.feedback!==undefined){const f=object(g.feedback);fields(f,['correct','incorrect','miss','neutral']);group.feedback={correct:text(f.correct,100),incorrect:text(f.incorrect,100),miss:text(f.miss,100),neutral:text(f.neutral,100)};}
    if(!group.rating&&new TextEncoder().encode(JSON.stringify(worstAuditPayload(group,budget.draw_budget))).length>120*1024)throw new ContractError('GROUP_AUDIT_SIZE_BUDGET_EXCEEDED');return group;
  });
  if (!pages.length && !groups.length) throw new ContractError('EMPTY_STUDY');
  const variants: Variant[] = list(p.variants, 20).map(value => {
    const v = object(value); fields(v, ['id', 'weight', 'group_order', 'trial_order']);
    const order = list(v.group_order, 20).map(id); const trial_order = object(v.trial_order);
    if (order.length !== groups.length || new Set(order).size !== groups.length || order.some(k => !groups.some(g => g.id === k))
      || Object.keys(trial_order).length !== groups.length) throw new ContractError('INVALID_VARIANT_ORDER');
    const result: Variant = { id: unique(v.id), weight: number(v.weight, 1, 20, true), group_order: order, trial_order: {} };
    for (const g of groups) {
      const ids = list(trial_order[g.id], g.rating&&g.sampling?200:100).map(id);
      if (ids.length !== g.trials.length || new Set(ids).size !== ids.length || ids.some(k => !g.trials.some(t => t.root_id === k))) throw new ContractError('INVALID_TRIAL_ORDER');
      result.trial_order[g.id] = ids;
    } return result;
  });
  if (!variants.length || variants.reduce((n, v) => n + v.weight, 0) > 100) throw new ContractError('INVALID_ALLOCATION_WEIGHTS');
  const l = object(p.layout); fields(l, ['aspect', 'portrait_min_width', 'landscape_min_width', 'background', 'orientation']);
  if(l.orientation!==undefined&&!['portrait','landscape'].includes(String(l.orientation)))throw new ContractError('INVALID_ORIENTATION');
  if (typeof l.background !== 'string' || !/^#[a-fA-F0-9]{6}$/.test(l.background)) throw new ContractError('INVALID_BACKGROUND');
  let ending:Protocol['ending'];if(p.ending!==undefined){const e=object(p.ending);fields(e,['title','text']);ending={title:text(e.title,TEXT_LIMITS.title),text:text(e.text,TEXT_LIMITS.instruction)};if(!ending.title.trim()||!ending.text.trim())throw new ContractError('INVALID_ENDING');}
  let consent:Protocol['consent'];if(p.consent!==undefined){const c=object(p.consent);fields(c,['title','text']);consent={title:text(c.title,TEXT_LIMITS.title),text:text(c.text,TEXT_LIMITS.instruction)};if(!consent.title.trim()||!consent.text.trim())throw new ContractError('INVALID_CONSENT');}
  return { schema: 'study-v1', title: text(p.title, TEXT_LIMITS.title), mode: p.mode as Protocol['mode'], pages, groups, variants,...(consent?{consent}:{}),...(ending?{ending}:{}),...(general?{timing_defaults:general}:{}),
    layout: { aspect: number(l.aspect, .25, 4), portrait_min_width: number(l.portrait_min_width, groups.length>0&&groups.every(g=>g.rating)?120:200, 2000, true),
      landscape_min_width: number(l.landscape_min_width, groups.length>0&&groups.every(g=>g.rating)?120:200, 2000, true), background: l.background,
      ...(l.orientation!==undefined?{orientation:l.orientation as 'portrait'|'landscape'}:{}) }, budget };
}
export function validateQuestionnaire(p:Protocol, strict=false) {
  if(strict&&!p.layout.orientation)throw new ContractError('ORIENTATION_REQUIRED');
  for(const page of p.pages)for(const q of page.questions){
    if(q.type==='text'&&q.input_purpose!=='personal')throw new ContractError('PERSONAL_INPUT_ONLY',409,{question:q.id});
    if(q.type==='scale'&&(!q.min_label?.trim()||!q.max_label?.trim()))throw new ContractError('SCALE_ENDPOINTS_REQUIRED',409,{question:q.id});
    if(strict&&q.type==='scale'&&!q.labels)throw new ContractError('SCALE_LABELS_REQUIRED',409,{question:q.id});
  }
}
export function pageSnapshot(page: Page, all: Record<string, Answer>, supplied: Record<string, Answer>) {
  if (Object.keys(supplied).some(k => !page.questions.some(q => q.id === k))) throw new ContractError('UNKNOWN_ANSWER');
  const result: Record<string, { state: 'ANSWERED' | 'UNANSWERED' | 'SKIPPED'; answer: Answer }> = {};
  const answers = { ...all };
  for (const q of page.questions) {
    if (!evaluate(q.condition, answers)) { result[q.id] = { state: 'SKIPPED', answer: null };answers[q.id]=null; continue; }
    let answer = supplied[q.id] ?? null;
    if(q.type==='scales'){
      const values=answer===null?{}:object(answer);
      if(Object.keys(values).some(key=>!q.axes!.some(axis=>axis.id===key)))throw new ContractError('UNKNOWN_AXIS_ANSWER');
      answer=Object.fromEntries(q.axes!.map(axis=>{const value=values[axis.id]??null;
        if(value!==null&&(typeof value!=='number'||!Number.isInteger(value)||value<axis.min||value>axis.max))throw new ContractError('INVALID_ANSWER');
        return [axis.id,value as number|null];}));
      if(q.required&&answerMissing(q,answer))throw new ContractError('REQUIRED_ANSWER',409,{question:q.id});
      const filled=Object.values(answer).some(value=>value!==null);
      result[q.id]={state:filled?'ANSWERED':'UNANSWERED',answer};answers[q.id]=answer;continue;
    }
    const empty = answer === null || answer === '' || (Array.isArray(answer) && !answer.length);
    if (empty && q.required) throw new ContractError('REQUIRED_ANSWER', 409, { question: q.id });
    if (!empty) {
      if (q.type === 'single' && (typeof answer !== 'string' || !q.choices!.includes(answer))) throw new ContractError('INVALID_ANSWER');
      if (q.type === 'multi' && (!Array.isArray(answer) || new Set(answer).size !== answer.length || answer.some(a => !q.choices!.includes(a)))) throw new ContractError('INVALID_ANSWER');
      if (q.type === 'scale' && (typeof answer !== 'number' || !Number.isInteger(answer) || answer < q.min! || answer > q.max!)) throw new ContractError('INVALID_ANSWER');
      if (q.type === 'text' && (typeof answer !== 'string' || answer.length > q.max_length! || (q.input_match!==undefined && !inputMatchRegex(q.input_match).test(answer)))) throw new ContractError('INVALID_ANSWER');
    }
    result[q.id] = { state: empty ? 'UNANSWERED' : 'ANSWERED', answer }; answers[q.id] = answer;
  } return result;
}
export function axisAnswers(answer:Answer|undefined):AxisAnswer {return answer&&typeof answer==='object'&&!Array.isArray(answer)?answer:{};}
export function copyAnswer(answer:Answer):Answer {return Array.isArray(answer)?[...answer]:answer&&typeof answer==='object'?{...answer}:answer;}
export function answerMissing(q:Question,answer:Answer|undefined):boolean {
  return q.type==='scales'?q.axes!.some(axis=>typeof axisAnswers(answer)[axis.id]!=='number')
    :answer==null||answer===''||(Array.isArray(answer)&&!answer.length);
}
export function sampleProtocol(): Protocol {
  return parseProtocol({ schema: 'study-v1', title: '新研究（测试）', mode: 'TEST_ONLY', pages: [
    { id: 'welcome', title: '说明与问卷', instruction: '这是开发测试研究。请作答后继续。', questions: [
      { id: 'ready', type: 'single', title: '是否准备好？', required: true, choices: ['是', '否'] },
    ] }], groups: [], variants: [{ id: 'standard', weight: 1, group_order: [], trial_order: {} }],
    layout: { aspect: 1.5, portrait_min_width: 280, landscape_min_width: 280, background: '#e5e5e5' },
    budget: { commit_ms: 40, activate_ms: 10, margin_ms: 10, draw_budget: 32, long_frame_ms: 100,
      max_group_ms: 300000, max_decoded_bytes: 32 * 1024 * 1024, refresh_min_hz: 45, refresh_max_hz: 144,
      quantization: 'ceil-frame', environment_id: 'TEST_ONLY' } });
}

```


=== FILE src/shared/lab-contract.ts (complete source; may continue in next chunk) ===
```
import { ContractError, eventRef, id, integer, object, type EventRef, type Receipt, type Seal, type SessionState } from './contract.js';
import { LAB_SCHEMA, type FrozenProtocol, type Answer, type Trial, type Protocol, type Feedback, type Rating } from './protocol.js';
import type {SamplingAudit} from './trial-sampling.js';
import type {DesignAudit} from './trial-design.js';
import type { ScheduleAudit } from './scheduler.js';
export interface LabEvent { event_schema_version: typeof LAB_SCHEMA; event_id: string; session_id: string; version_id: string;
  protocol_hash: string; writer_id: string; writer_epoch: number; scope: string; sequence: number; previous: EventRef | null;
  clock_epoch: string; time_ms: number; kind: 'PAGE_REVISION' | 'PAGE_SNAPSHOT' | 'GROUP_RECORD' | 'INPUT_DIAGNOSTIC'; payload: Record<string, unknown> }
export interface GroupPlan { group_id: string; scope: string; seed: [number,number,number,number]; roots: Trial[];
  rating?:Rating; sampling?:SamplingAudit;
  choices: string[]; repeats: number; start: number; frame_ms: number; layout: string; budget: Protocol['budget']; plan_hash?: string;
  design?: DesignAudit; response_keys?: Record<string,string>; feedback?: Feedback;
  geometry?: { viewport:{width:number;height:number;dpr:number}; canvas:{x:number;y:number;width:number;h