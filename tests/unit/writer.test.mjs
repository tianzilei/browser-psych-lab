import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseWriter } from '../../dist/server/writer.js';
import { digest } from '../../dist/server/collection-store.js';
import { openDatabase } from '../../dist/server/database.js';

async function fixture(t, options) {
  const directory = await mkdtemp(join(tmpdir(), 'bpl-worker-')); const path = join(directory, 'db.sqlite');
  const writer = new DatabaseWriter(path, options);
  t.after(async () => { await writer.close(); await rm(directory, { force: true, recursive: true }); });
  await writer.start(); return { writer, path };
}
test('single worker commits then acknowledges and rejects a second process owner', async t => {
  const { writer, path } = await fixture(t);
  const data = { request_id: 'create', credential_hash: digest('TEST_ONLY') };
  const session = await writer.request({ operation: 'create', data });
  assert.deepEqual(await writer.request({ operation: 'create', data }), session);
  const second = new DatabaseWriter(path); await assert.rejects(second.start(), /DATABASE_ALREADY_OWNED/);
  await second.waitForExit(); await second.close();
  assert.equal(writer.stats().in_flight, 0);
});
test('bounded queues distinguish never sent from an unknown commit and preserve identities on restart', async t => {
  const { writer, path } = await fixture(t, {
    workerUrl: new URL('../fixtures/stalled-worker.mjs', import.meta.url), workerData: { delay_ms: 500 },
    maxRequests: 3, maxBytes: 4096, controlReserve: 1, timeoutMs: 1000,
  });
  // Use a shorter RPC timeout after startup, which otherwise depends on machine load.
  writer.options.timeoutMs = 150;
  const data = { request_id: 'committed-with-lost-ack', credential_hash: digest('TEST_ONLY') };
  const sent = writer.request({ operation: 'create', data }, false).catch(e => e);
  const queued = writer.request({ operation: 'health', data: {} }, false).catch(e => e);
  const control = writer.request({ operation: 'health', data: {} }, true).catch(e => e);
  await assert.rejects(writer.request({ operation: 'health', data: {} }), e => e.ingestion === 'NOT_INGESTED' && e.code === 'QUEUE_FULL');
  assert.equal(writer.stats().in_flight, 1); assert.equal(writer.stats().queued, 2);
  const [sentError, queuedError, controlError] = await Promise.all([sent, queued, control]);
  assert.equal(sentError.ingestion, 'UNKNOWN'); assert.equal(queuedError.ingestion, 'NOT_INGESTED');
  assert.equal(controlError.ingestion, 'NOT_INGESTED');
  await writer.waitForExit();
  const db = openDatabase(path);
  let original;
  try { original = db.prepare('SELECT session_id FROM p0_sessions').get().session_id; } finally { db.close(); }
  writer.options.workerUrl = new URL('../../dist/server/db-worker.js', import.meta.url); writer.options.timeoutMs = 1000;
  await writer.start();
  assert.equal((await writer.request({ operation: 'create', data })).session_id, original);
});
test('byte budget rejects an oversized request before any RPC', async t => {
  const { writer } = await fixture(t, { maxBytes: 100 });
  await assert.rejects(writer.request({ operation: 'create', data: { huge: 'x'.repeat(200) } }), e => e.ingestion === 'NOT_INGESTED');
  assert.equal(writer.stats().in_flight, 0);
});
