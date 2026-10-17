import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url)),require=createRequire(`${root}/package.json`),{chromium}=require('@playwright/test'),Fastify=require('fastify'),fastifyStatic=require('@fastify/static');
const {fixture}=await import(`${root}/tests/helpers/lab-fixture.mjs`);
const {sampleProtocol}=await import(`${root}/src/shared/protocol.ts`);
const {digest}=await import(`${root}/src/server/collection-store.ts`);
const {LabStore}=await import(`${root}/src/server/lab-store.ts`);
const {openDatabase}=await import(`${root}/src/server/database.ts`);
const {Maintenance}=await import(`${root}/src/server/maintenance.ts`);
const {labRoutes}=await import(`${root}/src/server/lab-routes.ts`);
const {retainRelease}=await import(`${root}/src/server/release.ts`);
const {installJsonTransport}=await import(`${root}/src/server/json-transport.ts`);
let browserOrigin=process.env.AUDIT_BROWSER_ORIGIN,vite;
before(async()=>{
 if(browserOrigin)return;
 const {createServer}=await import('vite');
 vite=await createServer({configFile:join(root,'vite.config.ts'),server:{host:'127.0.0.1',port:0,strictPort:false}});
 await vite.listen();browserOrigin=`http://127.0.0.1:${vite.httpServer.address().port}`;
});
after(async()=>{await vite?.close();});
// The working tree contains the first audit's fixes. Build the actual older
// runtime from this immutable source snapshot; do not simulate its behavior.
function legacyDist(t){
 if(process.env.AUDIT_OLD_DIST)return process.env.AUDIT_OLD_DIST;
 const scratch=mkdtempSync(join(tmpdir(),'bpl-round2-legacy-'));
 t.after(()=>rmSync(scratch,{recursive:true,force:true}));
 const archive=join(scratch,'source.tar'),ref='fbab9710e1bc69ee355f37dee902f058ee3d1dce';
 execFileSync('git',['archive','--format=tar',`--output=${archive}`,ref],{cwd:root});
 execFileSync('tar',['-xf',archive,'-C',scratch]);
 symlinkSync(join(root,'node_modules'),join(scratch,'node_modules'),'dir');
 execFileSync('npm',['run','build'],{cwd:scratch,stdio:'pipe'});
 return join(scratch,'dist');
}
async function seed(page,version,meta,events=[]){await page.evaluate(async({version,meta,events})=>{
 const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('browser-psych-lab-v1',1);r.onupgradeneeded=()=>{const d=r.result,e=d.createObjectStore('events',{keyPath:'event_id'});e.createIndex('session','session_id');e.createIndex('scope','scope');const o=d.createObjectStore('outbox',{keyPath:'event_id'});o.createIndex('session','session_id');d.createObjectStore('meta');};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 try{await new Promise((resolve,reject)=>{const tx=db.transaction(['events','outbox','meta'],'readwrite');tx.objectStore('meta').put(meta,version);for(const event of events)tx.objectStore('events').put(event);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}finally{db.close();}
 },{version,meta,events});}
function metadata(version,session,secret,extra={}){return {version_id:version,request_id:randomUUID(),credential:secret,session,writer_id:'writer-a',heads:{},pending:{},finalize_id:randomUUID(),page_values:{},environment:{request_id:randomUUID(),sample_id:randomUUID(),raw:'{"schema":"environment-v1"}',received:true},...extra};}

test('backup rollback recovers acknowledged original bytes before declaring saved, including retry after a failed resend',async t=>{
 const f=fixture(t),secret='c'.repeat(64),created=f.store.execute({operation:'lab/participant.create',data:{request_id:randomUUID(),version_id:f.version.version_id,credential_hash:digest(secret)}});
 const call=(store,op,data={})=>store.execute({operation:`lab/participant.${op}`,session_id:created.session_id,credential_hash:digest(secret),data});
 const claimed=call(f.store,'claim',{request_id:randomUUID(),writer_id:'writer-a'}),snapshot=join(f.root,'before-ack.sqlite');await f.db.backup(snapshot);
 const event={event_schema_version:'lab-events-v1',event_id:randomUUID(),session_id:created.session_id,version_id:f.version.version_id,protocol_hash:f.version.hash,writer_id:'writer-a',writer_epoch:claimed.writer_epoch,scope:'welcome',sequence:0,previous:null,clock_epoch:'clock',time_ms:1,kind:'PAGE_REVISION',payload:{question_id:'ready',answer:'是'}},raw=JSON.stringify(event),ref={event_id:event.event_id,hash:digest(raw)},receipt=call(f.store,'ingest',{events:[{...ref,raw}]}).receipts[0];assert.equal(receipt.custody,'PERSISTED');
 const db=openDatabase(snapshot),restored=new LabStore(db);call(restored,'terminate',{request_id:randomUUID(),reason:'UNKNOWN_RUN'});
 const data={request_id:randomUUID(),manifest:{manifest_id:randomUUID(),scope:'welcome',path:[],events:[ref]},unknown:['unfinished-or-unknown-position']};
 const first=call(restored,'reconcile',data);assert.equal(first.status,'WAITING');
 db.prepare('UPDATE lab_requests SET response=? WHERE subject=? AND operation=? AND request_id=?').run(JSON.stringify({...first,status:'RECONCILED'}),created.session_id,'participant.reconcile',data.request_id);
 const browser=await chromium.launch({headless:true});let fail=true,uploads=[];
 try{const page=await browser.newPage();await page.route('**/api/participate/**',async route=>{try{const req=route.request(),url=new URL(req.url()),body=req.postDataJSON()??{},op=url.pathname.split('/')[5];let result;
  if(url.pathname.includes('/versions/')){const frozen=restored.frozen(f.version.version_id);result=url.pathname.endsWith('/metadata')?{title:frozen.protocol.title,background:frozen.protocol.layout.background,orientation:null}:url.pathname.endsWith('/consent')?null:frozen;}
  else {if(op==='ingest'){uploads.push(body.events);if(fail){await route.fulfill({status:409,json:{code:'TEST_ONLY_RESEND_FAILED'}});return;}}result=call(restored,op==='resume'?'view':op??'view',body);}
  await route.fulfill({json:result});}catch(error){await route.fulfill({status:error.status??400,json:{code:error.code??error.message}});}});
  await page.goto(`${browserOrigin}/participate.html`);await seed(page,f.version.version_id,metadata(f.version.version_id,claimed,secret,{heads:{welcome:{sequence:1,previous:ref}},reconciliations:{'welcome-1':data},page_values:{welcome:{ready:'是'}}}),[{...ref,raw,session_id:created.session_id,scope:'welcome',sequence:0,receipt}]);
  await page.goto(`${browserOrigin}/participate.html?version=${f.version.version_id}`);await page.getByRole('button',{name:'重试保存',exact:true}).waitFor();
  assert.doesNotMatch(await page.locator('#status').textContent(),/已有记录已保存/);assert.equal(db.prepare('SELECT count(*) n FROM lab_raw').get().n,0);
  fail=false;await page.getByRole('button',{name:'重试保存',exact:true}).click();await page.getByRole('button',{name:'重新作答',exact:true}).waitFor();
  assert.match(await page.locator('#status').textContent(),/已有记录已保存/);assert.ok(uploads.length>=2);assert.ok(uploads.every(batch=>batch.length===1&&batch[0].raw===raw&&batch[0].hash===ref.hash));
  assert.equal(db.prepare('SELECT count(*) n FROM lab_raw').get().n,1);assert.equal(call(restored,'reconcile',data).receipts[0].custody,'PERSISTED');assert.equal(call(restored,'view').state,'TERMINATED');
  const local=await page.evaluate(async id=>{const db=await new Promise(resolve=>{const r=indexedDB.open('browser-psych-lab-v1');r.onsuccess=()=>resolve(r.result);});try{return await new Promise(resolve=>{const tx=db.transaction(['events','outbox']),a=tx.objectStore('events').get(id),b=tx.objectStore('outbox').count();tx.oncomplete=()=>resolve({raw:a.result.raw,pending:b.result});});}finally{db.close();}},event.event_id);
  assert.equal(local.raw,raw);assert.equal(local.pending,0);
 }finally{await browser.close();db.close();}
});

test('reconciliation rejects mismatched manifests, missing proof and malformed custody receipts',async t=>{
 const f=fixture(t),browser=await chromium.launch({headless:true});
 try{const page=await browser.newPage();await page.goto(`${browserOrigin}/participate.html`);let tamper;
  await page.route('**/api/participate/sessions/**/reconcile',async route=>{
   const {manifest}=route.request().postDataJSON(),report={status:'RECONCILED',cleanup_allowed:false,manifest,receipts:manifest.events.map(ref=>({...ref,scope:manifest.scope,custody:'PERSISTED',receipt_id:'receipt',disposition:'ACCEPTED',disposition_version:1,reason:'VALID'}))};
   if(tamper==='manifest')report.manifest={...manifest,manifest_id:'different'};
   else if(tamper==='receipt_count')report.receipts=[];
   else if(tamper==='cleanup_allowed')report.cleanup_allowed=true;
   else report.receipts[0][tamper.key]=tamper.value;
   await route.fulfill({json:report});
  });
  for(tamper of [{key:'hash',value:'0'.repeat(64)},{key:'scope',value:'another-scope'},{key:'custody',value:'MISSING'},
   {key:'receipt_id',value:''},{key:'disposition',value:'UNKNOWN'},{key:'disposition_version',value:0},'manifest','receipt_count','cleanup_allowed']){
   const error=await page.evaluate(async session=>{const {Ledger}=await import('/ledger.ts'),{ParticipantAPI}=await import('/participant-api.ts');const ledger=await Ledger.open(session.frozen.version_id,'writer-a');await ledger.state();await ledger.session(session);await ledger.append('welcome','PAGE_REVISION',{question_id:'ready',answer:'是'});const api=new ParticipantAPI(ledger,session);api.sync=async()=>{};
    try{await api.reconcile();return '';}catch(error){return error.message;}finally{ledger.db.close();}
   },f.call('view'));assert.equal(error,'RECONCILIATION_MISMATCH',JSON.stringify(tamper));
  }
 }finally{await browser.close();}
});

test('real legacy runner keeps the entry protocol on reanswer and completes without conflicting with another local version',async t=>{
 const oldDist=legacyDist(t),storage=mkdtempSync(join(tmpdir(),'bpl-legacy-entry-')),path=join(storage,'db.sqlite'),oldHash=await retainRelease(storage,oldDist);
 const {LabStore:LegacyStore}=await import(join(oldDist,'server/lab-store.js')),{openDatabase:openLegacyDatabase}=await import(join(oldDist,'server/database.js'));
 const db=openLegacyDatabase(path),older=new LegacyStore(db,oldHash,()=>1000);t.after(()=>{db.close();rmSync(storage,{recursive:true,force:true});});
 const csrf=randomUUID();older.execute({operation:'lab/admin.issue',data:{token_hash:digest('admin'),csrf}});
 const admin=(op,data)=>older.execute({operation:`lab/${op}`,credential_hash:digest('admin'),data:{...data,csrf}}),study=admin('study.create',{request_id:randomUUID()});
 const p=sampleProtocol();p.pages=[];p.layout.orientation='portrait';p.budget.commit_ms=200;p.budget.long_frame_ms=1000;
 p.groups=[{id:'task',title:'Task',choices:['left','right'],repeats:0,trials:[{root_id:'root',text:'X',image_ms:1000,isi_ms:300,correct:null}]}];p.variants[0].group_order=['task'];p.variants[0].trial_order={task:['root']};
 const publish=(revision,protocol)=>{const saved=admin('study.save',{request_id:randomUUID(),study_id:study.study_id,revision,protocol});return admin('study.publish',{request_id:randomUUID(),study_id:study.study_id,revision:saved.revision});};
 const entry=publish(1,p),secret='d'.repeat(64);admin('study.admission',{request_id:randomUUID(),study_id:study.study_id,paused:false});
 const old=older.execute({operation:'lab/participant.create',data:{request_id:randomUUID(),version_id:entry.version_id,credential_hash:digest(secret)}});
 const oldCall=(op,data={})=>older.execute({operation:`lab/participant.${op}`,session_id:old.session_id,credential_hash:digest(secret),data});oldCall('terminate',{request_id:randomUUID(),reason:'TEST_ONLY_END'});
 const replacement=publish(2,{...p,layout:{...p.layout,orientation:'landscape'}}),otherSecret='e'.repeat(64);
 const other=older.execute({operation:'lab/participant.create',data:{request_id:randomUUID(),version_id:replacement.version_id,credential_hash:digest(otherSecret)}});
 const current=new LabStore(db,undefined,()=>1000),adapter={request:async command=>current.execute(command)},maintenance=new Maintenance(adapter,path,storage),app=Fastify();installJsonTransport(app);app.setErrorHandler((error,_r,reply)=>reply.code(error.status??500).send({code:error.code??error.message}));await app.register(fastifyStatic,{root:join(root,'dist/web')});await labRoutes(app,adapter,maintenance,storage);const origin=await app.listen({host:'127.0.0.1',port:0});
 const browser=await chromium.launch({headless:true});try{const page=await browser.newPage({viewport:{width:390,height:844}}),versions=[];
  page.on('request',r=>{if(/\/versions\/.*\/metadata$/.test(r.url()))versions.push(r.url().split('/').at(-2));});
  await page.goto(`${origin}/participate.html`);await seed(page,entry.version_id,metadata(entry.version_id,oldCall('view'),secret));await seed(page,replacement.version_id,metadata(replacement.version_id,other,otherSecret));
  await page.goto(`${origin}/participate.html?version=${entry.version_id}`);await page.getByRole('button',{name:'重新作答',exact:true}).click();
  await page.getByRole('button',{name:'准备任务',exact:true}).waitFor();
  const next=current.view(db.prepare('SELECT new_session_id FROM lab_reanswer_links WHERE old_session_id=?').get(old.session_id).new_session_id);
  assert.equal(next.frozen.version_id,entry.version_id);assert.equal(next.frozen.runner_hash,oldHash);
  await page.getByRole('button',{name:'准备任务',exact:true}).click();await page.waitForURL(`**/runners/${oldHash}/run.html?version=${entry.version_id}`);
  await page.getByRole('button',{name:'开始本组',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('第 1 次呈现'));
  await page.getByRole('button',{name:'left',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('研究已完成'));
  assert.ok(versions.every(v=>v===entry.version_id));assert.equal(current.view(next.session_id).state,'COMPLETED');assert.equal(current.view(next.session_id).reanswer.old_session_id,old.session_id);
  const retained=await page.evaluate(async version=>{const db=await new Promise(resolve=>{const r=indexedDB.open('browser-psych-lab-v1');r.onsuccess=()=>resolve(r.result);});try{return await new Promise(resolve=>{const r=db.transaction('meta').objectStore('meta').get(version);r.onsuccess=()=>resolve(r.result.session.session_id);});}finally{db.close();}},replacement.version_id);
  assert.equal(retained,other.session_id);
 }finally{await browser.close();await app.close();await maintenance.close();}
});

test('preparation limit preserves the first 100 reports and permits answer sync, terminal reconciliation and runner navigation',async t=>{
 const f=fixture(t),browser=await chromium.launch({headless:true});try{const page=await browser.newPage();await page.goto(`${browserOrigin}/participate.html`);
 await page.route('**/api/participate/sessions/**',async route=>{try{const op=new URL(route.request().url()).pathname.split('/')[5],data=route.request().postDataJSON()??{};await route.fulfill({json:f.call(op,data)});}catch(error){await route.fulfill({status:error.status??400,json:{code:error.code??error.message}});}});
 const report=await page.evaluate(async session=>{
  const {Ledger}=await import('/ledger.ts'),{ParticipantAPI}=await import('/participant-api.ts'),{preparationAttempt}=await import('/preparation-report.ts');
  const ledger=await Ledger.open(session.frozen.version_id,'writer-a');await ledger.state();await ledger.session(session);await ledger.environment('{"schema":"environment-v1"}');await ledger.environment();
  const sample={schema:'preparation-v1',attempt_id:'',phase:'runner-loading',group_id:null,started_at:new Date().toISOString(),elapsed_ms:1,configured_commit_ms:session.frozen.protocol.budget.commit_ms,stages:{},outcome:'CANCELED',device:{user_agent:'test',platform:'test',language:'zh',cores:1,memory_gb:null,width:390,height:844,dpr:1,network:{}}};
  for(let i=0;i<100;i++)await ledger.preparation({...sample,attempt_id:crypto.randomUUID()});
  const original=Object.values((await ledger.state()).preparations).map(r=>r.raw),api=new ParticipantAPI(ledger,session);
  const accepted=await ledger.preparation({...sample,attempt_id:crypto.randomUUID()});await preparationAttempt(api,'runner-loading').finish('READY');
  await ledger.append('welcome','PAGE_REVISION',{question_id:'ready',answer:'是'},undefined,{ready:'是'});await api.sync();await ledger.drain();
  const state=await ledger.state(),events=await ledger.db.getAll('events');ledger.db.close();return {accepted,original,retained:Object.values(state.preparations).map(r=>r.raw),received:Object.values(state.preparations).every(r=>r.received),answer_events:events.length};
 },f.call('view'));
 assert.equal(report.accepted,false);assert.deepEqual(report.retained,report.original);assert.equal(report.received,true);assert.equal(report.answer_events,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM lab_raw').get().n,1);assert.equal(f.db.prepare("SELECT count(*) n FROM lab_covariates WHERE source='preparation-reported'").get().n,100);
 f.call('terminate',{request_id:randomUUID(),reason:'UNKNOWN_RUN'});
 await page.evaluate(async session=>{const {Ledger}=await import('/ledger.ts'),{ParticipantAPI}=await import('/participant-api.ts');const ledger=await Ledger.open(session.frozen.version_id,'writer-a');await ledger.session(session);await new ParticipantAPI(ledger,session).reconcile();await ledger.drain();ledger.db.close();},f.call('view'));
 await page.route('**/run.html?version=*',route=>route.fulfill({contentType:'text/html',body:'<p>Navigation reached</p>'}));
 await Promise.all([page.waitForURL('**/run.html?version=*'),page.evaluate(async session=>{const {Ledger}=await import('/ledger.ts'),{loadRunner}=await import('/runner-loading.ts');const ledger=await Ledger.open(session.frozen.version_id,'writer-a');await loadRunner({ledger,session,syncPreparations:async()=>{}},document.querySelector('#status'),document.querySelector('#content'));},f.call('view'))]);
 assert.match(await page.locator('p').textContent(),/Navigation reached/);
 }finally{await browser.close();}
});
