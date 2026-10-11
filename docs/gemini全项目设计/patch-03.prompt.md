这是实施后设计复审 3/7。内容为当前修改源码、测试或采用设计。先吸收本段；只回复“已接收复审3”，等全部7段后再讨论。

   return {errors,activity:()=>{const e=new Event('pointerdown');Object.defineProperty(e,'isTrusted',{value:true});target.dispatchEvent(e);},tick:async ms=>{now+=ms;t.mock.timers.tick(ms);await new Promise(r=>setImmediate(r));},calls:()=>calls,stop};
 }
 test('idle limit interrupts after two minutes; one tiny renewal per minute and cleanup stops timers',async t=>{
-  const f=setup(t);await f.tick(60000);assert.equal(f.calls(),1);assert.deepEqual(f.errors,[]);await f.tick(60000);assert(f.errors.includes('USER_IDLE_TIMEOUT'));f.stop();const before=f.calls();await f.tick(60000);assert.equal(f.calls(),before);
+  const f=setup(t);await f.tick(60000);assert.equal(f.calls(),1);assert.deepEqual(f.errors,[]);await f.tick(60000);assert.deepEqual(f.errors,['USER_IDLE_TIMEOUT']);const before=f.calls();await f.tick(60000);assert.equal(f.calls(),before);assert.deepEqual(f.errors,['USER_IDLE_TIMEOUT']);f.stop();
 });
 test('active disconnected task tolerates short loss and interrupts after five minutes',async t=>{
-  const f=setup(t,false);for(let i=0;i<4;i++){f.activity();await f.tick(60000);assert.deepEqual(f.errors,[]);}f.activity();await f.tick(60000);assert(f.errors.includes('CONNECTION_TIMEOUT'));assert.equal(f.calls(),5);
+  const f=setup(t,false);for(let i=0;i<4;i++){f.activity();await f.tick(60000);assert.deepEqual(f.errors,[]);}f.activity();await f.tick(60000);assert.deepEqual(f.errors,['CONNECTION_TIMEOUT']);assert.equal(f.calls(),4);
+});
+test('stopping a task ignores an in-flight terminal activity response',async t=>{
+  let respond;const f=setup(t,()=>new Promise(resolve=>{respond=resolve;}));
+  await f.tick(60000);assert.equal(f.calls(),1);f.stop();
+  respond(new Response('{"status":"TERMINATED"}',{status:409}));
+  await new Promise(resolve=>setImmediate(resolve));
+  await f.tick(300000);assert.deepEqual(f.errors,[]);assert.equal(f.calls(),1);
+});
+test('stopping during activity body decoding ignores its late terminal status',async t=>{
+  let decode;const f=setup(t,()=>({ok:true,json:()=>new Promise(resolve=>{decode=resolve;})}));
+  await f.tick(60000);assert.equal(f.calls(),1);f.stop();decode({status:'TERMINATED'});
+  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(f.errors,[]);
 });
diff --git a/tests/unit/writer.test.mjs b/tests/unit/writer.test.mjs
index ce5f248..3280b4f 100644
--- a/tests/unit/writer.test.mjs
+++ b/tests/unit/writer.test.mjs
@@ -4,7 +4,7 @@ import { mkdtemp, rm } from 'node:fs/promises';
 import { tmpdir } from 'node:os';
 import { join } from 'node:path';
 import { DatabaseWriter } from '../../dist/server/writer.js';
-import { digest } from '../../dist/server/collection-store.js';
+import { CollectionStore, digest } from '../../dist/server/collection-store.js';
 import { openDatabase } from '../../dist/server/database.js';
 
 async function fixture(t, options) {
@@ -25,7 +25,7 @@ test('single worker commits then acknowledges and rejects a second process owner
 test('bounded queues distinguish never sent from an unknown commit and preserve identities on restart', async t => {
   const { writer, path } = await fixture(t, {
     workerUrl: new URL('../fixtures/stalled-worker.mjs', import.meta.url), workerData: { delay_ms: 500 },
-    maxRequests: 3, maxBytes: 4096, controlReserve: 1, timeoutMs: 1000,
+    maxRequests: 3, maxBytes: 4096, controlReserve: 1,
   });
   // Use a shorter RPC timeout after startup, which otherwise depends on machine load.
   writer.options.timeoutMs = 150;
@@ -42,10 +42,26 @@ test('bounded queues distinguish never sent from an unknown commit and preserve
   const db = openDatabase(path);
   let original;
   try { original = db.prepare('SELECT session_id FROM p0_sessions').get().session_id; } finally { db.close(); }
-  writer.options.workerUrl = new URL('../../dist/server/db-worker.js', import.meta.url); writer.options.timeoutMs = 1000;
+  writer.options.workerUrl = new URL('../../dist/server/db-worker.js', import.meta.url); delete writer.options.timeoutMs;
   await writer.start();
   assert.equal((await writer.request({ operation: 'create', data })).session_id, original);
 });
+for (const [name, heartbeat] of [['stale', { heartbeat_at: Date.now() - 60_000 }], ['missing', {}]]) {
+  test(`living database owner with ${name} heartbeat cannot be replaced`, async t => {
+    const directory = await mkdtemp(join(tmpdir(), 'bpl-owner-')); const path = join(directory, 'db.sqlite');
+    const db = openDatabase(path); new CollectionStore(db);
+    const record = JSON.stringify({ pid: process.pid, owner: 'previous-live-owner', ...heartbeat });
+    db.prepare("INSERT OR REPLACE INTO p0_meta VALUES ('app_instance',?)").run(record);
+    db.close();
+    const replacement = new DatabaseWriter(path);
+    t.after(async () => { await replacement.close(); await rm(directory, { recursive: true, force: true }); });
+    await assert.rejects(replacement.start(), /DATABASE_ALREADY_OWNED/);
+    await replacement.waitForExit();
+    const reopened = openDatabase(path);
+    try { assert.equal(reopened.prepare("SELECT value FROM p0_meta WHERE key='app_instance'").get().value, record); }
+    finally { reopened.close(); }
+  });
+}
 test('byte budget rejects an oversized request before any RPC', async t => {
   const { writer } = await fixture(t, { maxBytes: 100 });
   await assert.rejects(writer.request({ operation: 'create', data: { huge: 'x'.repeat(200) } }), e => e.ingestion === 'NOT_INGESTED');
