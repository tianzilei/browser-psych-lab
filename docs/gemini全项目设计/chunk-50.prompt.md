全项目设计讨论，传输段 50，源码主题：运维工具和部署（源包 16/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

  const ca=resolve(tls,'ca.pem'),caKey=resolve(tls,'ca-key.pem'),key=resolve(tls,'server-key.pem'),cert=resolve(tls,'server.pem');
  const run=args=>execute('openssl',args);
  try{await access(ca);await access(caKey);}catch{
    await run(['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','365','-keyout',caKey,'-out',ca,'-subj','/CN=Browser Psych Lab TEST_ONLY Local CA',
      '-addext','basicConstraints=critical,CA:TRUE,pathlen:0','-addext','keyUsage=critical,keyCertSign,cRLSign']);
  }
  const csr=resolve(tls,'server.csr'),extensions=resolve(tls,'server.ext');
  await writeFile(extensions,`basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1,IP:${ip}\n`,{mode:0o600});
  await run(['req','-new','-newkey','rsa:2048','-nodes','-sha256','-keyout',key,'-out',csr,'-subj','/CN=Browser Psych Lab local preview']);
  await run(['x509','-req','-in',csr,'-CA',ca,'-CAkey',caKey,'-CAcreateserial','-out',cert,'-days','30','-sha256','-extfile',extensions]);
  await Promise.all([chmod(caKey,0o600),chmod(key,0o600)]);
  await run(['verify','-CAfile',ca,cert]);
  const download=resolve(tls,'local-test-ca.cer');await run(['x509','-in',ca,'-outform','DER','-out',download]);
  return {key,cert,download,fingerprint:new X509Certificate(await readFile(ca)).fingerprint256};
}

```

### scripts/profile-bandwidth.mjs L1–L85

```
// Isolated TEST_ONLY preparation exercise. Aggregate response-body shaping,
// not an ECS capacity or TLS/wire-level benchmark.
import {spawn} from 'node:child_process';
import {createServer,request as httpRequest,Agent} from 'node:http';
import {Transform} from 'node:stream';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {randomBytes,randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {passwordHash} from '../src/server/auth.ts';
import {sampleProtocol} from '../src/shared/protocol.ts';
import {digest} from '../src/server/collection-store.ts';
const root=await mkdtemp(join(tmpdir(),'bpl-bandwidth-')),rate=125000,queue=[],sessionLimit=Number(process.env.SESSION_CONCURRENCY??2);
let backend='',timer=null,next=0,shapedBytes=0,child;
const agent=new Agent({keepAlive:true,timeout:75000,maxSockets:64});
function pump(){
  if(timer||!queue.length)return;
  const delay=Math.max(0,next-performance.now());timer=setTimeout(()=>{
    timer=null;const item=queue[0];if(item.target.destroyed){queue.shift();item.done();pump();return;}
    const bytes=item.chunk.subarray(item.offset,item.offset+4096);item.target.push(bytes);item.offset+=bytes.length;shapedBytes+=bytes.length;
    next=Math.max(next,performance.now())+bytes.length/rate*1000;
    if(item.offset===item.chunk.length){queue.shift();item.done();}pump();
  },delay);
}
const proxy=createServer((req,res)=>{
  const upstream=httpRequest(`${backend}${req.url}`,{method:req.method,headers:req.headers,agent},response=>{
    res.writeHead(response.statusCode,response.headers);
    const shaper=new Transform({transform(chunk,_encoding,done){queue.push({chunk,offset:0,target:this,done});pump();}});
    response.on('error',()=>res.destroy());res.on('close',()=>{response.destroy();shaper.destroy();});response.pipe(shaper).pipe(res);
  });upstream.on('error',()=>{res.statusCode=502;res.end();});req.on('aborted',()=>upstream.destroy());req.pipe(upstream);
});
proxy.keepAliveTimeout=75000;
await new Promise(r=>proxy.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${proxy.address().port}`;
let output='',adminCookie='',csrf='';
async function req(path,data,cookie=adminCookie,admin=true){
  let response;
  try{response=await fetch(`${origin}${path}`,{method:data===undefined?'GET':'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json',...(admin?{'X-CSRF-Token':csrf}:{})},...(data===undefined?{}:{body:JSON.stringify(data)}),signal:AbortSignal.timeout(15000)});}
  catch(error){throw new Error(`SHAPED_REQUEST_FAILED: ${path}`,{cause:error});}
  const value=await response.json();if(!response.ok)throw new Error(`${path}: ${value.code}`);return {value,cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
try{
  const hash=await passwordHash('TEST_ONLY-bandwidth-password');
  child=spawn(process.execPath,[resolve('dist/server/main.js')],{env:{...process.env,NODE_ENV:'production',HOST:'127.0.0.1',PORT:'0',PUBLIC_ORIGIN:origin,STORAGE_ROOT:root,DATABASE_PATH:join(root,'db.sqlite'),SESSION_CONCURRENCY:String(sessionLimit),PREPARATION_CONCURRENCY:'1',ADMIN_PASSWORD_HASH:hash},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>{output=(output+b.toString()).slice(-64000);});child.stderr.on('data',()=>{});
  for(let i=0;i<200;i++){backend=/Server listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1]??'';if(backend)break;if(child.exitCode!==null)throw new Error('SERVER_EXITED');await new Promise(r=>setTimeout(r,25));}if(!backend)throw new Error('STARTUP_TIMEOUT');
  const login=await req('/api/auth/login',{password:'TEST_ONLY-bandwidth-password'},'',false);adminCookie=login.cookie;csrf=login.value.csrf;
  const {value:study}=await req('/api/lab/studies',{request_id:randomUUID()});
  const edge=256,png=await sharp(randomBytes(edge*edge*3),{raw:{width:edge,height:edge,channels:3}}).png().toBuffer();
  const upload=await fetch(`${origin}/api/lab/studies/${study.study_id}/upload`,{method:'POST',headers:{Origin:origin,Cookie:adminCookie,'Content-Type':'image/png','X-CSRF-Token':csrf,'X-Request-Id':randomUUID(),'X-File-Name':'noise.png'},body:png});const asset=await upload.json();if(!upload.ok)throw new Error(asset.code);
  const p=sampleProtocol();p.pages=[];p.groups=[{id:'images',title:'TEST_ONLY shaped preparation',choices:['left','right'],repeats:0,trials:[{root_id:'one',asset_id:asset.result.asset_id,image_ms:400,isi_ms:400,correct:null}]}];p.variants[0].group_order=['images'];p.variants[0].trial_order={images:['one']};
  await req(`/api/lab/studies/${study.study_id}/save`,{request_id:randomUUID(),revision:1,protocol:p});const {value:version}=await req(`/api/lab/studies/${study.study_id}/publish`,{request_id:randomUUID(),revision:2});await req(`/api/lab/studies/${study.study_id}/admission`,{request_id:randomUUID(),paused:false});
  const sessions=await Promise.all(Array.from({length:20},async()=>{
    const session=await req('/api/participate/sessions',{request_id:randomUUID(),version_id:version.version_id,credential:digest(randomUUID())},'',false),path=`/api/participate/sessions/${session.value.session_id}`;
    return {path,cookie:session.cookie};
  }));
  const admitted=[],finished=[],sessionAdmitted=[],started=performance.now(),bodyStart=shapedBytes;let maximumStreams=0,liveStreams=0,maximumActive=0;
  const results=await Promise.all(sessions.map(async(s,index)=>{
    const admissionTicket=randomUUID();let admission=(await req(`${s.path}/admission`,{action:'join',ticket_id:admissionTicket},s.cookie,false)).value;
    sessionAdmitted.push({index,position:admission.position,status:admission.status});
    for(let i=0;admission.status==='QUEUED';i++){if(i>=600)throw new Error('SESSION_WAIT_EXCEEDED');await new Promise(r=>setTimeout(r,1000));admission=(await req(`${s.path}/admission`,{action:'touch',ticket_id:admissionTicket},s.cookie,false)).value;}
    if(admission.status!=='ACTIVE')throw new Error('SESSION_NOT_ADMITTED');const status=(await req('/api/lab/operations')).value.state.admission;maximumActive=Math.max(maximumActive,status.active);if(status.active>sessionLimit)throw new Error('SESSION_LIMIT_VIOLATED');
    const writer_id=randomUUID(),claim=await req(`${s.path}/claim`,{request_id:randomUUID(),writer_id},s.cookie,false);s.fence={writer_id,writer_epoch:claim.value.writer_epoch};
    await req(`${s.path}/reserve`,{request_id:randomUUID(),...s.fence},s.cookie,false);
    const ticket_id=randomUUID(),body=action=>({action,ticket_id,...s.fence}),joined=await req(`${s.path}/preparation`,body('join'),s.cookie,false);admitted.push({index,position:joined.value.position,status:joined.value.status});let ticket=joined.value;
    while(ticket.status!=='READY'){await new Promise(r=>setTimeout(r,ticket.poll_ms));ticket=(await req(`${s.path}/preparation`,body('touch'),s.cookie,false)).value;}
    const waiting=performance.now()-started;liveStreams++;maximumStreams=Math.max(maximumStreams,liveStreams);
    try{const response=await fetch(`${origin}${s.path}/assets/${asset.result.asset_id}`,{headers:{Cookie:s.cookie,'X-Preparation-Ticket':ticket_id,'X-Writer-Id':s.fence.writer_id,'X-Writer-Epoch':String(s.fence.writer_epoch)},signal:AbortSignal.timeout(60000)});
      if(!response.ok)throw new Error('DOWNLOAD_REJECTED');if(digest(Buffer.from(await response.arrayBuffer()))!==digest(png))throw new Error('IMAGE_HASH_MISMATCH');
    }finally{liveStreams--;await req(`${s.path}/preparation`,body('release'),s.cookie,false);}
    await req(`${s.path}/terminate`,{request_id:randomUUID(),reason:'TEST_ONLY_PREPARATION_COMPLETE'},s.cookie,false);
    finished.push(index);return {index,wait_ms:waiting,complete_ms:performance.now()-started};
  }));
  const operations=(await req('/api/lab/operations')).value;
  const report={schema:'shaped-preparation-v2',mode:'TEST_ONLY',scope:'loopback HTTP aggregate response bodies capped at 125000 B/s; whole-session admission with 1s synthetic polling and explicit TEST_ONLY termination after preparation; headers/TLS/real ECS excluded; no trial timing or formal capacity claim',configured_mbps:1,session_concurrency:sessionLimit,maximum_observed_active_sessions:maximumActive,admission_queue:operations.state.admission,session_admitted:sessionAdmitted,participants:20,image_bytes:png.length,source_hash:digest(png),maximum_simultaneous_asset_streams:maximumStreams,admitted,finished,results,elapsed_ms:performance.now()-started,shaped_body_bytes:shapedBytes-bodyStart,queue:operations.preparation};
  if(maximumStreams!==1||report.queue.active||report.queue.queued)throw new Error('QUEUE_BOUND_VIOLATED');
  if(report.admission_queue.active||report.admission_queue.queued)throw new Error('SESSION_QUEUE_NOT_EMPTY');
  if(JSON.stringify(finished)!==JSON.stringify(admitted.map(a=>a.index)))throw new Error('FIFO_ORDER_VIOLATED');
  const json=JSON.stringify(report,null,2)+'\n';if(process.argv[2])await writeFile(resolve(process.argv[2]),json);console.log(json);
}finally{
  if(child&&child.exitCode===null){const ended=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await ended;}
  clearTimeout(timer);agent.destroy();proxy.closeAllConnections();await new Promise(r=>proxy.close(r));await rm(root,{recursive:true,force:true});
}

```

### scripts/profile-foundation.mjs L1–L81

```
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { root, loadEnv } from './lib.mjs';

// Foundation-only probe: read-only readiness, not participant ingestion capacity.
loadEnv();
const assets = [];
for (const name of await readdir(resolve(root, 'dist/web/assets'))) {
  const path = resolve(root, 'dist/web/assets', name);
  if (!/\.(js|css)$/.test(name)) continue;
  const bytes = await readFile(path);
  assets.push({ name, bytes: (await stat(path)).size, gzipBytes: gzipSync(bytes).length });
}
const manifest = JSON.parse(await readFile(resolve(root, 'dist/web/.vite/manifest.json'), 'utf8'));
const initialPaths = new Set();
function visit(key) {
  const item = manifest[key];
  if (!item || initialPaths.has(item.file)) return;
  initialPaths.add(item.file);
  for (const path of item.css ?? []) initialPaths.add(path);
  for (const imported of item.imports ?? []) visit(imported);
}
for (const [key, item] of Object.entries(manifest)) if (item.isEntry) visit(key);
const initialAssets = assets.filter(asset => initialPaths.has(`assets/${asset.name}`));
const child = spawn(process.execPath, [resolve(root, 'dist/server/main.js')], {
  cwd: root,
  env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', chunk => { logs = (logs + chunk.toString()).slice(-64000); });
child.stderr.on('data', () => {});
try {
  let address;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('Probe server exited');
    address = /Server listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(logs)?.[1];
    if (address) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!address) throw new Error('Probe server startup timed out');
  const latencies = [];
  let failures = 0;
  const start = performance.now();
  for (let wave = 0; wave < 10; wave++) {
    await Promise.all(Array.from({ length: 20 }, async () => {
      const before = performance.now();
      try {
        const response = await fetch(`${address}/api/health/ready`, { signal: AbortSignal.timeout(5000) });
        const body = await response.json();
        if (!response.ok || body.mode !== 'TEST_ONLY') failures++;
      } catch { failures++; }
      latencies.push(performance.now() - before);
    }));
  }
  latencies.sort((a, b) => a - b);
  const report = {
    scope: 'TEST_ONLY; 20 concurrent readiness GETs per wave; no participant writes or image preload',
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    assets,
    initialAssetBytes: initialAssets.reduce((sum, asset) => sum + asset.bytes, 0),
    initialGzipBytes: initialAssets.reduce((sum, asset) => sum + asset.gzipBytes, 0),
    initialAssets: initialAssets.map(asset => asset.name),
    requests: latencies.length, concurrency: 20, failures,
    elapsedMs: Number((performance.now() - start).toFixed(2)),