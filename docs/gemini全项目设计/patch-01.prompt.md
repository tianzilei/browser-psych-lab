这是实施后设计复审 1/7。内容为当前修改源码、测试或采用设计。先吸收本段；只回复“已接收复审1”，等全部7段后再讨论。

## src/shared/task-policy.ts
// These values belong to the frozen v1 runner contract. A different timeout
// policy must receive a new identity rather than changing this policy in place.
export const TASK_ACTIVITY_POLICY = Object.freeze({
  id: 'idle120-offline300-v1',
  idle_timeout_ms: 120_000,
  connection_timeout_ms: 300_000,
  renewal_interval_ms: 60_000,
  request_timeout_ms: 10_000,
  client_check_interval_ms: 1_000,
  server_scan_interval_ms: 30_000,
} as const);


## src/web/task-liveness.ts
import type {ParticipantAPI} from './participant-api.js';
import {TASK_ACTIVITY_POLICY as policy} from '../shared/task-policy.js';
// Actions stay local. A tiny control request renews the task lease at most once
// per minute; transient network failures do not block the UI or lose evidence.
export function taskLiveness(api:ParticipantAPI,interrupt:(reason:string)=>void){
  const events=document;
  let last=performance.now(),lastAck=last,closed=false,inFlight=false;
  const activity=(event:Event)=>{if(event.isTrusted)last=performance.now();};
  const types=['pointerdown','pointermove','pointerup','keydown','input'];
  for(const type of types)events.addEventListener(type,activity,{capture:true,passive:true});
  const stop=()=>{
    if(closed)return;
    closed=true;clearInterval(check);clearInterval(renew);
    for(const type of types)events.removeEventListener(type,activity,true);
  };
  const fail=(reason:string)=>{if(closed)return;stop();interrupt(reason);};
  const check=setInterval(()=>{
    if(performance.now()-last>=policy.idle_timeout_ms)fail('USER_IDLE_TIMEOUT');
    else if(performance.now()-lastAck>=policy.connection_timeout_ms)fail('CONNECTION_TIMEOUT');
  },policy.client_check_interval_ms);
  const renew=setInterval(()=>{
    if(closed||inFlight||performance.now()-last>=policy.idle_timeout_ms)return;
    inFlight=true;
    void fetch(api.path('activity'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(api.fence()),signal:AbortSignal.timeout(policy.request_timeout_ms)}).then(async response=>{
      if(closed)return;
      if(response.ok){
        const value=await response.json() as {status:string};
        if(closed)return;
        if(value.status==='ACTIVE')lastAck=performance.now();else fail('SERVER_TASK_TERMINATED');
      }else if([401,409].includes(response.status))fail('SERVER_TASK_TERMINATED');
    }).catch(()=>{}).finally(()=>{inFlight=false;});
  },policy.renewal_interval_ms);
  return stop;
}


## src/server/db-worker.ts
import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from './database.js';
import { CollectionStore, type Command } from './collection-store.js';
import { ContractError } from '../shared/contract.js';
import { LabStore } from './lab-store.js';
import { TASK_ACTIVITY_POLICY } from '../shared/task-policy.js';

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
      // A stale heartbeat is not evidence of process exit. Native work or a
      // suspended process can resume; only ESRCH allows another owner to start.
      if (alive) throw new Error('DATABASE_ALREADY_OWNED');
    }
  }
  heartbeat();
}).immediate();
const lab = new LabStore(db, workerData.runnerHash as string | undefined,Date.now,workerData.sessionConcurrency as number|undefined);
lab.execute({operation:'lab/internal.job.interrupted',data:{}});
lab.expireTaskActivity();
const activityTimer=setInterval(()=>{try{lab.expireTaskActivity();}catch{}},TASK_ACTIVITY_POLICY.server_scan_interval_ms);
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


## src/server/runner-asset-policy.ts
import {join} from 'node:path';
import {digest} from './collection-store.js';
import {openPrivate} from './private-files.js';
import {ContractError} from '../shared/contract.js';
import {TASK_ACTIVITY_POLICY} from '../shared/task-policy.js';
type AssetPolicy='legacy'|'ticket';
export class RunnerAssetPolicy {
  private cache=new Map<string,AssetPolicy>();
  private pending=new Map<string,Promise<AssetPolicy>>();
  private activity=new Set<string>();
  constructor(private root:string){}
  private async read(path:string,maxBytes:number){
    const file=await openPrivate(path);
    try{if((await file.stat()).size>maxBytes)throw new Error('RUNNER_POLICY_BUDGET_EXCEEDED');return await file.readFile();}
    finally{await file.close();}
  }
  async get(hash:string){
    if(!/^[a-f0-9]{64}$/.test(hash))throw new Error('INVALID_RUNNER_IDENTITY');
    const cached=this.cache.get(hash);if(cached){this.cache.delete(hash);this.cache.set(hash,cached);return cached;}
    const pending=this.pending.get(hash);if(pending)return pending;
    if(this.pending.size>=16)throw new ContractError('RUNNER_POLICY_BUSY',503);
    const load=this.load(hash);this.pending.set(hash,load);
    try{return await load;}finally{this.pending.delete(hash);}
  }
  private async load(hash:string):Promise<AssetPolicy>{
    const directory=join(this.root,'research-assets','runners',hash);
    const release=JSON.parse((await this.read(join(directory,'release.json'),256*1024)).toString()) as {runnerHash:string;files:{path:string;hash:string}[]};
    if(release.runnerHash!==hash||!Array.isArray(release.files)||release.files.length>500||digest(JSON.stringify(release.files))!==hash)throw new Error('RUNNER_POLICY_IDENTITY_MISMATCH');
    const contracts=release.files.filter(f=>f.path==='runner-contract.json');if(contracts.length>1)throw new Error('INVALID_RUNNER_CONTRACT');
    let policy:AssetPolicy='legacy';
    if(contracts.length){const bytes=await this.read(join(directory,'runner-contract.json'),1024);
      if(digest(bytes)!==contracts[0]!.hash)throw new Error('RUNNER_CONTRACT_HASH_MISMATCH');
      const contract=JSON.parse(bytes.toString()) as {schema:string;preparation_queue:boolean;task_activity?:string};
      if(contract.schema!=='runner-assets-v1'||contract.preparation_queue!==true)throw new Error('UNSUPPORTED_RUNNER_CONTRACT');policy='ticket';
      if(contract.task_activity!==undefined){
        if(contract.task_activity!==TASK_ACTIVITY_POLICY.id)throw new Error('UNSUPPORTED_TASK_ACTIVITY_POLICY');
        this.activity.add(hash);
      }
    }
    if(this.cache.size>=64){const evicted=this.cache.keys().next().value!;this.cache.delete(evicted);this.activity.delete(evicted);}this.cache.set(hash,policy);return policy;
  }
  async requiresActivity(hash:string){await this.get(hash);return this.activity.has(hash);}
}


## Other core and regression changes
diff --git a/scripts/release.mjs b/scripts/release.mjs
index 3f97fce..bca2938 100644
--- a/scripts/release.mjs
+++ b/scripts/release.mjs
@@ -3,10 +3,11 @@ import {join} from 'node:path';
 import {createHash} from 'node:crypto';
 import {root} from './lib.mjs';
 import {gunzipSync,brotliDecompressSync} from 'node:zlib';
+import {TASK_ACTIVITY_POLICY} from '../dist/shared/task-policy.js';
 const hash=b=>createHash('sha256').update(b).digest('hex');const files=[];
 // The transport contract participates in canonical runner identity. Old frozen
 // archives without this file retain their original asset request contract.
-await writeFile(join(root,'dist/web/runner-contract.json'),JSON.stringify({schema:'runner-assets-v1',preparation_queue:true,session_admission:true,task_activity:'idle120-offline300-v1'})+'\n');
+await writeFile(join(root,'dist/web/runner-contract.json'),JSON.stringify({schema:'runner-assets-v1',preparation_queue:true,session_admission:true,task_activity:TASK_ACTIVITY_POLICY.id})+'\n');
 async function scan(directory,prefix=''){for(const name of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const path=join(directory,name.name),key=prefix?`${prefix}/${name.name}`:name.name;
  if(name.isDirectory())await scan(path,key);else if(!/\.(br|gz)$/.test(key))files.push({path:key,hash:hash(await readFile(path))});}}
 await scan(join(root,'dist/web'));const runnerHash=hash(JSON.stringify(files));
diff --git a/src/server/lab-routes.ts b/src/server/lab-routes.ts
index eb8582d..d35921b 100644
--- a/src/server/lab-routes.ts
+++ b/src/server/lab-routes.ts
@@ -12,6 +12,7 @@ import {digest} from './collection-store.js';
 import {verifyPassword,RateLimits} from './auth.js';
 import {ContractError,id,object} from '../shared/contract.js';
 import {receiveUpload,assetPath,openPrivate,safeDownload,fileHash,privateRoot} from './private-files.js';
+import {TASK_ACTIVITY_POLICY} from '../shared/task-policy.js';
 export async function labRoutes(app:FastifyInstance,writer:DatabaseWriter,maintenance:Maintenance,root:string){
   const preparation=new PreparationQueue(Number(process.env.PREPARATION_CONCURRENCY??1)),assetPolicy=new RunnerAssetPolicy(root);
   app.addHook('onClose',async()=>preparation.close());
@@ -146,7 +147,7 @@ export async function labRoutes(app:FastifyInstance,writer:DatabaseWriter,mainte
     const data=object(request.body);delete data.proof_job_id;
     if(op==='permit'){
       const session=await participant(request,'view') as {frozen:{runner_hash:string}};
-      if(await assetPolicy.requiresActivity(session.frozen.runner_hash))object(data.readiness).activity_policy='idle120-offline300-v1';
+      if(await assetPolicy.requiresActivity(session.frozen.runner_hash))object(data.readiness).activity_policy=TASK_ACTIVITY_POLICY.id;
     }
     if(op==='seal'&&String(object(data.manifest).scope).startsWith('g-')){
       const params=request.params as {session:string};await participant(request,'admission.check');
diff --git a/src/server/lab-store.ts b/src/server/lab-store.ts
index ae3e083..f91081c 100644
--- a/src/server/lab-store.ts
+++ b/src/server/lab-store.ts
@@ -5,6 +5,7 @@ import { digest, type Command } from './collection-store.js';
 import { Xoshiro128, sampleBounded } from '../shared/prng.js';
 import { LAB_SQL } from './lab-schema.js';
 import {SessionAdmission,SESSION_LEASE_MS} from './session-admission.js';
+import {TASK_ACTIVITY_POLICY} from '../shared/task-policy.js';
 import { ContractError, eventRef, hash, id, object, integer, parseManifest, manifestText, type Receipt, type Seal } from '../shared/contract.js';
 import { parseProtocol, sampleProtocol, stableJSON, evaluate, pageSnapshot, RUNNER_VERSION,
   type Protocol, type FrozenProtocol, type AssetInfo, type Answer } from '../shared/protocol.js';
@@ -85,7 +86,7 @@ export class LabStore {
     return {session_id:sid,study_id:s.study_id,admission_id:s.admission_id,state:s.state,writer_id:s.writer_id,writer_epoch:s.writer_epoch,lease_until:s.lease_until,
       frozen:this.frozen(s.version_id),answers:JSON.parse(s.answers) as Record<string,Answer>,path:JSON.parse(s.path) as string[],page_index:s.page_index,group_index:s.group_index,
       allocation,permit:p?{permit_id:p.permit_id,scope:p.scope,group_id:p.group_id,plan:JSON.parse(p.plan) as GroupPlan,state:p.state}:null,