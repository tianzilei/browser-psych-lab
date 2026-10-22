import {test,expect,type BrowserContext,type Page} from '@playwright/test';
import {questionnaireTemplate} from '../../src/shared/questionnaire-json.js';
import {gunzipSync} from 'node:zlib';
import {signIn} from './admin-auth.js';
const origin='http://127.0.0.1:3107';
async function setup(context:BrowserContext,questions=65,configure?:(source:any)=>void){
  const csrf=await signIn(context);
  const post=async(url:string,data:unknown)=>{const r=await context.request.post(url,{headers:{Origin:origin,'X-CSRF-Token':csrf},data});expect(r.ok(),await r.text()).toBeTruthy();return r.json();};
  const source={...questionnaireTemplate(),title:'自动保存与自适应分页测试',questionnaire_layout:'adaptive',record_interactions:false,orientation:'auto',consent:undefined,
    pages:[{id:'survey',title:'',instruction:'',questions:[
      {id:'identifier',type:'text',title:'问卷编号',input_purpose:'personal',max_length:15,required:true,input_match:{kind:'regex',pattern:'[0-9]{11}[A-Z][A-Z][A-Z][A-Z]',message:'编号须为11位数字和4位大写字母。'}},
      ...Array.from({length:questions-1},(_,i)=>({id:`q${i+2}`,type:'scale',title:`第${i+2}道题：请按实际情况评分。`,required:true,labels:['完全不符合','2','3','4','完全符合']}))
    ]}]};
  configure?.(source);
  const study=await post('/api/lab/studies',{request_id:crypto.randomUUID()});
  const {frozen}=await post(`/api/lab/studies/${study.study_id}/import`,{request_id:crypto.randomUUID(),revision:1,source:JSON.stringify(source)});
  await post(`/api/lab/studies/${study.study_id}/admission`,{request_id:crypto.randomUUID(),paused:false});
  return {study,version:frozen.version_id,protocol:frozen.protocol};
}
async function local(page:Page,store='meta'){
  return page.evaluate(async store=>{
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open('browser-psych-lab-v1');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    try{return await new Promise<any[]>((resolve,reject)=>{const request=db.transaction(store).objectStore(store).getAll();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}finally{db.close();}
  },store);
}
async function answerScreen(page:Page){
  for(const input of await page.getByRole('slider').all())await input.press('End');
}
async function nextScreen(page:Page){
  const before=await page.locator('.question-progress').textContent();
  await page.getByRole('button',{name:/^(下一页|完成问卷)$/}).click();
  await expect.poll(async()=>await page.locator('.adaptive-waiting,.ending-page').count()>0||await page.locator('.question-progress').textContent()!==before).toBe(true);
}
async function detail(context:BrowserContext,study:string){
  const {sessions}=await (await context.request.get(`/api/lab/studies/${study}/sessions`)).json();
  return (await context.request.get(`/api/lab/sessions/${sessions[0].session_id}`)).json();
}
test.afterEach(async({context})=>{for(const cookie of await context.cookies())if(/^lab_[a-f0-9-]{36}$/.test(cookie.name))await context.request.post(`/api/participate/sessions/${cookie.name.slice(4)}/terminate`,{headers:{Origin:origin},data:{request_id:crypto.randomUUID(),reason:'TEST_ONLY_TEARDOWN'}});});
for(const acknowledged of [false,true])test(`hidden answers stay null across segment recovery with seal ${acknowledged?'confirmed':'pending'}`,async({page,context})=>{
  const {study,version}=await setup(context,3,source=>{
    const scale={id:'end',type:'scale',title:'最后评分',required:true,labels:['低','2','3','4','高']};
    source.pages=[
      {id:'first',title:'',instruction:'',questions:[
        {id:'a',type:'single',title:'显示补充题？',required:true,choices:['是','否']},
        {id:'hidden',type:'single',title:'补充题',required:true,choices:['foo','bar'],condition:{op:'eq',question:'a',value:'是'}}
      ]},
      {id:'conditional',title:'',instruction:'',condition:{op:'eq',question:'hidden',value:'foo'},questions:[{...scale,id:'skipped',title:'应跳过的整段'}]},
      {id:'last',title:'',instruction:'',questions:[scale]}
    ];
  });
  if(!acknowledged)await page.route('**/seal',route=>route.abort());
  await page.goto(`/participate.html?version=${version}`);
  await page.getByRole('button',{name:'是',exact:true}).click();await page.getByRole('button',{name:'foo',exact:true}).click();
  await page.getByRole('button',{name:'否',exact:true}).click();await expect(page.getByRole('button',{name:'foo',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'下一页',exact:true}).click();await expect(page.getByRole('slider',{name:'最后评分'})).toBeVisible();
  await expect.poll(async()=>!!(await local(page))[0].pending.first).toBe(true);
  if(acknowledged)await expect.poll(async()=>(await detail(context,study.study_id)).page_index).toBe(2);
  const raw=(await local(page,'events')).map(row=>({event_id:row.event_id,raw:row.raw,hash:row.hash}));
  expect((await local(page))[0].page_values.first.hidden).toBe('foo');
  await page.reload();await expect(page.getByRole('slider',{name:'最后评分'})).toBeVisible();
  await expect(page.getByRole('slider',{name:'应跳过的整段'})).toHaveCount(0);
  expect((await local(page,'events')).map(row=>({event_id:row.event_id,raw:row.raw,hash:row.hash}))).toEqual(raw);
  await page.unroute('**/seal');await page.getByRole('slider',{name:'最后评分'}).press('End');
  await page.getByRole('button',{name:'完成问卷',exact:true}).click();await expect(page.locator('.ending-page')).toBeVisible();
  const saved=await detail(context,study.study_id);expect(saved.state).toBe('COMPLETED');
  expect(saved.answers.hidden).toBeNull();expect(saved.answers.skipped).toBeNull();expect(saved.answers.end).toBe(5);
  expect(saved.path).toEqual(['first','last']);expect(saved.diagnostics).toEqual([]);
  expect((await local(page,'events')).filter(row=>row.scope==='conditional')).toEqual([]);
  expect(await local(page,'outbox')).toEqual([]);
});
test('adaptive pages fit actual viewport, reject missing/malformed answers, persist edits and resize safely',async({page,context})=>{
  const {study,version}=await setup(context);
  await page.setViewportSize({width:375,height:667});await page.goto(`/participate.html?version=${version}`);
  const input=page.getByRole('textbox',{name:'问卷编号'});await expect(input).toBeVisible();
  await input.fill('20991231001Test');await page.getByRole('button',{name:'下一页',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('大写字母');await expect(input).toBeVisible();
  await input.fill('20991231001TEST');await page.getByRole('button',{name:'下一页',exact:true}).click();
  const cards=page.locator('.adaptive-card');await expect(page.locator('.question-progress')).toContainText('第 2');expect(await cards.count()).toBeGreaterThan(1);
  const phoneCount=await cards.count();await expect(page.locator('.question-progress')).toContainText('第 2');
  expect(await page.getByRole('slider').first().getAttribute('data-answered')).toBe('false');
  const before=await page.locator('.question-progress').textContent();
  await page.getByRole('slider').first().press('End');await page.getByRole('button',{name:'下一页',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('所有必答题');expect(await page.locator('.question-progress').textContent()).toBe(before);
  await answerScreen(page);await page.screenshot({path:'.local/adaptive-mobile.png'});
  const geometry=await page.locator('.adaptive-screen').evaluate(node=>({client:node.clientHeight,scroll:node.scrollHeight,width:document.documentElement.scrollWidth,viewport:innerWidth}));
  expect(geometry.scroll).toBeLessThanOrEqual(geometry.client+1);expect(geometry.width).toBeLessThanOrEqual(geometry.viewport);
  await page.setViewportSize({width:1280,height:900});await expect.poll(()=>cards.count()).toBeGreaterThan(phoneCount);
  await answerScreen(page);await page.screenshot({path:'.local/adaptive-desktop.png'});
  await nextScreen(page);const cursor=(await local(page))[0].survey_cursor;
  await page.reload();await expect(page.locator('.adaptive-card').first()).toHaveAttribute('data-question-id',cursor.question_id);
  await expect(page.getByRole('button',{name:'上一页',exact:true})).toBeVisible();
  await expect.poll(async()=>Object.keys((await local(page))[0].page_values.survey_part_1).length).toBeGreaterThan(2);
  const saved=await detail(context,study.study_id);expect(saved.diagnostics).toEqual([]);
});
test('initial packing reserves progress height before adding wrapped question cards',async({page,context})=>{
  const {version}=await setup(context,8,source=>{
    source.pages[0].questions=source.pages[0].questions.slice(1);
    for(const [i,q]of source.pages[0].questions.entries())q.title=i%2?'我批评那些不对自己负责的人。':'我对信仰虔诚。';
  });
  await page.setViewportSize({width:320,height:568});await page.goto(`/participate.html?version=${version}`);
  await expect(page.getByRole('slider').first()).toBeVisible();
  const bounds=await page.locator('.adaptive-screen').evaluate(node=>({height:node.clientHeight,scroll:node.scrollHeight}));
  expect(bounds.scroll).toBeLessThanOrEqual(bounds.height+1);
});
test('normal background custody stays quiet and does not move the active question',async({page,context})=>{
  const {version}=await setup(context,8);
  await page.setViewportSize({width:390,height:844});await page.goto(`/participate.html?version=${version}`);
  const banner=page.locator('.adaptive-save'),input=page.getByRole('textbox',{name:'问卷编号'});
  await expect(input).toBeVisible();await expect(banner).toBeHidden();
  const inputBounds=await input.boundingBox();await input.pressSequentially('20991231001TEST',{delay:20});
  await expect.poll(async()=>(await local(page,'events')).filter(row=>JSON.parse(row.raw).kind==='PAGE_REVISION'&&row.receipt?.custody==='PERSISTED').length).toBe(15);
  await expect(input).toBeFocused();expect(await input.boundingBox()).toEqual(inputBounds);
  await expect(banner).toBeHidden();await expect(banner.getByRole('status',{includeHidden:true})).toHaveText('');
  await nextScreen(page);const slider=page.getByRole('slider').first(),before=await slider.boundingBox();
  await slider.press('End');
  await expect.poll(async()=>(await local(page,'events')).some(row=>JSON.parse(row.raw).payload.question_id==='q2'&&row.receipt?.custody==='PERSISTED')).toBe(true);
  await expect(slider).toBeFocused();expect(await slider.boundingBox()).toEqual(before);
  await expect(banner).toBeHidden();await expect(banner.getByRole('status',{includeHidden:true})).toHaveText('');
  expect(await local(page,'outbox')).toEqual([]);
});
test('final save shows confirmed progress and automatic retry without claiming completion before finalize',async({page,context})=>{
  const {version}=await setup(context,2);
  await page.setViewportSize({width:390,height:844});await page.goto(`/participate.html?version=${version}`);
  await page.getByRole('textbox').fill('20991231001TEST');await nextScreen(page);
  await page.route('**/finalize',route=>route.abort());await answerScreen(page);await nextScreen(page);
  await expect(page.locator('.adaptive-save')).toContainText('100%');
  await expect(page.locator('.adaptive-save')).toContainText('自动重试');
  await expect(page.locator('.adaptive-save')).toContainText('完成状态尚未确认');
  await expect(page.locator('.ending-page')).toHaveCount(0);
  expect(await page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;})).toBe(true);
  await page.unroute('**/finalize');await page.getByRole('button',{name:'重试保存',exact:true}).click();
  await expect(page.locator('.ending-page')).toBeVisible();
  expect(await page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;})).toBe(false);
  await expect(page.locator('.ending-page')).toBeVisible();expect(await local(page,'outbox')).toEqual([]);
});
test('a lost finalization response recovers the completed page and clears the close warning',async({page,context})=>{
  const {version}=await setup(context,2);await page.goto(`/participate.html?version=${version}`);
  await page.getByRole('textbox').fill('20991231001TEST');await nextScreen(page);
  await page.route('**/finalize',async route=>{const response=await route.fetch();expect(response.ok()).toBe(true);await route.abort();});
  await answerScreen(page);await nextScreen(page);await expect(page.locator('.adaptive-save')).toContainText('自动重试');
  await page.unroute('**/finalize');await page.getByRole('button',{name:'重试保存',exact:true}).click();await expect(page.locator('.ending-page')).toBeVisible();
  expect(await page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;})).toBe(false);
});
test('long questions scroll with navigation visible, IME cannot advance, and hidden branches seal as null',async({page,context})=>{
  const {study,version}=await setup(context,3,source=>{
    source.pages[0].questions[1].title='这是一道需要完整阅读的长题。'.repeat(40);
    source.pages[0].questions[2].condition={op:'eq',question:'q2',value:1};
  });
  await page.setViewportSize({width:320,height:480});await page.goto(`/participate.html?version=${version}`);
  const input=page.getByRole('textbox');await input.fill('20991231001TEST');
  await input.evaluate(node=>node.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})));
  await page.getByRole('button',{name:'下一页',exact:true}).click();await expect(input).toBeVisible();
  await input.evaluate(node=>node.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})));
  await nextScreen(page);
  await expect(page.locator('.adaptive-title')).toHaveText('这是一道需要完整阅读的长题。'.repeat(40));
  await expect(page.locator('.adaptive-item-meta')).toHaveText('第 2 题 · 必答');
  const next=page.getByRole('button',{name:'完成问卷',exact:true}),bounds=await next.boundingBox();
  expect(bounds!.y+bounds!.height).toBeLessThanOrEqual(480);expect(bounds!.height).toBeGreaterThanOrEqual(44);
  await page.getByRole('slider').press('End');await nextScreen(page);await expect(page.locator('.ending-page')).toBeVisible();
  const saved=await detail(context,study.study_id);expect(saved.answers.q2).toBe(5);expect(saved.answers.q3).toBe(null);expect(saved.diagnostics).toEqual([]);
});
test('offline future segments wait for predecessor seal; ambiguous seal replies, reload and finalization recover',async({page,context})=>{
  test.setTimeout(120000);const {study,version,protocol}=await setup(context);
  await page.setViewportSize({width:390,height:844});await page.goto(`/participate.html?version=${version}`);
  await page.getByRole('textbox').fill('20991231001TEST');await page.getByRole('button',{name:'下一页',exact:true}).click();
  await context.setOffline(true);
  while(!(await page.locator('.adaptive-card').first().getAttribute('data-question-id'))?.startsWith('q31')){
    await answerScreen(page);await nextScreen(page);
  }
  await expect(page.getByRole('button',{name:'上一页',exact:true})).toBeHidden();
  await answerScreen(page);const firstFuture=await page.locator('.adaptive-card').first().getAttribute('data-question-id');
  await expect(page.locator('.adaptive-save')).toContainText('本机');
  const outbox=await local(page,'outbox');expect(new Set(outbox.map(row=>row.scope))).toEqual(new Set(['survey_part_1','survey_part_2']));
  let firstSealed=false,dropped=false;
  const futureScopes:string[]=[];
  await page.route('**/ingest',async route=>{
    const request=route.request(),raw=request.postDataBuffer()!;
    const body=JSON.parse((request.headers()['content-encoding']==='gzip'?gunzipSync(raw):raw).toString('utf8'));
    if(body?.events)for(const event of body.events){const scope=JSON.parse(event.raw).scope;if(scope==='survey_part_2'&&!firstSealed)futureScopes.push(scope);}
    await route.continue();
  });
  await page.route('**/seal',async route=>{
    const response=await route.fetch();expect(response.ok(),await response.text()).toBeTruthy();
    if(!dropped){dropped=true;firstSealed=true;await route.abort();}else await route.fulfill({response});
  });
  await context.setOffline(false);
  await expect.poll(async()=>dropped,{timeout:20000}).toBe(true);
  await page.reload();
  await expect(page.locator('.adaptive-card').first()).toHaveAttribute('data-question-id',firstFuture!);
  for(const input of await page.getByRole('slider').all())await expect(input).toHaveAttribute('data-answered','true');
  await page.unroute('**/seal');
  let clicks=0;
  while(!(await page.locator('.ending-page').count())){
    if(await page.getByRole('slider').count()){await answerScreen(page);
      await nextScreen(page);clicks++;
    }else await expect(page.locator('.ending-page')).toBeVisible({timeout:30000});
    expect(clicks).toBeLessThan(65);
  }
  expect(futureScopes).toEqual([]);
  const saved=await detail(context,study.study_id);expect(saved.state).toBe('COMPLETED');expect(saved.diagnostics).toEqual([]);
  expect(saved.seals).toHaveLength(protocol.pages.length);expect(Object.keys(saved.answers)).toHaveLength(65);
  expect(saved.answers.identifier).toBe('20991231001TEST');expect(Object.values(saved.answers).filter(v=>v===5)).toHaveLength(64);
  expect(await local(page,'outbox')).toEqual([]);
  expect((await local(page,'events')).some(row=>JSON.parse(row.raw).kind==='INPUT_DIAGNOSTIC')).toBe(false);
});
