实施后复审差异第 4 段。原版完整源码已在本会话前15段给出；这些是git diff和新增测试连续片段。仅确认接收 PATCH_ACK_04，等最终请求再审计。
as any;
@@ -26,6 +26,7 @@ async function start(page:Page,rating=false,age=false){
     trials:[{root_id:'image',asset_id:asset.asset_id,correct:'Left'},{root_id:'text',text:'HELLO',correct:'Right'}]}]});
   if(rating&&age){p.groups[0]!.rating={...p.groups[0]!.rating!,age_prompt:'你的年龄是？',age_min:18,age_max:65};p.groups[0]!.trials.splice(1);p.variants[0]!.trial_order.ratings=['first'];}
   else if(rating){const second=admin('asset.begin',{request_id:randomUUID(),study_id:study.study_id,name:'second.png'});p.groups[0]!.trials[1]!.asset_id=second.asset_id;store.execute({operation:'lab/internal.asset.ready',data:{asset_id:second.asset_id,info:{hash:digest(png),bytes:png.length,width:1080,height:720,format:'png'}}});}
+  configure?.(p);
   const saved=admin('study.save',{request_id:randomUUID(),revision:1,study_id:study.study_id,protocol:p});
   const version=admin('study.publish',{request_id:randomUUID(),revision:saved.revision,study_id:study.study_id});
   admin('study.admission',{request_id:randomUUID(),study_id:study.study_id,paused:false});
@@ -62,7 +63,7 @@ async function start(page:Page,rating=false,age=false){
   await page.goto(`/run.html?version=${version.version_id}`);
   await expect(page.getByRole('button',{name:'开始本组'})).toBeVisible();
   return {view:()=>call('view'),records:()=>db.prepare("SELECT envelope FROM lab_events WHERE session_id=? AND kind='GROUP_RECORD' ORDER BY sequence").all(sid).map((e:any)=>JSON.parse(e.envelope).payload.record),
-    requests:()=>groupCalls,downloads:()=>assetCalls,close:()=>{db.close();rmSync(root,{recursive:true,force:true});}};
+    requests:()=>groupCalls,downloads:()=>assetCalls,scopeEvents:(scope:string)=>db.prepare('SELECT envelope FROM lab_events WHERE session_id=? AND scope=? ORDER BY sequence').all(sid,scope).map((row:any)=>JSON.parse(row.envelope)),close:()=>{db.close();rmSync(root,{recursive:true,force:true});}};
 }
 
 test('image click visibly confirms first answer; right click, repeated key, and changed second answer are excluded',async({page})=>{
@@ -134,3 +135,74 @@ test('one rating plus age advances before submitting and honors frozen age bound
     await page.getByRole('button',{name:'提交评分'}).click();await expect(page.locator('#done')).toBeVisible({timeout:10000});expect(f.records().find((r:any)=>r.type==='RATING').values).toEqual([9,18]);expect(f.view().diagnostics).toHaveLength(0);expect(f.view().permit.state).toBe('CLOSED_NORMAL');
   }finally{f.close();}
 });
+
+test('releasing a captured rating drag after advancing cannot answer the age question',async({page})=>{
+  const f=await start(page,true,true),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
+  try{
+    await page.getByRole('button',{name:'开始本组'}).click();
+    const range=page.getByRole('slider',{name:'测试项目'});await expect(range).toBeVisible();
+    const rect=(await range.boundingBox())!;
+    await page.mouse.move(rect.x+11,rect.y+rect.height/2);await page.mouse.down();
+    const next=page.getByRole('button',{name:'下一题',exact:true});await expect(next).toBeEnabled();
+    await next.focus();await page.keyboard.press('Enter');
+    const age=page.getByRole('textbox',{name:'你的年龄是？'});await expect(age).toBeVisible();await expect(age).toBeFocused();
+    await page.mouse.move(rect.x+rect.width-11,rect.y+rect.height/2);await page.mouse.up();
+    await expect(page.getByRole('button',{name:'提交评分'})).toBeDisabled();
+    await age.press('1');await age.press('8');await page.getByRole('button',{name:'提交评分'}).click();
+    await expect(page.locator('#done')).toBeVisible({timeout:10000});
+    expect(errors).toEqual([]);expect(f.records().find((r:any)=>r.type==='RATING').values).toEqual([1,18]);
+    expect(f.view().permit.state).toBe('CLOSED_NORMAL');
+  }finally{f.close();}
+});
+
+test('a held rating drag cannot leak into another axis or the next image',async({page})=>{
+  const f=await start(page,true,false,p=>{p.groups[0]!.rating!.items=['第一项','第二项'];});
+  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
+  try{
+    await page.getByRole('button',{name:'开始本组'}).click();
+    const first=page.getByRole('slider',{name:'第一项'}),second=page.getByRole('slider',{name:'第二项'});
+    await expect(first).toBeVisible();const rect=(await first.boundingBox())!;
+    await page.mouse.move(rect.x+11,rect.y+rect.height/2);await page.mouse.down();
+    const next=page.getByRole('button',{name:'下一题',exact:true});await next.focus();await page.keyboard.press('Enter');
+    await expect(second).toBeVisible();await expect(second).toBeFocused();await page.mouse.move(rect.x+rect.width-11,rect.y+rect.height/2);await page.mouse.up();
+    await expect(second).toHaveAttribute('data-answered','false');await expect(page.getByRole('button',{name:'提交评分'})).toBeDisabled();
+    const secondRect=(await second.boundingBox())!;
+    await page.mouse.move(secondRect.x+11+(secondRect.width-22)/4,secondRect.y+secondRect.height/2);await page.mouse.down();
+    const submit=page.getByRole('button',{name:'提交评分'});await submit.focus();await page.keyboard.press('Enter');
+    await expect(page.locator('#stimulus')).toBeHidden();await expect(page.locator('#status')).toContainText('第 2/2 张',{timeout:5000});
+    await page.mouse.move(rect.x+rect.width-11,rect.y+rect.height/2);await page.mouse.up();
+    await expect(first).toHaveAttribute('data-answered','false');await expect(next).toBeDisabled();
+    await first.press('Space');await next.click();await second.press('End');await submit.click();
+    await expect(page.locator('#done')).toBeVisible({timeout:10000});
+    expect(errors).toEqual([]);expect(f.records().filter((r:any)=>r.type==='RATING').map((r:any)=>r.values)).toEqual([[1,3],[5,9]]);
+    expect(f.records().filter((r:any)=>r.type==='RATING_CHANGE')).toHaveLength(4);
+  }finally{f.close();}
+});
+
+test('a layout change while the permit request is pending stops before any stimulus',async({page})=>{
+  const f=await start(page);let release!:()=>void,received!:()=>void;
+  const blocked=new Promise<void>(resolve=>release=resolve),incoming=new Promise<void>(resolve=>received=resolve);
+  await page.route('**/api/participate/sessions/*/permit',async route=>{received();await blocked;await route.fallback();});
+  try{
+    await page.getByRole('button',{name:'开始本组'}).click();await incoming;
+    await page.setViewportSize({width:430,height:844});release();
+    await expect(page.getByRole('button',{name:'返回问卷'})).toBeVisible();
+    expect(f.view().state).toBe('TERMINATED');expect(f.records().filter((r:any)=>r.type==='ONSET')).toHaveLength(0);
+  }finally{release();f.close();}
+});
+
+test('a failed group seal removes task input before the retry interface is used',async({page})=>{
+  const f=await start(page);let attempts=0;
+  await page.route('**/api/participate/sessions/*/seal',async route=>{
+    if(++attempts===1)await route.fulfill({status:400,json:{code:'TEST_SEAL_FAILED'}});else await route.fallback();
+  });
+  try{
+    await page.getByRole('button',{name:'开始本组'}).click();
+    await expect(page.getByRole('button',{name:'重试保存'})).toBeVisible({timeout:10000});
+    const scope=`d-${f.view().permit.scope}`,before=f.scopeEvents(scope).length;
+    await page.keyboard.press('f');await page.getByRole('button',{name:'重试保存'}).click();
+    await expect(page.locator('#done')).toBeVisible();
+    expect(f.scopeEvents(scope)).toHaveLength(before);expect(f.view().permit.state).toBe('CLOSED_NORMAL');
+    expect(attempts).toBe(2);
+  }finally{f.close();}
+});

=== NEW FILE tests/runner-browser/interaction.spec.ts ===
import {test,expect} from '@playwright/test';

test('optional formatted personal information can be cleared and skipped after validation',async({page})=>{
  await page.goto('/participate.html');
  await page.evaluate(async()=>{
    const source='/survey-page.ts';
    const {mountPage}=await import(source);
    (window as any).submitted=[];
    mountPage(document.querySelector('#content'),{id:'personal',title:'Interaction regression',instruction:'',questions:[
      {id:'name',type:'text',input_purpose:'personal',title:'可选姓名',required:false,max_length:30,input_match:{kind:'regex',pattern:'[A-Z]{2,10}',message:'请输入大写姓名'}},
      {id:'done',type:'single',title:'确认继续',required:true,choices:['继续']},
    ]},{},{},()=>{},(answers:unknown)=>(window as any).submitted.push(answers),{key:'interaction-optional',title:'Interaction regression'});
  });
  const input=page.getByRole('textbox',{name:'可选姓名'});
  await input.fill('wrong');await page.getByRole('button',{name:'完成输入'}).click();
  await page.getByRole('button',{name:'下一题',exact:true}).click();await expect(page.getByRole('alert')).toHaveText('请输入大写姓名');
  await input.fill('');await page.getByRole('button',{name:'完成输入'}).click();
  await page.getByRole('button',{name:'下一题',exact:true}).click();
  await expect(page.getByRole('button',{name:'继续',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'继续',exact:true}).click();await page.getByRole('button',{name:'提交本页'}).click();
  expect(await page.evaluate(()=>(window as any).submitted)).toEqual([{name:'',done:'继续'}]);
});

test('large diagnostic screens fit the event budget and retain native input samples',async({page})=>{
  await page.goto('/participate.html');
  const result=await page.evaluate(async()=>{
    const source='/interaction-recorder.ts';const {recordInteractions}=await import(source);
    const root=document.querySelector<HTMLElement>('#content')!;root.replaceChildren();
    for(let i=0;i<1200;i++){const node=document.createElement('button');node.textContent=`选项 ${i}：${'完整中文内容'.repeat(30)}`;root.append(node);}
    const input=document.createElement('input');input.value='保留完整输入';root.append(input);
    const batches:any[]=[],errors:string[]=[],data='原始输入'.repeat(1000);
    const recorder=recordInteractions(root,()=>({page_id:'large-screen'}),async(batch:unknown)=>{batches.push(batch);},(error:unknown)=>errors.push(String(error)));
    input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data}));
    await recorder.stop();
    const samples=batches.flatMap(batch=>batch.samples),screens=samples.filter(sample=>sample.type==='screen');
    return {errors,sizes:batches.map(batch=>new TextEncoder().encode(JSON.stringify(batch)).length),screens:screens.map(screen=>({truncated:screen.nodes_truncated,nodes:screen.nodes.length})),input:samples.find(sample=>sample.type==='input'),data};
  });
  expect(result.errors).toEqual([]);expect(result.sizes.length).toBeGreaterThan(0);
  expect(result.sizes.every((size:number)=>size<=91000)).toBe(true);
  expect(result.screens.every((screen:any)=>screen.truncated&&screen.nodes>0&&screen.nodes<1900)).toBe(true);
  expect(result.input).toMatchObject({value:'保留完整输入',data:result.data,input_type:'insertText'});
});
