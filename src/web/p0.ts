import './style.css';
import { LocalStore } from './local-store.js';
import type { Receipt, Seal, SessionView } from '../shared/contract.js';

const status = document.querySelector<HTMLParagraphElement>('#status')!;
const evidence = document.querySelector<HTMLParagraphElement>('#evidence')!;
const form = document.querySelector<HTMLFormElement>('#questionnaire')!;
const retry = document.querySelector<HTMLButtonElement>('#retry')!;
const unknownClose = document.querySelector<HTMLButtonElement>('#unknown-close')!;
const writer = sessionStorage.getItem('p0-writer') ?? crypto.randomUUID();
sessionStorage.setItem('p0-writer', writer);
const clock = crypto.randomUUID();
let local: LocalStore; let session: SessionView; let ownsLock = false; let busy = false;
async function api<T>(path: string, data?: unknown): Promise<T> {
  const response = await fetch(path, data === undefined ? { signal: AbortSignal.timeout(10_000) } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json() as { code?: string };
  if (!response.ok) throw new Error(result.code ?? 'SAVE_FAILED');
  return result as T;
}
const path = (op = '') => `/api/p0/sessions/${session.session_id}${op ? `/${op}` : ''}`;
const fence = () => ({ writer_id: writer, writer_epoch: session.writer_epoch });
function failed(error: unknown) {
  form.hidden = true; retry.hidden = !ownsLock;
  const code = error instanceof Error ? error.message : 'SAVE_FAILED';
  status.textContent = code === 'RUN_LOCKED' ? '另一个页面持有运行权。此页只读，不能作答。'
    : '保存尚未完成。已提交的本地答案会保留，联网后可重试核对。';
  unknownClose.hidden = code !== 'RUN_LOCKED' || session?.permit?.state !== 'ISSUED';
  evidence.textContent = `状态：${code}`;
}
async function sync() {
  const state = await local.state();
  if (!state.submission) { form.hidden = false; retry.hidden = true; status.textContent = '可以作答。'; return; }
  form.hidden = true; retry.hidden = true; status.textContent = '答案已在本机保存，正在等待服务器确认…';
  for (;;) {
    const batch = await local.batch(); if (!batch.length) break;
    const result = await api<{ receipts: Receipt[] }>(path('ingest'), { batch_id: crypto.randomUUID(), events: batch });
    if (result.receipts.length !== batch.length || batch.some(e => !result.receipts.some(r => r.event_id === e.event_id && r.hash === e.hash)))
      throw new Error('RECEIPT_SET_MISMATCH');
    await local.acknowledge(result.receipts);
  }
  const sub = (await local.state()).submission!;
  const seal = sub.seal ?? await api<Seal>(path('seal'), { request_id: sub.seal_request_id, ...fence(), manifest: sub.manifest });
  await local.seal(seal);
  const completion = await api<{ status: string; completion_id: string }>(path('finalize'), {
    request_id: sub.finalize_request_id, ...fence(), seal_ids: [seal.seal_id],
  });
  if (completion.status !== 'COMPLETED') throw new Error('COMPLETION_NOT_CONFIRMED');
  session = await api<SessionView>(path()); await local.session(session);
  status.textContent = '保存完成，页面已封存。'; evidence.textContent = `完成凭证：${completion.completion_id}`;
}
async function restore() {
  const state = await local.state();
  // Replaying admission also restores the HttpOnly cookie; request and secret stay fixed.
  session = await api<SessionView>('/api/p0/sessions', { request_id: state.access_request_id, credential: state.credential });
  session = await api<SessionView>(path()); await local.session(session);
  if (session.state === 'COMPLETED') {
    if (state.submission && session.seals[0]) await local.seal(session.seals[0]);
    form.hidden = true; retry.hidden = true; status.textContent = '保存完成，页面已封存。'; return;
  }
  if (session.state === 'TERMINATED') {
    form.hidden = true; retry.hidden = true; status.textContent = '此会话已终止，不能继续作答。原始答案仍保留。'; return;
  }
  session = await api<SessionView>(path('claim'), { request_id: crypto.randomUUID(), writer_id: writer });
  await local.session(session); await sync();
}
async function run(action: () => Promise<void>) {
  if (busy) return; busy = true; retry.disabled = true;
  try { await action(); } catch (error) { failed(error); }
  finally { busy = false; retry.disabled = false; }
}
form.addEventListener('submit', event => {
  event.preventDefault();
  if (!ownsLock) return;
  const answer = new FormData(form).get('answer') as string;
  void run(async () => {
    form.hidden = true; await local.submit(session, writer, clock, answer); await sync();
  });
});
retry.addEventListener('click', () => { if (ownsLock) void run(restore); });
unknownClose.addEventListener('click', () => { void run(async () => {
  session = await api<SessionView>(path('terminate'), { request_id: crypto.randomUUID(), reason: 'UNKNOWN_RUN' });
  await local.session(session); unknownClose.hidden = true; status.textContent = '旧运行已关闭，会话已终止。';
}); });
window.addEventListener('online', () => { if (ownsLock) void run(restore); });
window.addEventListener('pagehide', () => {
  if (ownsLock && session?.state === 'ACTIVE' && session.permit?.state !== 'ISSUED') {
    void fetch(path('release'), { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: crypto.randomUUID(), ...fence() }), keepalive: true });
  }
});
try {
  if (!navigator.locks || !crypto.subtle) throw new Error('REQUIRED_CAPABILITY_UNAVAILABLE');
  await navigator.locks.request('browser-psych-lab-p0', { ifAvailable: true }, async lock => {
    local = await LocalStore.open();
    if (!lock) {
      const state = await local.state();
      if (state.session) { session = await api<SessionView>(`/api/p0/sessions/${state.session.session_id}`); }
      failed(new Error('RUN_LOCKED')); return;
    }
    ownsLock = true; await run(restore);
    await new Promise<void>(resolve => window.addEventListener('pagehide', () => { ownsLock = false; local.db.close(); resolve(); }, { once: true }));
  });
} catch (error) { failed(error); }
