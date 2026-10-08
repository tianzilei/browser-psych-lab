import { ContractError, eventRef, id, integer, object, type EventRef, type Receipt, type Seal, type SessionState } from './contract.js';
import { LAB_SCHEMA, type FrozenProtocol, type Answer, type Trial, type Protocol } from './protocol.js';
import type { ScheduleAudit } from './scheduler.js';
export interface LabEvent { event_schema_version: typeof LAB_SCHEMA; event_id: string; session_id: string; version_id: string;
  protocol_hash: string; writer_id: string; writer_epoch: number; scope: string; sequence: number; previous: EventRef | null;
  clock_epoch: string; time_ms: number; kind: 'PAGE_REVISION' | 'PAGE_SNAPSHOT' | 'GROUP_RECORD' | 'INPUT_DIAGNOSTIC'; payload: Record<string, unknown> }
export interface GroupPlan { group_id: string; scope: string; seed: [number,number,number,number]; roots: Trial[];
  choices: string[]; repeats: number; start: number; frame_ms: number; layout: string; budget: Protocol['budget']; plan_hash?: string;
  geometry?: { viewport:{width:number;height:number;dpr:number}; canvas:{x:number;y:number;width:number;height:number}; buttons:{choice:string;x:number;y:number;width:number;height:number}[] } }
export interface LabSession {
  session_id: string; study_id: string; admission_id: string; state: SessionState; writer_id: string | null; writer_epoch: number;
  lease_until: number; frozen: FrozenProtocol; answers: Record<string, Answer>; path: string[]; page_index: number; group_index: number;
  allocation: { allocation_id: string; variant_id: string; reservation_id: string } | null;
  permit: { permit_id: string; scope: string; group_id: string; plan: GroupPlan; state: string } | null;
  seals: Seal[]; completion: unknown; diagnostics: { code: string; scope: string | null }[];
  admission?:SessionAdmissionStatus;
}
export interface SessionAdmissionStatus {status:'QUEUED'|'ACTIVE'|'EXPIRED'|'LEFT'|'ENDED';ticket_id:string|null;position:number;limit:number;poll_ms:number;lease_until:number;lease_remaining_ms:number;pinned:boolean}
export interface RunRecord { type: 'OP' | 'COMMIT' | 'ONSET' | 'WINDOW' | 'END' | 'INPUT' | 'CORRECTION' | 'CLOSING' | 'ABORT';
  at: number; instance_id?: string; operation?: ScheduleAudit; op_id?: string; evidence?: string; answer?: string | null;
  input_time?: number; pointer_id?: number; reason?: string; root_id?: string; unresolved?: boolean;
  processed_watermark?: number; draw_time?: number;clock_origin?:number;raf_time?:number }
export interface InputRecord extends RunRecord { type:'INPUT'; action:'down'|'up'|'cancel'; valid:boolean;
  choice:string|null; raw_timestamp:number; time_origin:number; pointer_type:string; x:number;y:number }
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
