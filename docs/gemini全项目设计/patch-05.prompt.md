这是实施后设计复审 5/7。内容为当前修改源码、测试或采用设计。先吸收本段；只回复“已接收复审5”，等全部7段后再讨论。

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
  const value=await response.json();if(!response.ok)throw Object.assign(new Error(`${path}: ${value.code}`),{status:response.status,code:value.code});return {value,cookie:response.headers.get('set-cookie')?.split(';')[0]};
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
  const results=await Promise.all(sessions.map(async(s,index)=>{try{
    const admissionTicket=randomUUID();let admission=(await req(`${s.path}/admission`,{action:'join',ticket_id:admissionTicket},s.cookie,false)).value;
    sessionAdmitted.push({index,position:admission.position,status:admission.status});
    if(admission.status!=='ACTIVE')throw new Error('SESSION_NOT_ADMITTED');const status=(await req('/api/lab/operations')).value.state.admission;maximumActive=Math.max(maximumActive,status.active);if(status.active>sessionLimit)throw new Error('SESSION_LIMIT_VIOLATED');
    const writer_id=randomUUID(),claim=await req(`${s.path}/claim`,{request_id:randomUUID(),writer_id},s.cookie,false);s.fence={writer_id,writer_epoch:claim.value.writer_epoch};
    await req(`${s.path}/reserve`,{request_id:randomUUID(),...s.fence},s.cookie,false);
    const ticket_id=randomUUID(),body=action=>({action,ticket_id,...s.fence}),joined=await req(`${s.path}/preparation`,body('join'),s.cookie,false);admitted.push({index,position:joined.value.position,status:joined.value.status});
    if(joined.value.status!=='READY')throw new Error('PREPARATION_NOT_ADMITTED');
    const waiting=performance.now()-started;liveStreams++;maximumStreams=Math.max(maximumStreams,liveStreams);
    try{const response=await fetch(`${origin}${s.path}/assets/${asset.result.asset_id}`,{headers:{Cookie:s.cookie,'X-Preparation-Ticket':ticket_id,'X-Writer-Id':s.fence.writer_id,'X-Writer-Epoch':String(s.fence.writer_epoch)},signal:AbortSignal.timeout(60000)});
      if(!response.ok)throw new Error('DOWNLOAD_REJECTED');if(digest(Buffer.from(await response.arrayBuffer()))!==digest(png))throw new Error('IMAGE_HASH_MISMATCH');
    }finally{liveStreams--;await req(`${s.path}/preparation`,body('release'),s.cookie,false);}
    await req(`${s.path}/terminate`,{request_id:randomUUID(),reason:'TEST_ONLY_PREPARATION_COMPLETE'},s.cookie,false);
    finished.push(index);return {index,status:'PREPARED',wait_ms:waiting,complete_ms:performance.now()-started};
    }catch(error){
      if(error.status!==409||!['SESSION_CAPACITY_FULL','PREPARATION_CAPACITY_FULL'].includes(error.code))throw error;
      await req(`${s.path}/terminate`,{request_id:randomUUID(),reason:'TEST_ONLY_CAPACITY_REJECTED',evidence:{code:error.code}},s.cookie,false);
      return {index,status:'REJECTED',reason:error.code,retry_after_seconds:1800};
    }
  }));
  const operations=(await req('/api/lab/operations')).value;
  const report={schema:'shaped-preparation-v3',admission_mode:'reject_when_full',outcomes:{prepared:finished.length,capacity_rejected:results.filter(r=>r.status==='REJECTED').length},mode:'TEST_ONLY',scope:'loopback HTTP aggregate response bodies capped at 125000 B/s; immediate task/preparation capacity rejection without waiting polling and explicit TEST_ONLY termination after preparation; headers/TLS/real ECS excluded; no trial timing or formal capacity claim',configured_mbps:1,session_concurrency:sessionLimit,maximum_observed_active_sessions:maximumActive,admission_queue:operations.state.admission,session_admitted:sessionAdmitted,participants:20,image_bytes:png.length,source_hash:digest(png),maximum_simultaneous_asset_streams:maximumStreams,admitted,finished,results,elapsed_ms:performance.now()-started,shaped_body_bytes:shapedBytes-bodyStart,queue:operations.preparation};
  if(maximumStreams!==1||report.queue.active||report.queue.queued)throw new Error('QUEUE_BOUND_VIOLATED');
  if(report.admission_queue.active||report.admission_queue.queued)throw new Error('SESSION_QUEUE_NOT_EMPTY');
  if(finished.length!==admitted.length||admitted.some(a=>!finished.includes(a.index)))throw new Error('ADMITTED_DOWNLOAD_INCOMPLETE');
  const json=JSON.stringify(report,null,2)+'\n';if(process.argv[2])await writeFile(resolve(process.argv[2]),json);console.log(json);
}finally{
  if(child&&child.exitCode===null){const ended=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await ended;}
  clearTimeout(timer);agent.destroy();proxy.closeAllConnections();await new Promise(r=>proxy.close(r));await rm(root,{recursive:true,force:true});
}


## tests/runner-browser/runner.spec.ts
import {test,expect,type Page} from '@playwright/test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../../src/server/database.js';
import {LabStore} from '../../src/server/lab-store.js';
import {digest} from '../../src/server/collection-store.js';
import {compileQuestionnaire} from '../../src/shared/questionnaire-json.js';
import {RunReplay} from '../../src/shared/run-replay.js';
import {stableJSON} from '../../src/shared/protocol.js';
import sharp from 'sharp';

async function start(page:Page,rating=false){
  const root=mkdtempSync(join(tmpdir(),'bpl-runner-')),db=openDatabase(join(root,'db.sqlite')),store=new LabStore(db,digest('runner'));
  const token=digest('admin'),csrf=randomUUID();store.execute({operation:'lab/admin.issue',data:{token_hash:token,csrf}});
  const admin=(operation:string,data:Record<string,unknown>={})=>store.execute({operation:`lab/${operation}`,credential_hash:token,data:{csrf,...data}}) as any;
  const study=admin('study.create',{request_id:randomUUID()}),png=await sharp({create:{width:1080,height:720,channels:3,background:'#587a91'}}).png().toBuffer(),asset=admin('asset.begin',{request_id:randomUUID(),study_id:study.study_id,name:'test.png'});
  store.execute({operation:'lab/internal.asset.ready',data:{asset_id:asset.asset_id,info:{hash:digest(png),bytes:png.length,width:1080,height:720,format:'png'}}});
  const p=compileQuestionnaire(rating?{schema:'questionnaire-v1',title:'Rating regression',orientation:'portrait',pages:[],layout:{aspect:413/626,portrait_min_width:120},budget:{commit_ms:200,long_frame_ms:1000},
    groups:[{id:'ratings',title:'评分测试',choices:['1','2','3','4','5','6','7','8','9'],repeats:0,rating:{prompt:'测试评分',items:['测试项目'],labels:['完全不','非常少','较少','有一点','一般','较多','很多','几乎完全','非常']},
      trials:[{root_id:'first',asset_id:asset.asset_id,correct:null,image_ms:1,isi_ms:3000},{root_id:'second',asset_id:'rating-second-asset',correct:null,image_ms:1,isi_ms:3000}]}]}:{schema:'questionnaire-v1',title:'Runner regression',orientation:'portrait',pages:[],budget:{commit_ms:40,long_frame_ms:1000},
    timing_defaults:{stimulus_ms:1500,isi_ms:500,feedback_ms:300},groups:[{id:'task',title:'Task',choices:['Left','Right'],response_keys:{Right:'KeyJ',Left:'KeyF'},
    feedback:{correct:'Correct',incorrect:'Incorrect',miss:'Miss',neutral:'Recorded'},repeats:0,
    trials:[{root_id:'image',asset_id:asset.asset_id,correct:'Left'},{root_id:'text',text:'HELLO',correct:'Right'}]}]});
  if(rating){const second=admin('asset.begin',{request_id:randomUUID(),study_id:study.study_id,name:'second.png'});p.groups[0]!.trials[1]!.asset_id=second.asset_id;store.execute({operation:'lab/internal.asset.ready',data:{asset_id:second.asset_id,info:{hash:digest(png),bytes:png.length,width:1080,height:720,format:'png'}}});}
  const saved=admin('study.save',{request_id:randomUUID(),revision:1,study_id:study.study_id,protocol:p});
  const version=admin('study.publish',{request_id:randomUUID(),revision:saved.revision,study_id:study.study_id});
  admin('study.admission',{request_id:randomUUID(),study_id:study.study_id,paused:false});
  let sid:string,groupCalls=0,assetCalls=0;
  const call=(op:string,data:Record<string,unknown>={})=>store.execute({operation:`lab/participant.${op}`,session_id:sid,credential_hash:digest('test'),data}) as any;
  await page.addInitScript(version=>sessionStorage.setItem(`lab-writer-${version}`,'writer-a'),version.version_id);
  await page.route('**/api/participate/**',async route=>{
    const url=new URL(route.request().url()),path=url.pathname,body=route.request().postDataJSON()??{};
    try{let result:any;
      if(path.includes('/versions/')){
        result=path.endsWith('/metadata')?{title:p.title,background:p.layout.background,orientation:'portrait'}:path.endsWith('/consent')?null:version;
      }else if(path==='/api/participate/sessions'){
        const created=store.execute({operation:'lab/participant.create',data:{request_id:body.request_id,version_id:version.version_id,credential_hash:digest('test')}}) as any;
        sid=created.session_id;result=created;
      }else{
        const op=path.split('/')[5];
        if(op==='assets'){assetCalls++;await route.fulfill({body:png,contentType:'image/png'});return;}
        if(op==='covariates')result={hash:digest(body.raw),status:'PERSISTED'};
        else if(op==='preparation')result=body.action==='release'?{}:{status:'READY',ticket_id:body.ticket_id};
        else if(op==='seal'){
          const permit=call('view').permit,replay=new RunReplay(permit.plan);