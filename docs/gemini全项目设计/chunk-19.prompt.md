全项目设计讨论，传输段 19，源码主题：HTTP和资源授权（源包 7/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

### src/server/main.ts L1–L98

```
import Fastify, { LogController } from 'fastify';
import fastifyStatic from '@fastify/static';
import { DatabaseWriter, WriterError } from './writer.js';
import { collectionRoutes } from './collection-routes.js';
import { ContractError } from '../shared/contract.js';
import { labRoutes } from './lab-routes.js';
import { Maintenance } from './maintenance.js';
import { privateRoot } from './private-files.js';
import { retainRelease } from './release.js';
import { access,readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

try { process.loadEnvFile(); } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
if (!process.env.DATABASE_PATH) throw new Error('Run npm run setup or configure DATABASE_PATH.');
const tlsKey=process.env.TLS_KEY_PATH,tlsCert=process.env.TLS_CERT_PATH;
if(!!tlsKey!==!!tlsCert)throw new Error('TLS_KEY_PATH and TLS_CERT_PATH must be configured together.');
const tls=tlsKey&&tlsCert?{key:await readFile(tlsKey),cert:await readFile(tlsCert)}:undefined;

const storageRoot = await privateRoot(resolve(process.env.STORAGE_ROOT ?? './var'));
for(const bucket of ['research-assets','research-exports','research-backups']) await privateRoot(resolve(storageRoot,bucket));
const runnerHash = await retainRelease(storageRoot);
const sessionConcurrency=Number(process.env.SESSION_CONCURRENCY??2);
if(!Number.isSafeInteger(sessionConcurrency)||sessionConcurrency<1||sessionConcurrency>10000)throw new Error('INVALID_SESSION_CONCURRENCY');
const writer = new DatabaseWriter(resolve(process.env.DATABASE_PATH),{workerData:{runnerHash,sessionConcurrency}});
await writer.start();
export const app = Fastify({
  ...(tls?{https:tls}:{}),
  trustProxy:'127.0.0.1',
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'],
  },
  logController: new LogController({ disableRequestLogging: true }),
});
const maintenance = new Maintenance(writer,resolve(process.env.DATABASE_PATH),storageRoot);
app.setErrorHandler((error, _request, reply) => {
  const known = error instanceof ContractError || error instanceof WriterError;
  const status = known ? error.status : ((error as { statusCode?: number }).statusCode ?? 500);
  if (status === 503) reply.header('Retry-After', '1');
  if (known && ['SESSION_CAPACITY_FULL','PREPARATION_CAPACITY_FULL'].includes(error.code)) reply.header('Retry-After','1800');
  return reply.code(status).send({ code: known ? error.code : 'REQUEST_FAILED',
    ingestion: error instanceof WriterError ? error.ingestion : 'NOT_INGESTED',
    details: known ? error.details : null });
});
app.addHook('onRequest', async (request, reply) => {
  const frameAncestors=request.url.split('?')[0]==='/simulate.html'?"'self'":"'none'";
  reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer').header('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors ${frameAncestors}; base-uri 'self'; form-action 'self'`);
  if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
});
app.addHook('onResponse', async (request, reply) => {
  if (reply.statusCode >= 400) {
    // No raw URL, cookies or submitted data. Durable business audit belongs in DB.
    app.log.warn({ requestId: request.id, statusCode: reply.statusCode }, 'HTTP request failed');
  }
});

app.get('/api/health/live', async () => ({ status: 'ok', mode: 'TEST_ONLY' }));
app.get('/api/health/ready', async (_request, reply) => {
  try {
    const result = await writer.request({ operation: 'health', data: {} }) as { version: string };
    for (const bucket of ['research-assets', 'research-exports', 'research-backups']) {
      await access(resolve(storageRoot, bucket));
    }
    return { status: 'ok', mode: 'TEST_ONLY', database: `SQLite ${result.version}`, storage: 'ready' };
  } catch {
    reply.code(503);
    return { status: 'unavailable', mode: 'TEST_ONLY' };
  }
});

// Only Vite output is public; research storage has no static route.
const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
if (process.env.NODE_ENV === 'production') {
  await app.register(fastifyStatic, {
    root: webRoot,
    preCompressed: true,
    cacheControl: false,
    setHeaders(reply, path) {
      const assetPath = relative(webRoot, path).replaceAll('\\', '/');
      reply.header('Cache-Control', assetPath.startsWith('assets/')
        ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
}
await collectionRoutes(app, writer);
await labRoutes(app,writer,maintenance,storageRoot);
app.addHook('onClose', async () => { await maintenance.close(); await writer.close(); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().catch(() => { process.exitCode = 1; });
  });
}
try { await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 3000) }); }
catch (error) { await app.close(); throw error; }

```

### src/server/lab-routes.ts L1–L198

```
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {randomBytes,randomUUID} from 'node:crypto';
import {resolve,join} from 'node:path';
import {readFile,lstat,readdir,unlink,statfs} from 'node:fs/promises';
import type {Readable} from 'node:stream';
import {DatabaseWriter} from './writer.js';
import {Maintenance} from './maintenance.js';
import {runnerEncodings} from './runner-encoding.js';
import {PreparationQueue} from './preparation-queue.js';
import {RunnerAssetPolicy} from './runner-asset-policy.js';
import {digest} from './collection-store.js';
import {verifyPassword,RateLimits} from './auth.js';
import {ContractError,id,object} from '../shared/contract.js';
import {receiveUpload,assetPath,openPrivate,safeDownload,fileHash,privateRoot} from './private-files.js';
export async function labRoutes(app:FastifyInstance,writer:DatabaseWriter,maintenance:Maintenance,root:string){
  const preparation=new PreparationQueue(Number(process.env.PREPARATION_CONCURRENCY??1)),assetPolicy=new RunnerAssetPolicy(root);
  app.addHook('onClose',async()=>preparation.close());
  const limits=new RateLimits();let loginBusy=0;let receiving=0,receivingBytes=0;const charged=new Map<string,number>();
  const secure=(request:FastifyRequest)=>request.protocol==='https'||(process.env.PUBLIC_ORIGIN??'').startsWith('https:');
  const cookie=(request:FastifyRequest,name:string)=>request.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith(`${name}=`))?.slice(name.length+1)??'';
  const release=(r:FastifyRequest)=>{const b=charged.get(r.id);if(b!==undefined){receiving--;receivingBytes-=b;charged.delete(r.id);}};
  app.addHook('onResponse',async request=>release(request));app.addHook('onRequestAbort',async request=>release(request));
  app.addHook('onRequest',async(request,reply)=>{
    if(!/^\/api\/(auth|lab|participate)(\/|$)/.test(request.url))return;
    limits.take('global',200,100);const session=(request.params as {session?:string}).session;
    if(session)limits.take(`session-${session}`,50,10);
    if(request.method!=='GET'){
      const expected=process.env.PUBLIC_ORIGIN||`${request.protocol}://${request.host}`;
      if(request.headers.origin!==expected)throw new ContractError('ORIGIN_REJECTED',403);
      const upload=request.routeOptions.url?.endsWith('/upload')||request.routeOptions.url?.endsWith('/package');const declared=Number(request.headers['content-length']??(upload?8*1024*1024:1024*1024));
      const max=upload?8*1024*1024:1024*1024;if(!Number.isSafeInteger(declared)||declared<0||declared>max)throw new ContractError('REQUEST_TOO_LARGE',413);
      const bytes=declared*2+1024;if(receiving>=32||receivingBytes+bytes>20*1024*1024)throw new ContractError('RECEIVE_QUEUE_FULL',503);
      receiving++;receivingBytes+=bytes;charged.set(request.id,bytes);
      if(!upload&&!request.headers['content-type']?.startsWith('application/json'))throw new ContractError('JSON_REQUIRED',415);
    }
    reply.header('Cache-Control','no-store');
  });
  const admin=(request:FastifyRequest,op:string,data:Record<string,unknown>={})=>writer.request({operation:`lab/${op}`,
    credential_hash:digest(cookie(request,'lab_admin')),data:{...data,csrf:request.headers['x-csrf-token']??''}});
  const participant=(request:FastifyRequest,op:string,data:Record<string,unknown>={})=>{
    const sid=id((request.params as {session:string}).session);const token=cookie(request,`lab_${sid}`);
    if(!/^[a-f0-9]{64}$/.test(token))throw new ContractError('UNAUTHORIZED',401);
    return writer.request({operation:`lab/participant.${op}`,session_id:sid,credential_hash:digest(token),data},op!=='ingest');
  };
  app.post('/api/auth/login',{bodyLimit:2048},async(request,reply)=>{
    limits.take(`login-${request.ip}`,5,.1);if(loginBusy>=2)throw new ContractError('LOGIN_BUSY',503);
    const d=object(request.body);if(typeof d.password!=='string'||Object.keys(d).some(key=>key!=='password'))throw new ContractError('INVALID_LOGIN');
    const stored=process.env.ADMIN_PASSWORD_HASH;
    if(!stored)throw new ContractError('LOGIN_NOT_CONFIGURED',503);loginBusy++;
    let valid:boolean;try{valid=await verifyPassword(d.password,stored);}finally{loginBusy--;}
    if(!valid)throw new ContractError('INVALID_LOGIN',401);const token=randomBytes(32).toString('hex'),csrf=randomUUID();
    const result=await writer.request({operation:'lab/admin.issue',data:{token_hash:digest(token),csrf}});
    reply.header('Set-Cookie',`lab_admin=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=28800${secure(request)?'; Secure':''}`);return result;
  });
  app.get('/api/auth/me',async request=>admin(request,'admin.me'));
  app.post('/api/auth/logout',async(request,reply)=>{const result=await admin(request,'admin.logout');reply.header('Set-Cookie',`lab_admin=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0${secure(request)?'; Secure':''}`);return result;});
  app.get('/api/lab/studies',async request=>admin(request,'study.list'));
  app.post('/api/lab/studies',async request=>admin(request,'study.create',object(request.body)));
  app.get('/api/lab/studies/:study',async request=>admin(request,'study.get',{study_id:id((request.params as {study:string}).study)}));
  for(const op of ['save','publish','admission','import','delete'])app.post(`/api/lab/studies/:study/${op}`,async request=>admin(request,`study.${op}`,{...object(request.body),study_id:id((request.params as {study:string}).study)}));
  app.get('/api/lab/studies/:study/assets',async request=>admin(request,'asset.list',{study_id:id((request.params as {study:string}).study)}));
  app.addContentTypeParser(['image/png','image/jpeg','image/webp'],(request,payload,done)=>done(null,payload));
  app.addContentTypeParser('application/zip',(request,payload,done)=>done(null,payload));
  app.post('/api/lab/studies/:study/package',{bodyLimit:8*1024*1024},async request=>{
    if(maintenance.busy)throw new ContractError('MAINTENANCE_BUSY',503);
    const study=id((request.params as {study:string}).study),job=id(request.headers['x-request-id']),name=decodeURIComponent(String(request.headers['x-file-name']??''));
    await admin(request,'package.begin',{request_id:job,job_id:job,study_id:study,name});
    const original=await admin(request,'job.get',{job_id:job}) as {state:string;result:string};
    if(original.state==='READY'){const result=JSON.parse(original.result) as {hash:string},temp=await receiveUpload(root,job,request.body as Readable);const matches=await fileHash(temp.path)===result.hash;await unlink(temp.path);if(!matches)throw new ContractError('UPLOAD_IDEMPOTENCY_CONFLICT',409);return {job_id:job,result};}
    if(original.state!=='RUNNING')throw new ContractError('UPLOAD_RECOVERY_REQUIRED',409);
    try{const temp=await receiveUpload(root,job,request.body as Readable);return await maintenance.run('PACKAGE',{study_id:study,name,temp:temp.path,package_id:job},job);}
    catch(error){await writer.request({operation:'lab/internal.job.finish',data:{job_id:job,state:'RECOVERY_REQUIRED',error:String(error)}}).catch(()=>{});throw error;}
  });
  app.post('/api/lab/studies/:study/upload',{bodyLimit:8*1024*1024},async request=>{
    if(maintenance.busy)throw new ContractError('MAINTENANCE_BUSY',503);
    const study=id((request.params as {study:string}).study);const requestId=id(request.headers['x-request-id']);
    const job=requestId;const intent=await admin(request,'asset.begin',{request_id:requestId,job_id:job,study_id:study,name:decodeURIComponent(String(request.headers['x-file-name']??'image'))}) as {asset_id:string;state:string};
    try{const temp=await receiveUpload(root,intent.asset_id,request.body as Readable);const original=await admin(request,'job.get',{job_id:job}) as {state:string;result:string};
      if(original.state==='READY'){const result=JSON.parse(original.result) as {info:{hash:string}};const matches=await fileHash(temp.path)===result.info.hash;await unlink(temp.path);if(!matches)throw new ContractError('UPLOAD_IDEMPOTENCY_CONFLICT',409);return {job_id:job,result};}
      if(original.state!=='RUNNING')throw new ContractError('UPLOAD_RECOVERY_REQUIRED',409);return await maintenance.run('UPLOAD',{asset_id:intent.asset_id,temp:temp.path,study_id:study},job);}
    catch(error){await writer.request({operation:'lab/internal.job.finish',data:{job_id:job,state:'RECOVERY_REQUIRED',error:error instanceof Error?error.message:'UPLOAD_FAILED'}}).catch(()=>{});throw error;}
  });
  app.post('/api/lab/assets/:asset/delete',async request=>{
    const asset=id((request.params as {asset:string}).asset);await admin(request,'asset.delete',{...object(request.body),asset_id:asset});
    return maintenance.run('DELETE',{asset_id:asset});
  });