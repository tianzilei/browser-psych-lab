import { ContractError, id, object } from './contract.js';
import {parseTiming,parseTimingDefaults,parseOrdering,orderTrials} from './trial-design.js';
import {parseSampling,type Sampling} from './trial-sampling.js';
export const LAB_SCHEMA = 'lab-events-v1';
export const RUNNER_VERSION = 'canvas-v1';
// UTF-16 character budgets. Keep these unchanged for existing frozen protocols.
export const TEXT_LIMITS = { title: 200, question: 1000, instruction: 8000, choice: 200, answer: 4000, endpoint: 40 } as const;
export type Condition = { op: 'eq' | 'neq' | 'includes'; question: string; axis?: string; value: string | number }
  | { op: 'and' | 'or'; args: Condition[] } | { op: 'not'; arg: Condition };
export type AxisAnswer = Record<string, number | null>;
export type Answer = string | string[] | number | AxisAnswer | null;
export type InputPreset = 'digits' | 'integer' | 'decimal' | 'letters' | 'alphanumeric' | 'chinese' | 'phone_cn' | 'email';
export type InputMatch =
  | { kind: 'preset'; preset: InputPreset; message?: string }
  | { kind: 'regex'; pattern: string; flags?: string; message?: string };
export interface ScaleAxis {id:string;title:string;min:number;max:number;min_label:string;max_label:string;labels:string[]}
export interface Question { id: string; type: 'single' | 'multi' | 'scale' | 'scales' | 'text'; title: string;
  required: boolean; axes?: ScaleAxis[]; choices?: string[]; min?: number; max?: number; min_label?: string; max_label?: string; labels?: string[]; max_length?: number; input_purpose?: 'personal'; input_match?: InputMatch; condition?: Condition }
export interface Page { id: string; title: string; instruction: string; condition?: Condition; questions: Question[] }
export interface TimingSpec {base: number; jitter: number}
export interface TimingDefaults {stimulus_ms?: TimingSpec; isi_ms?: TimingSpec; feedback_ms?: TimingSpec}
export interface Ordering {mode: 'fixed' | 'shuffle' | 'category' | 'balanced'; max_run?: number}
export interface Feedback {correct: string; incorrect: string; miss: string; neutral: string}
export interface Rating {prompt:string;labels:string[];items?:string[]}
export interface Trial { root_id: string; asset_id?: string; text?: string; category?: string; image_ms: number; isi_ms: number; correct: string | null;
  timing?: TimingDefaults; timing_general?: (keyof TimingDefaults)[]; feedback_ms?: number }
export interface Group { id: string; title: string; choices: string[]; repeats: number; trials: Trial[];
  rating?:Rating; sampling?:Sampling;
  timing_defaults?: TimingDefaults; ordering?: Ordering; response_keys?: Record<string,string>; feedback?: Feedback }
export interface Variant { id: string; weight: number; group_order: string[]; trial_order: Record<string, string[]> }
export interface Protocol {
  schema: 'study-v1'; title: string; mode: 'TEST_ONLY' | 'COLLECTION'; pages: Page[]; groups: Group[];
  consent?: {title:string;text:string}; timing_defaults?: TimingDefaults;
  ending?: {title:string;text:string};
  variants: Variant[]; layout: { aspect: number; portrait_min_width: number; landscape_min_width: number; background: string; orientation?: 'portrait' | 'landscape' };
  budget: { commit_ms: number; activate_ms: number; margin_ms: number; draw_budget: number;
    long_frame_ms: number; max_group_ms: number; max_decoded_bytes: number; refresh_min_hz: number; refresh_max_hz: number;
    quantization: 'ceil-frame'; environment_id: string };
}
export interface FrozenProtocol { version_id: string; study_id: string; hash: string; protocol: Protocol;
  runner_version: string; runner_hash: string; assets: AssetInfo[] }
export interface AssetInfo { asset_id: string; hash: string; bytes: number; width: number; height: number;
  format: 'png' | 'jpeg' | 'webp'; state: string; name: string }
export function worstAuditPayload(group:Group,drawBudget:number){const entries=group.trials.flatMap(t=>Array.from({length:group.repeats+1},(_,i)=>({candidate:{...t,instance_id:`${t.root_id}:${i+1}`,number:i+1},proposal_id:'00000000-0000-0000-0000-000000000000',target:3600000})));
  return {type:'OP',at:3600000,operation:{before_plan:entries,after_plan:entries,before:entries.map(e=>e.candidate.instance_id),after:entries.map(e=>e.candidate.instance_id),random:{attempts:Array.from({length:drawBudget},()=>4294967295)}}};}
export function stableJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k =>
    `${JSON.stringify(k)}:${stableJSON((value as Record<string, unknown>)[k])}`).join(',')}}`;
  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new ContractError('INVALID_JSON_VALUE');
  return JSON.stringify(value);
}
function fields(o: Record<string, unknown>, names: string[]) {
  if (Object.keys(o).some(k => !names.includes(k))) throw new ContractError('UNKNOWN_PROTOCOL_FIELD');
}
function text(v: unknown, max = 2000): string {
  if (typeof v !== 'string' || v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) throw new ContractError('INVALID_TEXT');
  return v;
}
function number(v: unknown, min: number, max: number, whole = false) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (whole && !Number.isInteger(v))) throw new ContractError('INVALID_PROTOCOL_NUMBER');
  return v;
}
function list(v: unknown, max: number): unknown[] {
  if (!Array.isArray(v) || v.length > max) throw new ContractError('INVALID_PROTOCOL_LIST'); return v;
}
function strings(v: unknown, min: number, max: number) {
  const a = list(v, max).map(x => text(x, TEXT_LIMITS.choice));
  if (a.length < min || new Set(a).size !== a.length || a.some(x => !x.trim())) throw new ContractError('INVALID_CHOICES'); return a;
}
const INPUT_PRESETS: Record<InputPreset, string> = {
  digits: '[0-9]+', integer: '-?[0-9]+', decimal: '-?(?:[0-9]+(?:\\.[0-9]+)?)',
  letters: '[A-Za-z]+', alphanumeric: '[A-Za-z0-9]+', chinese: '[\\u3400-\\u9fff]+',
  phone_cn: '1[3-9][0-9]{9}', email: '[^\\s@]+@[^\\s@]+\\.[^\\s@]+',
};
const INPUT_PRESET_NAMES = new Set(Object.keys(INPUT_PRESETS));
function inputMatch(v: unknown): InputMatch {
  const o = object(v); fields(o, ['kind', 'preset', 'pattern', 'flags', 'message']);
  const message = o.message === undefined ? undefined : text(o.message, 200);
  if (o.kind === 'preset') {
    if (typeof o.preset !== 'string' || !INPUT_PRESET_NAMES.has(o.preset)) throw new ContractError('INVALID_INPUT_MATCH');
    if (o.pattern !== undefined || o.flags !== undefined) throw new ContractError('INVALID_INPUT_MATCH');
    return { kind: 'preset', preset: o.preset as InputPreset, ...(message === undefined ? {} : { message }) };
  }
  if (o.kind !== 'regex' || typeof o.pattern !== 'string' || o.pattern.length < 1 || o.pattern.length > 160)
    throw new ContractError('INVALID_INPUT_MATCH');
  const flags = o.flags === undefined ? '' : o.flags;
  if (typeof flags !== 'string' || !/^i?$/.test(flags))
    throw new ContractError('INVALID_INPUT_MATCH');
  // Avoid backreferences/lookarounds and nested unbounded quantifiers. They are
  // unnecessary for questionnaire identifiers and can make a browser regex
  // take unbounded time on a 4,000-character answer.
  const bounded = [...o.pattern.matchAll(/\{(\d+)(?:,(\d+))?\}/g)];
  const hasUnsafeQuantifier = /(?:^|[^\\])[+*?]/.test(o.pattern)
    || bounded.length > 1
    || bounded.some(m => Number(m[1]) > 4000 || (m[2] !== undefined && Number(m[2]) > 4000));
  if (/[()|]/.test(o.pattern) || /(?:^|[^\\])\./.test(o.pattern) || /\\[1-9]|\{\d+,\}/.test(o.pattern) || hasUnsafeQuantifier)
    throw new ContractError('UNSAFE_INPUT_MATCH');
  try { new RegExp(`^(?:${o.pattern})$`, flags); } catch { throw new ContractError('INVALID_INPUT_MATCH'); }
  return { kind: 'regex', pattern: o.pattern, ...(flags ? { flags } : {}), ...(message === undefined ? {} : { message }) };
}
export function inputMatchPattern(match: InputMatch): string {
  return match.kind === 'preset' ? INPUT_PRESETS[match.preset] : match.pattern;
}
export function inputMatchRegex(match: InputMatch): RegExp {
  return new RegExp(`^(?:${inputMatchPattern(match)})$`, match.kind === 'regex' ? (match.flags ?? '') : '');
}
export function inputMatchMessage(match: InputMatch): string {
  return match.message ?? '输入格式不符合要求。';
}
function condition(v: unknown, prior: Map<string,Question>, depth = 0): Condition {
  if (depth > 8) throw new ContractError('CONDITION_TOO_DEEP'); const o = object(v);
  if (o.op === 'not') { fields(o, ['op', 'arg']); return { op: 'not', arg: condition(o.arg, prior, depth + 1) }; }
  if (o.op === 'and' || o.op === 'or') {
    fields(o, ['op', 'args']); const args = list(o.args, 10).map(x => condition(x, prior, depth + 1));
    if (!args.length) throw new ContractError('EMPTY_CONDITION'); return { op: o.op, args };
  }
  fields(o, ['op', 'question', 'axis', 'value']);
  if (!['eq', 'neq', 'includes'].includes(String(o.op)) || !prior.has(id(o.question))
    || !['string', 'number'].includes(typeof o.value)) throw new ContractError('INVALID_CONDITION_REFERENCE');
  const q=prior.get(id(o.question))!;
  if(o.axis!==undefined){if(q.type!=='scales'||!q.axes!.some(axis=>axis.id===id(o.axis))||o.op==='includes'||typeof o.value!=='number')throw new ContractError('INVALID_CONDITION_AXIS');}
  else if(q.type==='scales')throw new ContractError('CONDITION_AXIS_REQUIRED');
  if (typeof o.value === 'number') number(o.value, -100000, 100000); else text(o.value, 2000);
  return o as unknown as Condition;
}
export function evaluate(c: Condition | undefined, answers: Record<string, Answer>): boolean {
  if (!c) return true;
  if (c.op === 'and') return c.args.every(a => evaluate(a, answers));
  if (c.op === 'or') return c.args.some(a => evaluate(a, answers));
  if (c.op === 'not') return !evaluate(c.arg, answers);
  if (!('question' in c)) return false;
  const value = answers[c.question];
  const a = c.axis!==undefined ? value&&typeof value==='object'&&!Array.isArray(value)?value[c.axis]:null : value;
  if (a === undefined || a === null) return false;
  if(typeof a==='object'&&!Array.isArray(a))return false;
  return c.op === 'eq' ? a === c.value : c.op === 'neq' ? a !== c.value : Array.isArray(a) && a.includes(String(c.value));
}
export function parseProtocol(value: unknown): Protocol {
  const p = object(value);
  fields(p, ['schema', 'title', 'mode', 'pages', 'groups', 'variants', 'layout', 'budget', 'consent', 'ending', 'timing_defaults']);
  if (p.schema !== 'study-v1' || !['TEST_ONLY', 'COLLECTION'].includes(String(p.mode))) throw new ContractError('INVALID_PROTOCOL_SCHEMA');
  const prior = new Map<string,Question>(); const ids = new Set<string>();
  const unique = (v: unknown) => { const s = id(v); if (ids.has(s)) throw new ContractError('DUPLICATE_PROTOCOL_ID'); ids.add(s); return s; };
  const pages: Page[] = list(p.pages, 30).map(value => {
    const page = object(value); fields(page, ['id', 'title', 'instruction', 'condition', 'questions']);
    const result: Page = { id: unique(page.id), title: text(page.title, TEXT_LIMITS.title), instruction: text(page.instruction, TEXT_LIMITS.instruction), questions: [] };
    if (page.condition) result.condition = condition(page.condition, prior);
    result.questions = list(page.questions, 30).map(value => {
      const q = object(value); fields(q, ['id', 'type', 'title', 'required', 'choices', 'min', 'max', 'min_label', 'max_label', 'labels', 'axes', 'max_length', 'input_purpose', 'input_match', 'condition']);
      if (!['single', 'multi', 'scale', 'scales', 'text'].includes(String(q.type)) || typeof q.required !== 'boolean') throw new ContractError('INVALID_QUESTION');
      const result: Question = { id: unique(q.id), title: text(q.title, TEXT_LIMITS.question), type: q.type as Question['type'], required: q.required };
      if(q.input_purpose!==undefined){if(q.type!=='text'||q.input_purpose!=='personal')throw new ContractError('INVALID_INPUT_PURPOSE');result.input_purpose='personal';}
      if(q.input_match!==undefined){if(q.type!=='text')throw new ContractError('INVALID_INPUT_MATCH');result.input_match=inputMatch(q.input_match);}
      if(q.type==='scale'&&q.choices!==undefined)throw new ContractError('SCALE_CHOICES_NOT_ALLOWED');
      if(q.axes!==undefined&&q.type!=='scales')throw new ContractError('INVALID_SCALE_AXES');
      if(q.type==='scales'){
        if(['choices','min','max','min_label','max_label','labels'].some(key=>q[key]!==undefined))throw new ContractError('INVALID_SCALE_AXES');
        const axes=list(q.axes,6),names=new Set<string>();if(axes.length<2)throw new ContractError('INVALID_SCALE_AXES');
        result.axes=axes.map(value=>{const a=object(value);fields(a,['id','title','min','max','min_label','max_label','labels']);const key=id(a.id);
          if(names.has(key)||['__proto__','constructor','prototype'].includes(key))throw new ContractError('DUPLICATE_AXIS_ID');names.add(key);
          const min=number(a.min,-1000,1000,true),max=number(a.max,min+1,min+20,true),labels=list(a.labels,21).map(v=>text(v,TEXT_LIMITS.endpoint));
          const min_label=text(a.min_label,TEXT_LIMITS.endpoint),max_label=text(a.max_label,TEXT_LIMITS.endpoint),title=text(a.title,TEXT_LIMITS.endpoint);
          if(!title.trim()||labels.length!==max-min+1||labels.some(v=>!v.trim())||labels[0]!==min_label||labels.at(-1)!==max_label)throw new ContractError('INVALID_SCALE_LABELS');
          return {id:key,title,min,max,min_label,max_label,labels};});
      }
      if(q.min_label!==undefined||q.max_label!==undefined){
        if(q.type!=='scale')throw new ContractError('INVALID_SCALE_ENDPOINTS');
        if(q.min_label!==undefined)result.min_label=text(q.min_label,TEXT_LIMITS.endpoint);
        if(q.max_label!==undefined)result.max_label=text(q.max_label,TEXT_LIMITS.endpoint);
      }
      if (q.condition) result.condition = condition(q.condition, prior);
      if (q.type === 'single' || q.type === 'multi') result.choices = strings(q.choices, 2, 20);
      if (q.type === 'scale') { result.min = number(q.min, -1000, 1000, true); result.max = number(q.max, result.min + 1, result.min + 20, true); }
      if (q.labels !== undefined) {
        if (q.type !== 'scale') throw new ContractError('INVALID_SCALE_LABELS');
        result.labels = list(q.labels,21).map(v=>text(v,TEXT_LIMITS.endpoint));
        if(result.labels.length!==result.max!-result.min!+1||result.labels.some(v=>!v.trim())||result.labels[0]!==result.min_label||result.labels.at(-1)!==result.max_label)throw new ContractError('INVALID_SCALE_LABELS');
      }
      if (q.type === 'text') result.max_length = number(q.max_length, 1, TEXT_LIMITS.answer, true);
      prior.set(result.id,result); return result;
    }); return result;
  });
  const b = object(p.budget); fields(b, ['commit_ms', 'activate_ms', 'margin_ms', 'draw_budget', 'long_frame_ms', 'max_group_ms',
    'max_decoded_bytes', 'refresh_min_hz', 'refresh_max_hz', 'quantization', 'environment_id']);
  if (b.quantization !== 'ceil-frame') throw new ContractError('INVALID_QUANTIZATION');
  const budget: Protocol['budget'] = { commit_ms: number(b.commit_ms, 1, 1000), activate_ms: number(b.activate_ms, 1, 100),
    margin_ms: number(b.margin_ms, 0, 100), draw_budget: number(b.draw_budget, 1, 4096, true),
    long_frame_ms: number(b.long_frame_ms, 10, 1000), max_group_ms: number(b.max_group_ms, 100, 3600000),
    max_decoded_bytes: number(b.max_decoded_bytes, 1024, 256 * 1024 * 1024, true),
    refresh_min_hz: number(b.refresh_min_hz, 20, 240), refresh_max_hz: number(b.refresh_max_hz, 20, 240),
    quantization: 'ceil-frame', environment_id: id(b.environment_id) };
  if (budget.refresh_min_hz > budget.refresh_max_hz) throw new ContractError('INVALID_REFRESH_RANGE');
  const general=p.timing_defaults===undefined?undefined:parseTimingDefaults(p.timing_defaults);
  const groups: Group[] = list(p.groups, 20).map(value => {
    const g = object(value); fields(g, ['id', 'title', 'choices', 'repeats', 'trials','timing_defaults','ordering','response_keys','feedback','rating','sampling']);
    const choices = strings(g.choices, 2, g.rating===undefined?6:11); const repeats = number(g.repeats, 0, 2, true);
    const defaults=general||g.timing_defaults!==undefined?{...general,...(g.timing_defaults===undefined?{}:parseTimingDefaults(g.timing_defaults))}:undefined;
    const trials: Trial[] = list(g.trials, g.rating!==undefined&&g.sampling!==undefined?200:100).map(value => {
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
      const r=object(g.rating);fields(r,['prompt','labels','items']);const prompt=text(r.prompt,TEXT_LIMITS.question),labels=strings(r.labels,choices.length,choices.length),items=r.items===undefined?undefined:strings(r.items,1,20);
      if(!prompt.trim()||choices.some((c,i)=>c!==String(i+1))||repeats!==0||defaults||g.ordering!==undefined||g.response_keys!==undefined||g.feedback!==undefined||trials.some(t=>t.correct!==null||!t.asset_id||t.timing||t.feedback_ms||t.image_ms!==1)||new Set(trials.map(t=>t.asset_id)).size!==trials.length)throw new ContractError('INVALID_SELF_PACED_RATING');
      group.rating={prompt,labels,...(items?{items}:{})};
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
