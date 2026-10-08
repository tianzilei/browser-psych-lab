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
    if (!Array.isArray(data.events) || !data.events.length || data.events.length > LIMITS.batch_records) throw new ContractError('INVALID_BATCH');
    let bytes = 0;
    // Validate the entire transport and authorization before taking custody of ANY body.
    const items = data.events.map(value => {
      const v = object(value); const ref = eventRef(v);
      if (typeof v.raw !== 'string') throw new ContractError('INVALID_RAW');
      const raw = Buffer.from(v.raw, 'utf8'); bytes += raw.byteLength;
      if (raw.byteLength > LIMITS.event_bytes || bytes > LIMITS.batch_bytes || digest(raw) !== ref.hash)
        throw new ContractError('HASH_OR_SIZE_MISMATCH');
      const e = parseEnvelope(v.raw);
      if (e.session_id !== session.session_id || e.event_id !== ref.event_id) throw new ContractError('UNAUTHORIZED_EVENT', 403);
      const writer = this.get<{ writer_id: string }>('SELECT writer_id FROM p0_writers WHERE session_id=? AND epoch=?', session.session_id, e.writer_epoch);
      if (!writer || writer.writer_id !== e.writer_id || (e.scope !== PROTOCOL.page_id
        && !this.get('SELECT 1 FROM p0_permits WHERE session_id=? AND scope=? AND writer_epoch=?', session.session_id, e.scope, e.writer_epoch)))
        throw new ContractError('UNAUTHORIZED_EVENT_SCOPE', 403);
      return { ref, raw, e, text: v.raw };
    });
    for (const { ref, raw, e, text } of items) {
      if (this.custody(session.session_id, ref)) continue;
      const total = this.get<{ n: number }>('SELECT count(*) AS n FROM p0_raw WHERE session_id=? AND scope=?', session.session_id, e.scope)!.n;
      if (total >= LIMITS.scope_events) throw new ContractError('SCOPE_EVENT_LIMIT', 413);
      const existing = this.get<StoredEvent>('SELECT * FROM p0_events WHERE session_id=? AND event_id=?', session.session_id, e.event_id);
      const receipt = randomUUID();
      this.run('INSERT INTO p0_raw VALUES (?,?,?,?,?,?,?)', session.session_id, e.event_id, ref.hash, e.scope, receipt, raw, this.now());
      const [disposition, reason] = existing ? ['QUARANTINED', 'EVENT_ID_HASH_CONFLICT'] as const : this.semantic(session, e);
      this.run('INSERT INTO p0_dispositions VALUES (?,?,?,?)', receipt, 1, disposition, reason);
      if (!existing) this.run('INSERT INTO p0_events VALUES (?,?,?,?,?,?,?,?,?,?)', session.session_id, e.event_id, ref.hash, e.scope,
        text, e.sequence, e.writer_epoch, disposition, 1, reason);
      if (existing || disposition === 'QUARANTINED') {
        this.diagnostic(session.session_id, existing?.scope ?? e.scope, reason, ref);
      }
    }
    const scopes = [...new Set(items.map(i => i.e.scope))];
    for (const scope of scopes) {
      // Bounded chain walk promotes pending dependencies; historical raw never drives current answers.
      const events = this.all<StoredEvent>("SELECT * FROM p0_events WHERE session_id=? AND scope=? ORDER BY sequence", session.session_id, scope);
      for (const event of events) if (event.disposition === 'RECEIVED_PENDING') {
        const [state, reason] = this.semantic(session, parseEnvelope(event.envelope));
        this.dispose(session.session_id, event, state, reason);
      }
    }
    return { batch_id: data.batch_id, receipts: items.map(i => this.custody(session.session_id, i.ref)) };
  }
  execute(command: Command): unknown {
    const started = performance.now();
    const result = this.db.transaction(() => {
      const result = this.dispatch(command);
      this.beforeCommit?.();
      if (performance.now() - started > LIMITS.transaction_ms) throw new ContractError('TRANSACTION_BUDGET_EXCEEDED', 503);
      return result;
    }).immediate(); // The return leaves this function only after COMMIT succeeds.
    if (result instanceof CommittedRejection) throw result.error;
    return result;
  }
  private dispatch(command: Command): unknown {
    const d = object(command.data);
    if (command.operation === 'health') return { version: this.get<{ version: string }>('SELECT sqlite_version() AS version')!.version };
    if (command.operation === 'pause') {
      this.run("UPDATE p0_meta SET value=? WHERE key='admission'", d.paused ? 'PAUSED' : 'OPEN'); return { status: 'ok' };
    }
    if (command.operation === 'create') return this.request('admission', 'create', d, () => {
      const credential = hash(d.credential_hash);
      if (this.get<{ value: string }>("SELECT value FROM p0_meta WHERE key='admission'")!.value !== 'OPEN')
        throw new ContractError('ADMISSION_PAUSED', 409);
      const session = randomUUID();
      this.run('INSERT INTO p0_sessions(session_id,admission_id,credential_hash,state,created_at) VALUES (?,?,?,\'CREATED\',?)', session, randomUUID(), credential, this.now());
      return this.view(session);
    });
    const session = this.auth(command); const sid = session.session_id;
    switch (command.operation) {
      case 'view': return this.view(sid);
      case 'claim': return this.request(sid, 'claim', d, () => {
        const writer = id(d.writer_id);
        if (['COMPLETED', 'TERMINATED'].includes(session.state)) throw new ContractError('SESSION_TERMINAL', 409);
        const permit = this.get<{ state: string }>("SELECT state FROM p0_permits WHERE session_id=? AND state='ISSUED'", sid);
        if (session.writer_id !== writer && (permit || session.lease_until > this.now())) throw new ContractError('RUN_LOCKED', 409);
        const epoch = session.writer_id === writer ? session.writer_epoch : session.writer_epoch + 1;
        this.run("UPDATE p0_sessions SET writer_id=?,writer_epoch=?,lease_until=?,state='ACTIVE' WHERE session_id=?", writer, epoch, this.now() + 30_000, sid);
        this.run('INSERT OR IGNORE INTO p0_writers VALUES (?,?,?)', sid, epoch, writer); return this.view(sid);
      });
      case 'release': return this.request(sid, 'release', d, () => {
        this.active(session, d);
        if (this.get("SELECT 1 FROM p0_permits WHERE session_id=? AND state='ISSUED'", sid)) throw new ContractError('RUN_LOCKED', 409);
        this.run('UPDATE p0_sessions SET lease_until=0 WHERE session_id=?', sid); return { status: 'RELEASED' };
      });
      case 'permit': return this.request(sid, 'permit', d, () => {
        this.active(session, d);
        if (!this.get('SELECT 1 FROM p0_seals WHERE session_id=? AND scope=?', sid, PROTOCOL.page_id)) throw new ContractError('PAGE_NOT_SEALED', 409);
        if (this.get("SELECT 1 FROM p0_permits WHERE session_id=?", sid)) throw new ContractError('PERMIT_ALREADY_EXISTS', 409);
        const scope = `${PROTOCOL.group_id}-${randomUUID()}`;
        this.run("INSERT INTO p0_permits VALUES (?,?,?,?,?,'ISSUED')", randomUUID(), sid, scope, session.writer_epoch, randomUUID());
        return this.view(sid).permit;
      });
      case 'ingest': return this.ingest(session, d);
      case 'receipts': {
        if (!Array.isArray(d.events) || d.events.length > LIMITS.batch_records) throw new ContractError('INVALID_RECEIPT_QUERY');
        return { receipts: d.events.map(eventRef).map(ref => this.custody(sid, ref)) };
      }
      case 'seal': return this.request(sid, 'seal', d, () => {
        const manifest = parseManifest(d.manifest); const manifestHash = digest(manifestText(manifest));
        const prior = this.get<{ manifest_hash: string; response: string }>('SELECT * FROM p0_seals WHERE session_id=? AND scope=?', sid, manifest.scope);
        if (prior) {
          if (prior.manifest_hash !== manifestHash) throw new ContractError('SEAL_CONFLICT', 409);
          return JSON.parse(prior.response);
        }
        this.active(session, d);
        if (manifest.path.join('/') !== PROTOCOL.page_id) throw new ContractError('INVALID_PATH');
        const required = manifest.scope === PROTOCOL.page_id ? 1 : 4;
        const stored = this.all<StoredEvent>('SELECT * FROM p0_events WHERE session_id=? AND scope=? ORDER BY sequence', sid, manifest.scope);
        const received = new Map(stored.map(e => [e.event_id, e]));
        const missing = manifest.events.filter(e => received.get(e.event_id)?.hash !== e.hash);
        const extra = stored.filter(e => !manifest.events.some(ref => ref.event_id === e.event_id && ref.hash === e.hash)).map(e => e.event_id);
        const problems = stored.filter(e => e.disposition !== 'ACCEPTED' || e.writer_epoch !== session.writer_epoch).map(e => ({ event_id: e.event_id, reason: e.reason }));
        const diagnostics = this.all<{ code: string }>('SELECT code FROM p0_diagnostics WHERE session_id=? AND scope=?', sid, manifest.scope);
        if (missing.length || extra.length || problems.length || diagnostics.length || stored.length !== required)
          return { status: 'WAITING', missing, extra, problems, diagnostics, required_count: required };
        if (manifest.scope !== PROTOCOL.page_id && !this.get("SELECT 1 FROM p0_permits WHERE session_id=? AND scope=? AND state='ISSUED'", sid, manifest.scope))
          throw new ContractError('OUTSIDE_PERMIT', 409);
        const seal: Seal = { seal_id: randomUUID(), manifest, manifest_hash: manifestHash, algorithm: 'exact-set-and-chain-v1', status: 'SEALED' };
        this.run('INSERT INTO p0_seals VALUES (?,?,?,?,?)', sid, manifest.scope, seal.seal_id, manifestHash, JSON.stringify(seal));
        if (manifest.scope !== PROTOCOL.page_id) this.run("UPDATE p0_permits SET state='CLOSED_NORMAL' WHERE session_id=? AND scope=?", sid, manifest.scope);
        return seal;
      });
      case 'finalize': return this.request(sid, 'finalize', d, () => {
        this.active(session, d);
        if (!Array.isArray(d.seal_ids) || d.seal_ids.length > 2) throw new ContractError('INVALID_FINAL_MANIFEST');
        const seals = this.view(sid).seals;
        const permits = this.all<{ state: string }>('SELECT state FROM p0_permits WHERE session_id=?', sid);
        const sealIds = d.seal_ids.map(id);
        const exact = seals.length === sealIds.length && new Set(sealIds).size === seals.length
          && seals.every(s => sealIds.includes(s.seal_id));
        this.run("UPDATE p0_sessions SET state='FINALIZING' WHERE session_id=?", sid);
        if (!exact || !seals.some(s => s.manifest.scope === PROTOCOL.page_id) || permits.some(p => p.state !== 'CLOSED_NORMAL')
          || this.get('SELECT 1 FROM p0_diagnostics WHERE session_id=?', sid)) {
          this.run("UPDATE p0_sessions SET state='ACTIVE' WHERE session_id=?", sid);
          return { status: 'WAITING', reason: 'PATH_OR_INTEGRITY_NOT_CONFIRMED' };
        }
        const completion = { completion_id: randomUUID(), session_id: sid, seal_ids: d.seal_ids, status: 'COMPLETED' };
        this.run("UPDATE p0_sessions SET state='COMPLETED',completion=? WHERE session_id=?", JSON.stringify(completion), sid);
        return completion;
      });
      case 'terminate': return this.request(sid, 'terminate', d, () => {
        if (session.state === 'COMPLETED') throw new ContractError('SESSION_TERMINAL', 409);
        const reason = id(d.reason);
        this.run("UPDATE p0_sessions SET state='TERMINATED',lease_until=0 WHERE session_id=?", sid);
        this.run("UPDATE p0_permits SET state=? WHERE session_id=? AND state='ISSUED'", reason === 'UNKNOWN_RUN' ? 'CLOSED_UNKNOWN' : 'CLOSED_TERMINATED', sid);
        this.diagnostic(sid, null, reason, { request_id: d.request_id });
        return this.view(sid);
      });
      case 'reconcile': return this.request(sid, 'reconcile', d, () => {
        if (session.state !== 'TERMINATED') throw new ContractError('SESSION_NOT_TERMINATED', 409);
        const manifest = parseManifest(d.manifest);
        if (!Array.isArray(d.unknown) || d.unknown.length > LIMITS.scope_events) throw new ContractError('INVALID_UNKNOWN_POSITIONS');
        const unknown = d.unknown.map(id);
        const receipts = manifest.events.map(ref => this.custody(sid, ref));
        return { reconciliation_id: randomUUID(), manifest, receipts,
          missing: manifest.events.filter((_, i) => receipts[i] === null), unknown,
          // P0 never authorizes deletion: retention policy and independent backup are P1.
          cleanup_allowed: false, status: 'RECONCILED' };
      });
      default: throw new ContractError('UNKNOWN_OPERATION', 404);
    }
  }
}
