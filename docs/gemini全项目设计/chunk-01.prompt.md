全项目设计讨论，传输段 1，源码主题：合同和问卷编译（源包 1/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

### src/shared/contract.ts L1–L103

```
// P0 is an explicitly frozen diagnostic protocol, never a published research.
export const CONTRACT_VERSION = 'p0-contract-v1';
export const PROTOCOL = {
  study_id: 'TEST_ONLY', protocol_version_id: 'test-questionnaire-v1',
  runner_version: 'p0-v1', page_id: 'check', question_id: 'component_check',
  choices: ['正常显示', '需要检查'], group_id: 'diagnostic-group',
} as const;
export const LIMITS = { batch_records: 32, batch_bytes: 128 * 1024, event_bytes: 16 * 1024,
  request_bytes: 288 * 1024,
  scope_events: 128, queue_requests: 32, queue_bytes: 2 * 1024 * 1024,
  control_reserve: 4, rpc_timeout_ms: 10_000, transaction_ms: 1000 } as const;
export type SessionState = 'CREATED' | 'ACTIVE' | 'FINALIZING' | 'COMPLETED' | 'TERMINATED';
export type Disposition = 'ACCEPTED' | 'RECEIVED_PENDING' | 'QUARANTINED';
export type PermitState = 'ISSUED' | 'CLOSED_NORMAL' | 'CLOSED_TERMINATED' | 'CLOSED_UNKNOWN';
export type EventKind = 'ANSWER_SNAPSHOT' | 'TRIAL_INTENT' | 'SOFTWARE_ONSET' | 'WINDOW_CLOSED' | 'TRIAL_ENDED';
export interface EventRef { event_id: string; hash: string }
export interface EventEnvelope {
  event_schema_version: typeof CONTRACT_VERSION; event_id: string; session_id: string;
  protocol_version_id: typeof PROTOCOL.protocol_version_id; writer_id: string; writer_epoch: number;
  scope: string; sequence: number; previous: EventRef | null; kind: EventKind;
  clock_epoch: string; time_ms: number; payload: Record<string, unknown>;
}
export interface WireEvent extends EventRef { raw: string }
export interface Receipt extends EventRef {
  scope: string; receipt_id: string; custody: 'PERSISTED'; disposition: Disposition;
  disposition_version: number; reason: string;
}
export interface Manifest {
  manifest_id: string; scope: string; events: EventRef[]; path: string[];
}
export interface Seal {
  seal_id: string; manifest: Manifest; manifest_hash: string;
  algorithm: 'exact-set-and-chain-v1'; status: 'SEALED';
}
export interface SessionView {
  session_id: string; admission_id: string; state: SessionState; writer_id: string | null;
  writer_epoch: number; lease_until: number; permit: {
    permit_id: string; scope: string; state: PermitState; instance_id: string;
  } | null; seals: Seal[]; completion: unknown;
}
export class ContractError extends Error {
  constructor(public code: string, public status = 400, public details: unknown = null) {
    super(code); this.name = 'ContractError';
  }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContractError('INVALID_OBJECT');
  return value as Record<string, unknown>;
}
export function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new ContractError('INVALID_ID');
  if(['__proto__','prototype','constructor','toString','toLocaleString','hasOwnProperty','isPrototypeOf','propertyIsEnumerable','valueOf','__defineGetter__','__defineSetter__','__lookupGetter__','__lookupSetter__'].includes(value))throw new ContractError('RESERVED_ID');
  return value;
}
export function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new ContractError('INVALID_HASH');
  return value;
}
export function integer(value: unknown, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) throw new ContractError('INVALID_INTEGER');
  return value as number;
}
export function eventRef(value: unknown): EventRef {
  const v = object(value); return { event_id: id(v.event_id), hash: hash(v.hash) };
}
export function parseEnvelope(raw: string): EventEnvelope {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new ContractError('INVALID_EVENT_JSON'); }
  const v = object(value);
  const fields = ['event_schema_version', 'event_id', 'session_id', 'protocol_version_id', 'writer_id',
    'writer_epoch', 'scope', 'sequence', 'previous', 'kind', 'clock_epoch', 'time_ms', 'payload'];
  if (Object.keys(v).some(key => !fields.includes(key))) throw new ContractError('UNKNOWN_EVENT_FIELD');
  const validJSON = (item: unknown, depth: number): boolean => {
    if (depth > 16) return false;
    if (typeof item === 'number') return Number.isFinite(item);
    if (item && typeof item === 'object') return Object.values(item).every(child => validJSON(child, depth + 1));
    return item === null || ['string', 'boolean'].includes(typeof item);
  };
  if (!validJSON(v.payload, 0)) throw new ContractError('INVALID_PAYLOAD_VALUE');
  if (v.event_schema_version !== CONTRACT_VERSION || v.protocol_version_id !== PROTOCOL.protocol_version_id)
    throw new ContractError('UNSUPPORTED_EVENT_VERSION');
  for (const name of ['event_id', 'session_id', 'writer_id', 'clock_epoch', 'scope']) id(v[name]);
  integer(v.writer_epoch, 1); integer(v.sequence);
  if (typeof v.time_ms !== 'number' || !Number.isFinite(v.time_ms) || v.time_ms < 0)
    throw new ContractError('INVALID_MONOTONIC_TIME');
  if (!['ANSWER_SNAPSHOT', 'TRIAL_INTENT', 'SOFTWARE_ONSET', 'WINDOW_CLOSED', 'TRIAL_ENDED'].includes(String(v.kind)))
    throw new ContractError('INVALID_EVENT_KIND');
  if (v.previous !== null) eventRef(v.previous);
  object(v.payload);
  return v as unknown as EventEnvelope;
}
export function parseManifest(value: unknown, maximum: number = LIMITS.scope_events): Manifest {
  const v = object(value);
  if (!Array.isArray(v.events) || v.events.length > maximum || !Array.isArray(v.path)
    || v.path.length > 60) throw new ContractError('INVALID_MANIFEST');
  const events = v.events.map(eventRef);
  if (new Set(events.map(e => e.event_id)).size !== events.length) throw new ContractError('DUPLICATE_MANIFEST_EVENT');
  return { manifest_id: id(v.manifest_id), scope: id(v.scope), events, path: v.path.map(id) };
}
// Manifest hashing has a defined serialization; raw event bytes are never canonicalized.
export function manifestText(manifest: Manifest): string { return JSON.stringify({manifest_id:manifest.manifest_id,scope:manifest.scope,
  events:manifest.events.map(({event_id,hash})=>({event_id,hash})),path:manifest.path}); }

```

### src/shared/lab-contract.ts L1–L49

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
  geometry?: { viewport:{width:number;height:number;dpr:number}; canvas:{x:number;y:number;width:number;height:number}; buttons:{choice:string;x:number;y:number;width:number;height:number}[] } }
export interface LabSession {
  session_id: string; study_id: string; admission_id: string; state: SessionState; writer_id: string | null; writer_epoch: number;
  lease_until: number; frozen: FrozenProtocol; answers: Record<string, Answer>; path: string[]; page_index: number; group_index: number;
  allocation: { allocation_id: string; variant_id: string; reservation_id: string } | null;
  permit: { permit_id: string; scope: string; group_id: string; plan: GroupPlan; state: string } | null;
  seals: Seal[]; completion: unknown; diagnostics: { code: string; scope: string | null }[];
  admission?:SessionAdmissionStatus;
  task_activity?:{last_seen:number;idle_timeout_ms:number;connection_timeout_ms:number}|null;
  reanswer?:{old_session_id:string;new_session_id:string;created_at:number}|null;
}
export interface SessionAdmissionStatus {status:'QUEUED'|'ACTIVE'|'EXPIRED'|'LEFT'|'ENDED';ticket_id:string|null;position:number;limit:number|null;poll_ms:number;lease_until:number;lease_remaining_ms:number;pinned:boolean}
export interface RunRecord { type: 'OP' | 'COMMIT' | 'ONSET' | 'WINDOW' | 'END' | 'INPUT' | 'CORRECTION' | 'CLOSING' | 'ABORT' | 'RATING' | 'RATING_INTENT' | 'RATING_CHANGE';
  value?:number; item?:number; values?:number[];
  at: number; instance_id?: string; operation?: ScheduleAudit; op_id?: string; evidence?: string; answer?: string | null;
  input_time?: number; pointer_id?: number; reason?: string; root_id?: string; unresolved?: boolean;
  processed_watermark?: number; draw_time?: number;clock_origin?:number;raf_time?:number }
export interface InputRecord extends RunRecord { type:'INPUT'; action:'down'|'up'|'cancel'; valid:boolean;
  choice:string|null; raw_timestamp:number; time_origin:number; pointer_type:string; x:number;y:number; key_code?:string; button?:number }
export interface TrialSelection {group_id:string;seed:GroupPlan['seed'];roots:Trial[];sampling:SamplingAudit}
export interface GroupReservation {reservation_id:string;variant_id:string;selection?:TrialSelection}
export function parseLabEvent(raw: string): LabEvent {
  let v: Record<string,unknown>; try { v = object(JSON.parse(raw)); } catch { throw new ContractError('INVALID_EVENT_JSON'); }
  const keys = ['event_schema_version','event_id','session_id','version_id','protocol_hash','writer_id','writer_epoch','scope','sequence','previous','clock_epoch','time_ms','kind','payload'];
  if (Object.keys(v).some(k => !keys.includes(k)) || v.event_schema_version !== LAB_SCHEMA
    || !['PAGE_REVISION','PAGE_SNAPSHOT','GROUP_RECORD','INPUT_DIAGNOSTIC'].includes(String(v.kind))) throw new ContractError('INVALID_EVENT_SCHEMA');
  for (const k of ['event_id','session_id','version_id','writer_id','scope','clock_epoch']) id(v[k]);
  integer(v.writer_epoch,1); integer(v.sequence); object(v.payload);
  if (v.previous !== null) eventRef(v.previous);
  if (typeof v.protocol_hash !== 'string' || !/^[a-f0-9]{64}$/.test(v.protocol_hash)
    || typeof v.time_ms !== 'number' || !Number.isFinite(v.time_ms) || v.time_ms < 0) throw new ContractError('INVALID_CLOCK_OR_HASH');
  const check = (x: unknown, depth: number): boolean => depth < 20 && (x === null || typeof x === 'string' || typeof x === 'boolean'
    || (typeof x === 'number' && Number.isFinite(x)) || (typeof x === 'object' && Object.values(x as object).every(y => check(y,depth+1))));
  if (!check(v.payload,0)) throw new ContractError('INVALID_PAYLOAD'); return v as unknown as LabEvent;
}
export interface LabReceipt extends Receipt {}

```

### src/shared/protocol.ts L1–L320

```
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
export interface Rating {prompt:string;labels:string[];items?:string[];age_prompt?:string;age_min?:number;age_max?:number}
export interface Trial { root_id: string; asset_id?: string; text?: string; category?: string; image_ms: number; isi_ms: number; correct: string | null;
  timing?: TimingDefaults; timing_general?: (keyof TimingDefaults)[]; feedback_ms?: number }
export interface Group { id: string; title: string; choices: string[]; repeats: number; trials: Trial[];
  rating?:Rating; sampling?:Sampling;
  timing_defaults?: TimingDefaults; ordering?: Ordering; response_keys?: Record<string,string>; feedback?: Feedback }