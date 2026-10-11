import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import Fastify from 'fastify';
import {DatabaseWriter,WriterError} from '../../src/server/writer.ts';
import {Maintenance} from '../../src/server/maintenance.ts';
import {labRoutes} from '../../src/server/lab-routes.ts';
import {retainRelease} from '../../src/server/release.ts';
import {digest} from '../../src/server/collection-store.ts';
import {ContractError} from '../../src/shared/contract.ts';
import {writeDurable,assetPath} from '../../src/server/private-files.ts';
import {sampleProtocol} from '../../src/shared/protocol.ts';

test('frozen legacy GET remains private and shares capacity; new runner cannot omit a ticket',async t=>{
  const root=await mkdtemp(join(tmpdir(),'bpl-asset-compat-')),dist=join(root,'dist');await mkdir(join(dist,'web'),{recursive:true,mode:0o700});
  const source='<canvas></canvas>',files=[{path:'run.html',hash:digest(source)}],oldHash=digest(JSON.stringify(files));
  await writeFile(join(dist,'web/run.html'),source);await writeFile(join(dist,'release.json'),JSON.stringify({runnerHash:oldHash,runnerVersion:'canvas-v1',files}));await retainRelease(root,dist);
  const contract=JSON.stringify({schema:'runner-assets-v1',preparation_queue:true}),currentFiles=[...files,{path:'runner-contract.json',hash:digest(contract)}],newHash=digest(JSON.stringify(currentFiles));
  await writeFile(join(dist,'web/runner-contract.json'),contract);await writeFile(join(dist,'release.json'),JSON.stringify({runnerHash:newHash,runnerVersion:'canvas-v1',files:currentFiles}));await retainRelease(root,dist);
  const path=join(root,'db.sqlite');let writer=new DatabaseWriter(path,{workerData:{runnerHash:oldHash}}),maintenance,app;
  await writer.start();t.after(async()=>{await app?.close();await maintenance?.close();await writer.close();await rm(root,{recursive:true,force:true});});
  const call=(op,data={},extra={})=>writer.request({operation:`lab/${op}`,data,...extra});
  const token=digest('TEST_ONLY-operator'),csrf=randomUUID();await call('admin.issue',{token_hash:token,csrf});
  const admin=(op,data={})=>call(op,{...data,csrf},{credential_hash:token});
  const study=await admin('study.create',{request_id:randomUUID()}),asset=await admin('asset.begin',{request_id:randomUUID(),study_id:study.study_id,name:'fixture.png'});
  const png=await sharp({create:{width:24,height:24,channels:3,background:'#123456'}}).png().toBuffer();await writeDurable(await assetPath(root,asset.asset_id),png);
  await call('internal.asset.ready',{asset_id:asset.asset_id,info:{hash:digest(png),bytes:png.length,width:24,height:24,format:'png'}});
  const p=sampleProtocol();p.pages=[];p.groups=[{id:'images',title:'Images',choices:['left','right'],repeats:0,trials:[{root_id:'one',asset_id:asset.asset_id,image_ms:200,isi_ms:300,correct:null}]}];p.variants[0].group_order=['images'];p.variants[0].trial_order={images:['one']};
  await admin('study.save',{request_id:randomUUID(),study_id:study.study_id,revision:1,protocol:p});const old=await admin('study.publish',{request_id:randomUUID(),study_id:study.study_id,revision:2});await admin('study.admission',{request_id:randomUUID(),study_id:study.study_id,paused:false});
  async function session(version=old){const credential=digest(randomUUID()),created=await call('participant.create',{request_id:randomUUID(),version_id:version.version_id,credential_hash:digest(credential)});return {session_id:created.session_id,credential};}
  const legacy=await session(),sibling=await session();
  // Exercise a real single-writer application upgrade: frozen rows and refs are
  // untouched, the old writer exits, and only a new publication uses new code.
  await writer.close();writer=new DatabaseWriter(path,{workerData:{runnerHash:newHash}});await writer.start();
  const current=await admin('study.publish',{request_id:randomUUID(),study_id:study.study_id,revision:2});assert.equal(current.runner_hash,newHash);
  const modern=await session(current);assert.equal((await call('participant.view',{}, {session_id:legacy.session_id,credential_hash:digest(legacy.credential)})).frozen.runner_hash,oldHash);
  maintenance=new Maintenance(writer,path,root);app=Fastify();
  let failedResponse;
  app.addHook('onRequest',async(request,reply)=>{if(request.headers['x-test-read-fault'])failedResponse=reply.raw;});
  app.setErrorHandler((error,_req,reply)=>reply.code(error instanceof ContractError||error instanceof WriterError?error.status:500).send({code:error.code??'FAILED'}));
  await labRoutes(app,writer,maintenance,root);const origin=await app.listen({host:'127.0.0.1',port:0});
  const cookie=s=>`lab_${s.session_id}=${s.credential}`,url=s=>`${origin}/api/participate/sessions/${s.session_id}/assets/${asset.asset_id}`;
  const allowed=await fetch(url(legacy),{headers:{Cookie:cookie(legacy)}});assert.equal(allowed.status,200);assert.equal(digest(Buffer.from(await allowed.arrayBuffer())),digest(png));assert.equal(allowed.headers.get('cache-control'),'private, no-store, no-transform');
  const rejected=await fetch(url(modern),{headers:{Cookie:cookie(modern)}});assert.equal(rejected.status,409);assert.equal((await rejected.json()).code,'PREPARATION_TICKET_REQUIRED');
  const foreign=await fetch(url(legacy),{headers:{Cookie:cookie(sibling)}});assert.equal(foreign.status,401);
  const claimed=await call('participant.claim',{request_id:randomUUID(),writer_id:'writer'},{session_id:modern.session_id,credential_hash:digest(modern.credential)}),fence={writer_id:'writer',writer_epoch:claimed.writer_epoch};
  await call('participant.reserve',{request_id:randomUUID(),...fence},{session_id:modern.session_id,credential_hash:digest(modern.credential)});
  const ticket_id=randomUUID();const post=action=>fetch(`${origin}/api/participate/sessions/${modern.session_id}/preparation`,{method:'POST',headers:{Origin:origin,Cookie:cookie(modern),'Content-Type':'application/json'},body:JSON.stringify({ticket_id,...fence,action})});
  assert.equal((await (await post('join')).json()).status,'READY');
  async function waitForQueue(queued){for(let i=0;i<100;i++){
    const stats=await app.inject({method:'GET',url:'/api/lab/operations',headers:{Cookie:`lab_admin=TEST_ONLY-operator`}});
    if(stats.json().preparation?.queued===queued)return stats.json().preparation;
    await new Promise(r=>setTimeout(r,10));
  }assert.fail(`queue did not reach ${queued}`);}
  const full=await fetch(url(legacy),{headers:{Cookie:cookie(legacy)}});assert.equal(full.status,409);assert.equal((await full.json()).code,'PREPARATION_CAPACITY_FULL');
  assert.equal((await waitForQueue(0)).active,1);await post('release');
  const served=await fetch(url(legacy),{headers:{Cookie:cookie(legacy)}});assert.equal(served.status,200);assert.equal(digest(Buffer.from(await served.arrayBuffer())),digest(png));
  // Force a real file stream error before EOF. The response must be destroyed
  // before capacity is reclaimed by its close handler, and a later GET works.
  const handle=await open(await assetPath(root,asset.asset_id)),prototype=Object.getPrototypeOf(handle);await handle.close();
  const createReadStream=prototype.createReadStream;let failNext=true,destroyedOnError=false;
  const fault=t.mock.method(prototype,'createReadStream',function(options){
    const inject=failNext;failNext=false;const stream=createReadStream.call(this,inject?{...options,highWaterMark:1}:options);
    if(inject)stream.once('data',()=>{stream.emit('error',new Error('TEST_ONLY_READ_FAILURE'));destroyedOnError=failedResponse.destroyed;});return stream;
  });
  await assert.rejects(fetch(url(legacy),{headers:{Cookie:cookie(legacy),'X-Test-Read-Fault':'1'}}).then(r=>r.arrayBuffer()));
  fault.mock.restore();assert.equal(destroyedOnError,true);assert.equal((await waitForQueue(0)).active,0);
  const recovered=await fetch(url(legacy),{headers:{Cookie:cookie(legacy)}});assert.equal(recovered.status,200);assert.equal(digest(Buffer.from(await recovered.arrayBuffer())),digest(png));
});
