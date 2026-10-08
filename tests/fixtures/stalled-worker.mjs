import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from '../../dist/server/database.js';
import { CollectionStore } from '../../dist/server/collection-store.js';
const db = openDatabase(workerData.path);
const store = new CollectionStore(db);
parentPort.postMessage({ ready: true });
parentPort.on('message', message => {
  if (!message.command) { db.close(); parentPort.close(); return; }
  const result = store.execute(message.command);
  // A deterministic post-COMMIT/native-stall fixture; never included in production.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.delay_ms ?? 200);
  parentPort.postMessage({ id: message.id, result });
});
