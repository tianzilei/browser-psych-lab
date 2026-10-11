import {test,expect,type BrowserContext,type Page} from '@playwright/test';
import sharp from 'sharp';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {sampleProtocol,type Protocol} from '../../src/shared/protocol.js';
import {compileQuestionnaire} from '../../src/shared/questionnaire-json.js';
const origin='http://127.0.0.1:3107';
// Reuse only the admin credential across isolated participant contexts. Repeated
// setup logins otherwise exhaust the real production login rate limiter.
const auth=new Map<string,{csrf:string;cookies:Awaited<ReturnType<BrowserContext['cookies']>>}>();
async function signIn(context:BrowserContext){
  const cached=auth.get('admin');if(cached){await context.addCookies(cached.cookies);return cached.csrf;}
  const login=await context.request.post('/api/auth/login',{headers:{Origin:origin},data:{password:'TEST_ONLY-browser-password'}});
  expect(login.ok(),await login.text()).toBeTruthy();const {csrf}=await login.json();
  auth.set('admin',{csrf,cookies:(await context.cookies()).filter(c=>c.name==='lab_admin')});return csrf as string;
}
async function finishSessions(context:BrowserContext){for(const cookie of await context.cookies()){
  if(!/^lab_[a-f0-9-]{36}$/.test(cookie.name))continue;
  await context.request.post(`/api/participate/sessions/${cookie.name.slice(4)}/terminate`,{headers:{Origin:origin},data:{request_id:crypto.randomUUID(),reason:'TEST_ONLY_TEARDOWN'}});
}}
test.afterEach(async({context})=>finishSessions(context));
async function setup(context:BrowserContext,images=false,cap=0,configure?:(p:Protocol)=>void){
  const csrf=await signIn(context);
  const post=async(url:string,data:unknown)=>{const r=await context.request.post(url,{headers:{Origin:origin,'X-CSRF-Token':csrf},data});expect(r.ok(),await r.text()).toBeTruthy();return r.json();};
  const study=await post('/api/lab/studies',{request_id:crypto.randomUUID()}),p=sampleProtocol();p.title=`Browser ${crypto.randomUUID()}`;
  if(images){const png=await sharp({create:{width:64,height:48,channels:3,background:'#de6749'}}).png().toBuffer();const upload=await context.request.post(`/api/lab/studies/${study.study_id}/upload`,{headers:{Origin:origin,'X-CSRF-Token':csrf,'Content-Type':'image/png','X-Request-Id':crypto.randomUUID(),'X-File-Name':'fixture.png'},data:png});expect(upload.ok(),await upload.text()).toBeTruthy();const {result}=await upload.json();
    p.pages=[];p.groups=[{id:'images',title:'Browser image group',choices:['Left','Right'],repeats:cap,trials:[{root_id:'one',asset_id:result.asset_id,image_ms:400,isi_ms:400,correct:'Left'}]}];p.variants[0]!.group_order=['images'];p.variants[0]!.trial_order={images:['one']};
  }else{p.pages[0]!.questions.push({id:'detail',type:'text',input_purpose:'personal',title:'补充说明',required:true,max_length:100,condition:{op:'eq',question:'ready',value:'否'}});}
  configure?.(p);
  await post(`/api/lab/studies/${study.study_id}/save`,{request_id:crypto.randomUUID(),revision:1,protocol:p});const version=await post(`/api/lab/studies/${study.study_id}/publish`,{request_id:crypto.randomUUID(),revision:2});await post(`/api/lab/studies/${study.study_id}/admission`,{request_id:crypto.randomUUID(),paused:false});return {study,version,p,post};
}
async function begin(page:Page){await page.getByRole('button',{name:'开始作答',exact:true}).click();}
async function fit(page:Page){
  await expect.poll(()=>page.evaluate(()=>{
    const problems:string[]=[],root=document.documentElement,v=visualViewport;
    if(scrollX||root.scrollWidth>root.clientWidth+1)problems.push('horizontal page scroll');
    const left=v?.offsetLeft??0,top=v?.offsetTop??0,right=left+(v?.width??innerWidth),bottom=top+(v?.height??innerHeight);
    for(const node of document.querySelectorAll<HTMLElement>('main button,main input')){
      if(getComputedStyle(node).visibility==='hidden')continue;
      const r=node.getBoundingClientRect();if(!r.width||!r.height)continue;
      if(r.left<left-1||r.right>right+1)problems.push(`clipped control: ${node.textContent??node.tagName}`);
      if(node instanceof HTMLButtonElement&&(node.scrollHeight>node.clientHeight+1||node.scrollWidth>node.clientWidth+1))problems.push('button overflow');
    }
    const reading=document.querySelector<HTMLElement>('.reading-text');
    if(reading&&getComputedStyle(reading).visibility!=='hidden'&&(reading.scrollHeight>reading.clientHeight+1||reading.scrollWidth>reading.clientWidth+1))problems.push('reading overflow');
    return problems;
  })).toEqual([]);
}
async function local(page:Page){return page.evaluate(async()=>{const db=await new Promise<IDBDatabase>((res,rej)=>{const q=indexedDB.open('browser-psych-lab-v1');q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error);});try{return await new Promise<{raw:number;queued:number}>((resolve,reject)=>{const tx=db.transaction(['events','outbox']),r=tx.objectStore('events').getAll(),o=tx.objectStore('outbox').getAll();const answer=(rows:{raw:string}[])=>rows.filter(row=>JSON.parse(row.raw).kind!=='INPUT_DIAGNOSTIC').length;tx.oncomplete=()=>resolve({raw:answer(r.result),queued:answer(o.result)});tx.onerror=()=>reject(tx.error);});}finally{db.close();}});}
test('admin logs in with only a password using Enter or click and can log out',async({page,context})=>{
  await page.setViewportSize({width:390,height:844});await page.goto('/admin.html');
  await expect(page.locator('input')).toHaveCount(1);await expect(page.locator('select')).toHaveCount(0);
  const password=page.getByLabel('密码',{exact:true});await password.fill('wrong-password');await password.press('Enter');
  await expect(page.locator('#message')).toContainText('密码不正确');
  await password.fill('TEST_ONLY-browser-password');
  const request=page.waitForRequest(r=>r.url().endsWith('/api/auth/login')&&r.method()==='POST');await password.press('Enter');
  expect((await request).postDataJSON()).toEqual({password:'TEST_ONLY-browser-password'});
  await expect(page.getByRole('button',{name:'上传 JSON',exact:true})).toBeVisible();
  await page.reload();await expect(page.getByRole('button',{name:'上传 JSON',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'退出',exact:true}).click();await expect(password).toBeVisible();await expect(password).toHaveValue('');
  expect((await context.request.get('/api/auth/me')).status()).toBe(401);
  await password.fill('TEST_ONLY-browser-password');await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('button',{name:'上传 JSON',exact:true})).toBeVisible();
  const me=await (await context.request.get('/api/auth/me')).json();expect(me.authenticated).toBe(true);expect(me).not.toHaveProperty('role');
  auth.set('admin',{csrf:me.csrf,cookies:(await context.cookies()).filter(c=>c.name==='lab_admin')});
});
test('research cards and finite survey recover offline exact revisions and reject a second tab',async({page,context})=>{
  const {version,study}=await setup(context);await page.goto('/admin.html');await expect(page.getByRole('heading',{name:'问卷',exact:true})).toBeVisible();await page.goto(`/participate.html?version=${version.version_id}`);await begin(page);await page.getByRole('button',{name:'否',exact:true}).click();await page.getByRole('button',{name:'下一题',exact:true}).click();await expect(page.getByRole('textbox',{name:/补充说明/})).toBeVisible();await page.getByRole('button',{name:'上一题',exact:true}).click();await page.getByRole('button',{name:'是',exact:true}).click();await expect(page.getByRole('textbox',{name:/补充说明/})).toBeHidden();
  const sid=(await (await context.request.get(`/api/lab/studies/${study.study_id}/sessions`)).json()).sessions[0].session_id;
  const ticket=(await (await context.request.get(`/api/lab/sessions/${sid}`)).json()).admission.ticket_id;
  const second=await context.newPage();await second.goto(`/participate.html?version=${version.version_id}`);await expect(second.locator('#status')).toContainText('只读');await second.close();
  expect((await (await context.request.get(`/api/lab/sessions/${sid}`)).json()).admission.ticket_id).toBe(ticket);
  await context.setOffline(true);await page.getByRole('button',{name:'提交本页'}).click();await expect(page.getByRole('button',{name:'重试保存与核对'})).toBeVisible();const before=await local(page);expect(before.raw).toBeGreaterThanOrEqual(3);expect(before.queued).toBe(before.raw);await context.setOffline(false);await page.reload();await expect(page.locator('#status')).toContainText('研究已完成');const after=await local(page);expect(after.raw).toBe(before.raw);expect(after.queued).toBe(0);
});
test('button wizard preserves branches, optional empty choice and numeric zero without scrolling',async({page,context})=>{
  const {version,study}=await setup(context,false,0,p=>{
    p.layout.background='#202020';p.pages[0]!.instruction='按钮作答';p.pages[0]!.questions=[
      {id:'gate',type:'single',title:'显示补充题？',required:true,choices:['显示','隐藏']},
      {id:'multi',type:'multi',title:'多选',required:true,choices:['A','B']},
      {id:'score',type:'scale',title:'量表',required:true,min:-1,max:1,min_label:'不同意',max_label:'同意'},
      {id:'note',type:'text',input_purpose:'personal',title:'个人信息',required:true,max_length:10,condition:{op:'eq',question:'gate',value:'显示'}},
      {id:'follow',type:'single',title:'下游选择',required:true,choices:['E','F'],condition:{op:'eq',question:'note',value:'保留'}},
      {id:'empty',type:'multi',title:'可选多选',required:false,choices:['C','D']},
    ];
  });
  await page.setViewportSize({width:320,height:480});await page.goto(`/participate.html?version=${version.version_id}`);await begin(page);await fit(page);
  await page.getByRole('button',{name:'下一题',exact:true}).click();await expect(page.getByRole('alert')).toContainText('请选择答案');
  await page.getByRole('button',{name:'显示',exact:true}).click();await page.getByRole('button',{name:'下一题',exact:true}).click();
  await page.getByRole('button',{name:'A',exact:true}).click();await page.getByRole('button',{name:'B',exact:true}).click();await page.getByRole('button',{name:'A',exact:true}).click();
  await expect(page.getByRole('button',{name:'B',exact:true})).toHaveAttribute('aria-pressed','true');await page.getByRole('button',{name:'下一题',exact:true}).click();
  await page.getByRole('slider',{name:'量表',exact:true}).focus();await page.keyboard.press('Space');await expect(page.getByRole('slider')).toHaveAttribute('data-answered','true');await page.getByRole('button',{name:'下一题',exact:true}).click();
  await page.getByRole('textbox',{name:'个人信息'}).fill('保留');await page.setViewportSize({width:568,height:180});await fit(page);
  await page.getByRole('button',{name:'完成输入'}).click();await page.setViewportSize({width:320,height:480});await page.getByRole('button',{name:'下一题',exact:true}).click();
  await page.getByRole('button',{name:'E',exact:true}).click();await page.getByRole('button',{name:'上一题',exact:true}).click();await expect(page.getByRole('textbox')).toHaveValue('保留');
  for(let i=0;i<3;i++)await page.getByRole('button',{name:'上一题',exact:true}).click();
  await page.getByRole('button',{name:'隐藏',exact:true}).click();
  for(let i=0;i<3;i++)await page.getByRole('button',{name:'下一题',exact:true}).click();
  await expect(page.getByRole('button',{name:'C',exact:true})).toBeVisible();await expect(page.getByRole('textbox')).toHaveCount(0);
  await page.getByRole('button',{name:'C',exact:true}).click();await page.getByRole('button',{name:'C',exact:true}).click();await fit(page);
  await page.getByRole('button',{name:'提交本页'}).click();await expect(page.locator('#status')).toContainText('研究已完成');
  const sid=(await (await context.request.get(`/api/lab/studies/${study.study_id}/sessions`)).json()).sessions[0].session_id;
  const result=await (await context.request.get(`/api/lab/sessions/${sid}`)).json();expect(result.answers).toMatchObject({gate:'隐藏',multi:['B'],score:0,note:null,follow:null,empty:[]});expect((await local(page)).queued).toBe(0);
});
test('long instructions retain IME input; long choices remain together and require enough space',async({page,context})=>{
  const instruction='<img src=x> **纯文本**\n'+'说明👨‍👩‍👧‍👦é'.repeat(220);
  const {version,p}=await setup(context,false,0,p=>{p.pages[0]!.instruction=instruction;p.pages[0]!.questions=[
    {id:'text',type:'text',input_purpose:'personal',title:'个人信息',required:true,max_length:10},
    {id:'choice',type:'single',title:'长选项',required:true,choices:['W'.repeat(200),'普通选项']}];
  });
  await page.setViewportSize({width:390,height:844});await page.goto(`/participate.html?version=${version.version_id}`);
  await expect(page.locator('.reading-text')).toBeVisible();
  let read='';for(let i=0;i<100;i++){await fit(page);read+=await page.locator('.reading-text').textContent();if(await page.getByRole('button',{name:'开始作答',exact:true}).count())break;await page.getByRole('button',{name:'阅读下一段'}).click();}
  expect(read).toBe([p.title,p.pages[0]!.title,instruction].join('\n\n'));await expect(page.locator('#content img,#content strong')).toHaveCount(0);await begin(page);
  const text=page.getByRole('textbox',{name:'个人信息'});await text.pressSequentially('abc');await expect.poll(async()=>(await local(page)).raw).toBe(3);
  await page.reload();await expect(text).toHaveValue('abc');await text.focus();
  await text.evaluate(input=>{const n=input as HTMLInputElement;n.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));n.value='中';n.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));n.value='中文';n.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));});
  await page.locator('form').evaluate(form=>(form as HTMLFormElement).requestSubmit());await expect(text).toBeFocused();
  await text.evaluate(n=>n.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'})));await expect.poll(async()=>(await local(page)).raw).toBe(5);
  await page.setViewportSize({width:568,height:180});await fit(page);await expect(text).toBeFocused();
  await expect(page.getByRole('button',{name:'完成输入'})).toBeInViewport();await page.getByRole('button',{name:'完成输入'}).click();await page.setViewportSize({width:568,height:320});
  await page.getByRole('button',{name:'下一题',exact:true}).click();await fit(page);await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('内容放不下');await expect(page.getByRole('button',{name:'提交本页'})).toBeDisabled();
  await expect(page.locator('.choice-button')).toHaveCount(0);await expect(page.getByRole('button',{name:/下一组选项|上一组选项/})).toHaveCount(0);
  await page.setViewportSize({width:1440,height:900});await expect(page.locator('.choice-button')).toHaveCount(2);await fit(page);
  await page.getByRole('button',{name:'W'.repeat(200),exact:true}).click();await expect(page.getByRole('button',{name:'W'.repeat(200),exact:true})).toHaveAttribute('aria-pressed','true');
  await page.screenshot({path:'test-results/participant-long-options.png'});await page.getByRole('button',{name:'提交本页'}).click();await expect(page.locator('#status')).toContainText('研究已完成');
});
test('viewport layouts expose every option and rapid navigation seals only one snapshot',async({page,context})=>{
  const labels=Array.from({length:8},(_,i)=>`方案 ${i+1}`);
  const {version,study}=await setup(context,false,0,p=>{p.pages[0]!.questions=[
    {id:'many',type:'single',title:'选择方案',required:true,choices:labels},
    {id:'second',type:'single',title:'第二题',required:false,choices:['继续','暂不']},
    {id:'third',type:'single',title:'第三题',required:false,choices:['完成','保留']},
  ];});
  await page.goto(`/participate.html?version=${version.version_id}`);await begin(page);
  for(const size of [{width:320,height:480},{width:390,height:844},{width:568,height:320},{width:844,height:390},{width:768,height:1024},{width:1440,height:900}]){
    await page.setViewportSize(size);await fit(page);await page.mouse.wheel(500,500);await page.evaluate(()=>scrollTo(100,100));await fit(page);
    await expect(page.getByRole('textbox')).toHaveCount(0);
  }
  await page.setViewportSize({width:320,height:480});await fit(page);
  await expect(page.locator('.choice-button')).toHaveCount(8);
  expect(await page.locator('.choice-button').evaluateAll(nodes=>nodes.map(n=>(n as HTMLElement).dataset.choice!))).toEqual(labels);
  await expect(page.getByRole('button',{name:/下一组选项|上一组选项/})).toHaveCount(0);
  await page.getByRole('button',{name:'方案 8',exact:true}).click();
  await page.getByRole('button',{name:'下一题',exact:true}).dblclick();
  await expect(page.locator('.reading-text')).toContainText('第二题');await expect(page.getByRole('button',{name:'下一题',exact:true})).toBeEnabled();
  await expect(page.locator('.reading-text')).toContainText('第二题');await page.getByRole('button',{name:'继续',exact:true}).click();
  await page.getByRole('button',{name:'下一题',exact:true}).click();await page.getByRole('button',{name:'完成',exact:true}).click();
  const submit=page.getByRole('button',{name:'提交本页'});await expect(submit).toBeEnabled();
  await submit.evaluate(node=>{for(let i=0;i<3;i++)(node as HTMLButtonElement).click();});
  await expect(page.locator('#status')).toContainText('研究已完成');await fit(page);expect((await local(page)).raw).toBe(4);
  const sid=(await (await context.request.get(`/api/lab/studies/${study.study_id}/sessions`)).json()).sessions[0].session_id;
  const result=await (await context.request.get(`/api/lab/sessions/${sid}`)).json();expect(result.answers).toEqual({many:'方案 8',second:'继续',third:'完成'});
});
test('axis has explicit endpoints, no default answer, mouse and keyboard scores, clearing and reload',async({page,context,browser})=>{
  const {version,study}=await setup(context,false,0,p=>{p.pages[0]!.questions=[
    {id:'axis',type:'scale',title:'操作体验',required:true,min:-2,max:2,min_label:'很不方便',max_label:'很方便'},
    {id:'optional',type:'scale',title:'可选量表',required:false,min:1,max:5,min_label:'不满意',max_label:'满意'},
  ];});
  await page.setViewportSize({width:390,height:844});await page.goto(`/participate.html?version=${version.version_id}`);await begin(page);
  const axis=page.getByRole('slider',{name:'操作体验',exact:true});await expect(axis).toHaveAttribute('data-answered','false');expect((await local(page)).raw).toBe(0);
  await expect(page.locator('.choice-button')).toHaveCount(0);await page.getByRole('button',{name:'下一题',exact:true}).click();await expect(page.getByRole('alert')).toContainText('请选择分值');
  for(const size of [{width:320,height:480},{width:390,height:844},{width:568,height:320},{width:844,height:390},{width:768,height:1024},{width:1440,height:900}]){
    await page.setViewportSize(size);await fit(page);await expect(axis).toHaveAttribute('data-answered','false');
    await expect(page.locator('.axis-ends')).toHaveText('很不方便很方便');
  }
  await page.setViewportSize({width:390,height:844});await fit(page);
  await axis.click();await expect(axis).toHaveValue('0');await expect(axis).toHaveAttribute('data-answered','true');
  await expect.poll(async()=>(await local(page)).raw).toBe(1);await axis.click();expect((await local(page)).raw).toBe(1);
  await axis.press('Home');await expect(axis).toHaveValue('-2');await axis.press('End');await expect(axis).toHaveValue('2');
  const box=(await axis.boundingBox())!;await page.mouse.move(box.x+box.width-12,box.y+22);await page.mouse.down();await page.mouse.move(box.x+12,box.y+22,{steps:4});await page.mouse.up();await expect(axis).toHaveValue('-2');
  await page.reload();await expect(axis).toHaveValue('-2');await expect(axis).toHaveAttribute('data-answered','true');await axis.press('End');await axis.press('ArrowLeft');await expect(axis).toHaveValue('1');
  await fit(page);await page.screenshot({path:'test-results/participant-axis.png'});await page.getByRole('button',{name:'下一题',exact:true}).click();
  const optional=page.getByRole('slider',{name:'可选量表',exact:true});await expect(optional).toHaveAttribute('data-answered','false');await optional.press('End');await expect(optional).toHaveValue('5');
  await page.setViewportSize({width:568,height:320});await fit(page);await page.getByRole('button',{name:'清除',exact:true}).click();await expect(optional).toHaveAttribute('data-answered','false');
  await page.getByRole('button',{name:'提交本页'}).click();await expect(page.locator('#status')).toContainText('研究已完成');
  const sid=(await (await context.request.get(`/api/lab/studies/${study.study_id}/sessions`)).json()).sessions[0].session_id;
  expect((await (await context.request.get(`/api/lab/sessions/${sid}`)).json()).answers).toEqual({axis:1,optional:null});
  const mobile=await browser.newContext({viewport:{width:320,height:480},isMobile:true,hasTouch:true});
  try{
    const touch=await mobile.newPage();await touch.goto(`${origin}/participate.html?version=${version.version_id}`);await begin(touch);await fit(touch);
    const slider=touch.getByRole('slider',{name:'操作体验',exact:true});const r=(await slider.boundingBox())!;await slider.tap({position:{x:r.width/2,y:22}});
    await expect(slider).toHaveValue('0');await expect(slider).toHaveAttribute('data-answered','true');await touch.getByRole('button',{name:'下一题',exact:true}).tap();
    await touch.getByRole('button',{name:'提交本页'}).tap();await expect(touch.locator('#status')).toContainText('研究已完成');
  }finally{await finishSessions(mobile);await mobile.close();}
});
test('twenty single-choice options stay on one screen or stop instead of paging',async({page,context})=>{
  const {version}=await setup(context,false,0,p=>{p.pages[0]!.questions=[{id:'many',type:'single',title:'全部选项',required:true,choices:Array.from({length:20},(_,i)=>`方案 ${i+1}`)}];});
  await page.setViewportSize({width:1440,height:900});await page.goto(`/participate.html?version=${version.version_id}`);await begin(page);await expect(page.locator('.choice-button')).toHaveCount(20);await fit(page);
  await page.getByRole('button',{name:'方案 20',exact:true}).click();await page.setViewportSize({width:320,height:480});await expect(page.getByRole('alert')).toContainText('内容放不下');await fit(page);
  await expect(page.locator('.choice-button')).toHaveCount(0);await expect(page.getByRole('button',{name:/下一组选项|上一组选项/})).toHaveCount(0);await expect(page.getByRole('button',{name:'提交本页'})).toBeDisabled();
  await page.locator('form').evaluate(form=>(form as HTMLFormElement).requestSubmit());await expect(page.locator('#status')).not.toContainText('研究已完成');
  await page.setViewportSize({width:1440,height:900});await expect(page.locator('.choice-button')).toHaveCount(20);await expect(page.getByRole('button',{name:'方案 20',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.getByRole('button',{name:'提交本页'}).click();await expect(page.locator('#status')).toContainText('研究已完成');
});
test('multiple axes stay together, restore independent drafts, confirm endings and download a fresh export from home',async({page,context})=>{
  const labels=['低','中','高'],definition={schema:'questionnaire-v1',title:`Multi ${crypto.randomUUID()}`,orientation:'portrait',ending:{title:'感谢参与这次测试',text:'结束语正文：你的答案已经保存。'},pages:[{id:'axes',questions:[
    {id:'feel',type:'scales',title:'从三个方面评价体验',axes:[{id:'ease',title:'便利',min:-1,labels},{id:'clear',title:'清晰',min:0,labels},{id:'comfort',title:'舒适',min:0,labels}]},
    {id:'optional',type:'scales',title:'可选的两个方面',required:false,axes:[{id:'left',title:'左侧',min:0,labels},{id:'right',title:'右侧',min:0,labels}]},
  ]}]};
  const {study,version,p}=await setup(context,false,0,p=>{Object.assign(p,compileQuestionnaire(definition));delete p.layout.orientation;});
  await page.setViewportSize({width:390,height:844});await page.goto(`/participate.html?version=${version.version_id}`);await begin(page);
  await expect(page.getByRole('slider')).toHaveCount(3);await expect(page.getByRole('slider').nth(0)).toHaveAttribute('data-answered','false');
  await page.getByRole('button',{name:'下一题',exact:true}).click();await expect(page.locator('.question-error')).toContainText('每个坐标轴');
  await context.setOffline(true);await page.getByRole('slider',{name:'便利',exact:true}).press('Home');await page.getByRole('slider',{name:'便利',exact:true}).press('ArrowRight');
  await page.getByRole('slider',{name:'清晰',exact:true}).press('End');await page.getByRole('slider',{name:'舒适',exact:true}).press('Home');
  await expect.poll(async()=> (await local(page)).raw).toBeGreaterThan(2);await context.setOffline(false);await page.reload();
  await expect(page.getByRole('slider',{name:'便利',exact:true})).toHaveValue('0');await expect(page.getByRole('slider',{name:'清晰',exact:true})).toHaveValue('2');await expect(page.getByRole('slider',{name:'舒适',exact:true})).toHaveValue('0');
  for(const viewport of [{width:320,height:480},{width:390,height:844},{width:844,height:390},{width:1024,height:768}]){await page.setViewportSize(viewport);await expect(page.getByRole('slider')).toHaveCount(3);await fit(page);}
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'下一题',exact:true}).click();await expect(page.getByRole('slider')).toHaveCount(2);
  await page.getByRole('slider',{name:'左侧',exact:true}).press('Home');await expect(page.locator('[data-axis-id=left] output')).toHaveText('已选：低');
  await page.getByRole('button',{name:'提交本页'}).click();await expect(page.locator('.ending-title')).toHaveText('感谢参与这次测试');await expect(page.locator('.ending-text')).toContainText('结束语正文');await fit(page);
  await expect(page.locator('a')).toHaveCount(0);await page.reload();await expect(page.locator('.ending-text')).toContainText('结束语正文');
  const sid=(await (await context.request.get(`/api/lab/studies/${study.study_id}/sessions`)).json()).sessions[0].session_id;
  const detail=await (await context.request.get(`/api/lab/sessions/${sid}`)).json();expect(detail.state).toBe('COMPLETED');expect(detail.answers.feel).toEqual({ease:0,clear:2,comfort:0});expect(detail.answers.optional).toEqual({left:0,right:null});
  await page.goto('/admin.html');const card=page.locator('section').filter({has:page.getByRole('heading',{name:p.title,exact:true})});
  const firstDownload=page.waitForEvent('download');await card.getByRole('button',{name:'下载数据',exact:true}).click();const downloaded=await firstDownload;
  const csv=await readFile((await downloaded.path())!,'utf8');expect(csv).toContain('axis_answers');expect(csv).toContain('covariates');expect(csv).toContain('UNANSWERED');expect(csv).toContain('""value"":null');expect(csv).toContain('""value"":0');
  await expect(card.getByRole('link',{name:'下载导出说明',exact:true})).toBeVisible();
  const manifest=await (await context.request.get((await card.getByRole('link',{name:'下载导出说明'}).getAttribute('href'))!)).json();expect(manifest.tables.axis_answers).toBe(5);
  const before=(await (await context.request.get('/api/lab/jobs')).json()).jobs.filter((job:{kind:string})=>job.kind==='EXPORT').length;
  const nextDownload=page.waitForEvent('download');await card.getByRole('button',{name:'下载数据',exact:true}).click();await nextDownload;
  expect((await (await context.request.get('/api/lab/jobs')).json()).jobs.filter((job:{kind:string})=>job.kind==='EXPORT')).toHaveLength(before+1);
  let exportPosts=0;
  await page.route('**/api/lab/jobs/export',async route=>{exportPosts++;await route.fetch();await route.abort();});
  await card.getByRole('button',{name:'下载数据',exact:true}).click();await expect(page.locator('#message')).toContainText('fetch');
  const pending=await page.evaluate(id=>sessionStorage.getItem(`lab-export-${id}`),study.study_id);expect(pending).toBeTruthy();
  const savedJob=JSON.parse(pending!).job_id;await page.reload();const retry=page.waitForEvent('download');await card.getByRole('button',{name:'下载数据',exact:true}).click();await retry;
  expect(exportPosts).toBe(1);expect((await context.request.get(`/api/lab/jobs/${savedJob}/data.csv`)).ok()).toBe(true);
  expect((await (await context.request.get('/api/lab/jobs')).json()).jobs.filter((job:{kind:string})=>job.kind==='EXPORT')).toHaveLength(before+2);
  const guest=await context.browser()!.newContext();try{expect((await guest.request.get(`${origin}/api/lab/jobs/${savedJob}/data.csv`)).status()).toBe(401);}finally{await guest.close();}
});
test('six axes use a wide grid and block undersized screens without paging or scrolling',async({page,context})=>{
  const {version}=await setup(context,false,0,p=>{p.pages[0]!.questions=[{id:'six',type:'scales',title:'六个维度',required:true,axes:Array.from({length:6},(_,index)=>({id:`a${index}`,title:`维度 ${index+1}`,min:0,max:2,min_label:'低',max_label:'高',labels:['低','中','高']}))}];});
  await page.setViewportSize({width:320,height:480});await page.goto(`/participate.html?version=${version.version_id}`);await begin(page);
  await expect(page.getByRole('button',{name:'提交本页'})).toBeDisabled();await expect(page.locator('.question-error')).toContainText('内容放不下');await fit(page);await expect(page.getByRole('button',{name:/下一组|下一轴/})).toHaveCount(0);
  await page.setViewportSize({width:1024,height:768});await expect(page.getByRole('slider')).toHaveCount(6);await fit(page);
  for(const slider of await page.getByRole('slider').all())await slider.press('Home');await page.getByRole('button',{name:'提交本页'}).click();await expect(page.locator('.ending-page')).toBeVisible();await fit(page);
});
test('long ending text is button-paged without scroll and failed finalization never shows it',async({page,context})=>{
  const {version}=await setup(context,false,0,p=>{p.ending={title:'结束语标题',text:Array.from({length:300},(_,i)=>`第${i+1}行：文本完整保留，点击按钮继续阅读。\n`).join('')};});
  await page.setViewportSize({width:320,height:480});await page.goto(`/participate.html?version=${version.version_id}`);await begin(page);await page.getByRole('button',{name:'是',exact:true}).click();
  await page.route('**/api/participate/sessions/*/finalize',route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({code:'TEST_ONLY_FINALIZE_FAILED'})}));
  await page.getByRole('button',{name:'提交本页'}).click();await expect(page.getByRole('button',{name:'重试保存与核对'})).toBeVisible();await expect(page.locator('.ending-page')).toHaveCount(0);
  await page.unroute('**/api/participate/sessions/*/finalize');await page.getByRole('button',{name:'重试保存与核对'}).click();await expect(page.locator('.ending-title')).toHaveText('结束语标题');await fit(page);
  const first=await page.locator('.ending-text').textContent();await page.getByRole('button',{name:'阅读下一段'}).click();expect(await page.locator('.ending-text').textContent()).not.toBe(first);await fit(page);
  await page.getByRole('button',{name:'阅读上一段'}).click();expect(await page.locator('.ending-text').textContent()).toBe(first);
});
test('JSON replaces content, previews locally, freezes versions, opens, hides and soft deletes',async({page,context})=>{
  const {study,p,version}=await setup(context);
  await page.goto('/admin.html');const card=page.locator('section').filter({has:page.getByRole('heading',{name:p.title,exact:true})});await card.getByRole('button',{name:'修改 JSON'}).click();
  await expect(page.locator('textarea')).toHaveCount(0);const json=page.getByLabel('问卷 JSON');
  const upload=async(value:unknown)=>json.setInputFiles({name:'survey.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(value))});
  await json.setInputFiles({name:'broken.json',mimeType:'application/json',buffer:Buffer.from('{broken')});await expect(page.getByRole('alert')).toContainText('语法错误');await expect(page.getByRole('button',{name:'替换 JSON 并生成新版本'})).toBeDisabled();
  const input={schema:'questionnaire-v1',title:p.title,background:'#202020',orientation:'portrait',consent:{title:'模拟知情同意书',text:'用于检查界面。请使用模拟信息。'},pages:[{id:'survey',questions:[{id:'axis',type:'scale',title:'操作体验',labels:['很不方便','不方便','一般','方便','很方便']},{id:'note',type:'text',title:'昵称',required:false,input_purpose:'personal',max_length:20}]}]};
  await upload({...input,orientation:'diagonal'});await expect(page.getByRole('alert')).toContainText('portrait');
  await upload({...input,pages:[{id:'survey',questions:[{id:'note',type:'text',title:'普通文字',required:false,max_length:20}]}]});await expect(page.getByRole('alert')).toContainText('个人信息');
  await upload(input);await expect(page.getByText('语法与内容校验通过',{exact:false})).toBeVisible();
  const count=(await (await context.request.get(`/api/lab/studies/${study.study_id}/sessions`)).json()).sessions.length;
  await page.getByRole('button',{name:'生成模拟问卷'}).click();const frame=page.frameLocator('iframe');await expect(frame.getByText('请将设备调整为竖屏')).toBeVisible();await page.setViewportSize({width:390,height:844});await frame.getByRole('button',{name:'不同意并退出'}).click();await expect(frame.locator('#status')).toContainText('未同意');await frame.getByRole('button',{name:'重新阅读知情同意书'}).click();await frame.getByRole('button',{name:'我已阅读并同意'}).click();await frame.getByRole('button',{name:'开始作答'}).click();await frame.getByRole('slider').press('End');await expect(frame.locator('output')).toHaveText('已选：很方便');await page.getByRole('button',{name:'关闭模拟'}).click();
  expect((await (await context.request.get(`/api/lab/studies/${study.study_id}/sessions`)).json()).sessions.length).toBe(count);
  await page.getByRole('button',{name:'替换 JSON 并生成新版本'}).click();await expect(page.getByLabel('问卷 JSON')).toHaveCount(0);const draft=await (await context.request.get(`/api/lab/studies/${study.study_id}`)).json();expect(draft.versions).toHaveLength(2);expect(draft.draft.layout.background).toBe('#202020');expect(draft.source).toBe(JSON.stringify(input));
  expect((await (await context.request.get(`/api/participate/versions/${version.version_id}`)).json()).protocol.layout.background).toBe('#e5e5e5');
  const updated=page.locator('section').filter({has:page.getByRole('heading',{name:p.title,exact:true})});await updated.getByRole('button',{name:'隐藏',exact:true}).click();await expect(updated.getByRole('button',{name:'开放',exact:true})).toBeVisible();await updated.getByRole('button',{name:'开放',exact:true}).click();await updated.getByRole('button',{name:'删除',exact:true}).click();await expect(updated).toHaveCount(0);
  expect((await (await context.request.get(`/api/lab/studies/${study.study_id}`)).json()).versions).toHaveLength(2);
});
test('orientation blocks full session loading and keyboard resizing preserves it; covariates persist once',async({page,context})=>{
  const {version,study}=await setup(context,false,0,p=>{p.layout.orientation='portrait';p.pages[0]!.questions=[{id:'name',type:'text',title:'个人信息',required:true,input_purpose:'personal',max_length:20}];});
  await page.setViewportSize({width:844,height:390});await page.goto(`/participate.html?version=${version.version_id}`);await expect(page.locator('#orientation-gate')).toBeVisible();await expect(page.getByRole('button',{name:'开始作答'})).toHaveCount(0);
  expect((await (await context.request.get(`/api/lab/studies/${study.study_id}/sessions`)).json()).sessions).toHaveLength(0);
  await page.setViewportSize({width:390,height:844});await begin(page);await page.getByRole('textbox').fill('模拟');await page.setViewportSize({width:390,height:260});await expect(page.locator('#orientation-gate')).toBeHidden();await fit(page);
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'完成输入'}).click();await page.getByRole('button',{name:'提交本页'}).click();await expect(page.locator('#status')).toContainText('研究已完成');
  const sid=(await (await context.request.get(`/api/lab/studies/${study.study_id}/sessions`)).json()).sessions[0].session_id;
  let detail=await (await context.request.get(`/api/lab/sessions/${sid}`)).json();expect(detail.covariates).toHaveLength(2);const record=detail.covariates.find((r:{source:string})=>r.source==='client-reported');const env=JSON.parse(record.raw);expect(env.schema).toBe('environment-v1');expect(env.user_agent).toContain('Chrome');expect(env.screen.width).toBeGreaterThan(0);expect(env).toHaveProperty('client_hints_high.status');
  await page.reload();await expect(page.locator('#status')).toContainText('研究已完成');detail=await (await context.request.get(`/api/lab/sessions/${sid}`)).json();expect(detail.covariates).toHaveLength(2);expect(detail.covariates.find((r:{source:string})=>r.source==='client-reported').raw).toBe(record.raw);
});
test('orientation metadata failure can retry without consuming a session',async({page,context})=>{
  const {version,study}=await setup(context,false,0,p=>{p.layout.orientation='portrait';});await page.setViewportSize({width:390,height:844});let metadata=0;
  await page.route('**/versions/*/metadata',async route=>{if(++metadata===1)await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({code:'TEST_METADATA_FAILURE'})});else await route.continue();});
  await page.goto(`/participate.html?version=${version.version_id}`);await expect(page.locator('#status')).toContainText('TEST_METADATA_FAILURE');expect((await (await context.request.get(`/api/lab/studies/${study.study_id}/sessions`)).json()).sessions).toHaveLength(0);
  await page.getByRole('button',{name:'重试保存与核对'}).click();await begin(page);expect(metadata).toBe(2);await page.getByRole('button',{name:'是',exact:true}).click();await page.getByRole('button',{name:'提交本页'}).click();await expect(page.locator('#status')).toContainText('研究已完成');
});
test('ZIP and JSON upload preserve private image bytes and run the mobile image sample',async({page,context})=>{
  await signIn(context);await page.setViewportSize({width:390,height:844});await page.goto('/admin.html');await page.getByRole('button',{name:'上传 JSON',exact:true}).click();
  const input=JSON.parse(await readFile('examples/questionnaires/with-images.json','utf8'));input.title=`ZIP ${crypto.randomUUID()}`;input.pages=[];
  await page.getByLabel('问卷 JSON').setInputFiles({name:'images.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(input))});await page.getByLabel('图片 ZIP（可选，可多选）').setInputFiles('examples/stimuli/mobile-stimuli.zip');
  await expect(page.getByRole('button',{name:'上传并生成版本'})).toBeEnabled();await page.getByRole('button',{name:'上传并生成版本'}).click();
  const card=page.locator('section').filter({has:page.getByRole('heading',{name:input.title,exact:true})});await expect(card).toBeVisible();await card.getByRole('button',{name:'开放',exact:true}).click();const url=await card.getByRole('link',{name:'参与链接'}).getAttribute('href');expect(url).toBeTruthy();
  const versionId=new URL(url!,origin).searchParams.get('version'),frozen=await (await context.request.get(`/api/participate/versions/${versionId}`)).json();expect(frozen.assets).toHaveLength(1);
  const png=await readFile('examples/stimuli/mobile-card.png');expect(frozen.assets[0]).toMatchObject({hash:createHash('sha256').update(png).digest('hex'),width:1080,height:720,name:'mobile-stimuli.zip/images/mobile-card.png'});
  const privateImage=await context.request.get(`/api/lab/assets/${frozen.assets[0].asset_id}`);expect(await privateImage.body()).toEqual(png);
  await page.goto(url!);await page.getByRole('button',{name:'我已阅读并同意'}).click();await page.getByRole('button',{name:'点击下载测试'}).click();await expect(page.getByRole('button',{name:'开始本组'})).toBeVisible();await fit(page);await page.screenshot({path:'test-results/mobile-readable-image-ready.png'});await page.getByRole('button',{name:'开始本组'}).click();await expect(page.locator('#status')).toContainText('本组已呈现 1 次');await page.getByRole('button',{name:'左边',exact:true}).click();await expect(page.locator('#status')).toContainText('研究已完成',{timeout:10000});
});
test('task capacity rejects later participants with a 30-minute suggestion and no polling or auto-start',async({page,context,browser})=>{
 const {version}=await setup(context,false,0,p=>{p.groups=[{id:'task',title:'Task',choices:['left','right'],repeats:0,trials:[{root_id:'one',text:'Task',image_ms:400,isi_ms:400,correct:null}]}];p.variants[0]!.group_order=['task'];p.variants[0]!.trial_order={task:['one']};}),others=await Promise.all(Array.from({length:2},()=>browser.newContext()));
 try{await page.goto(`/participate.html?version=${version.version_id}`);await begin(page);
 const second=await others[0]!.newPage(),third=await others[1]!.newPage();await second.goto(`${origin}/participate.html?version=${version.version_id}`);await begin(second);
 let admissionRequests=0;third.on('request',r=>{if(r.url().endsWith('/admission'))admissionRequests++;});await third.goto(`${origin}/participate.html?version=${version.version_id}`);
 await expect(third.locator('#status')).toContainText('建议30分钟后');await expect(third.getByRole('button',{name:'提交本页'})).toHaveCount(0);
 expect((await (await context.request.get('/api/lab/operations')).json()).state.admission.queued).toBe(0);expect(admissionRequests).toBe(1);
 await finishSessions(context);await expect(third.getByRole('button',{name:'开始作答'})).toHaveCount(0);await third.reload();await begin(third);await expect(third.getByRole('button',{name:'提交本页'})).toBeVisible();
 }finally{for(const c of others){await finishSessions(c);await c.close();}}
});
test('frozen private image runner seals a fixed Canvas group without group-time HTTP calls',async({page,context})=>{
  const {version,study,post}=await setup(context,true,0);const requests:string[]=[];await page.route('**/api/**',async route=>{if(page.url().includes('run.html')&&(await page.locator('#status').innerText()).startsWith('本组已呈现'))requests.push(route.request().url());await route.continue();});await page.goto(`/participate.html?version=${version.version_id}`);await page.getByRole('button',{name:'点击下载测试'}).click();await page.getByRole('button',{name:'开始本组'}).click();await expect(page.locator('#status')).toContainText('本组已呈现 1 次');await page.getByRole('button',{name:'Left',exact:true}).click();await expect(page.locator('#status')).toContainText('研究已完成',{timeout:10000});expect(requests).toHaveLength(0);
  const sessions=await context.request.get(`/api/lab/studies/${study.study_id}/sessions`);const sid=(await sessions.json()).sessions[0].session_id;const detail=await context.request.get(`/api/lab/sessions/${sid}`);const result=await detail.json();expect(result.state).toBe('COMPLETED');expect(result.permit.state).toBe('CLOSED_NORMAL');expect(result.diagnostics).toHaveLength(0);expect((await local(page)).queued).toBe(0);
  const exported=await post('/api/lab/jobs/export',{request_id:crypto.randomUUID(),job_id:crypto.randomUUID(),study_id:study.study_id});const csv=await context.request.get(`/api/lab/jobs/${exported.job_id}/data.csv`);expect(await csv.text()).toContain('trial_results');
  const csrf=await signIn(context),headers={Origin:origin,'X-CSRF-Token':csrf};expect((await context.request.post(`/api/lab/studies/${study.study_id}/admission`,{headers,data:{request_id:crypto.randomUUID(),paused:true}})).ok()).toBeTruthy();const rebuilt=await context.request.post('/api/lab/jobs/rebuild',{headers,data:{request_id:crypto.randomUUID(),job_id:crypto.randomUUID(),study_id:study.study_id}});expect(rebuilt.ok(),await rebuilt.text()).toBeTruthy();expect((await rebuilt.json()).result.projections[0].result[0].answer).toBe('Left');
});
test('misses consume exactly K=2 extra candidates; reload of an unclosed run only terminates UNKNOWN',async({page,context})=>{
  const {version,study}=await setup(context,true,2);await page.goto(`/participate.html?version=${version.version_id}`);await page.getByRole('button',{name:'点击下载测试'}).click();await page.getByRole('button',{name:'开始本组'}).click();await expect(page.locator('#status')).toContainText('本组已呈现 3 次',{timeout:10000});await expect(page.locator('#status')).toContainText('研究已完成',{timeout:10000});
  const rows=await context.request.get(`/api/lab/studies/${study.study_id}/sessions`);const sid=(await rows.json()).sessions[0].session_id;const detail=await (await context.request.get(`/api/lab/sessions/${sid}`)).json();expect(detail.state).toBe('COMPLETED');expect(detail.permit.plan.repeats).toBe(2);expect(detail.diagnostics).toHaveLength(0);
  // A fresh isolated browser identity starts a separate session and crashes during its permit.
  const fresh=await context.browser()!.newContext();try{const p=await fresh.newPage();await p.goto(`${origin}/participate.html?version=${version.version_id}`);await p.getByRole('button',{name:'点击下载测试'}).click();await p.getByRole('button',{name:'开始本组'}).click();await expect(p.locator('#status')).toContainText('本组已呈现 1 次');await p.reload();await expect(p.getByRole('button',{name:'确认旧运行已中断并终止'})).toHaveCount(0);await expect(p.locator('#status')).toContainText('此会话已终止');}finally{await finishSessions(fresh);await fresh.close();}
});
test('mobile touch emulation stops on geometry change and keeps historical raw',async({browser,context})=>{
  const {version,study}=await setup(context,true,0),mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});try{const page=await mobile.newPage();await page.goto(`${origin}/participate.html?version=${version.version_id}`);await page.getByRole('button',{name:'点击下载测试'}).tap();await expect(page.getByRole('button',{name:'开始本组'})).toBeVisible();await fit(page);await page.getByRole('button',{name:'开始本组'}).tap();await expect(page.locator('#status')).toContainText('本组已呈现 1 次');await fit(page);await page.screenshot({path:'test-results/mobile-run.png'});await page.setViewportSize({width:844,height:390});await expect(page.getByRole('button',{name:'返回核对保存记录'})).toBeVisible();await fit(page);const localState=await local(page);expect(localState.raw).toBeGreaterThan(2);const sessions=await (await context.request.get(`/api/lab/studies/${study.study_id}/sessions`)).json();expect(sessions.sessions[0].state).toBe('TERMINATED');}finally{await finishSessions(mobile);await mobile.close();}
});

test('full image preparation rejects without polling; download shows only percentage and retry is manual',async({page,context,browser})=>{
 const {version}=await setup(context,true,0);let received!:()=>void,unblock!:()=>void;const incoming=new Promise<void>(r=>received=r),blocked=new Promise<void>(r=>unblock=r);
 await page.route('**/api/participate/sessions/*/assets/*',async route=>{received();await blocked;await route.continue();});
 await page.goto(`/participate.html?version=${version.version_id}`);await expect(page.locator('#status')).toContainText('预计下载约');await page.getByRole('button',{name:'点击下载测试'}).click();await incoming;await expect(page.locator('#status')).toHaveText('下载 0%');
 const fresh=await browser.newContext();try{const next=await fresh.newPage();let transfers=0;next.on('request',r=>{if(/\/sessions\/[^/]+\/assets\//.test(r.url()))transfers++;});
 await next.goto(`${origin}/participate.html?version=${version.version_id}`);await next.getByRole('button',{name:'点击下载测试'}).click();await expect(next.locator('#status')).toContainText('建议30分钟后');expect(transfers).toBe(0);
 expect((await (await context.request.get('/api/lab/operations')).json()).preparation.queued).toBe(0);
 unblock();await expect(page.getByRole('button',{name:'开始本组'})).toBeVisible();await expect(next.getByRole('button',{name:'开始本组'})).toHaveCount(0);
 await next.getByRole('button',{name:'返回保存与核对'}).click();await next.getByRole('button',{name:'点击下载测试'}).click();await expect(next.getByRole('button',{name:'开始本组'})).toBeVisible();
 }finally{unblock();await finishSessions(fresh);await fresh.close();}
});
test('frozen runner uses precompressed code and respects encoding refusal',async({context})=>{
  const {version}=await setup(context,true,0),base=`/runners/${version.runner_hash}/`,html=await (await context.request.get(`${base}run.html`)).text(),path=/src="\.\/([^" ]+\.js)"/.exec(html)?.[1];expect(path).toBeTruthy();
  const compressed=await context.request.get(`${base}${path}`,{headers:{'Accept-Encoding':'gzip, identity;q=0'}});expect(compressed.ok()).toBeTruthy();expect(compressed.headers()['content-encoding']).toBe('gzip');expect(compressed.headers()['vary']).toContain('Accept-Encoding');expect(compressed.headers()['cache-control']).toContain('no-transform');
  const plain=await context.request.get(`${base}${path}`,{headers:{'Accept-Encoding':'br;q=0,gzip;q=0,identity;q=1'}});expect(plain.headers()['content-encoding']).toBeUndefined();expect(await compressed.text()).toBe(await plain.text());
  const refused=await context.request.get(`${base}${path}`,{headers:{'Accept-Encoding':'br;q=0,gzip;q=0,identity;q=0'}});expect(refused.status()).toBe(406);
});

test('canceling active preparation frees capacity without issuing a run',async({page,context})=>{
 const {version}=await setup(context,true,0);let received!:()=>void,unblock!:()=>void;const incoming=new Promise<void>(r=>received=r),blocked=new Promise<void>(r=>unblock=r);
 await page.route('**/api/participate/sessions/*/assets/*',async route=>{received();await blocked;await route.abort().catch(()=>{});});
 await page.goto(`/participate.html?version=${version.version_id}`);await page.getByRole('button',{name:'点击下载测试'}).click();await incoming;await page.getByRole('button',{name:'取消准备'}).click();unblock();
 await expect(page.locator('#status')).toContainText('已取消准备');const op=(await (await context.request.get('/api/lab/operations')).json());expect(op.preparation.active).toBe(0);expect(op.preparation.queued).toBe(0);expect(op.state.open_permits.count).toBe(0);
});
test('orientation precedes paged consent; decline has no session or covariates; agreement persists across reload and exports',async({page,context})=>{
  const {version,study,p,post}=await setup(context,false,0,p=>{p.layout.orientation='portrait';p.consent={title:'知情同意书 <b>纯文本</b>',text:'同意后才开始记录。\n'+('模拟测试说明：可以拒绝参加或关闭页面退出。请使用虚构个人信息。\n').repeat(55)};});
  const requests:string[]=[];page.on('request',r=>requests.push(r.url()));
  const sessions=async()=>(await (await context.request.get(`/api/lab/studies/${study.study_id}/sessions`)).json()).sessions;
  await page.setViewportSize({width:844,height:390});await page.goto(`/participate.html?version=${version.version_id}`);
  await expect(page.locator('#orientation-gate')).toBeVisible();await expect(page.locator('.consent-page')).toHaveCount(0);expect(requests.some(url=>url.endsWith('/consent'))).toBe(false);expect(await sessions()).toHaveLength(0);
  await page.setViewportSize({width:320,height:480});await expect(page.locator('.consent-text')).toContainText('知情同意书');await fit(page);
  await expect(page.getByRole('button',{name:'我已阅读并同意'})).toBeDisabled();await expect(page.locator('#content b,#content input')).toHaveCount(0);
  await page.getByRole('button',{name:'不同意并退出'}).click();await expect(page.locator('#status')).toContainText('未同意');await fit(page);
  expect(await sessions()).toHaveLength(0);expect(requests.filter(url=>/\/sessions$|\/covariates$/.test(url))).toEqual([]);
  const meta=await page.evaluate(async version=>{const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('browser-psych-lab-v1');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});try{return await new Promise<Record<string,unknown>>(resolve=>{const r=db.transaction('meta').objectStore('meta').get(version);r.onsuccess=()=>resolve(r.result);});}finally{db.close();}},version.version_id);expect(meta).not.toHaveProperty('environment');expect(meta).not.toHaveProperty('consent');
  await page.reload();await expect(page.locator('.consent-page')).toBeVisible();expect(await sessions()).toHaveLength(0);
  let read='';for(let i=0;i<100;i++){await fit(page);read+=await page.locator('.consent-text').textContent();if(await page.getByRole('button',{name:'我已阅读并同意'}).isEnabled())break;await page.getByRole('button',{name:'阅读下一段'}).click();}
  expect(read).toBe(`${p.consent!.title}\n\n${p.consent!.text}`);
  await page.getByRole('button',{name:'阅读上一段'}).click();await expect(page.getByRole('button',{name:'我已阅读并同意'})).toBeDisabled();await page.getByRole('button',{name:'阅读下一段'}).click();
  await page.getByRole('button',{name:'我已阅读并同意'}).click();await begin(page);await page.getByRole('button',{name:'是',exact:true}).click();await page.getByRole('button',{name:'提交本页'}).click();await expect(page.locator('.ending-page')).toBeVisible();
  const rows=await sessions();expect(rows).toHaveLength(1);const detail=await (await context.request.get(`/api/lab/sessions/${rows[0].session_id}`)).json();expect(detail.covariates).toHaveLength(2);
  await page.reload();await expect(page.locator('.ending-page')).toBeVisible();await expect(page.locator('.consent-page')).toHaveCount(0);expect(await sessions()).toHaveLength(1);await fit(page);
  const exported=await post('/api/lab/jobs/export',{request_id:crypto.randomUUID(),job_id:crypto.randomUUID(),study_id:study.study_id}),csv=await (await context.request.get(`/api/lab/jobs/${exported.job_id}/data.csv`)).text(),manifest=await (await context.request.get(`/api/lab/jobs/${exported.job_id}/manifest.json`)).json();expect(manifest.tables.consents).toBe(1);expect(csv).toContain('document_hash');expect(csv).toContain('accepted_at');
});
test('short consent fits portrait and landscape devices and server refuses direct consent bypass',async({page,context})=>{
  const {version,study}=await setup(context,false,0,p=>{p.consent={title:'测试知情同意',text:'这是一份模拟问卷。同意后才创建作答会话和收集设备信息。'};});
  const info=await (await context.request.get(`/api/participate/versions/${version.version_id}/consent`)).json(),base={request_id:crypto.randomUUID(),version_id:version.version_id,credential:'a'.repeat(64)};
  for(const consent of [undefined,{accepted:false,document_hash:info.document_hash},{accepted:true,document_hash:'b'.repeat(64)}]){const r=await context.request.post('/api/participate/sessions',{headers:{Origin:origin},data:{...base,...(consent?{consent}:{})}});expect(r.status()).toBe(403);expect((await r.json()).code).toBe('CONSENT_REQUIRED');}
  await page.goto(`/participate.html?version=${version.version_id}`);await expect(page.locator('.consent-page')).toBeVisible();
  for(const viewport of [{width:320,height:480},{width:390,height:844},{width:844,height:390},{width:1024,height:768}]){await page.setViewportSize(viewport);await fit(page);await expect(page.getByRole('button',{name:'我已阅读并同意'})).toBeEnabled();}
  expect((await (await context.request.get(`/api/lab/studies/${study.study_id}/sessions`)).json()).sessions).toHaveLength(0);
  await page.getByRole('button',{name:'不同意并退出'}).click();await page.getByRole('button',{name:'重新阅读知情同意书'}).click();await page.getByRole('button',{name:'我已阅读并同意'}).click();await expect(page.getByRole('button',{name:'开始作答'})).toBeVisible();
});

test('rating axes keep stable image geometry, age stays separate, RT actions replay and terminated sessions restart',async({page,context})=>{
  await page.setViewportSize({width:390,height:844});const {version,study,post}=await setup(context,true,0,p=>{const g=p.groups[0]!;g.trials[0]!.correct=null;g.trials[0]!.image_ms=1;g.choices=Array.from({length:9},(_,i)=>String(i+1));g.rating={prompt:'可信度',items:['可信度','能力'],labels:['非常低','低','较低','略低','一般','略高','较高','高','非常高'],age_prompt:'估计年龄',age_min:0,age_max:120};});
  await page.goto(`/participate.html?version=${version.version_id}`);await page.getByRole('button',{name:'点击下载测试'}).click();await expect(page.getByRole('button',{name:'开始本组'})).toBeVisible();await expect(page.locator('input[type=range]:visible')).toHaveCount(0);await page.getByRole('button',{name:'开始本组'}).click();await expect(page.locator('#status')).toContainText('第 1/1 张');await expect(page.locator('#stimulus')).toBeVisible();await expect(page.getByRole('slider',{name:'可信度'})).toBeVisible();
  const first=page.getByRole('slider',{name:'可信度'}),box=await first.boundingBox();await page.mouse.move(box!.x+box!.width/2,box!.y+box!.height/2);await page.mouse.down();await page.mouse.move(box!.x+box!.width*.8,box!.y+box!.height/2,{steps:12});await page.mouse.up();await page.getByRole('button',{name:'下一题',exact:true}).click();await expect(page.getByRole('button',{name:'下一题',exact:true})).toBeDisabled();await page.getByRole('slider',{name:'能力'}).click();await page.getByRole('button',{name:'下一题',exact:true}).click();
  const age=page.getByRole('textbox',{name:'估计年龄'});await expect(age).toBeVisible();await expect(page.getByRole('slider',{name:'能力'})).not.toBeVisible();const a=await age.boundingBox(),submit=await page.getByRole('button',{name:'提交评分',exact:true}).boundingBox();expect(a!.y+a!.height).toBeLessThanOrEqual(submit!.y);await age.click();await expect(age).toHaveAttribute('readonly','');await expect(age).toHaveAttribute('inputmode','none');await age.press('4');await age.press('1');await page.getByRole('button',{name:'退格',exact:true}).click();await page.getByRole('button',{name:'0',exact:true}).click();await expect(age).toHaveValue('40');await page.screenshot({path:'test-results/rating-age-separated.png'});await page.getByRole('button',{name:'提交评分',exact:true}).click();await expect(page.locator('#status')).toContainText('研究已完成',{timeout:15000});
  const sessions=(await (await context.request.get(`/api/lab/studies/${study.study_id}/sessions`)).json()).sessions,sid=sessions[0].session_id;const actions:any={batches:[]};let after=0;for(;;){const part=await (await context.request.get(`/api/lab/sessions/${sid}/actions?after=${after}`)).json();actions.batches.push(...part.batches);if(!part.more)break;after=part.next;}expect(actions.batches.length).toBeGreaterThan(0);expect(actions.batches.flatMap((b:any)=>b.samples).some((s:any)=>s.type==='pointerdown'&&s.x!==null&&s.rt_ms>=0)).toBeTruthy();expect(actions.batches.flatMap((b:any)=>b.samples).some((s:any)=>s.type==='screen'&&s.context.asset_id)).toBeTruthy();
  await page.goto(`/replay.html?session=${sid}`);await expect(page.locator('#status')).toContainText('动作');await page.getByRole('button',{name:'下一个动作'}).click();await expect(page.locator('#details')).toContainText('context');const exported=await post('/api/lab/jobs/export',{request_id:crypto.randomUUID(),job_id:crypto.randomUUID(),study_id:study.study_id});expect(await (await context.request.get(`/api/lab/jobs/${exported.job_id}/data.csv`)).text()).toContain('interaction_actions');
});
test('terminated questionnaire reanswers in a fresh associated session and keeps old local records',async({page,context})=>{
  const {version,study}=await setup(context);await page.goto(`/participate.html?version=${version.version_id}`);await begin(page);await page.getByRole('button',{name:'是',exact:true}).click();const old=(await (await context.request.get(`/api/lab/studies/${study.study_id}/sessions`)).json()).sessions[0].session_id;await context.request.post(`/api/participate/sessions/${old}/terminate`,{headers:{Origin:origin},data:{request_id:crypto.randomUUID(),reason:'TEST_ONLY_END'}});await page.reload();await page.getByRole('button',{name:'删除此前答卷以重新回答'}).click();await expect(page.getByRole('button',{name:'开始作答',exact:true})).toBeVisible();await begin(page);await page.getByRole('button',{name:'是',exact:true}).click();await page.getByRole('button',{name:'提交本页'}).click();await expect(page.locator('#status')).toContainText('研究已完成');const rows=(await (await context.request.get(`/api/lab/studies/${study.study_id}/sessions`)).json()).sessions;expect(rows).toHaveLength(2);const detail=await (await context.request.get(`/api/lab/sessions/${rows[0].session_id}`)).json();expect(detail.reanswer.old_session_id).toBe(old);expect(detail.marks.some((m:any)=>m.type==='REANSWER')).toBeTruthy();
});

test('mobile rating range follows real touch drag and cancels without scroll',async({context,browser})=>{
 const {version}=await setup(context,true,0,p=>{p.groups[0]!.choices=Array.from({length:9},(_,i)=>String(i+1));p.groups[0]!.rating={prompt:'可信度',labels:['1','2','3','4','5','6','7','8','9']};p.groups[0]!.trials[0]!.correct=null;p.groups[0]!.trials[0]!.image_ms=1;});
 const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});try{const p=await mobile.newPage();await p.goto(`${origin}/participate.html?version=${version.version_id}`);await p.getByRole('button',{name:'点击下载测试'}).tap();await p.getByRole('button',{name:'开始本组'}).tap();const axis=p.getByRole('slider',{name:'可信度'});await expect(axis).toBeVisible();const r=(await axis.boundingBox())!,cdp=await mobile.newCDPSession(p);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:r.x+20,y:r.y+r.height/2}]});await expect(axis).toHaveValue('1');
 for(let i=1;i<=8;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:r.x+20+(r.width-40)*i/8,y:r.y+r.height/2}]});await expect(axis).toHaveValue('9');await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});expect(await p.evaluate(()=>scrollY)).toBe(0);
 await p.getByRole('button',{name:'提交评分',exact:true}).tap();await expect(p.locator('#status')).toContainText('研究已完成');
 }finally{await finishSessions(mobile);await mobile.close();}
});
