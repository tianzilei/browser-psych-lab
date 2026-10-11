全项目设计讨论，传输段 20，源码主题：HTTP和资源授权（源包 7/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

  app.get('/api/lab/assets/:asset',async(request,reply)=>{
    await admin(request,'admin.me');const asset=id((request.params as {asset:string}).asset);
    const info=await writer.request({operation:'lab/internal.asset.info',data:{asset_id:asset}}) as {state:string;format:string};
    if(!info||info.state!=='READY')throw new ContractError('ASSET_NOT_READY',404);const file=await openPrivate(await assetPath(root,asset));reply.type(`image/${info.format}`).header('Cache-Control','private, no-store, no-transform');return reply.send(file.createReadStream());
  });
  app.get('/api/lab/studies/:study/sessions',async request=>admin(request,'session.list',{study_id:id((request.params as {study:string}).study),...object(request.query)}));
  app.get('/api/lab/sessions/:session',async request=>admin(request,'session.detail',{session_id:id((request.params as {session:string}).session)}));
  app.get('/api/lab/sessions/:session/actions',async request=>admin(request,'session.actions',{session_id:id((request.params as {session:string}).session),...object(request.query)}));
  app.post('/api/lab/sessions/:session/marks',async request=>admin(request,'session.mark',{...object(request.body),session_id:id((request.params as {session:string}).session)}));
  app.get('/api/lab/jobs',async request=>admin(request,'job.list'));
  app.get('/api/lab/jobs/:job',async request=>{const job=await admin(request,'job.get',{job_id:id((request.params as {job:string}).job)}) as {job_id?:string};if(!job.job_id)throw new ContractError('JOB_NOT_FOUND',404);return job;});
  app.get('/api/lab/operations',async request=>{await admin(request,'admin.me');const fs=await statfs(root);let wal=0;try{wal=(await lstat(`${maintenance.path}-wal`)).size;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}const state=await writer.request({operation:'lab/internal.operations',data:{}});return {state,writer:writer.stats(),maintenance_busy:maintenance.busy,preparation:preparation.stats(),wal_bytes:wal,free_bytes:fs.bavail*fs.bsize,process:process.memoryUsage()};});
  app.post('/api/lab/jobs/:job/recover',async request=>{const d={...object(request.body),job_id:id((request.params as {job:string}).job)};const review=await admin(request,'job.recover',d) as {report:string};return maintenance.recover(d.job_id,review.report);});
  for(const kind of ['EXPORT','BACKUP','REBUILD'])app.post(`/api/lab/jobs/${kind.toLowerCase()}`,async request=>{
    if(maintenance.busy)throw new ContractError('MAINTENANCE_BUSY',503);
    const d=object(request.body);const job=id(d.job_id);await admin(request,'job.begin',{request_id:id(d.request_id),job_id:job,kind,study_id:kind!=='BACKUP'?id(d.study_id):null,config:d});
    const original=await admin(request,'job.get',{job_id:job}) as {state:string;result:string};if(original.state==='READY')return {job_id:job,result:JSON.parse(original.result)};
    // Request remains pending until READY; asynchronous work is isolated in one maintenance worker.
    return maintenance.run(kind,{...d,...(kind==='BACKUP'?{independent_root:process.env.BACKUP_ROOT??''}:{})},job);
  });
  app.get('/api/lab/jobs/:job/:file',async(request,reply)=>{
    const params=request.params as {job:string;file:string};const job=await admin(request,'job.get',{job_id:id(params.job)}) as {state:string;kind:string};
    if(job.state!=='READY'||!['EXPORT','BACKUP'].includes(job.kind))throw new ContractError('JOB_NOT_READY',409);
    const file=await safeDownload(root,params.job,params.file,job.kind==='EXPORT'?'research-exports':'research-backups');
    reply.header('Content-Disposition',`attachment; filename="${params.file}"`).header('Cache-Control','private, no-store, no-transform');return reply.send(file.createReadStream());
  });
  app.get('/api/lab/environments',async request=>admin(request,'environment.list'));
  app.post('/api/lab/environments',async request=>admin(request,'environment.put',object(request.body)));
  app.post('/api/lab/collection-gate/close',async request=>admin(request,'gate.close',object(request.body)));
  app.post('/api/lab/collection-gate',async request=>admin(request,'gate.open',object(request.body)));
  app.get('/api/participate/versions/:version',async request=>writer.request({operation:'lab/version.public',data:{version_id:id((request.params as {version:string}).version)}}));
  app.get('/api/questionnaires',async()=>writer.request({operation:'lab/questionnaires.public',data:{}}));
  app.get('/api/participate/versions/:version/metadata',async request=>writer.request({operation:'lab/version.metadata',data:{version_id:id((request.params as {version:string}).version)}}));
  app.get('/api/participate/versions/:version/consent',async request=>writer.request({operation:'lab/version.consent',data:{version_id:id((request.params as {version:string}).version)}}));
  app.post('/api/participate/sessions',async(request,reply)=>{
    const d=object(request.body);if(typeof d.credential!=='string'||!/^[a-f0-9]{64}$/.test(d.credential))throw new ContractError('INVALID_CREDENTIAL');
    const result=await writer.request({operation:'lab/participant.create',data:{request_id:id(d.request_id),version_id:id(d.version_id),credential_hash:digest(d.credential),...(d.consent!==undefined?{consent:d.consent}:{}),server_covariates:{observed_at:new Date().toISOString(),ip:request.ip,user_agent:request.headers['user-agent']??null,accept_language:request.headers['accept-language']??null,accept_encoding:request.headers['accept-encoding']??null,client_hints:Object.fromEntries(Object.entries(request.headers).filter(([k])=>k.startsWith('sec-ch-ua')))}}}) as {session_id:string};
    reply.header('Set-Cookie',`lab_${result.session_id}=${d.credential}; HttpOnly; SameSite=Strict; Path=/api/participate/sessions/${result.session_id}${secure(request)?'; Secure':''}`);return result;
  });
  app.post('/api/participate/sessions/:session/reanswer',async(request,reply)=>{
    const params=request.params as {session:string};const sid=id(params.session),token=cookie(request,`lab_${sid}`);if(!/^[a-f0-9]{64}$/.test(token))throw new ContractError('UNAUTHORIZED',401);
    const data=object(request.body),credential=data.credential;if(typeof credential!=='string'||!/^[a-f0-9]{64}$/.test(credential))throw new ContractError('INVALID_CREDENTIAL');const result=await writer.request({operation:'lab/participant.reanswer',session_id:sid,credential_hash:digest(token),data:{request_id:id(data.request_id),credential_hash:digest(credential)}}) as {session_id:string};
    reply.header('Set-Cookie',`lab_${result.session_id}=${credential}; HttpOnly; SameSite=Strict; Path=/api/participate/sessions/${result.session_id}${secure(request)?'; Secure':''}`);return {...result,credential};
  });
  app.get('/api/participate/sessions/:session',async request=>participant(request,'view'));
  app.post('/api/participate/sessions/:session/resume',async(request,reply)=>{
    const sid=id((request.params as {session:string}).session),credential=object(request.body).credential;if(typeof credential!=='string'||!/^[a-f0-9]{64}$/.test(credential))throw new ContractError('INVALID_CREDENTIAL');const result=await writer.request({operation:'lab/participant.view',session_id:sid,credential_hash:digest(credential),data:{}});
    reply.header('Set-Cookie',`lab_${sid}=${credential}; HttpOnly; SameSite=Strict; Path=/api/participate/sessions/${sid}${secure(request)?'; Secure':''}`);return result;
  });
  app.post('/api/participate/sessions/:session/preparation',async request=>{
    const d=object(request.body),nonce=id(d.ticket_id),action=String(d.action);
    if(action==='release'){const s=await participant(request,'preparation.release') as {session_id:string};return preparation.releaseSession(s.session_id,nonce);}
    const info=await participant(request,'preparation',d) as {key:string};
    if(action==='join')return preparation.join(info.key,nonce);
    if(action==='touch')return preparation.touch(info.key,nonce);
    throw new ContractError('INVALID_PREPARATION_ACTION');
  });
  app.post('/api/participate/sessions/:session/admission',async request=>participant(request,'admission',object(request.body)));
  for(const op of ['activity','claim','release','reserve','permit','ingest','receipts','seal','finalize','terminate','reconcile','covariates'])app.post(`/api/participate/sessions/:session/${op}`,{bodyLimit:1024*1024},async request=>{
    const data=object(request.body);delete data.proof_job_id;
    if(op==='permit'){
      const session=await participant(request,'view') as {frozen:{runner_hash:string}};
      if(await assetPolicy.requiresActivity(session.frozen.runner_hash))object(data.readiness).activity_policy='idle120-offline300-v1';
    }
    if(op==='seal'&&String(object(data.manifest).scope).startsWith('g-')){
      const params=request.params as {session:string};await participant(request,'admission.check');
      const proof=await maintenance.run('REPLAY',{session_id:id(params.session),scope:id(object(data.manifest).scope)});data.proof_job_id=proof.job_id;
    }return participant(request,op,data);
  });
  app.get('/api/participate/sessions/:session/assets/:asset',async(request,reply)=>{
    const asset=id((request.params as {asset:string}).asset);
    const info=await participant(request,'asset',{asset_id:asset}) as {format:string;hash:string;state:string;runner_hash:string};
    if(info.state!=='READY')throw new ContractError('ASSET_NOT_READY',409);
    const headerless=['x-preparation-ticket','x-writer-id','x-writer-epoch'].every(h=>request.headers[h]===undefined);
    let stream:Readable|undefined,closed=false,done:(()=>void)|undefined;
    const connection=new AbortController();
    const cancel=()=>{closed=true;stream?.destroy();reply.raw.destroy();};
    const release=()=>{closed=true;connection.abort(new Error('ASSET_CONNECTION_CLOSED'));stream?.destroy();done?.();};
    reply.raw.once('finish',release);reply.raw.once('close',release);
    try{
      if(headerless){
        // Only archives predating the queue contract may use their original GET.
        // Their pending requests still share the global FIFO stream budget.
        if(await assetPolicy.get(info.runner_hash)!=='legacy')throw new ContractError('PREPARATION_TICKET_REQUIRED',409);
        done=await preparation.legacyTransfer(id((request.params as {session:string}).session),connection.signal,cancel);
      }else{
        const nonce=id(request.headers['x-preparation-ticket']);
        const ready=await participant(request,'preparation',{writer_id:id(request.headers['x-writer-id']),writer_epoch:Number(request.headers['x-writer-epoch'])}) as {key:string;asset_ids:string[]};
        if(!ready.asset_ids.includes(asset))throw new ContractError('ASSET_FORBIDDEN',403);
        done=preparation.transfer(ready.key,nonce,cancel);
      }
      const file=await openPrivate(await assetPath(root,asset));stream=file.createReadStream();
      if(closed||reply.raw.destroyed){stream.destroy();done();throw new ContractError('PREPARATION_TICKET_EXPIRED',409);}stream.once('error',cancel);
      reply.type(`image/${info.format}`).header('ETag',`"${info.hash}"`).header('Cache-Control','private, no-store, no-transform');return reply.send(stream);
    }catch(error){done?.();throw error;}
  });
  app.get('/runners/:hash/*',async(request,reply)=>{
    const params=request.params as {hash:string;'*':string};if(!/^[a-f0-9]{64}$/.test(params.hash)||!params['*']||params['*'].split('/').some(p=>!p||p==='..'||! /^[a-zA-Z0-9._-]+$/.test(p)))throw new ContractError('INVALID_RUNNER_OBJECT',404);
    const path=join(root,'research-assets','runners',params.hash,params['*']),suffix=params['*'].split('.').at(-1);
    reply.type(suffix==='js'?'text/javascript':suffix==='css'?'text/css':suffix==='html'?'text/html':'application/json');
    reply.header('Vary','Accept-Encoding').header('Cache-Control',suffix==='html'?'no-cache, no-transform':'public, max-age=31536000, immutable, no-transform');
    for(const encoding of runnerEncodings(request.headers['accept-encoding'])){
      if(encoding!=='identity'&&!/^assets\/.*\.(js|css)$/.test(params['*']))continue;
      try{const file=await openPrivate(encoding==='identity'?path:`${path}.${encoding==='br'?'br':'gz'}`);
        if(encoding!=='identity')reply.header('Content-Encoding',encoding);
        reply.header('Content-Length',(await file.stat()).size);return reply.send(file.createReadStream());
      }catch(error){if(encoding==='identity'||(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    throw new ContractError('ENCODING_NOT_ACCEPTABLE',406);
  });
}

```

### src/server/preparation-queue.ts L1–L58

```
import {ContractError} from '../shared/contract.js';
import {randomUUID} from 'node:crypto';
interface Ticket {key:string;nonce:string;joined:number;seen:number;started:number|null;closing:boolean;streams:Set<()=>void>}
// Ephemeral preparation state only. Formal allocations/events remain in SQLite.
export class PreparationQueue {
  private tickets:Ticket[]=[];
  constructor(private concurrency=1,private now=Date.now,private leaseMs=90000){
    if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>10000)throw new Error('INVALID_PREPARATION_CONCURRENCY');
  }
  private sweep(){
    const time=this.now();
    for(const t of [...this.tickets]){
      if(!t.closing&&((t.started!==null&&time-t.started>=20*60000)||(time-t.seen>=this.leaseMs&&t.streams.size===0))){
        t.closing=true;for(const cancel of t.streams)cancel();
      }
    }
    this.tickets=this.tickets.filter(t=>!t.closing||t.streams.size>0);
  }
  join(key:string,nonce:string){
    this.sweep();const old=this.tickets.find(t=>t.key===key);
    if(old&&old.nonce!==nonce)throw new ContractError('PREPARATION_ALREADY_ACTIVE',409);
    if(!old){if(this.tickets.length>=this.concurrency)throw new ContractError('PREPARATION_CAPACITY_FULL',409,{retry_after_seconds:1800});