import { ContractError, id, object } from './contract.js';
export const LAB_SCHEMA = 'lab-events-v1';
export const RUNNER_VERSION = 'canvas-v1';
export type Condition = { op: 'eq' | 'neq' | 'includes'; question: string; value: string | number }
  | { op: 'and' | 'or'; args: Condition[] } | { op: 'not'; arg: Condition };
export type Answer = string | string[] | number | null;
export interface Question { id: string; type: 'single' | 'multi' | 'scale' | 'text'; title: string;
  required: boolean; choices?: string[]; min?: number; max?: number; max_length?: number; condition?: Condition }
export interface Page { id: string; title: string; instruction: string; condition?: Condition; questions: Question[] }
export interface Trial { root_id: string; asset_id: string; image_ms: number; isi_ms: number; correct: string | null }
export interface Group { id: string; title: string; choices: string[]; repeats: number; trials: Trial[] }
export interface Variant { id: string; weight: number; group_order: string[]; trial_order: Record<string, string[]> }
export interface Protocol {
  schema: 'study-v1'; title: string; mode: 'TEST_ONLY' | 'COLLECTION'; pages: Page[]; groups: Group[];
  variants: Variant[]; layout: { aspect: number; portrait_min_width: number; landscape_min_width: number; background: string };
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
  const a = list(v, max).map(x => text(x, 200));
  if (a.length < min || new Set(a).size !== a.length || a.some(x => !x.trim())) throw new ContractError('INVALID_CHOICES'); return a;
}
function condition(v: unknown, prior: Set<string>, depth = 0): Condition {
  if (depth > 8) throw new ContractError('CONDITION_TOO_DEEP'); const o = object(v);
  if (o.op === 'not') { fields(o, ['op', 'arg']); return { op: 'not', arg: condition(o.arg, prior, depth + 1) }; }
  if (o.op === 'and' || o.op === 'or') {
    fields(o, ['op', 'args']); const args = list(o.args, 10).map(x => condition(x, prior, depth + 1));
    if (!args.length) throw new ContractError('EMPTY_CONDITION'); return { op: o.op, args };
  }
  fields(o, ['op', 'question', 'value']);
  if (!['eq', 'neq', 'includes'].includes(String(o.op)) || !prior.has(id(o.question))
    || !['string', 'number'].includes(typeof o.value)) throw new ContractError('INVALID_CONDITION_REFERENCE');
  if (typeof o.value === 'number') number(o.value, -100000, 100000); else text(o.value, 2000);
  return o as unknown as Condition;
}
export function evaluate(c: Condition | undefined, answers: Record<string, Answer>): boolean {
  if (!c) return true;
  if (c.op === 'and') return c.args.every(a => evaluate(a, answers));
  if (c.op === 'or') return c.args.some(a => evaluate(a, answers));
  if (c.op === 'not') return !evaluate(c.arg, answers);
  if (!('question' in c)) return false;
  const a = answers[c.question];
  if (a === undefined || a === null) return false;
  return c.op === 'eq' ? a === c.value : c.op === 'neq' ? a !== c.value : Array.isArray(a) && a.includes(String(c.value));
}
export function parseProtocol(value: unknown): Protocol {
  const p = object(value);
  fields(p, ['schema', 'title', 'mode', 'pages', 'groups', 'variants', 'layout', 'budget']);
  if (p.schema !== 'study-v1' || !['TEST_ONLY', 'COLLECTION'].includes(String(p.mode))) throw new ContractError('INVALID_PROTOCOL_SCHEMA');
  const prior = new Set<string>(); const ids = new Set<string>();
  const unique = (v: unknown) => { const s = id(v); if (ids.has(s)) throw new ContractError('DUPLICATE_PROTOCOL_ID'); ids.add(s); return s; };
  const pages: Page[] = list(p.pages, 30).map(value => {
    const page = object(value); fields(page, ['id', 'title', 'instruction', 'condition', 'questions']);
    const result: Page = { id: unique(page.id), title: text(page.title, 200), instruction: text(page.instruction, 8000), questions: [] };
    if (page.condition) result.condition = condition(page.condition, prior);
    result.questions = list(page.questions, 30).map(value => {
      const q = object(value); fields(q, ['id', 'type', 'title', 'required', 'choices', 'min', 'max', 'max_length', 'condition']);
      if (!['single', 'multi', 'scale', 'text'].includes(String(q.type)) || typeof q.required !== 'boolean') throw new ContractError('INVALID_QUESTION');
      const result: Question = { id: unique(q.id), title: text(q.title, 1000), type: q.type as Question['type'], required: q.required };
      if (q.condition) result.condition = condition(q.condition, prior);
      if (q.type === 'single' || q.type === 'multi') result.choices = strings(q.choices, 2, 20);
      if (q.type === 'scale') { result.min = number(q.min, -1000, 1000, true); result.max = number(q.max, result.min + 1, result.min + 20, true); }
      if (q.type === 'text') result.max_length = number(q.max_length, 1, 4000, true);
      prior.add(result.id); return result;
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
  const groups: Group[] = list(p.groups, 20).map(value => {
    const g = object(value); fields(g, ['id', 'title', 'choices', 'repeats', 'trials']);
    const choices = strings(g.choices, 2, 6); const repeats = number(g.repeats, 0, 2, true);
    const trials: Trial[] = list(g.trials, 100).map(value => {
      const t = object(value); fields(t, ['root_id', 'asset_id', 'image_ms', 'isi_ms', 'correct']);
      const image_ms = number(t.image_ms, 1, 60000); const isi_ms = number(t.isi_ms, 0, 60000);
      if (t.correct !== null && !choices.includes(String(t.correct))) throw new ContractError('INVALID_CORRECT_ANSWER');
      if (repeats && isi_ms < budget.commit_ms + budget.activate_ms + budget.margin_ms) throw new ContractError('DYNAMIC_ISI_BUDGET_INSUFFICIENT');
      return { root_id: unique(t.root_id), asset_id: id(t.asset_id), image_ms, isi_ms, correct: t.correct as string | null };
    });
    if (!trials.length || trials.reduce((n, t) => n + (t.image_ms + t.isi_ms) * (repeats + 1), 0) > budget.max_group_ms)
      throw new ContractError('GROUP_TIME_BUDGET_EXCEEDED');
    const group={ id: unique(g.id), title: text(g.title, 200), choices, repeats, trials };
    if(new TextEncoder().encode(JSON.stringify(worstAuditPayload(group,budget.draw_budget))).length>120*1024)throw new ContractError('GROUP_AUDIT_SIZE_BUDGET_EXCEEDED');return group;
  });
  if (!pages.length && !groups.length) throw new ContractError('EMPTY_STUDY');
  const variants: Variant[] = list(p.variants, 20).map(value => {
    const v = object(value); fields(v, ['id', 'weight', 'group_order', 'trial_order']);
    const order = list(v.group_order, 20).map(id); const trial_order = object(v.trial_order);
    if (order.length !== groups.length || new Set(order).size !== groups.length || order.some(k => !groups.some(g => g.id === k))
      || Object.keys(trial_order).length !== groups.length) throw new ContractError('INVALID_VARIANT_ORDER');
    const result: Variant = { id: unique(v.id), weight: number(v.weight, 1, 20, true), group_order: order, trial_order: {} };
    for (const g of groups) {
      const ids = list(trial_order[g.id], 100).map(id);
      if (ids.length !== g.trials.length || new Set(ids).size !== ids.length || ids.some(k => !g.trials.some(t => t.root_id === k))) throw new ContractError('INVALID_TRIAL_ORDER');
      result.trial_order[g.id] = ids;
    } return result;
  });
  if (!variants.length || variants.reduce((n, v) => n + v.weight, 0) > 100) throw new ContractError('INVALID_ALLOCATION_WEIGHTS');
  const l = object(p.layout); fields(l, ['aspect', 'portrait_min_width', 'landscape_min_width', 'background']);
  if (typeof l.background !== 'string' || !/^#[a-fA-F0-9]{6}$/.test(l.background)) throw new ContractError('INVALID_BACKGROUND');
  return { schema: 'study-v1', title: text(p.title, 200), mode: p.mode as Protocol['mode'], pages, groups, variants,
    layout: { aspect: number(l.aspect, .25, 4), portrait_min_width: number(l.portrait_min_width, 200, 2000, true),
      landscape_min_width: number(l.landscape_min_width, 200, 2000, true), background: l.background }, budget };
}
export function pageSnapshot(page: Page, all: Record<string, Answer>, supplied: Record<string, Answer>) {
  if (Object.keys(supplied).some(k => !page.questions.some(q => q.id === k))) throw new ContractError('UNKNOWN_ANSWER');
  const result: Record<string, { state: 'ANSWERED' | 'UNANSWERED' | 'SKIPPED'; answer: Answer }> = {};
  const answers = { ...all };
  for (const q of page.questions) {
    if (!evaluate(q.condition, answers)) { result[q.id] = { state: 'SKIPPED', answer: null };answers[q.id]=null; continue; }
    const answer = supplied[q.id] ?? null;
    const empty = answer === null || answer === '' || (Array.isArray(answer) && !answer.length);
    if (empty && q.required) throw new ContractError('REQUIRED_ANSWER', 409, { question: q.id });
    if (!empty) {
      if (q.type === 'single' && (typeof answer !== 'string' || !q.choices!.includes(answer))) throw new ContractError('INVALID_ANSWER');
      if (q.type === 'multi' && (!Array.isArray(answer) || new Set(answer).size !== answer.length || answer.some(a => !q.choices!.includes(a)))) throw new ContractError('INVALID_ANSWER');
      if (q.type === 'scale' && (typeof answer !== 'number' || !Number.isInteger(answer) || answer < q.min! || answer > q.max!)) throw new ContractError('INVALID_ANSWER');
      if (q.type === 'text' && (typeof answer !== 'string' || answer.length > q.max_length!)) throw new ContractError('INVALID_ANSWER');
    }
    result[q.id] = { state: empty ? 'UNANSWERED' : 'ANSWERED', answer }; answers[q.id] = answer;
  } return result;
}
export function sampleProtocol(): Protocol {
  return parseProtocol({ schema: 'study-v1', title: '新研究（测试）', mode: 'TEST_ONLY', pages: [
    { id: 'welcome', title: '说明与问卷', instruction: '这是开发测试研究。请作答后继续。', questions: [
      { id: 'ready', type: 'single', title: '是否准备好？', required: true, choices: ['是', '否'] },
    ] }], groups: [], variants: [{ id: 'standard', weight: 1, group_order: [], trial_order: {} }],
    layout: { aspect: 1.5, portrait_min_width: 280, landscape_min_width: 280, background: '#f4f6f2' },
    budget: { commit_ms: 40, activate_ms: 10, margin_ms: 10, draw_budget: 32, long_frame_ms: 100,
      max_group_ms: 300000, max_decoded_bytes: 32 * 1024 * 1024, refresh_min_hz: 45, refresh_max_hz: 144,
      quantization: 'ceil-frame', environment_id: 'TEST_ONLY' } });
}
