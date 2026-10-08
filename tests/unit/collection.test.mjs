import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/server/database.ts';
import { CollectionStore, digest } from '../../src/server/collection-store.ts';
import { CONTRACT_VERSION, PROTOCOL } from '../../src/shared/contract.ts';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bpl-p0-')); const db = openDatabase(join(dir, 'db.sqlite'));
  let now = 1000; let fail = false;
  const store = new CollectionStore(db, () => now, () => { if (fail) throw new Error('INJECTED_ROLLBACK'); });
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const credential = digest('TEST_ONLY');
  const create = { request_id: randomUUID(), credential_hash: credential };
  const session = store.execute({ operation: 'create', data: create });
  const call = (operation, data = {}) => store.execute({ operation, session_id: session.session_id, credential_hash: credential, data });
  const claimed = call('claim', { request_id: randomUUID(), writer_id: 'writer-a' });
  const fence = { writer_id: 'writer-a', writer_epoch: claimed.writer_epoch };
  const wire = (changes = {}) => {
    const envelope = { event_schema_version: CONTRACT_VERSION, event_id: randomUUID(), session_id: session.session_id,
      protocol_version_id: PROTOCOL.protocol_version_id, ...fence, scope: PROTOCOL.page_id,
      sequence: 0, previous: null, kind: 'ANSWER_SNAPSHOT', clock_epoch: 'clock-a', time_ms: 10,
      payload: { component_check: '正常显示' }, ...changes };
    const raw = JSON.stringify(envelope); return { event_id: envelope.event_id, hash: digest(raw), raw };
  };
  const ingest = events => call('ingest', { batch_id: randomUUID(), events });
  const seal = (events, scope = PROTOCOL.page_id, requestId = randomUUID()) => call('seal', {
    request_id: requestId, ...fence, manifest: { manifest_id: `manifest-${scope}`, scope,
      events: events.map(({ event_id, hash }) => ({ event_id, hash })), path: [PROTOCOL.page_id] },
  });
  return { db, store, call, session, create, fence, wire, ingest, seal, setNow: v => { now = v; }, fail: v => { fail = v; } };
}
test('exact bytes survive retries/reopen; custody is stable and completion uses exact seals', t => {
  const f = fixture(t); const event = f.wire();
  // Noncanonical whitespace is deliberately retained.
  event.raw = ` ${event.raw}\n`; event.hash = digest(event.raw);
  const first = f.ingest([event]).receipts[0];
  assert.equal(first.disposition, 'ACCEPTED'); assert.deepEqual(f.ingest([event]).receipts[0], first);
  assert.equal(f.db.prepare('SELECT raw FROM p0_raw').get().raw.toString(), event.raw);
  assert.throws(() => f.db.prepare("UPDATE p0_raw SET raw=x'00'").run(), /immutable/);
  const missing = f.seal([{ event_id: 'missing', hash: digest('missing') }]);
  assert.equal(missing.status, 'WAITING'); assert.equal(missing.missing.length, 1);
  const seal = f.seal([event]); assert.equal(seal.status, 'SEALED');
  assert.equal(f.seal([event]).seal_id, seal.seal_id);
  const finalize = { request_id: 'finalize-a', ...f.fence, seal_ids: [seal.seal_id] };
  const done = f.call('finalize', finalize); assert.equal(done.status, 'COMPLETED');
  assert.deepEqual(f.call('finalize', finalize), done);
  assert.throws(() => f.call('terminate', { request_id: 'late-stop', reason: 'UNKNOWN_RUN' }), /SESSION_TERMINAL/);
  assert.throws(() => f.call('finalize', { ...finalize, seal_ids: [] }), /IDEMPOTENCY_CONFLICT/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM p0_request_conflicts').get().n, 1);
  const late = f.wire(); assert.equal(f.ingest([late]).receipts[0].reason, 'LATE_AFTER_SEAL');
  assert.equal(f.call('view').state, 'COMPLETED');
  assert.equal(f.call('view').seals[0].seal_id, seal.seal_id);
});
test('conflicting bytes have independent custody and block normal seal', t => {
  const f = fixture(t); const event = f.wire(); const normal = f.ingest([event]).receipts[0];
  const conflict = f.wire({ event_id: event.event_id, payload: { component_check: '需要检查' } });
  const quarantined = f.ingest([conflict]).receipts[0];
  assert.equal(quarantined.disposition, 'QUARANTINED'); assert.notEqual(quarantined.receipt_id, normal.receipt_id);
  assert.deepEqual(f.ingest([event]).receipts[0], normal);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM p0_raw').get().n, 2);
  assert.equal(f.seal([event]).status, 'WAITING');
});
test('whole-batch transport validation and injected failure roll back raw and receipts together', t => {
  const f = fixture(t); const event = f.wire();
  assert.throws(() => f.ingest([event, { ...f.wire(), hash: digest('wrong') }]), /HASH_OR_SIZE/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM p0_raw').get().n, 0);
  const nonfinite = f.wire(); nonfinite.raw = nonfinite.raw.replace('"正常显示"', '1e309'); nonfinite.hash = digest(nonfinite.raw);
  assert.throws(() => f.ingest([nonfinite]), /INVALID_PAYLOAD_VALUE/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM p0_raw').get().n, 0);
  f.fail(true); assert.throws(() => f.ingest([event]), /INJECTED_ROLLBACK/); f.fail(false);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM p0_raw').get().n, 0);
  assert.equal(f.call('receipts', { events: [event] }).receipts[0], null);
  assert.equal(f.ingest([event]).receipts[0].custody, 'PERSISTED');
});
test('paused admission still allows existing credentials, while new identities are blocked', t => {
  const f = fixture(t);
  f.store.execute({ operation: 'pause', data: { paused: true } });
  assert.deepEqual(f.store.execute({ operation: 'create', data: f.create }), f.session);
  assert.throws(() => f.store.execute({ operation: 'create', data: { ...f.create, request_id: randomUUID() } }), /ADMISSION_PAUSED/);
  assert.equal(f.ingest([f.wire()]).receipts[0].disposition, 'ACCEPTED');
});
test('out-of-order execution gets pending custody then a new disposition version', t => {
  const f = fixture(t); const answer = f.wire(); f.ingest([answer]); f.seal([answer]);
  const permit = f.call('permit', { request_id: 'permit-a', ...f.fence });
  const kinds = ['TRIAL_INTENT', 'SOFTWARE_ONSET', 'WINDOW_CLOSED', 'TRIAL_ENDED'];
  const events = [];
  for (let i = 0; i < kinds.length; i++) events.push(f.wire({ scope: permit.scope, sequence: i,
    previous: i ? { event_id: events[i - 1].event_id, hash: events[i - 1].hash } : null,
    kind: kinds[i], time_ms: i * 100, payload: { instance_id: permit.instance_id, permit_id: permit.permit_id } }));
  const pending = f.ingest([events[3], events[2], events[1]]).receipts;
  assert.ok(pending.every(r => r.disposition === 'RECEIVED_PENDING'));
  assert.equal(f.seal(events, permit.scope).status, 'WAITING');
  f.ingest([events[0]]);
  const current = f.call('receipts', { events }).receipts;
  assert.ok(current.every(r => r.disposition === 'ACCEPTED'));
  assert.equal(current[3].receipt_id, pending[0].receipt_id);
  assert.equal(current[3].disposition_version, pending[0].disposition_version + 1);
  assert.equal(f.seal(events, permit.scope).status, 'SEALED');
  assert.equal(f.call('view').permit.state, 'CLOSED_NORMAL');
});
test('unclosed permit blocks a second writer even after lease expiry; explicit unknown close is final', t => {
  const f = fixture(t); const answer = f.wire(); f.ingest([answer]); f.seal([answer]);
  f.call('permit', { request_id: 'permit-a', ...f.fence }); f.setNow(1_000_000);
  assert.throws(() => f.call('claim', { request_id: 'claim-b', writer_id: 'writer-b' }), /RUN_LOCKED/);
  assert.equal(f.call('view').state, 'ACTIVE');
  const stopped = f.call('terminate', { request_id: 'stop-a', reason: 'UNKNOWN_RUN' });
  assert.equal(stopped.state, 'TERMINATED'); assert.equal(stopped.permit.state, 'CLOSED_UNKNOWN');
  assert.throws(() => f.call('claim', { request_id: 'claim-b', writer_id: 'writer-b' }), /SESSION_TERMINAL/);
  const old = f.wire(); assert.equal(f.ingest([old]).receipts[0].disposition, 'RECEIVED_PENDING');
  const report = f.call('reconcile', { request_id: 'reconcile-a', manifest: {
    manifest_id: 'terminate-manifest', scope: PROTOCOL.page_id,
    events: [old, { event_id: 'lost', hash: digest('lost') }], path: [PROTOCOL.page_id],
  }, unknown: ['unknown-position'] });
  assert.equal(report.missing.length, 1); assert.equal(report.cleanup_allowed, false);
});
test('old writer data is preserved after a fenced takeover and cannot seal the current page', t => {
  const f = fixture(t); f.setNow(1_000_000);
  const current = f.call('claim', { request_id: 'takeover', writer_id: 'writer-b' });
  assert.equal(current.writer_epoch, 2);
  const old = f.wire(); assert.equal(f.ingest([old]).receipts[0].reason, 'HISTORICAL_RECONCILIATION_REQUIRED');
  assert.throws(() => f.seal([old]), /WRITER_FENCED/);
  assert.equal(f.db.prepare('SELECT raw FROM p0_raw').get().raw.toString(), old.raw);
});
test('session authorization rejects foreign bodies without persisting them', t => {
  const f = fixture(t);
  assert.throws(() => f.store.execute({ operation: 'view', session_id: f.session.session_id,
    credential_hash: digest('foreign'), data: {} }), /UNAUTHORIZED/);
  assert.throws(() => f.ingest([f.wire({ session_id: randomUUID() })]), /UNAUTHORIZED_EVENT/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM p0_raw').get().n, 0);
});
