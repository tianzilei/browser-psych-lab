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
