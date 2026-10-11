当前交互源码第 14 段。连续片段，请与前后段拼接阅读。本阶段只回复 ACK_INTERACTION_14。
 minmax(44px,1fr) 44px minmax(16px,1fr); }
.axes-grid .axis-bottom button { min-height: 44px; padding: 2px 6px; font-size: 12px; }
.ending-page { width: min(100%,900px); min-height: 100%; justify-self: center; display: flex; flex-direction: column; gap: 12px; }
.ending-title { flex: 0 0 auto; margin: 0; font-size: 22px; line-height: 1.35; font-weight: 600; }
.ending-text { height: max(160px,calc(var(--viewport-height,100dvh) - 200px)); flex: 0 0 auto; min-height: 0; overflow: auto; font-size: var(--font-size-ending); line-height: 1.6; align-self: stretch; }
.ending-nav { flex: 0 0 auto; display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; padding-bottom: var(--safe-bottom); }
.ending-nav button { flex: 1 1 140px; max-width: 300px; }
.consent-page { width: min(100%,900px); height: 100%; min-height: 0; min-width: 0; justify-self: center; display: grid; grid-template-rows: minmax(0,1fr) auto auto; gap: min(2dvh,12px); }
.consent-text { font-size: clamp(16px,2.8dvh,20px); }
.consent-reading-nav,.consent-decisions { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 8px; }
.consent-decisions button { padding: 8px 4px; }
.consent-decisions button:last-child { font-weight: 600; }
.consent-declined { display: grid; gap: 24px; width: min(100%,600px); justify-self: center; }
@media (max-height: 450px) {
  .axis-control { padding: 0 8px; gap: 0; border-radius: 10px; }
  .question-screen.single-axis-question { grid-template-rows: minmax(32px,20%) minmax(0,1fr); gap: 6px; }
}
.orientation-gate { position: fixed; inset: 0; z-index: 100; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4dvh; background: var(--background); color: var(--foreground); padding: 5%; text-align: center; }
.orientation-gate[hidden] { display: none; }
.orientation-gate p { font-size: clamp(18px,4vw,24px); margin: 0; }
.orientation-gate span { font-size: 14px; }
.orientation-device { width: 48px; height: 76px; border: 2px solid currentColor; border-radius: 9px; }
.orientation-device[data-orientation=landscape] { width: 76px; height: 48px; }
.simulation-image-nav { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 6px; }
.question-nav { grid-row: 3; display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 8px; min-height: 0; padding-bottom: var(--safe-bottom); }
.question-nav.single-action { grid-template-columns: 1fr; }
input[type=text] { align-self: center; width: 100%; min-width: 0; height: 44px; font: inherit; color: inherit; background: transparent; border: 1px solid currentColor; padding: 8px; border-radius: 0; touch-action: manipulation; }
body.typing main { grid-template-rows: 0 minmax(0,100%); }
body.typing header { display: none; }
body.typing .questionnaire { height: max(120px,calc(var(--viewport-height,100dvh) - var(--survey-top,16px) - 16px)); grid-template-rows: 0 minmax(0,1fr) auto; }
body.typing .question-meta { display: none; }
body.typing .question-screen { grid-template-rows: 0 minmax(0,100%); }
body.typing .reading-text { visibility: hidden; }
@media (max-width: 360px) {
  .recovery-actions,.ending-nav { display: grid; grid-template-columns: 1fr; }
  .recovery-actions button,.ending-nav button { max-width: none; }
}
[hidden] { display: none !important; }

```


=== FILE src/web/runner.css (complete source; may continue in next chunk) ===
```
html:has(body.runner-layout),body.runner-layout { height: 100%; overflow: hidden; }
body.runner-layout main { height: var(--viewport-height,100dvh); min-height: 0; overflow: hidden; }
/* Measure once before permit issuance; runtime copy never changes geometry. */
body.runner-layout #status { display: block; height: 3.6em; overflow: hidden; }
.runner-stage { min-height: 0; min-width: 0; width: min(100%,960px); height: 100%; justify-self: center; display: grid; grid-template-rows: minmax(0,1fr) auto minmax(48px,auto); gap: 12px; }
.canvas-slot { display: grid; place-items: center; min-height: 0; min-width: 0; overflow: hidden; }
#stimulus { max-width: 100%; max-height: 100%; }
.response-buttons { display: grid; grid-template-columns: repeat(var(--response-columns,2),minmax(0,1fr)); gap: 8px; width: 100%; touch-action: none; }
.response-buttons button { min-width: 0; min-height: 56px; user-select: none; touch-action: none; }
.runner-start { display: grid; grid-template-columns: 1fr; }
.runner-stage { user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; touch-action: none; }
.response-buttons button[aria-pressed=true] { color: var(--background,#e5e5e5); background: var(--foreground,#000000); }
body.running #stimulus,
body.running .response-buttons button { transition: none !important; animation: none !important; }
body.rating-layout #status { height: 2.4em; }
.rating-stage { gap: 8px; grid-template-rows: minmax(0,1fr) 190px 48px; }
.rating-stage .canvas-slot { align-items: start; }
.rating-controls { display: grid; gap: 6px; }
.rating-controls p { font-size: 16px; }
.rating-controls .response-buttons { gap: 6px; }
.rating-controls .response-buttons button { min-height: 48px; padding: 8px; }
.rating-age { width: 100%; min-height: 48px; font: inherit; padding: 8px; }
.rating-stage .runner-start { position: relative; height: 48px; display: grid; grid-template-rows: 48px; }
.rating-stage .runner-start button { width: 100%; }
.rating-controls { position: relative; display: grid; grid-template-rows: 36px 146px; gap: 8px; min-height: 0; }
.rating-controls > p { grid-row: 1; }
.rating-controls > .rating-axis,.rating-age-row { grid-row: 2; grid-column: 1; }
.rating-start { position: absolute; inset: 0; }
.rating-ticks { display: flex; justify-content: space-between; margin: -6px 11px 0; font-size: 12px; }
.rating-ticks span[data-selected=true] { font-weight: 700; }
.rating-axis { min-height: 0; padding: 8px 12px; border-radius: 12px; }
.rating-axis[hidden] { display: none !important; }
.rating-geometry-reserve { position: absolute; width: 1px; height: 1px; overflow: hidden; opacity: 0; pointer-events: none; }
.rating-age-row { display: grid; gap: 6px; min-height: 56px; }
.rating-age-row { align-content: center; }
.rating-age-row label { font-weight: 600; }
.rating-age { width: 100%; min-height: 48px; }
.rating-age-row { gap: 4px; align-content: start; }
.rating-age-keypad { display: grid; grid-template-columns: repeat(6,minmax(0,1fr)); gap: 4px; }
.rating-age-keypad button { min-height: 44px; padding: 4px; font-size: 18px; }
.rating-age-entry { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 8px; align-items: center; }
.rating-age-entry input { height: 44px; min-height: 44px; }
.rating-age-hint { max-width: 100px; font-size: 12px; text-align: right; }
.rating-age-keypad button:last-child { font-size: 12px; }

```


=== FILE tests/runner-browser/runner.spec.ts (complete source; may continue in next chunk) ===
```
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
import {gunzipSync} from 'node:zlib';

async function start(page:Page,rating=false,age=false){
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
  if(rating&&age){p.groups[0]!.rating={...p.groups[0]!.rating!,age_prompt:'你的年龄是？',age_min:18,age_max:65};p.groups[0]!.trials.splice(1);p.variants[0]!.trial_order.ratings=['first'];}
  else if(rating){const second=admin('asset.begin',{request_id:randomUUID(),study_id:study.study_id,name:'second.png'});p.groups[0]!.trials[1]!.asset_id=second.asset_id;store.execute({operation:'lab/internal.asset.ready',data:{asset_id:second.asset_id,info:{hash:digest(png),bytes:png.length,width:1080,height:720,format:'png'}}});}
  const saved=admin('study.save',{request_id:randomUUID(),revision:1,study_id:study.study_id,protocol:p});
  const version=admin('study.publish',{request_id:randomUUID(),revision:saved.revision,study_id:study.study_id});
  admin('study.admission',{request_id:randomUUID(),study_id:study.study_id,paused:false});
  let sid:string,groupCalls=0,assetCalls=0;
  const call=(op:string,data:Record<string,unknown>={})=>store.execute({operation:`lab/participant.${op}`,session_id:sid,credential_hash:digest('test'),data}) as any;
  await page.addInitScript(version=>sessionStorage.setItem(`lab-writer-${version}`,'writer-a'),version.version_id);
  await page.route('**/api/participate/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname;
    try{const payload=request.postDataBuffer(),body=payload?JSON.parse((request.headers()['content-encoding']==='gzip'?gunzipSync(payload):payload).toString('utf8')):{};let result:any;
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
          const refs=db.prepare('SELECT event_id,hash,disposition,writer_epoch,kind FROM lab_events WHERE session_id=? AND scope=? ORDER BY sequence').all(sid,permit.scope);
          for(const row of db.prepare('SELECT envelope FROM lab_events WHERE session_id=? AND scope=? ORDER BY sequence').all(sid,permit.scope) as any[]){const e=JSON.parse(row.envelope);if(e.kind==='GROUP_RECORD')replay.apply(e.payload.record);}
          const results=replay.finish(),job=randomUUID();store.beginJob(job,'REPLAY',null,{});
          store.execute({operation:'lab/internal.job.finish',data:{job_id:job,state:'READY',result:{session_id:sid,scope:permit.scope,source_hash:digest(stableJSON(refs)),valid:true,results}}});
          result=call('seal',{...body,proof_job_id:job});
        }else{if(op==='ingest')groupCalls++;result=call(op??'view',body);}
      }
      await route.fulfill({json:result});
    }catch(error){await route.fulfill({status:400,json:{code:String(error)}});}
  });
  await page.route('**/participate.html?**',route=>route.fulfill({contentType:'text/html',body:'<p id="done">Group saved</p>'}));
  await page.setViewportSize({width:390,height:844});
  await page.goto(`/run.html?version=${version.version_id}`);
  await expect(page.getByRole('button',{name:'开始本组'})).toBeVisible();
  return {view:()=>call('view'),records:()=>db.prepare("SELECT envelope FROM lab_events WHERE session_id=? AND kind='GROUP_RECORD' ORDER BY sequence").all(sid).map((e:any)=>JSON.parse(e.envelope).payload.record),
    requests:()=>groupCalls,downloads:()=>assetCalls,close:()=>{db.close();rmSync(root,{recursive:true,force:true});}};
}

test('image click visibly confirms first answer; right click, repeated key, and changed second answer are excluded',async({page})=>{
  const f=await start(page);try{
    await page.getByRole('button',{name:'开始本组'}).click();
    await expect(page.locator('#status')).toContainText('第 1 次呈现');
    const left=page.getByRole('button',{name:'Left',exact:true}),right=page.getByRole('button',{name:'Right',exact:true});
    await left.click({button:'right'});awai