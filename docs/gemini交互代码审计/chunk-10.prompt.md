当前交互源码第 10 段。连续片段，请与前后段拼接阅读。本阶段只回复 ACK_INTERACTION_10。
Rating; sampling?:Sampling;
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
    const trials: Trial[] = list(g.trials, g.rating!==undefined&&