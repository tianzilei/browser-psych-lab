import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../../dist/server/collection-store.js';
import { CONTRACT_VERSION, PROTOCOL } from '../../dist/shared/contract.js';

test('whole-process crash preserves exact custody and unclosed permit; restart cannot grant a second run', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bpl-process-'));
  const path = join(directory, 'db.sqlite'); const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    await rm(directory, { recursive: true, force: true });
  });
  async function boot() {
    const child = fork(new URL('../fixtures/writer-process.mjs', import.meta.url), [path], { execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    children.push(child); assert.equal((await once(child, 'message'))[0].ready, true); return child;
  }
  async function call(child, command) {
    const received = once(child, 'message'); child.send({ command });
    const reply = (await received)[0]; return reply.error ? { error: reply.error } : reply.result;
  }
  const first = await boot(); const credential = digest('TEST_ONLY');
  const session = await call(first, { operation: 'create', data: { request_id: 'access', credential_hash: credential } });
  const cmd = (operation, data = {}) => ({ operation, session_id: session.session_id, credential_hash: credential, data });
  const writer = await call(first, cmd('claim', { request_id: 'writer', writer_id: 'writer-a' }));
  const fence = { writer_id: 'writer-a', writer_epoch: writer.writer_epoch };
  const envelope = { event_schema_version: CONTRACT_VERSION, event_id: 'answer', session_id: session.session_id,
    protocol_version_id: PROTOCOL.protocol_version_id, ...fence, scope: PROTOCOL.page_id, sequence: 0,
    previous: null, kind: 'ANSWER_SNAPSHOT', clock_epoch: 'clock', time_ms: 10, payload: { component_check: '正常显示' } };
  const raw = ` ${JSON.stringify(envelope)}\n`; const event = { event_id: 'answer', hash: digest(raw), raw };
  const received = await call(first, cmd('ingest', { batch_id: 'batch', events: [event] }));
  await call(first, cmd('seal', { request_id: 'seal', ...fence,
    manifest: { manifest_id: 'manifest', scope: PROTOCOL.page_id, events: [event], path: [PROTOCOL.page_id] } }));
  const permit = await call(first, cmd('permit', { request_id: 'permit', ...fence }));
  const exited = once(first, 'exit'); first.kill('SIGKILL'); await exited;
  const second = await boot();
  assert.deepEqual((await call(second, cmd('receipts', { events: [event] }))).receipts, received.receipts);
  const view = await call(second, cmd('view')); assert.equal(view.permit.permit_id, permit.permit_id);
  assert.equal(view.permit.state, 'ISSUED'); assert.equal(view.state, 'ACTIVE');
  assert.deepEqual(await call(second, cmd('claim', { request_id: 'second-writer', writer_id: 'writer-b' })), { error: 'RUN_LOCKED' });
  const closed = await call(second, cmd('terminate', { request_id: 'unknown-close', reason: 'UNKNOWN_RUN' }));
  assert.equal(closed.state, 'TERMINATED'); assert.equal(closed.permit.state, 'CLOSED_UNKNOWN');
});
