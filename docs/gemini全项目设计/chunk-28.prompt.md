全项目设计讨论，传输段 28，源码主题：P0诊断采集（源包 10/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

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

```

### src/server/collection-routes.ts L1–L60

```
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ContractError, LIMITS, PROTOCOL, CONTRACT_VERSION, id, object } from '../shared/contract.js';
import { digest, type Command } from './collection-store.js';
import { DatabaseWriter } from './writer.js';

export async function collectionRoutes(app: FastifyInstance, writer: DatabaseWriter) {
  const origins = new Set(process.env.PUBLIC_ORIGIN ? [new URL(process.env.PUBLIC_ORIGIN).origin] : []);
  const originFor = (request: FastifyRequest) => `${request.protocol}://${request.host}`;
  const receiving = new Map<string, number>(); let receivingBytes = 0;
  const release = (request: FastifyRequest) => {
    const charged = receiving.get(request.id);
    if (charged !== undefined) { receivingBytes -= charged; receiving.delete(request.id); }
  };
  app.addHook('onResponse', async request => { release(request); });
  app.addHook('onRequestAbort', async request => { release(request); });
  app.get('/api/p0/protocol', async () => ({ mode: 'TEST_ONLY', contract_version: CONTRACT_VERSION,
    protocol: PROTOCOL, protocol_hash: digest(JSON.stringify(PROTOCOL)), limits: LIMITS }));
  // Admission occurs before body parsing; parser buffers cannot bypass the RPC bound.
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/p0/') || request.method === 'GET') return;
    const origin = request.headers.origin;
    if (!origin || (origins.size ? !origins.has(origin) : origin !== originFor(request)))
      return reply.code(403).send({ code: 'ORIGIN_REJECTED', ingestion: 'NOT_INGESTED' });
    if (!request.headers['content-type']?.startsWith('application/json'))