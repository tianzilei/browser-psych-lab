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
port.postMessage({ ready: true });
port.on('message', (message: { id: number; command: Command | null }) => {
  if (message.command !== null) heartbeat();
  if (message.command === null) {
    db.transaction(() => {
      const record = db.prepare("SELECT value FROM p0_meta WHERE key='app_instance'").get() as { value: string } | undefined;
      if (record && (JSON.parse(record.value) as { owner: string }).owner === owner)
        db.prepare("DELETE FROM p0_meta WHERE key='app_instance'").run();
    }).immediate();
    clearInterval(heartbeatTimer); db.close(); port.close(); return;
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
