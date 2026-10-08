import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { CONTRACT_VERSION, LIMITS, PROTOCOL, manifestText, type EventEnvelope,
  type Manifest, type Receipt, type Seal, type SessionView, type WireEvent } from '../shared/contract.js';

interface LocalEvent extends WireEvent { session_id: string; scope: string; receipt: Receipt | null }
export interface Submission { event: WireEvent; manifest: Manifest; seal_request_id: string; finalize_request_id: string; seal: Seal | null }
export interface LocalState { access_request_id: string; credential: string; session: SessionView | null; submission: Submission | null }
interface LocalSchema extends DBSchema {
  events: { key: string; value: LocalEvent };
  outbox: { key: string; value: WireEvent };
  meta: { key: string; value: LocalState };
}
export async function sha256(text: string) {
  const bytes = new TextEncoder().encode(text);
  const result = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
}
export class LocalStore {
  constructor(readonly db: IDBPDatabase<LocalSchema>) {}
  static async open(name = 'browser-psych-lab-p0-v1') {
    return new LocalStore(await openDB<LocalSchema>(name, 1, { upgrade(db) {
      db.createObjectStore('events', { keyPath: 'event_id' });
      db.createObjectStore('outbox', { keyPath: 'event_id' }); db.createObjectStore('meta');
    } }));
  }
  async state(): Promise<LocalState> {
    const prior = await this.db.get('meta', 'state');
    if (prior) return prior;
    const state: LocalState = { access_request_id: crypto.randomUUID(),
      credential: Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join(''),
      session: null, submission: null };
    await this.db.add('meta', state, 'state'); return state;
  }
  async session(session: SessionView) {
    const tx = this.db.transaction('meta', 'readwrite', { durability: 'strict' });
    const state = (await tx.store.get('state'))!; state.session = session;
    await tx.store.put(state, 'state'); await tx.done;
  }
  async submit(session: SessionView, writer: string, clock: string, answer: string, injectAbort = false) {
    const e: EventEnvelope = { event_schema_version: CONTRACT_VERSION, event_id: crypto.randomUUID(),
      session_id: session.session_id, protocol_version_id: PROTOCOL.protocol_version_id,
      writer_id: writer, writer_epoch: session.writer_epoch, scope: PROTOCOL.page_id, sequence: 0,
      previous: null, kind: 'ANSWER_SNAPSHOT', clock_epoch: clock, time_ms: performance.now(),
      payload: { [PROTOCOL.question_id]: answer } };
    // Encoding and hashing happen exactly once, before the IDB transaction opens.
    const raw = JSON.stringify(e); const event = { event_id: e.event_id, hash: await sha256(raw), raw };
    const submission: Submission = { event, manifest: { manifest_id: crypto.randomUUID(), scope: PROTOCOL.page_id,
      events: [{ event_id: event.event_id, hash: event.hash }], path: [PROTOCOL.page_id] },
      seal_request_id: crypto.randomUUID(), finalize_request_id: crypto.randomUUID(), seal: null };
    const tx = this.db.transaction(['events', 'outbox', 'meta'], 'readwrite', { durability: 'strict' });
    try {
      const state = (await tx.objectStore('meta').get('state'))!;
      if (state.submission) throw new Error('PAGE_ALREADY_PENDING');
      await tx.objectStore('events').add({ ...event, session_id: session.session_id, scope: e.scope, receipt: null });
      await tx.objectStore('outbox').add(event); state.submission = submission;
      await tx.objectStore('meta').put(state, 'state');
      if (injectAbort) tx.abort();
      await tx.done; return submission;
    } catch (error) { try { tx.abort(); } catch {} await tx.done.catch(() => {}); throw error; }
  }
  async batch() {
    const tx = this.db.transaction('outbox');
    const batch: WireEvent[] = []; let bytes = 0;
    let cursor = await tx.store.openCursor();
    while (cursor && batch.length < LIMITS.batch_records) {
      const size = new TextEncoder().encode(cursor.value.raw).byteLength;
      if (bytes + size > LIMITS.batch_bytes) break;
      batch.push(cursor.value); bytes += size; cursor = await cursor.continue();
    }
    await tx.done; return batch;
  }
  async acknowledge(receipts: Receipt[]) {
    const tx = this.db.transaction(['events', 'outbox'], 'readwrite', { durability: 'strict' });
    try {
      for (const receipt of receipts) {
        const event = await tx.objectStore('events').get(receipt.event_id);
        if (!event || event.hash !== receipt.hash || event.scope !== receipt.scope || receipt.custody !== 'PERSISTED'
          || !['ACCEPTED', 'RECEIVED_PENDING', 'QUARANTINED'].includes(receipt.disposition)
          || !receipt.receipt_id || !Number.isInteger(receipt.disposition_version) || receipt.disposition_version < 1)
          throw new Error('RECEIPT_MISMATCH');
        event.receipt = receipt;
        await tx.objectStore('events').put(event); await tx.objectStore('outbox').delete(event.event_id);
      }
      // Raw events stay retained even when custody stops network retries.
      await tx.done;
    } catch (error) { try { tx.abort(); } catch {} await tx.done.catch(() => {}); throw error; }
  }
  async seal(seal: Seal) {
    const state = await this.state(); const submission = state.submission;
    if (!submission || seal.status !== 'SEALED' || seal.algorithm !== 'exact-set-and-chain-v1'
      || manifestText(submission.manifest) !== manifestText(seal.manifest)
      || seal.manifest_hash !== await sha256(manifestText(submission.manifest))) throw new Error('SEAL_MISMATCH');
    const tx = this.db.transaction('meta', 'readwrite', { durability: 'strict' });
    const latest = (await tx.store.get('state'))!;
    if (latest.submission?.seal_request_id !== submission.seal_request_id) { tx.abort(); await tx.done.catch(() => {}); throw new Error('LOCAL_VERSION_FORK'); }
    latest.submission.seal = seal; await tx.store.put(latest, 'state'); await tx.done;
  }
}
