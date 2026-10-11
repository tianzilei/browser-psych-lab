全项目设计讨论，传输段 51，源码主题：运维工具和部署（源包 16/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

    p50Ms: Number(latencies[Math.ceil(latencies.length * 0.5) - 1].toFixed(2)),
    p95Ms: Number(latencies[Math.ceil(latencies.length * 0.95) - 1].toFixed(2)),
    p99Ms: Number(latencies[Math.ceil(latencies.length * 0.99) - 1].toFixed(2)),
  };
  const text = JSON.stringify(report, null, 2) + '\n';
  if (process.argv[2]) await writeFile(resolve(root, process.argv[2]), text);
  process.stdout.write(text);
  if (failures) process.exitCode = 1;
} finally {
  const exited = new Promise(resolve => child.once('exit', resolve));
  if (child.exitCode === null) { child.kill('SIGTERM'); await exited; }
}

```

### scripts/profile-frontend.mjs L1–L40

```
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { root } from './lib.mjs';

// Canonical production build sizes, including dynamically loaded questionnaire code.
// This measures transfer content, not device memory, CPU time or real network latency.
const directory = resolve(root, 'dist/web');
const manifest = JSON.parse(await readFile(resolve(directory, '.vite/manifest.json'), 'utf8'));
async function measure(entry, dynamic) {
  const paths = new Set([entry]);
  const visited = new Set();
  function visit(key) {
    if (visited.has(key)) return;
    visited.add(key);
    const item = manifest[key];
    if (!item) throw new Error(`Missing manifest entry: ${key}`);
    paths.add(item.file);
    for (const file of item.css ?? []) paths.add(file);
    for (const key of item.imports ?? []) visit(key);
    if (dynamic) for (const key of item.dynamicImports ?? []) visit(key);
  }
  visit(entry);
  const files = await Promise.all([...paths].sort().map(async path => {
    const bytes = await readFile(resolve(directory, path));
    return { path, bytes: bytes.length, gzipBytes: gzipSync(bytes).length };
  }));
  return { bytes: files.reduce((n, f) => n + f.bytes, 0), gzipBytes: files.reduce((n, f) => n + f.gzipBytes, 0), files };
}
const report = {
  scope: 'Local production manifest closure; HTML + JS + CSS; gzipSync with defaults; no images, API responses or cache assumptions',
  node: process.version,
  initial: await measure('participate.html', false),
  questionnaire: await measure('participate.html', true),
  runner: await measure('run.html', true),
};
const output = resolve(root, process.argv[2] ?? 'docs/gemini前端讨论/frontend-sizes.json');
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, questionnaireBytes: report.questionnaire.bytes, questionnaireGzipBytes: report.questionnaire.gzipBytes }));

```

### scripts/profile-mixed.mjs L1–L51

```
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir,cpus,totalmem} from 'node:os';
import {join,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {randomUUID,randomInt} from 'node:crypto';
import sharp from 'sharp';
import {passwordHash} from '../src/server/auth.ts';
import {sampleProtocol} from '../src/shared/protocol.ts';
import {digest} from '../src/server/collection-store.ts';
import {downloadOriginal} from '../src/web/asset-download.ts';
import {trace} from '../tests/helpers/run-trace.mjs';
const root=await mkdtemp(join(tmpdir(),'bpl-mixed-')),database=join(root,'db.sqlite'),started=Date.now(),sessionLimit=Number(process.env.SESSION_CONCURRENCY??2);let output='',address='',csrf='',cookie='',maximumActive=0;
const child=spawn(process.execPath,[resolve('dist/server/main.js')],{env:{...process.env,NODE_ENV:'production',HOST:'127.0.0.1',PORT:'0',PUBLIC_ORIGIN:'',STORAGE_ROOT:root,DATABASE_PATH:database,SESSION_CONCURRENCY:String(sessionLimit),PREPARATION_CONCURRENCY:'1',ADMIN_PASSWORD_HASH:await passwordHash('TEST_ONLY-profile-password')},stdio:['ignore','pipe','pipe']});
child.stdout.on('data',b=>{output=(output+b.toString()).slice(-64000);});child.stderr.on('data',()=>{});
const metrics=[],warnings=[];let retries=0;
async function req(path,data,credentialCookie=cookie,admin=true){for(let attempt=0;attempt<20;attempt++){const before=performance.now(),response=await fetch(`${address}${path}`,{method:data===undefined?'GET':'POST',headers:{Origin:address,'Content-Type':'application/json',Cookie:credentialCookie,...(admin?{'X-CSRF-Token':csrf}:{})},...(data===undefined?{}:{body:JSON.stringify(data)}),signal:AbortSignal.timeout(150000)});const value=await response.json();metrics.push({path:/(ingest|seal|permit|sessions)$/.exec(path)?.[1]??'control',ms:performance.now()-before,status:response.status});if(response.status===429||response.status===503){retries++;await new Promise(r=>setTimeout(r,Math.min(1000,100*(attempt+1)+randomInt(150))));continue;}if(!response.ok)throw new Error(`${path}: ${value.code}`);return {value,cookie:response.headers.get('set-cookie')?.split(';')[0]};}const diagnosis=await fetch(`${address}/api/lab/operations`,{headers:{Cookie:cookie}});console.error(JSON.stringify(await diagnosis.json()));throw new Error(`RETRY_BUDGET_EXCEEDED_${path}`);}
try{
  for(let i=0;i<100;i++){address=/Server listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1]??'';if(address)break;if(child.exitCode!==null)throw new Error('SERVER_EXITED');await new Promise(r=>setTimeout(r,50));}if(!address)throw new Error('STARTUP_TIMEOUT');
  const login=await req('/api/auth/login',{password:'TEST_ONLY-profile-password'},'',false);cookie=login.cookie;csrf=login.value.csrf;
  const {value:study}=await req('/api/lab/studies',{request_id:randomUUID()});const png=await sharp({create:{width:128,height:96,channels:3,background:'#578668'}}).png().toBuffer();const upload=await fetch(`${address}/api/lab/studies/${study.study_id}/upload`,{method:'POST',headers:{Origin:address,Cookie:cookie,'Content-Type':'image/png','X-CSRF-Token':csrf,'X-Request-Id':randomUUID(),'X-File-Name':'capacity-fixture.png'},body:png});const image=await upload.json();if(!upload.ok)throw new Error(image.code);
  const p=sampleProtocol();p.title='TEST_ONLY mixed HTTP load';p.groups=[{id:'images',title:'Synthetic',choices:['left','right'],repeats:2,trials:[{root_id:'root',asset_id:image.result.asset_id,image_ms:200,isi_ms:300,correct:'left'}]}];p.variants[0].group_order=['images'];p.variants[0].trial_order={images:['root']};
  await req(`/api/lab/studies/${study.study_id}/save`,{request_id:randomUUID(),revision:1,protocol:p});const {value:version}=await req(`/api/lab/studies/${study.study_id}/publish`,{request_id:randomUUID(),revision:2});await req(`/api/lab/studies/${study.study_id}/admission`,{request_id:randomUUID(),paused:false});
  const waves=[],background_jobs=[];
  async function participant(index){const created=await req('/api/participate/sessions',{request_id:randomUUID(),version_id:version.version_id,credential:digest(randomUUID())},'',false);const sid=created.value.session_id,c=created.cookie,path=`/api/participate/sessions/${sid}`,writer_id=`writer-${randomUUID()}`;const call=async(op,data)=> (await req(`${path}${op?`/${op}`:''}`,data,c,false)).value;
    const admissionTicket=randomUUID();let admission=await call('admission',{action:'join',ticket_id:admissionTicket});
    for(let i=0;admission.status==='QUEUED';i++){if(i>=600)throw new Error('SESSION_WAIT_EXCEEDED');await new Promise(r=>setTimeout(r,1000));admission=await call('admission',{action:'touch',ticket_id:admissionTicket});}
    if(admission.status!=='ACTIVE')throw new Error('SESSION_NOT_ADMITTED');const status=(await req('/api/lab/operations')).value.state.admission;maximumActive=Math.max(maximumActive,status.active);if(status.active>sessionLimit)throw new Error('SESSION_LIMIT_VIOLATED');
    const s=await call('claim',{request_id:randomUUID(),writer_id}),fence={writer_id,writer_epoch:s.writer_epoch};let sequence=0,previous=null;
    const wire=(scope,kind,payload)=>{const e={event_schema_version:'lab-events-v1',event_id:randomUUID(),session_id:sid,version_id:version.version_id,protocol_hash:version.hash,...fence,scope,sequence:sequence++,previous,clock_epoch:'synthetic-clock',time_ms:sequence,kind,payload},raw=JSON.stringify(e),row={event_id:e.event_id,hash:digest(raw),raw};previous={event_id:row.event_id,hash:row.hash};return row;};
    const seal=async(scope,events,pathValue)=>call('seal',{request_id:randomUUID(),...fence,manifest:{manifest_id:randomUUID(),scope,events:events.map(({event_id,hash})=>({event_id,hash})),path:pathValue}});
    const page=wire('welcome','PAGE_SNAPSHOT',{answers:{ready:'是'}});await call('ingest',{events:[page]});await call('ingest',{events:[page]});const pageSeal=await seal('welcome',[page],['welcome']);
    const reservation=await call('reserve',{request_id:randomUUID(),...fence}),ticket=randomUUID();
    let queued=await call('preparation',{action:'join',ticket_id:ticket,...fence});
    for(let i=0;queued.status!=='READY';i++){if(i>=600)throw new Error('PREPARATION_WAIT_EXCEEDED');await new Promise(r=>setTimeout(r,1000));queued=await call('preparation',{action:'touch',ticket_id:ticket,...fence});}
    const bytes=await downloadOriginal(`${address}${path}/assets/${image.result.asset_id}`,image.result.info.bytes,new AbortController().signal,()=>{},undefined,{Cookie:c,'X-Preparation-Ticket':ticket,'X-Writer-Id':writer_id,'X-Writer-Epoch':String(s.writer_epoch)});if(digest(bytes)!==image.result.info.hash)throw new Error('ASSET_MISMATCH');
    await call('preparation',{action:'release',ticket_id:ticket});
    const permit=await call('permit',{request_id:randomUUID(),...fence,reservation_id:reservation.reservation_id,readiness:{frame_ms:1000/60,commit_ms:5,layout:'portrait',geometry:{viewport:{width:800,height:800,dpr:1},canvas:{x:0,y:0,width:500,height:333},buttons:[{choice:'left',x:0,y:400,width:100,height:60},{choice:'right',x:110,y:400,width:100,height:60}]},assets:{[image.result.asset_id]:image.result.info.hash},protocol_hash:version.hash}});
    sequence=0;previous=null;const records=trace(permit.plan,n=>index%3===0?null:n===1?'right':'left').records,events=records.map(record=>wire(permit.scope,'GROUP_RECORD',{record}));
    // Reverse arrival exercises pending custody; immutable duplicate bytes emulate a lost ACK.
    for(let j=events.length;j>0;j-=8)await call('ingest',{events:events.slice(Math.max(0,j-8),j).reverse()});await call('ingest',{events:[events[0]]});
    if(index%7===6){await call('terminate',{request_id:randomUUID(),reason:'INJECTED_UNKNOWN_RUN'});const reconciliation=await call('reconcile',{request_id:randomUUID(),manifest:{manifest_id:randomUUID(),scope:permit.scope,events:events.map(({event_id,hash})=>({event_id,hash})),path:['welcome','images']},unknown:['synthetic-fault']});if(reconciliation.cleanup_allowed!==false)throw new Error('UNSAFE_CLEANUP');return 'TERMINATED';}
    const groupSeal=await seal(permit.scope,events,['welcome','images']);if(groupSeal.status!=='SEALED')throw new Error('SEAL_INCOMPLETE');const done=await call('finalize',{request_id:randomUUID(),...fence,seal_ids:[pageSeal.seal_id,groupSeal.seal_id]});if(done.status!=='COMPLETED')throw new Error('INCOMPLETE');return 'COMPLETED';
  }
  for(const concurrency of [1,5,10,20]){const before=performance.now(),startMetrics=metrics.length;const sessionPromise=Promise.all(Array.from({length:concurrency},(_,i)=>participant(i)));const background=concurrency===20?(async()=>{await new Promise(r=>setTimeout(r,30));for(const kind of ['export','backup']){const job=await req(`/api/lab/jobs/${kind}`,{request_id:randomUUID(),job_id:randomUUID(),...(kind==='export'?{study_id:study.study_id}:{})});background_jobs.push({kind,result:job.value.result});}})():Promise.resolve();const [sessions]=await Promise.all([sessionPromise,background]);const values=metrics.slice(startMetrics).map(v=>v.ms).sort((a,b)=>a-b);waves.push({concurrency,sessions,elapsed_ms:performance.now()-before,requests:values.length,p50_ms:values[Math.ceil(values.length*.5)-1],p95_ms:values[Math.ceil(values.length*.95)-1],p99_ms:values[Math.ceil(values.length*.99)-1]});}

  const exportJob=randomUUID();const exported=await req('/api/lab/jobs/export',{request_id:randomUUID(),job_id:exportJob,study_id:study.study_id});const backup=await req('/api/lab/jobs/backup',{request_id:randomUUID(),job_id:randomUUID()});
  const report={schema:'mixed-load-v2',mode:'TEST_ONLY',scope:'loopback HTTP; offered waves 1/5/10/20 with whole-session admission and 1s synthetic polling; synthetic software records, real SQLite/decoder/resources/replay/export/backup; no mobile or physical timing claim',session_concurrency:sessionLimit,maximum_observed_active_sessions:maximumActive,admission_queue:(await req('/api/lab/operations')).value.state.admission,environment:{platform:process.platform,arch:process.arch,node:process.version,cpu:cpus()[0]?.model,logical_cpus:cpus().length,total_memory_bytes:totalmem()},waves,background_jobs,retryable_responses:retries,response_statuses:metrics.reduce((a,r)=>{a[r.status]=(a[r.status]??0)+1;return a;},{}),final_states:await req(`/api/lab/studies/${study.study_id}/sessions`),csv_snapshot:exported.value.result,backup:backup.value.result,wal_bytes:(await stat(`${database}-wal`)).size,warnings,elapsed_ms:Date.now()-started};
  const text=JSON.stringify(report,null,2)+'\n';if(process.argv[2])await writeFile(resolve(process.argv[2]),text);console.log(text);
}finally{if(child.exitCode===null){const exit=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await exit;}await rm(root,{recursive:true,force:true});}

```

### scripts/references.mjs L1–L55

```
import { mkdir, readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { root, run } from './lib.mjs';

const manifest = JSON.parse(await readFile(resolve(root, 'references/manifest.lock.json'), 'utf8'));
const base = resolve(root, 'references/checkouts');
await mkdir(base, { recursive: true });
let failed = false;
for (const repo of manifest.repositories) {
  try {