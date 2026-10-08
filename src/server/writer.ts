import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { LIMITS } from '../shared/contract.js';
import type { Command } from './collection-store.js';

export class WriterError extends Error {
  constructor(public code: string, public status: number, public ingestion: 'NOT_INGESTED' | 'UNKNOWN', public details: unknown = null) {
    super(code);
  }
}
interface Item { id: number; command: Command; bytes: number; control: boolean;
  resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }
export interface WriterOptions { maxRequests?: number; maxBytes?: number; controlReserve?: number;
  timeoutMs?: number; workerUrl?: URL; workerData?: Record<string, unknown> }
export class DatabaseWriter {
  private worker: Worker | null = null;
  private current: Item | null = null;
  private queue: Item[] = [];
  private bytes = 0;
  private sequence = 0;
  private controlTurns = 0;
  private available = false;
  private closed = false;
  private exitObserved = true;
  private exitPromise: Promise<void> = Promise.resolve();
  private owner = randomUUID();
  constructor(private path: string, private options: WriterOptions = {}) {}
  async start() {
    if (this.closed || !this.exitObserved) throw new Error('OLD_WRITER_NOT_EXITED');
    const source = import.meta.url.endsWith('.ts');
    const worker = new Worker(this.options.workerUrl ?? new URL(source ? './db-worker.ts' : './db-worker.js', import.meta.url), {
      workerData: { ...this.options.workerData, path: this.path, owner: this.owner },
      ...(source ? { execArgv: ['--import', 'tsx'] } : {}),
    });
    this.worker = worker; this.exitObserved = false;
    this.exitPromise = new Promise(resolve => worker.once('exit', () => {
      this.exitObserved = true; this.available = false;
      this.fail(new WriterError('WRITER_EXITED', 503, 'UNKNOWN')); resolve();
    }));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new WriterError('WRITER_START_TIMEOUT', 503, 'NOT_INGESTED')); void worker.terminate();
      }, this.options.timeoutMs ?? LIMITS.rpc_timeout_ms);
      worker.once('error', error => { clearTimeout(timer); reject(error); this.fail(new WriterError('WRITER_FAILED', 503, 'UNKNOWN')); });
      worker.once('exit', () => { clearTimeout(timer); reject(new Error('WRITER_START_FAILED')); });
      worker.on('message', (message: { ready?: boolean; id?: number; result?: unknown;
        error?: { code: string; status: number; ingestion: 'NOT_INGESTED' | 'UNKNOWN'; details: unknown } }) => {
        if (message.ready) { clearTimeout(timer); this.available = true; resolve(); this.pump(); return; }
        const current = this.current;
        if (!current || message.id !== current.id) return;
        clearTimeout(current.timer); this.current = null; this.bytes -= current.bytes;
        if (message.error) current.reject(new WriterError(message.error.code, message.error.status, message.error.ingestion, message.error.details));
        else current.resolve(message.result);
        this.pump();
      });
    });
  }
  stats() { return { ready: this.available, queued: this.queue.length, in_flight: this.current ? 1 : 0, bytes: this.bytes }; }
  request(command: Command, control = true): Promise<unknown> {
    if (!this.available || this.closed) return Promise.reject(new WriterError('WRITER_UNAVAILABLE', 503, 'NOT_INGESTED'));
    const bytes = Buffer.byteLength(JSON.stringify(command), 'utf8') * 2; // Include transport + clone allowance.
    const max = this.options.maxRequests ?? LIMITS.queue_requests;
    const reserve = this.options.controlReserve ?? LIMITS.control_reserve;
    const count = this.queue.length + (this.current ? 1 : 0);
    const maxBytes = this.options.maxBytes ?? LIMITS.queue_bytes;
    const byteBudget = control ? maxBytes : Math.floor(maxBytes * (max - reserve) / max);
    if (count >= (control ? max : max - reserve) || this.bytes + bytes > byteBudget)
      return Promise.reject(new WriterError('QUEUE_FULL', 503, 'NOT_INGESTED'));
    return new Promise((resolve, reject) => {
      this.bytes += bytes;
      this.queue.push({ id: ++this.sequence, command, bytes, control, resolve, reject }); this.pump();
    });
  }
  private pump() {
    if (!this.available || this.current || !this.worker || !this.queue.length) return;
    // At most two control turns before a bulk turn; FIFO within either class.
    const bulk = this.queue.findIndex(i => !i.control);
    const control = this.queue.findIndex(i => i.control);
    const index = control >= 0 && (this.controlTurns < 2 || bulk < 0) ? control : bulk >= 0 ? bulk : 0;
    const item = this.queue.splice(index, 1)[0]!;
    this.controlTurns = item.control ? this.controlTurns + 1 : 0; this.current = item;
    item.timer = setTimeout(() => {
      this.available = false;
      this.fail(new WriterError('WRITER_TIMEOUT', 503, 'UNKNOWN'));
      // No replacement is spawned here. terminate resolves only after native code exits.
      void this.worker?.terminate();
    }, this.options.timeoutMs ?? LIMITS.rpc_timeout_ms);
    try { this.worker.postMessage({ id: item.id, command: item.command }); }
    catch { this.available = false; this.fail(new WriterError('WRITER_SEND_FAILED', 503, 'UNKNOWN')); void this.worker.terminate(); }
  }
  private fail(error: WriterError) {
    this.available = false;
    if (this.current) {
      clearTimeout(this.current.timer); this.bytes -= this.current.bytes; this.current.reject(error); this.current = null;
    }
    for (const queued of this.queue) queued.reject(new WriterError(error.code, 503, 'NOT_INGESTED'));
    this.queue = []; this.bytes = 0;
  }
  async waitForExit() { await this.exitPromise; }
  async close() {
    this.closed = true; this.available = false;
    this.fail(new WriterError('WRITER_CLOSING', 503, 'UNKNOWN'));
    if (this.worker && !this.exitObserved) { this.worker.postMessage({ id: 0, command: null }); await this.exitPromise; }
  }
}
