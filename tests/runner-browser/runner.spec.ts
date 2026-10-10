import {test,expect,type Page} from '@playwright/test';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../../src/server/database.js';
import {LabStore} from '../../src/server/lab-store.js';
import {digest} from '../../src/server/collection-store.js';
import {compileQuestionnaire} from '../../src/shared/questionnaire-json.js';
import {RunReplay} from '../../src/shared/run-replay.js';
import {stableJSON} from '../../src/shared/protocol.js';

async function start(page:Page,rating=false,project1=false){
  const root=mkdtempSync(join(tmpdir(),'bpl-runner-')),db=openDatabase(join(root,'db.sqlite')),store=new LabStore(db,digest('runner'));
  const token=digest('admin'),csrf=randomUUID();store.execute({operation:'lab/admin.issue',data:{token_hash:token,csrf}});
  const admin=(operation:string,data:Record<string,unknown>={})=>store.execute({operation:`lab/${operation}`,credential_hash:token,data:{csrf,...data}}) as any;
  const study=admin('study.create',{request_id:randomUUID()}),png=readFileSync('examples/stimuli/mobile-card.png'),asset=admin('asset.begin',{request_id:randomUUID(),study_id:study.study_id,name:'test.png'});
  store.execute({operation:'lab/internal.asset.ready',data:{asset_id:asset.asset_id,info:{hash:digest(png),bytes:png.length,width:1080,height:720,format:'png'}}});
  const p=compileQuestionnaire(rating?{schema:'questionnaire-v1',title:'Rating regression',orientation:'portrait',pages:[],layout:{aspect:413/626,portrait_min_width:120},budget:{commit_ms:200,long_frame_ms:1000},
    groups:[{id:'ratings',title:'医生第一印象评分',choices:['1','2','3','4','5','6','7','8','9'],repeats:0,rating:{prompt:'可信度',items:['可信度'],labels:['完全不','非常少','较少','有一点','一般','较多','很多','几乎完全','非常']},
      trials:[{root_id:'first',asset_id:asset.asset_id,correct:null,image_ms:1,isi_ms:3000},{root_id:'second',asset_id:'rating-second-asset',correct:null,image_ms:1,isi_ms:3000}]}]}:{schema:'questionnaire-v1',title:'Runner regression',orientation:'portrait',pages:[],budget:{commit_ms:40,long_frame_ms:1000},
    timing_defaults:{stimulus_ms:1500,isi_ms:500,feedback_ms:300},groups:[{id:'task',title:'Task',choices:['Left','Right'],response_keys:{Right:'KeyJ',Left:'KeyF'},
    feedback:{correct:'Correct',incorrect:'Incorrect',miss:'Miss',neutral:'Recorded'},repeats:0,
    trials:[{root_id:'image',asset_id:asset.asset_id,correct:'Left'},{root_id:'text',text:'HELLO',correct:'Right'}]}]});
  if(rating){const second=admin('asset.begin',{request_id:randomUUID(),study_id:study.study_id,name:'second.png'});p.groups[0]!.trials[1]!.asset_id=second.asset_id;store.execute({operation:'lab/internal.asset.ready',data:{asset_id:second.asset_id,info:{hash:digest(png),bytes:png.length,width:1080,height:720,format:'png'}}});}
  const assetBytes=new Map<string,Buffer>();
  if(project1){
    const source=JSON.parse(readFileSync('examples/project1/experiment.json','utf8')),manifest=JSON.parse(readFileSync('examples/project1/processed-v1/manifest.json','utf8'));
    const assets=new Map<string,string>();
    for(const r of manifest.images){const bytes=readFileSync(`examples/project1/processed-v1/${r.output}`),asset=admin('asset.begin',{request_id:randomUUID(),study_id:study.study_id,name:r.id+'.webp'});store.execute({operation:'lab/internal.asset.ready',data:{asset_id:asset.asset_id,info:{hash:digest(bytes),bytes:bytes.length,width:413,height:626,format:'webp'}}});assetBytes.set(asset.asset_id,bytes);assets.set(`${r.package.split('/').at(-1)}/${r.path}`,asset.asset_id);}
    source.consent=undefined;source.budget.commit_ms=200;source.budget.long_frame_ms=1000;
    Object.assign(p,compileQuestionnaire(source,ref=>assets.get(`${ref.package}/${ref.path}`)!));
  }
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
        if(op==='assets'){assetCalls++;await route.fulfill({body:project1?assetBytes.get(path.split('/').at(-1)!)!:png,contentType:project1?'image/webp':'image/png'});return;}
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
    await expect(page.locator('#status')).toContainText('本组已呈现 1 次');
    const left=page.getByRole('button',{name:'Left',exact:true}),right=page.getByRole('button',{name:'Right',exact:true});
    await left.click({button:'right'});await left.click({button:'middle'});await expect(left).toHaveAttribute('aria-pressed','false');
    expect(await left.evaluate(e=>!e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})))).toBe(true);
    await left.click();await expect(left).toHaveAttribute('aria-pressed','true');await expect(page.locator('#status')).toContainText('已记录：Left');
    await right.click();await expect(left).toHaveAttribute('aria-pressed','true');await expect(right).toHaveAttribute('aria-pressed','false');
    expect(f.requests()).toBe(0);
    await expect(page.locator('#status')).toContainText('本组已呈现 2 次');
    await page.keyboard.down('j');await page.keyboard.down('j');await page.keyboard.up('j');
    await expect(right).toHaveAttribute('aria-pressed','true');await expect(page.locator('#done')).toBeVisible();
    expect(f.view().permit.state).toBe('CLOSED_NORMAL');expect(f.view().diagnostics).toHaveLength(0);
    const inputs=f.records().filter((r:any)=>r.type==='INPUT');expect(inputs.filter((r:any)=>r.pointer_type==='keyboard'&&r.action==='down')).toHaveLength(1);
    expect(f.records().filter((r:any)=>r.type==='WINDOW').map((r:any)=>r.answer)).toEqual(['Left','Right']);
    for(const [i,r] of f.records().filter((r:any)=>r.type==='END').entries())expect(r.at).toBeGreaterThanOrEqual(f.view().permit.plan.start+(i+1)*2300);
  }catch(error){console.log('Runner diagnostic',JSON.stringify(f.view().diagnostics),JSON.stringify(f.records()));throw error;}finally{f.close();}
});

test('mobile touch held through ISI never answers the next stimulus until release and a new press',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),page=await context.newPage(),f=await start(page);
  try{await page.getByRole('button',{name:'开始本组'}).tap();await expect(page.locator('#status')).toContainText('本组已呈现 1 次');
    await page.getByRole('button',{name:'Left',exact:true}).tap();await expect(page.getByRole('button',{name:'Left',exact:true})).toHaveAttribute('aria-pressed','true');
    // Watch every frame: ordinary assertion polling can miss a short interval.
    await page.waitForFunction(()=>document.querySelector('#status')?.textContent==='已记录；请等待下一刺激。');
    await page.evaluate(()=>{const r=document.querySelector('.response-buttons button')!.getBoundingClientRect();window.dispatchEvent(new PointerEvent('pointerdown',{pointerId:77,pointerType:'touch',button:0,clientX:r.x+10,clientY:r.y+10}));});
    await expect(page.locator('#status')).toContainText('本组已呈现 2 次');
    await page.evaluate(()=>{const r=document.querySelectorAll('.response-buttons button')[1]!.getBoundingClientRect();window.dispatchEvent(new PointerEvent('pointerdown',{pointerId:77,pointerType:'touch',button:0,clientX:r.x+10,clientY:r.y+10}));});
    await expect(page.getByRole('button',{name:'Right',exact:true})).toHaveAttribute('aria-pressed','false');
    await page.evaluate(()=>window.dispatchEvent(new PointerEvent('pointerup',{pointerId:77,pointerType:'touch',button:0})));
    await page.getByRole('button',{name:'Right',exact:true}).tap();await expect(page.locator('#done')).toBeVisible();
    expect(f.view().permit.state).toBe('CLOSED_NORMAL');expect(f.records().filter((r:any)=>r.type==='WINDOW').map((r:any)=>r.answer)).toEqual(['Left','Right']);
  }finally{await context.close();f.close();}
});

test('self-paced rating requires selection and submit, clears image, then waits a full 3-second ISI',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),page=await context.newPage(),f=await start(page,true);
  try{
    await page.getByRole('button',{name:'开始本组'}).tap();await expect(page.locator('#status')).toContainText('第 1/2 张');
    const submit=page.getByRole('button',{name:'提交评分',exact:true});await expect(submit).toBeDisabled();
    // More than the legacy fixed window: no answer still keeps the first picture.
    await page.waitForTimeout(3200);await expect(page.locator('#status')).toContainText('第 1/2 张');await expect(page.locator('#stimulus')).toBeVisible();
    await page.getByRole('button',{name:'评分 2：非常少',exact:true}).tap();await expect(submit).toBeEnabled();
    await submit.tap();
    await expect(page.locator('#stimulus')).toBeHidden();await expect(submit).toBeDisabled();expect(f.requests()).toBe(0);
    await expect(submit).toBeDisabled();
    await expect(page.locator('#status')).toContainText('第 2/2 张',{timeout:5000});
    await page.getByRole('button',{name:'评分 4：有一点',exact:true}).tap();await submit.tap();await expect(page.locator('#done')).toBeVisible({timeout:12000});
    const permit=f.view().permit,records=f.records();expect(permit.state).toBe('CLOSED_NORMAL');expect(f.view().diagnostics).toHaveLength(0);
    expect(records.filter((r:any)=>r.type==='RATING').map((r:any)=>r.values)).toEqual([[2],[4]]);
    const replay=new RunReplay(permit.plan);for(const r of records)replay.apply(r);const results=replay.finish();
    expect(results).toHaveLength(2);for(const r of results)expect(r.isi_ms).toBeGreaterThanOrEqual(3000);
    expect(results[1]!.onset-results[0]!.clear!).toBeGreaterThanOrEqual(3000);
  }catch(error){console.log('Rating diagnostic',JSON.stringify(f.view().diagnostics),JSON.stringify(f.records()));throw error;}finally{await context.close();f.close();}
});

test('Project1 downloads exactly 32 of 102 real portraits and saves all balanced ratings with 3-second gaps',async({page})=>{
  test.setTimeout(160000);const f=await start(page,true,true);
  try{
    expect(f.downloads()).toBe(32);await page.getByRole('button',{name:'开始本组'}).click();
    for(let i=1;i<=32;i++){
      await expect(page.locator('#status')).toHaveText(new RegExp(`第 ${i}\/32 张`),{timeout:10000});
      for(let item=0;item<6;item++){const value=(i+item-1)%9+1;await page.getByRole('button',{name:new RegExp(`^评分 ${value}：`)}).click();await page.getByRole('button',{name:'下一题',exact:true}).click();}
      await page.locator('.rating-age').fill('40');await page.getByRole('button',{name:'提交评分',exact:true}).click();
    }
    await expect(page.locator('#done')).toBeVisible({timeout:15000});
    const permit=f.view().permit,replay=new RunReplay(permit.plan);for(const r of f.records())replay.apply(r);
    const results=replay.finish();expect(results).toHaveLength(32);expect(new Set(results.map(r=>r.root_id)).size).toBe(32);
    expect(results.filter(r=>r.category!.startsWith('female')).length).toBe(16);expect(results.filter(r=>!r.category!.includes('no-glasses')).length).toBe(16);
    for(let i=0;i<32;i++){expect(results[i]!.ratings).toHaveLength(7);expect(results[i]!.ratings).toEqual([...Array.from({length:6},(_,item)=>(i+item)%9+1),40]);expect(results[i]!.isi_ms).toBeGreaterThanOrEqual(3000);if(i)expect(results[i]!.onset-results[i-1]!.clear!).toBeGreaterThanOrEqual(3000);}
    expect(permit.state).toBe('CLOSED_NORMAL');expect(f.view().diagnostics).toHaveLength(0);expect(f.downloads()).toBe(32);
  }finally{f.close();}
});
