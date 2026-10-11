全项目设计讨论，传输段 27，源码主题：P0诊断采集（源包 10/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

### src/server/collection-store.ts L1–L351

```
import type Database from 'better-sqlite3';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ContractError, LIMITS, PROTOCOL, eventRef, hash, id, integer, manifestText,
  object, parseEnvelope, parseManifest, type EventEnvelope, type Receipt, type Seal,
  type SessionState, type SessionView } from '../shared/contract.js';

export const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
class CommittedRejection { constructor(readonly error: ContractError) {} }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k =>
    `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export interface Command { operation: string; session_id?: string; credential_hash?: string; data: Record<string, unknown> }
interface SessionRow {
  session_id: string; admission_id: string; credential_hash: string; state: SessionState;
  writer_id: string | null; writer_epoch: number; lease_until: number; completion: string | null;
}
interface StoredEvent {
  event_id: string; hash: string; scope: string; envelope: string; sequence: number;
  writer_epoch: number; disposition: Receipt['disposition']; version: number; reason: string;
}
const schema = `
CREATE TABLE IF NOT EXISTS p0_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
INSERT OR IGNORE INTO p0_meta VALUES ('schema','1'), ('admission','OPEN');
CREATE TABLE IF NOT EXISTS p0_sessions (
 session_id TEXT PRIMARY KEY, admission_id TEXT UNIQUE NOT NULL, credential_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('CREATED','ACTIVE','FINALIZING','COMPLETED','TERMINATED')),
 writer_id TEXT, writer_epoch INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
 completion TEXT, created_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS p0_writers (
 session_id TEXT NOT NULL REFERENCES p0_sessions, epoch INTEGER NOT NULL, writer_id TEXT NOT NULL,
 PRIMARY KEY(session_id,epoch)) STRICT;
CREATE TABLE IF NOT EXISTS p0_requests (
 subject TEXT NOT NULL, operation TEXT NOT NULL, request_id TEXT NOT NULL, hash TEXT NOT NULL,
 response TEXT, PRIMARY KEY(subject,operation,request_id)) STRICT;
CREATE TABLE IF NOT EXISTS p0_request_conflicts (
 subject TEXT NOT NULL, operation TEXT NOT NULL, request_id TEXT NOT NULL, existing_hash TEXT NOT NULL,
 incoming_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(subject,operation,request_id,incoming_hash)) STRICT;
CREATE TABLE IF NOT EXISTS p0_permits (
 permit_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES p0_sessions, scope TEXT NOT NULL,
 writer_epoch INTEGER NOT NULL, instance_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('ISSUED','CLOSED_NORMAL','CLOSED_TERMINATED','CLOSED_UNKNOWN')),
 UNIQUE(session_id,scope)) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS p0_one_permit ON p0_permits(session_id) WHERE state='ISSUED';
CREATE TABLE IF NOT EXISTS p0_raw (
 session_id TEXT NOT NULL REFERENCES p0_sessions, event_id TEXT NOT NULL, hash TEXT NOT NULL,
 scope TEXT NOT NULL, receipt_id TEXT UNIQUE NOT NULL, raw BLOB NOT NULL, received_at INTEGER NOT NULL,
 PRIMARY KEY(session_id,event_id,hash)) STRICT;
CREATE TABLE IF NOT EXISTS p0_events (
 session_id TEXT NOT NULL REFERENCES p0_sessions, event_id TEXT NOT NULL, hash TEXT NOT NULL,
 scope TEXT NOT NULL, envelope TEXT NOT NULL, sequence INTEGER NOT NULL, writer_epoch INTEGER NOT NULL,
 disposition TEXT NOT NULL CHECK(disposition IN ('ACCEPTED','RECEIVED_PENDING','QUARANTINED')),
 version INTEGER NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(session_id,event_id),
 FOREIGN KEY(session_id,event_id,hash) REFERENCES p0_raw(session_id,event_id,hash)) STRICT;
CREATE INDEX IF NOT EXISTS p0_scope ON p0_events(session_id,scope,sequence);
CREATE TABLE IF NOT EXISTS p0_dispositions (
 receipt_id TEXT NOT NULL REFERENCES p0_raw(receipt_id), version INTEGER NOT NULL,
 disposition TEXT NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(receipt_id,version)) STRICT;
CREATE TABLE IF NOT EXISTS p0_seals (
 session_id TEXT NOT NULL REFERENCES p0_sessions, scope TEXT NOT NULL, seal_id TEXT UNIQUE NOT NULL,
 manifest_hash TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(session_id,scope)) STRICT;
CREATE TABLE IF NOT EXISTS p0_diagnostics (
 diagnostic_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES p0_sessions, scope TEXT,
 code TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
CREATE TRIGGER IF NOT EXISTS p0_raw_no_update BEFORE UPDATE ON p0_raw BEGIN SELECT RAISE(ABORT,'immutable raw'); END;
CREATE TRIGGER IF NOT EXISTS p0_raw_no_delete BEFORE DELETE ON p0_raw BEGIN SELECT RAISE(ABORT,'immutable raw'); END;
CREATE TRIGGER IF NOT EXISTS p0_envelope_no_update BEFORE UPDATE OF session_id,event_id,hash,scope,envelope,sequence,writer_epoch ON p0_events
 BEGIN SELECT RAISE(ABORT,'immutable envelope'); END;
CREATE TRIGGER IF NOT EXISTS p0_seal_no_update BEFORE UPDATE ON p0_seals BEGIN SELECT RAISE(ABORT,'immutable seal'); END;
CREATE TRIGGER IF NOT EXISTS p0_seal_no_delete BEFORE DELETE ON p0_seals BEGIN SELECT RAISE(ABORT,'immutable seal'); END;
CREATE TRIGGER IF NOT EXISTS p0_history_no_update BEFORE UPDATE ON p0_dispositions BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER IF NOT EXISTS p0_history_no_delete BEFORE DELETE ON p0_dispositions BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER IF NOT EXISTS p0_terminal BEFORE UPDATE OF state ON p0_sessions
 WHEN OLD.state IN ('COMPLETED','TERMINATED') AND NEW.state<>OLD.state
 BEGIN SELECT RAISE(ABORT,'irreversible session'); END;
CREATE TRIGGER IF NOT EXISTS p0_closed_permit BEFORE UPDATE OF state ON p0_permits
 WHEN OLD.state<>'ISSUED' AND NEW.state<>OLD.state BEGIN SELECT RAISE(ABORT,'irreversible permit'); END;
`;
export class CollectionStore {
  constructor(readonly db: Database.Database, private now = Date.now,
    private beforeCommit: (() => void) | null = null) {
    db.exec(schema);
    if (this.get<{ value: string }>('SELECT value FROM p0_meta WHERE key=?', 'schema')?.value !== '1')
      throw new Error('UNSUPPORTED_P0_DATABASE');
    const frozen = JSON.stringify(PROTOCOL);
    db.prepare("INSERT OR IGNORE INTO p0_meta VALUES ('frozen_protocol',?)").run(frozen);
    if (this.get<{ value: string }>("SELECT value FROM p0_meta WHERE key='frozen_protocol'")?.value !== frozen)
      throw new Error('FROZEN_PROTOCOL_MISMATCH');
  }
  private get<T>(sql: string, ...args: unknown[]): T | undefined { return this.db.prepare(sql).get(...args) as T | undefined; }
  private all<T>(sql: string, ...args: unknown[]): T[] { return this.db.prepare(sql).all(...args) as T[]; }
  private run(sql: string, ...args: unknown[]) { return this.db.prepare(sql).run(...args); }
  private diagnostic(session: string, scope: string | null, code: string, detail: unknown) {
    this.run('INSERT INTO p0_diagnostics VALUES (?,?,?,?,?,?)', randomUUID(), session, scope, code, JSON.stringify(detail), this.now());
  }
  private request(subject: string, operation: string, data: Record<string, unknown>, action: () => unknown): unknown {
    const requestId = id(data.request_id); const requestHash = digest(canonical(data));
    const prior = this.get<{ hash: string; response: string | null }>(
      'SELECT hash,response FROM p0_requests WHERE subject=? AND operation=? AND request_id=?', subject, operation, requestId);
    if (prior) {
      if (prior.hash !== requestHash) {
        this.run('INSERT OR IGNORE INTO p0_request_conflicts VALUES (?,?,?,?,?,?)', subject, operation,
          requestId, prior.hash, requestHash, this.now());
        return new CommittedRejection(new ContractError('IDEMPOTENCY_CONFLICT', 409));
      }
      if (prior.response !== null) return JSON.parse(prior.response);
    } else this.run('INSERT INTO p0_requests VALUES (?,?,?,?,NULL)', subject, operation, requestId, requestHash);
    const result = action();
    if (object(result).status !== 'WAITING') this.run(
      'UPDATE p0_requests SET response=? WHERE subject=? AND operation=? AND request_id=?', JSON.stringify(result), subject, operation, requestId);
    return result;
  }
  private auth(command: Command): SessionRow {
    const session = this.get<SessionRow>('SELECT * FROM p0_sessions WHERE session_id=?', id(command.session_id));
    if (!session || typeof command.credential_hash !== 'string' || command.credential_hash.length !== 64
      || !timingSafeEqual(Buffer.from(session.credential_hash), Buffer.from(command.credential_hash)))
      throw new ContractError('UNAUTHORIZED', 401);
    return session;
  }
  private active(session: SessionRow, data: Record<string, unknown>) {
    if (session.state === 'TERMINATED' || session.state === 'COMPLETED') throw new ContractError('SESSION_TERMINAL', 409);
    if (session.writer_id !== id(data.writer_id) || session.writer_epoch !== integer(data.writer_epoch, 1))
      throw new ContractError('WRITER_FENCED', 409);
  }
  private view(sessionId: string): SessionView {
    const session = this.get<SessionRow>('SELECT * FROM p0_sessions WHERE session_id=?', sessionId)!;
    const permit = this.get<SessionView['permit']>('SELECT permit_id,scope,state,instance_id FROM p0_permits WHERE session_id=? ORDER BY rowid DESC LIMIT 1', sessionId) ?? null;
    const seals = this.all<{ response: string }>('SELECT response FROM p0_seals WHERE session_id=? ORDER BY rowid', sessionId).map(r => JSON.parse(r.response) as Seal);
    return { session_id: sessionId, admission_id: session.admission_id, state: session.state, writer_id: session.writer_id,
      writer_epoch: session.writer_epoch, lease_until: session.lease_until, permit, seals,
      completion: session.completion === null ? null : JSON.parse(session.completion) };
  }
  private custody(session: string, ref: { event_id: string; hash: string }): Receipt | null {
    const raw = this.get<{ scope: string; receipt_id: string }>('SELECT scope,receipt_id FROM p0_raw WHERE session_id=? AND event_id=? AND hash=?', session, ref.event_id, ref.hash);
    if (!raw) return null;
    const current = this.get<{ version: number; disposition: Receipt['disposition']; reason: string }>(
      'SELECT * FROM p0_dispositions WHERE receipt_id=? ORDER BY version DESC LIMIT 1', raw.receipt_id)!;
    return { ...ref, ...raw, custody: 'PERSISTED', disposition: current.disposition,
      disposition_version: current.version, reason: current.reason };
  }
  private dispose(session: string, event: StoredEvent, disposition: Receipt['disposition'], reason: string) {
    if (event.disposition === disposition && event.reason === reason) return;
    const version = event.version + 1;
    const receipt = this.custody(session, event)!;
    this.run('INSERT INTO p0_dispositions VALUES (?,?,?,?)', receipt.receipt_id, version, disposition, reason);
    this.run('UPDATE p0_events SET disposition=?,version=?,reason=? WHERE session_id=? AND event_id=?', disposition, version, reason, session, event.event_id);
  }
  private semantic(session: SessionRow, e: EventEnvelope): [Receipt['disposition'], string] {
    if (session.state === 'TERMINATED' || e.writer_epoch !== session.writer_epoch || e.writer_id !== session.writer_id)
      return ['RECEIVED_PENDING', 'HISTORICAL_RECONCILIATION_REQUIRED'];
    if (session.state === 'COMPLETED' || this.get('SELECT 1 FROM p0_seals WHERE session_id=? AND scope=?', session.session_id, e.scope))
      return ['QUARANTINED', 'LATE_AFTER_SEAL'];
    if (e.scope === PROTOCOL.page_id) {
      if (e.kind !== 'ANSWER_SNAPSHOT' || e.sequence !== 0 || e.previous !== null
        || Object.keys(e.payload).length !== 1 || !PROTOCOL.choices.includes(e.payload[PROTOCOL.question_id] as never))
        return ['QUARANTINED', 'INVALID_ANSWER_SNAPSHOT'];
    } else {
      const permit = this.get<{ instance_id: string; writer_epoch: number; state: string }>(
        'SELECT * FROM p0_permits WHERE session_id=? AND scope=?', session.session_id, e.scope);
      if (!permit || permit.writer_epoch !== e.writer_epoch || permit.state !== 'ISSUED') return ['QUARANTINED', 'OUTSIDE_PERMIT'];
      const kinds = ['TRIAL_INTENT', 'SOFTWARE_ONSET', 'WINDOW_CLOSED', 'TRIAL_ENDED'];
      if (kinds[e.sequence] !== e.kind || e.payload.instance_id !== permit.instance_id
        || e.payload.permit_id !== this.view(session.session_id).permit?.permit_id)
        return ['QUARANTINED', 'INVALID_EXECUTION_POSITION'];
    }
    if ((e.sequence === 0) !== (e.previous === null)) return ['QUARANTINED', 'INVALID_CHAIN_START'];
    if (e.previous) {
      const parent = this.get<StoredEvent>('SELECT * FROM p0_events WHERE session_id=? AND event_id=?', session.session_id, e.previous.event_id);
      if (!parent) return ['RECEIVED_PENDING', 'MISSING_PREDECESSOR'];
      const previous = parseEnvelope(parent.envelope);
      if (parent.hash !== e.previous.hash || parent.scope !== e.scope || parent.writer_epoch !== e.writer_epoch
        || parent.sequence !== e.sequence - 1 || previous.clock_epoch !== e.clock_epoch || previous.time_ms > e.time_ms)
        return ['QUARANTINED', 'INVALID_PREDECESSOR_OR_CLOCK'];
      if (parent.disposition !== 'ACCEPTED') return ['RECEIVED_PENDING', 'PREDECESSOR_NOT_ACCEPTED'];
    }
    const duplicate = this.get('SELECT 1 FROM p0_events WHERE session_id=? AND scope=? AND writer_epoch=? AND sequence=? AND event_id<>?',
      session.session_id, e.scope, e.writer_epoch, e.sequence, e.event_id);
    if (duplicate) return ['QUARANTINED', 'DUPLICATE_POSITION'];
    return ['ACCEPTED', 'VALID'];
  }
  private ingest(session: SessionRow, data: Record<string, unknown>) {
    id(data.batch_id);