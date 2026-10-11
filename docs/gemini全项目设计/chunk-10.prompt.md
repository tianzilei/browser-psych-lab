全项目设计讨论，传输段 10，源码主题：数据库、RPC、认证及准入（源包 4/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

### src/server/database.ts L1–L31

```
import Database from 'better-sqlite3';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

// Connection policy shared by the dedicated writer and isolated setup/smoke scripts.
export function openDatabase(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { timeout: 3000 });
  try {
    const version = db.prepare('SELECT sqlite_version() AS version').get() as { version: string };
    const [major = 0, minor = 0, patch = 0] = version.version.split('.').map(Number);
    if (major < 3 || (major === 3 && (minor < 51 || (minor === 51 && patch < 3)))) {
      throw new Error('SQLite >=3.51.3 is required for the WAL-reset fix.');
    }
    const journal = db.pragma('journal_mode = WAL', { simple: true });
    if (journal !== 'wal') throw new Error('Database filesystem does not support WAL.');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 3000');
    for (const [name, expected] of [['synchronous', 2], ['foreign_keys', 1], ['busy_timeout', 3000]] as const) {
      if (db.pragma(name, { simple: true }) !== expected) throw new Error(`Database ${name} policy failed.`);
    }
    if (process.platform === 'darwin') {
      db.pragma('fullfsync = ON');
      db.pragma('checkpoint_fullfsync = ON');
    }
    chmodSync(path, 0o600);
    return db;
  } catch (error) { db.close(); throw error; }
}

```

### src/server/writer.ts L1–L106

```
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

```

### src/server/db-worker.ts L1–L54

```
import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from './database.js';
import { CollectionStore, type Command } from './collection-store.js';
import { ContractError } from '../shared/contract.js';
import { LabStore } from './lab-store.js';

const port = parentPort!;
const db = openDatabase(workerData.path as string);
const store = new CollectionStore(db);
const owner = workerData.owner as string;
const heartbeat = () => db.prepare("INSERT OR REPLACE INTO p0_meta VALUES ('app_instance',?)").run(JSON.stringify({ pid: process.pid, owner, started_at: Date.now(), heartbeat_at: Date.now() }));
const heartbeatTimer = setInterval(heartbeat, 5000);
// Local single-host process ownership, checked inside SQLite's write transaction.
// Replacement in the same process requires the supervisor to have observed exit.
db.transaction(() => {
  const record = db.prepare("SELECT value FROM p0_meta WHERE key='app_instance'").get() as { value: string } | undefined;
  if (record) {
    const previous = JSON.parse(record.value) as { pid: number; owner: string };
    if (previous.owner !== owner) {
      let alive = true;
      try { process.kill(previous.pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
      const heartbeatAt=Number((previous as {heartbeat_at?:number}).heartbeat_at??0);
      if (alive && heartbeatAt>0 && Date.now()-heartbeatAt<30000) throw new Error('DATABASE_ALREADY_OWNED');
    }
  }
  heartbeat();
}).immediate();
const lab = new LabStore(db, workerData.runnerHash as string | undefined,Date.now,workerData.sessionConcurrency as number|undefined);
lab.execute({operation:'lab/internal.job.interrupted',data:{}});
lab.expireTaskActivity();
const activityTimer=setInterval(()=>{try{lab.expireTaskActivity();}catch{}},30000);
port.postMessage({ ready: true });
port.on('message', (message: { id: number; command: Command | null }) => {
  if (message.command !== null) heartbeat();
  if (message.command === null) {
    db.transaction(() => {
      const record = db.prepare("SELECT value FROM p0_meta WHERE key='app_instance'").get() as { value: string } | undefined;
      if (record && (JSON.parse(record.value) as { owner: string }).owner === owner)
        db.prepare("DELETE FROM p0_meta WHERE key='app_instance'").run();
    }).immediate();
    clearInterval(heartbeatTimer); clearInterval(activityTimer); db.close(); port.close(); return;
  }
  try {
    const result = message.command.operation.startsWith('lab/') ? lab.execute(message.command) : store.execute(message.command);
    port.postMessage({ id: message.id, result });
  } catch (error) {
    const known = error instanceof ContractError;
    port.postMessage({ id: message.id, error: {
      code: known ? error.code : 'DATABASE_TRANSACTION_FAILED', status: known ? error.status : 503,
      details: known ? error.details : null, ingestion: known ? 'NOT_INGESTED' : 'UNKNOWN',
    } });
  }
});

```

### src/server/lab-schema.ts L1–L96

```
export const LAB_SQL = `
CREATE TABLE IF NOT EXISTS lab_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
INSERT OR IGNORE INTO lab_meta VALUES ('schema','1'),('resource_barrier',''),('collection_gate','CLOSED');
CREATE TABLE IF NOT EXISTS lab_admin_tokens(token_hash TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS lab_studies(study_id TEXT PRIMARY KEY,title TEXT NOT NULL,draft TEXT NOT NULL,
 revision INTEGER NOT NULL,admission TEXT NOT NULL CHECK(admission IN ('OPEN','PAUSED')),created_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS lab_versions(version_id TEXT PRIMARY KEY,study_id TEXT NOT NULL REFERENCES lab_studies,
 hash TEXT NOT NULL,protocol TEXT NOT NULL,runner_hash TEXT NOT NULL,runner_version TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS lab_questionnaire_sources(study_id TEXT PRIMARY KEY REFERENCES lab_studies,source TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS lab_archived_studies(study_id TEXT PRIMARY KEY REFERENCES lab_studies,archived_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS lab_packages(study_id TEXT NOT NULL REFERENCES lab_studies,name TEXT NOT NULL,hash TEXT NOT NULL,job_id TEXT NOT NULL,PRIMARY KEY(study_id,name)) STRICT;
CREATE TABLE IF NOT EXISTS lab_package_images(study_id TEXT NOT NULL,name TEXT NOT NULL,path TEXT NOT NULL,asset_id TEXT NOT NULL REFERENCES lab_assets,PRIMARY KEY(study_id,name,path),FOREIGN KEY(study_id,name) REFERENCES lab_packages(study_id,name)) STRICT;
CREATE TABLE IF NOT EXISTS lab_covariates(session_id TEXT NOT NULL REFERENCES lab_sessions,sample_id TEXT NOT NULL,hash TEXT NOT NULL,raw TEXT NOT NULL,source TEXT NOT NULL,received_at INTEGER NOT NULL,PRIMARY KEY(session_id,sample_id)) STRICT;
CREATE TABLE IF NOT EXISTS lab_group_selections(session_id TEXT NOT NULL REFERENCES lab_sessions,group_id TEXT NOT NULL,selection TEXT NOT NULL,PRIMARY KEY(session_id,group_id)) STRICT;
CREATE TRIGGER IF NOT EXISTS lab_group_selections_update BEFORE UPDATE ON lab_group_selections BEGIN SELECT RAISE(ABORT,'immutable selection'); END;
CREATE TRIGGER IF NOT EXISTS lab_group_selections_delete BEFORE DELETE ON lab_group_selections BEGIN SELECT RAISE(ABORT,'immutable selection'); END;
CREATE TABLE IF NOT EXISTS lab_consents(session_id TEXT PRIMARY KEY REFERENCES lab_sessions,document_hash TEXT NOT NULL,accepted_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS lab_task_activity(session_id TEXT PRIMARY KEY REFERENCES lab_sessions,writer_epoch INTEGER NOT NULL,last_seen INTEGER NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS lab_task_activity_seen ON lab_task_activity(last_seen);
CREATE TRIGGER IF NOT EXISTS lab_consents_update BEFORE UPDATE ON lab_consents BEGIN SELECT RAISE(ABORT,'immutable consent'); END;
CREATE TRIGGER IF NOT EXISTS lab_consents_delete BEFORE DELETE ON lab_consents BEGIN SELECT RAISE(ABORT,'immutable consent'); END;
CREATE TRIGGER IF NOT EXISTS lab_covariates_update BEFORE UPDATE ON lab_covariates BEGIN SELECT RAISE(ABORT,'immutable covariates'); END;
CREATE TRIGGER IF NOT EXISTS lab_covariates_delete BEFORE DELETE ON lab_covariates BEGIN SELECT RAISE(ABORT,'immutable covariates'); END;
CREATE TABLE IF NOT EXISTS lab_assets(asset_id TEXT PRIMARY KEY,study_id TEXT NOT NULL REFERENCES lab_studies,name TEXT NOT NULL,