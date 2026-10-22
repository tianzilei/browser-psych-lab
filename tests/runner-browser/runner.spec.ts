import {test,expect,type Page} from '@playwright/test';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
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

async function start(page:Page,rating=false,age=false,configure?:(p:ReturnType<typeof compileQuestionnaire>,addAsset:()=>string)=>void,viewport={width:390,height:844}){
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
  configure?.(p,()=>{const extra=admin('asset.begin',{request_id:randomUUID(),study_id:study.study_id,name:`extra-${randomUUID()}.png`});store.execute({operation:'lab/internal.asset.ready',data:{asset_id:extra.asset_id,info:{hash:digest(png),bytes:png.length,width:1080,height:720,format:'png'}}});return extra.asset_id;});
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
        if(op==='covariates')result=call('covariates',body);
        else if(op==='preparation')result=body.action==='release'?{}:{status:'READY',ticket_id:body.ticket_id};
        else if(op==='seal'){
          const permit=call('view').permit,replay=new RunReplay(permit.plan);
          const refs=db.prepare('SELECT event_id,hash,disposition,writer_epoch,kind FROM lab_events WHERE session_id=? AND scope=? ORDER BY sequence').all(sid,permit.scope);
          for(const row of db.prepare('SELECT envelope FROM lab_event_evidence WHERE session_id=? AND scope=? ORDER BY sequence').all(sid,permit.scope) as any[]){const e=JSON.parse(row.envelope);if(e.kind==='GROUP_RECORD')replay.apply(e.payload.record);}
          const results=replay.finish(),job=randomUUID();store.beginJob(job,'REPLAY',null,{});
          store.execute({operation:'lab/internal.job.finish',data:{job_id:job,state:'READY',result:{session_id:sid,scope:permit.scope,source_hash:digest(stableJSON(refs)),valid:true,results}}});
          result=call('seal',{...body,proof_job_id:job});
        }else{if(op==='ingest')groupCalls++;result=call(op??'view',body);}
      }
      await route.fulfill({json:result});
    }catch(error){await route.fulfill({status:400,json:{code:String(error)}});}
  });
  await page.route('**/participate.html?**',route=>route.fulfill({contentType:'text/html',body:'<p id="done">Group saved</p>'}));
  await page.setViewportSize(viewport);
  await page.goto(`/run.html?version=${version.version_id}`);
  await expect(page.getByRole('button',{name:'开始本组'})).toBeVisible();
  return {view:()=>call('view'),records:()=>db.prepare("SELECT envelope FROM lab_event_evidence WHERE session_id=? AND kind='GROUP_RECORD' ORDER BY sequence").all(sid).map((e:any)=>JSON.parse(e.envelope).payload.record),
    interactions:()=>db.prepare("SELECT envelope FROM lab_event_evidence WHERE session_id=? AND kind='INPUT_DIAGNOSTIC' ORDER BY sequence").all(sid).flatMap((row:any)=>JSON.parse(row.envelope).payload.interaction?.samples??[]),requests:()=>groupCalls,downloads:()=>assetCalls,scopeEvents:(scope:string)=>db.prepare('SELECT envelope FROM lab_event_evidence WHERE session_id=? AND scope=? ORDER BY sequence').all(sid,scope).map((row:any)=>JSON.parse(row.envelope)),close:()=>{db.close();rmSync(root,{recursive:true,force:true});}};
}

test('configured feedback stays visible for the whole feedback interval',async({page})=>{
  const f=await start(page,false,false,p=>{p.timing_defaults!.feedback_ms={base:1500,jitter:0};});try{
    await page.getByRole('button',{name:'开始本组'}).click();
    await expect(page.locator('#status')).toContainText('第 1 次呈现');
    await page.getByRole('button',{name:'Left',exact:true}).click();
    await expect(page.locator('#status')).toContainText('请等待下一次呈现');
    expect(await page.locator('#stimulus').evaluate(element=>(element as HTMLElement).style.visibility)).toBe('visible');
  }finally{f.close();}
});

test('image click visibly confirms first answer; right click, repeated key, and changed second answer are excluded',async({page})=>{
  const f=await start(page);try{
    await page.getByRole('button',{name:'开始本组'}).click();
    await expect(page.locator('#status')).toContainText('第 1 次呈现');
    const left=page.getByRole('button',{name:'Left',exact:true}),right=page.getByRole('button',{name:'Right',exact:true});
    await left.click({button:'right'});await left.click({button:'middle'});await expect(left).toHaveAttribute('aria-pressed','false');
    expect(await left.evaluate(e=>!e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})))).toBe(true);
    await left.click();await expect(left).toHaveAttribute('aria-pressed','true');await expect(page.locator('#status')).toContainText('已选择：Left');
    await right.click();await expect(left).toHaveAttribute('aria-pressed','true');await expect(right).toHaveAttribute('aria-pressed','false');
    expect(f.requests()).toBe(0);
    await expect(page.locator('#status')).toContainText('第 2 次呈现');
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
  try{await page.getByRole('button',{name:'开始本组'}).tap();await expect(page.locator('#status')).toContainText('第 1 次呈现');
    await page.getByRole('button',{name:'Left',exact:true}).tap();await expect(page.getByRole('button',{name:'Left',exact:true})).toHaveAttribute('aria-pressed','true');
    // Watch every frame: ordinary assertion polling can miss a short interval.
    await page.waitForFunction(()=>document.querySelector('#status')?.textContent==='请等待下一次呈现。');
    await page.evaluate(()=>{const r=document.querySelector('.response-buttons button')!.getBoundingClientRect();window.dispatchEvent(new PointerEvent('pointerdown',{pointerId:77,pointerType:'touch',button:0,clientX:r.x+10,clientY:r.y+10}));});
    await expect(page.locator('#status')).toContainText('第 2 次呈现');
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
    const chooseRating=async(value:number)=>{const range=page.getByRole('slider',{name:'测试项目',exact:true});const box=(await range.boundingBox())!;await page.touchscreen.tap(box.x+11+(box.width-22)*(value-1)/8,box.y+box.height/2);};
    const submit=page.getByRole('button',{name:'提交评分',exact:true});await expect(submit).toBeDisabled();
    // More than the legacy fixed window: no answer still keeps the first picture.
    await page.waitForTimeout(3200);await expect(page.locator('#status')).toContainText('第 1/2 张');await expect(page.locator('#stimulus')).toBeVisible();
    expect(f.requests()).toBeGreaterThan(0);expect(f.records().some((r:any)=>r.type==='ONSET')).toBe(true);expect(f.interactions().length).toBeGreaterThan(0);
    await chooseRating(2);await expect(submit).toBeEnabled();
    await submit.tap();
    await expect(page.locator('#stimulus')).toBeHidden();await expect(submit).toBeDisabled();
    await expect.poll(()=>f.records().filter((r:any)=>r.type==='RATING').length).toBe(1);
    await expect(submit).toBeDisabled();
    await expect(page.locator('#status')).toContainText('第 2/2 张',{timeout:5000});
    await chooseRating(4);await submit.tap();await expect(page.locator('#done')).toBeVisible({timeout:12000});
    const permit=f.view().permit,records=f.records();expect(permit.state).toBe('CLOSED_NORMAL');expect(f.view().diagnostics).toHaveLength(0);
    expect(records.filter((r:any)=>r.type==='RATING').map((r:any)=>r.values)).toEqual([[2],[4]]);
    for(const r of records.filter((r:any)=>r.instance_id)){expect(r.photo_id).toBe(r.instance_id.split(':')[0]);expect(r.photo_filename).toBe(r.photo_id==='first'?'test.png':'second.png');expect(r.group_id).toBe('ratings');}
    const actions=f.interactions().filter((s:any)=>s.context?.phase==='rating'&&s.context?.asset_id);expect(actions.length).toBeGreaterThan(0);for(const s of actions){expect(s.context.photo_filename).toBe(s.context.photo_id==='first'?'test.png':'second.png');expect(s.context.stimulus_visible).toBe(true);}
    const replay=new RunReplay(permit.plan);for(const r of records)replay.apply(r);const results=replay.finish();
    expect(results).toHaveLength(2);for(const r of results)expect(r.isi_ms).toBeGreaterThanOrEqual(3000);
    expect(results[1]!.onset-results[0]!.clear!).toBeGreaterThanOrEqual(3000);
  }catch(error){console.log('Rating diagnostic',JSON.stringify(f.view().diagnostics),JSON.stringify(f.records()));throw error;}finally{await context.close();f.close();}
});

test('one rating plus age advances before submitting and honors frozen age bounds without moving the image',async({page})=>{
  const f=await start(page,true,true);try{
    await page.getByRole('button',{name:'开始本组'}).click();const range=page.getByRole('slider',{name:'测试项目'});await expect(range).toBeVisible();
    const before=await page.locator('#stimulus').boundingBox();await expect(page.locator('#status')).toHaveText('第 1/1 张');await expect(page.getByRole('button',{name:'下一题',exact:true})).toBeDisabled();
    await range.press('End');await expect(page.locator('#status')).toHaveText('第 1/1 张');await expect(page.locator('.rating-axis output').first()).toHaveText('已选择：9 · 非常');
    await page.getByRole('button',{name:'下一题',exact:true}).click();const age=page.getByRole('textbox',{name:'你的年龄是？'});await expect(age).toBeVisible();await expect(page.locator('.rating-age-hint')).toHaveText('18–65 岁');
    await age.press('5');await expect(age).toHaveAttribute('aria-invalid','true');await expect(page.getByRole('button',{name:'提交评分'})).toBeDisabled();
    await age.press('Backspace');await age.press('1');await age.press('8');await expect(page.getByRole('button',{name:'提交评分'})).toBeEnabled();expect(await page.locator('#stimulus').boundingBox()).toEqual(before);
    await page.getByRole('button',{name:'提交评分'}).click();await expect(page.locator('#done')).toBeVisible({timeout:10000});expect(f.records().find((r:any)=>r.type==='RATING').values).toEqual([9,18]);expect(f.view().diagnostics).toHaveLength(0);expect(f.view().permit.state).toBe('CLOSED_NORMAL');
  }finally{f.close();}
});

test('releasing a captured rating drag after advancing cannot answer the age question',async({page})=>{
  const f=await start(page,true,true),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    await page.getByRole('button',{name:'开始本组'}).click();
    const range=page.getByRole('slider',{name:'测试项目'});await expect(range).toBeVisible();
    const rect=(await range.boundingBox())!;
    await page.mouse.move(rect.x+11,rect.y+rect.height/2);await page.mouse.down();
    const next=page.getByRole('button',{name:'下一题',exact:true});await expect(next).toBeEnabled();
    await next.focus();await page.keyboard.press('Enter');
    const age=page.getByRole('textbox',{name:'你的年龄是？'});await expect(age).toBeVisible();await expect(age).toBeFocused();
    await page.mouse.move(rect.x+rect.width-11,rect.y+rect.height/2);await page.mouse.up();
    await expect(page.getByRole('button',{name:'提交评分'})).toBeDisabled();
    await age.press('1');await age.press('8');await page.getByRole('button',{name:'提交评分'}).click();
    await expect(page.locator('#done')).toBeVisible({timeout:10000});
    expect(errors).toEqual([]);expect(f.records().find((r:any)=>r.type==='RATING').values).toEqual([1,18]);
    expect(f.view().permit.state).toBe('CLOSED_NORMAL');
  }finally{f.close();}
});

test('a held rating drag cannot leak into another axis or the next image',async({page})=>{
  const f=await start(page,true,false,p=>{p.groups[0]!.rating!.items=['第一项','第二项'];});
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    await page.getByRole('button',{name:'开始本组'}).click();
    const first=page.getByRole('slider',{name:'第一项'}),second=page.getByRole('slider',{name:'第二项'});
    await expect(first).toBeVisible();const rect=(await first.boundingBox())!;
    await page.mouse.move(rect.x+11,rect.y+rect.height/2);await page.mouse.down();
    const next=page.getByRole('button',{name:'下一题',exact:true});await next.focus();await page.keyboard.press('Enter');
    await expect(second).toBeVisible();await expect(second).toBeFocused();await page.mouse.move(rect.x+rect.width-11,rect.y+rect.height/2);await page.mouse.up();
    await expect(second).toHaveAttribute('data-answered','false');await expect(page.getByRole('button',{name:'提交评分'})).toBeDisabled();
    const secondRect=(await second.boundingBox())!;
    await page.mouse.move(secondRect.x+11+(secondRect.width-22)/4,secondRect.y+secondRect.height/2);await page.mouse.down();
    const submit=page.getByRole('button',{name:'提交评分'});await submit.focus();await page.keyboard.press('Enter');
    await expect(page.locator('#stimulus')).toBeHidden();await expect(page.locator('#status')).toContainText('第 2/2 张',{timeout:5000});
    await page.mouse.move(rect.x+rect.width-11,rect.y+rect.height/2);await page.mouse.up();
    await expect(first).toHaveAttribute('data-answered','false');await expect(next).toBeDisabled();
    await first.press('Space');await next.click();await second.press('End');await submit.click();
    await expect(page.locator('#done')).toBeVisible({timeout:10000});
    expect(errors).toEqual([]);expect(f.records().filter((r:any)=>r.type==='RATING').map((r:any)=>r.values)).toEqual([[1,3],[5,9]]);
    expect(f.records().filter((r:any)=>r.type==='RATING_CHANGE')).toHaveLength(4);
  }finally{f.close();}
});

test('a layout change while the permit request is pending stops before any stimulus',async({page})=>{
  const f=await start(page);let release!:()=>void,received!:()=>void;
  const blocked=new Promise<void>(resolve=>release=resolve),incoming=new Promise<void>(resolve=>received=resolve);
  await page.route('**/api/participate/sessions/*/permit',async route=>{received();await blocked;await route.fallback();});
  try{
    await page.getByRole('button',{name:'开始本组'}).click();await incoming;
    await page.setViewportSize({width:430,height:844});release();
    await expect(page.getByRole('button',{name:'返回问卷'})).toBeVisible();
    expect(f.view().state).toBe('TERMINATED');expect(f.records().filter((r:any)=>r.type==='ONSET')).toHaveLength(0);
  }finally{release();f.close();}
});

test('a failed group seal removes task input before the retry interface is used',async({page})=>{
  const f=await start(page);let attempts=0;
  await page.route('**/api/participate/sessions/*/seal',async route=>{
    if(++attempts===1)await route.fulfill({status:400,json:{code:'TEST_SEAL_FAILED'}});else await route.fallback();
  });
  try{
    await page.getByRole('button',{name:'开始本组'}).click();
    await expect(page.getByRole('button',{name:'重试保存'})).toBeVisible({timeout:10000});
    const scope=`d-${f.view().permit.scope}`,before=f.scopeEvents(scope).length;
    await page.keyboard.press('f');await page.getByRole('button',{name:'重试保存'}).click();
    await expect(page.locator('#done')).toBeVisible();
    expect(f.scopeEvents(scope)).toHaveLength(before);expect(f.view().permit.state).toBe('CLOSED_NORMAL');
    expect(attempts).toBe(2);
  }finally{f.close();}
});

for(const viewport of [{width:704,height:755},{width:390,height:660},{width:320,height:480}])test(`rating borders, feedback and age keypad fit without moving the portrait at ${viewport.width}x${viewport.height}`,async({page})=>{
 // Production links shared participant CSS after the runner CSS.
 await page.addInitScript(css=>window.addEventListener('DOMContentLoaded',()=>{const style=document.createElement('style');style.textContent=css;document.head.append(style);}),readFileSync(new URL('../../src/web/participant.css',import.meta.url),'utf8'));
 const prompts=['您觉得这位医生看起来有多值得信任？','您觉得这位医生的专业能力如何？','如果您需要看病，您有多愿意选择这位医生为您诊治？'];
 const f=await start(page,true,true,p=>{p.groups[0]!.rating!.items=prompts;},viewport);
 const check=async()=>{
  const issues=await page.evaluate(()=>{
   const issues:string[]=[],footer=document.querySelector('.runner-start')!.getBoundingClientRect();
   for(const node of document.querySelectorAll('main button,main input,.rating-axis,.axis-bottom output')){
    if(getComputedStyle(node).visibility==='hidden')continue;
    const r=node.getBoundingClientRect();if(!r.width||!r.height)continue;
    if(r.left<0||r.top<0||r.right>innerWidth+1||r.bottom>innerHeight+1)issues.push(`clipped ${node.className}`);
    if(node.classList.contains('rating-axis')&&r.bottom>footer.top-4)issues.push('rating border overlaps submit');
    if(node.tagName==='OUTPUT'&&r.bottom>node.closest('.rating-axis')!.getBoundingClientRect().bottom)issues.push('feedback outside rating border');
   }
   return issues;
  });expect(issues).toEqual([]);
 };
 try{
  const portrait=await page.locator('#stimulus').boundingBox();await check();
  await page.getByRole('button',{name:'开始本组',exact:true}).click();
  for(const prompt of prompts){const slider=page.getByRole('slider',{name:prompt,exact:true});await expect(slider).toBeVisible();await check();await slider.press('End');await check();expect(await page.locator('#stimulus').boundingBox()).toEqual(portrait);await page.getByRole('button',{name:'下一题',exact:true}).click();}
  await expect(page.getByRole('textbox',{name:'你的年龄是？'})).toBeVisible();await check();expect(await page.locator('#stimulus').boundingBox()).toEqual(portrait);
  await page.getByRole('button',{name:'1',exact:true}).click();await page.getByRole('button',{name:'8',exact:true}).click();await page.getByRole('button',{name:'提交评分',exact:true}).click();
  await expect(page.locator('#done')).toBeVisible({timeout:10000});expect(f.view().permit.state).toBe('CLOSED_NORMAL');expect(f.view().diagnostics).toHaveLength(0);
 }finally{f.close();}
});

test('fractional Android WebView slider rectangles pass admission without changing recorded geometry',async({browser})=>{
 const context=await browser.newContext({viewport:{width:400,height:779},deviceScaleFactor:2.7,isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (Linux; Android 16; wv) AppleWebKit/537.36 Chrome/150.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.79'}),page=await context.newPage();
 await context.addInitScript(()=>{const original=Element.prototype.getBoundingClientRect;Element.prototype.getBoundingClientRect=function(){const r=original.call(this);return this.matches('.axis-input')?new DOMRect(r.x,r.y,r.width,r.height-0.000003814697265625):r;};});
 const f=await start(page,true,true,p=>{p.budget.commit_ms=1000;},{width:400,height:779});
 try{
  await page.getByRole('button',{name:'开始本组',exact:true}).tap();await expect(page.getByRole('slider',{name:'测试项目'})).toBeVisible();
  expect(f.view().permit.plan.geometry.buttons[0].height).toBe(43.999996185302734);
  await page.getByRole('slider',{name:'测试项目'}).press('End');await page.getByRole('button',{name:'下一题',exact:true}).tap();
  const age=page.getByRole('textbox',{name:'你的年龄是？'});await age.press('1');await age.press('8');await page.getByRole('button',{name:'提交评分',exact:true}).tap();
  await expect(page.locator('#done')).toBeVisible({timeout:10000});expect(f.view().permit.state).toBe('CLOSED_NORMAL');expect(f.view().diagnostics).toHaveLength(0);expect(f.records().find((r:any)=>r.type==='RATING').values).toEqual([9,18]);
 }finally{await context.close();f.close();}
});

for(const control of ['slider','single'] as const)for(const viewport of [{width:704,height:755},{width:390,height:660},{width:320,height:480}])test(`five impressions then ${control} supplementary familiarity then age save without moving the photo at ${viewport.width}x${viewport.height}`,async({page})=>{
  const items=['可信度','专业能力','亲切友善','外貌吸引力','就诊意愿'],fam='在参加本研究前，您对这位医生有多熟悉？';
  const f=await start(page,true,true,p=>{const r=p.groups[0]!.rating!;r.items=items;r.age_min=18;r.age_max=50;r.familiarity={prompt:fam,labels:['从未见过','见过','多次见过','有过接触','多次接触','非常熟悉'],position:'before-age',...(control==='single'?{control}:{})};},viewport),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.getByRole('button',{name:'开始本组'}).click();await expect(page.getByRole('slider',{name:items[0]!,exact:true})).toBeVisible();const photo=await page.locator('#stimulus').boundingBox(),next=page.getByRole('button',{name:'下一题',exact:true});
    for(const prompt of [...items,fam]){await expect(next).toBeDisabled();await expect(page.locator('#stimulus')).toBeVisible();expect(await page.locator('#stimulus').boundingBox()).toEqual(photo);
      if(prompt===fam&&control==='single'){const group=page.getByRole('radiogroup',{name:fam,exact:true}),options=group.getByRole('radio');await expect(options).toHaveCount(6);await expect(group.locator('input:checked')).toHaveCount(0);await expect(page.getByRole('slider',{name:fam,exact:true})).toHaveCount(0);
        const labels=['从未见过','见过','多次见过','有过接触','多次接触','非常熟悉'];for(const [i,label]of labels.entries()){const option=group.getByRole('radio',{name:`${i+1} · ${label}`,exact:true});await option.check();await expect(option).toBeChecked();await expect(group.locator('input:checked')).toHaveCount(1);expect(await option.inputValue()).toBe(String(i+1));}
        const box=await group.boundingBox();expect(box!.y+box!.height).toBeLessThanOrEqual((await next.boundingBox())!.y);expect(await page.locator('#stimulus').boundingBox()).toEqual(photo);
      }else{const range=page.getByRole('slider',{name:prompt,exact:true});await expect(range).toBeVisible();const axis=await range.locator('xpath=../..').boundingBox(),footer=await next.boundingBox();expect(axis!.y+axis!.height).toBeLessThanOrEqual(footer!.y);expect(footer!.y+footer!.height).toBeLessThanOrEqual(viewport.height+1);await range.press('End');}await next.click();}
    const age=page.getByRole('textbox',{name:'你的年龄是？',exact:true}),submit=page.getByRole('button',{name:'提交评分',exact:true}),keypad=page.getByRole('group',{name:'年龄数字键盘',exact:true});await expect(age).toBeVisible();await expect(submit).toBeDisabled();expect(await page.locator('#stimulus').boundingBox()).toEqual(photo);
    await expect(keypad.getByRole('button')).toHaveCount(12);expect(await keypad.evaluate(node=>({columns:getComputedStyle(node).gridTemplateColumns.split(' ').length,rows:getComputedStyle(node).gridTemplateRows.split(' ').length}))).toEqual({columns:6,rows:2});
    const clear=keypad.getByRole('button',{name:'清空',exact:true});expect(await clear.evaluate(node=>getComputedStyle(node).color)).not.toBe(await keypad.getByRole('button',{name:'1',exact:true}).evaluate(node=>getComputedStyle(node).color));
    for(const value of ['17','51','18','50']){await clear.click();for(const digit of value)await age.press(digit);if(value==='17'||value==='51')await expect(submit).toBeDisabled();else await expect(submit).toBeEnabled();}
    await clear.click();await expect(age).toHaveValue('');await expect(submit).toBeDisabled();await age.press('4');await age.press('1');await keypad.getByRole('button',{name:'删除',exact:true}).click();await expect(age).toHaveValue('4');await age.press('0');await expect(submit).toBeEnabled();expect(await page.locator('#stimulus').boundingBox()).toEqual(photo);await submit.click();await expect(page.locator('#done')).toBeVisible({timeout:10000});
    const records=f.records(),familiarity=records.find((r:any)=>r.type==='RATING_FAMILIARITY');expect(familiarity.value).toBe(6);if(control==='single')expect(records.filter((r:any)=>r.type==='RATING_FAMILIARITY_CHANGE').map((r:any)=>r.value)).toEqual([1,2,3,4,5,6]);expect(familiarity.at).toBeGreaterThanOrEqual(Math.max(...records.filter((r:any)=>r.type==='RATING_CHANGE').map((r:any)=>r.at)));expect(records.find((r:any)=>r.type==='RATING').values).toEqual([9,9,9,9,9,40]);expect(f.view().permit.state).toBe('CLOSED_NORMAL');expect(errors).toEqual([]);
  }finally{f.close();}
});

test('twenty photos stream complete answers and replay during the task, recover a lost upload, and leave no final backlog',async({page,context})=>{
  test.setTimeout(150000);
  const items=['可信度','专业能力','亲切友善','外貌吸引力','就诊意愿'],fam='在参加本研究之前，您和照片中这位医生是否认识？';
  const f=await start(page,true,false,(p,addAsset)=>{
    const group=p.groups[0]!,base=[...group.trials];
    group.rating={...group.rating!,items,age_prompt:'请估计医生年龄',age_min:18,age_max:90,familiarity:{prompt:fam,labels:['从未见过','见过','多次见过','有过接触','多次接触','非常熟悉'],position:'before-age',control:'single'}};
    group.trials=Array.from({length:20},(_,i)=>({...base[i%2]!,asset_id:i<2?base[i]!.asset_id!:addAsset(),root_id:`photo-${i+1}`}));p.variants[0]!.trial_order.ratings=group.trials.map(t=>t.root_id);
  });
  let lost=false;await page.route('**/ingest',async route=>{if(!lost){lost=true;await route.abort();}else{await new Promise(resolve=>setTimeout(resolve,150));await route.fallback();}});
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    await page.getByRole('button',{name:'开始本组'}).click();
    for(let i=0;i<20;i++){
      await expect(page.locator('#status')).toHaveText(`第 ${i+1}/20 张`,{timeout:7000});
      if(i===1){expect(lost).toBe(true);await page.evaluate(()=>window.dispatchEvent(new Event('online')));}
      for(const item of items){await page.getByRole('slider',{name:item,exact:true}).press('End');await page.getByRole('button',{name:'下一题',exact:true}).click();}
      await page.getByRole('radio',{name:'1 · 从未见过',exact:true}).check();await page.getByRole('button',{name:'下一题',exact:true}).click();
      const age=page.getByRole('textbox',{name:'请估计医生年龄',exact:true});await age.press('4');await age.press('0');await page.getByRole('button',{name:'提交评分',exact:true}).click();
      if(i===2){await expect.poll(()=>f.records().filter((r:any)=>r.type==='RATING').length,{timeout:5000}).toBeGreaterThanOrEqual(2);expect(f.interactions().length).toBeGreaterThan(0);expect(f.view().permit.state).toBe('ISSUED');}
    }
    const submitted=Date.now();await expect(page.locator('#done')).toBeVisible({timeout:10000});
    expect(Date.now()-submitted).toBeLessThan(6000);expect(f.view().permit.state).toBe('CLOSED_NORMAL');expect(f.view().diagnostics).toEqual([]);
    const records=f.records();expect(records.filter((r:any)=>r.type==='RATING').map((r:any)=>r.values)).toEqual(Array.from({length:20},()=>[9,9,9,9,9,40]));
    expect(records.filter((r:any)=>r.type==='RATING_FAMILIARITY').map((r:any)=>r.value)).toEqual(Array(20).fill(1));expect(errors).toEqual([]);
    const pending=await page.evaluate(async()=>{const db=await new Promise<IDBDatabase>(resolve=>{const r=indexedDB.open('browser-psych-lab-v1');r.onsuccess=()=>resolve(r.result);});try{return await new Promise<number>(resolve=>{const r=db.transaction('outbox').objectStore('outbox').count();r.onsuccess=()=>resolve(r.result);});}finally{db.close();}});expect(pending).toBe(0);
  }finally{await context.close();f.close();}
});
