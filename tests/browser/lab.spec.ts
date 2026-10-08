import {test,expect,type BrowserContext,type Page} from '@playwright/test';
import sharp from 'sharp';
import {sampleProtocol,type Protocol} from '../../src/shared/protocol.js';
const origin='http://127.0.0.1:3107';
async function finishSessions(context:BrowserContext){for(const cookie of await context.cookies()){
  if(!/^lab_[a-f0-9-]{36}$/.test(cookie.name))continue;
  await context.request.post(`/api/participate/sessions/${cookie.name.slice(4)}/terminate`,{headers:{Origin:origin},data:{request_id:crypto.randomUUID(),reason:'TEST_ONLY_TEARDOWN'}});
}}
test.afterEach(async({context})=>finishSessions(context));
async function setup(context:BrowserContext,images=false,cap=0){
  const login=await context.request.post('/api/auth/login',{headers:{Origin:origin},data:{role:'researcher',password:'TEST_ONLY-browser-password'}});expect(login.ok()).toBeTruthy();const {csrf}=await login.json();
  const post=async(url:string,data:unknown)=>{const r=await context.request.post(url,{headers:{Origin:origin,'X-CSRF-Token':csrf},data});expect(r.ok(),await r.text()).toBeTruthy();return r.json();};
  const study=await post('/api/lab/studies',{request_id:crypto.randomUUID()}),p=sampleProtocol();p.title=`Browser ${crypto.randomUUID()}`;
  if(images){const png=await sharp({create:{width:64,height:48,channels:3,background:'#de6749'}}).png().toBuffer();const upload=await context.request.post(`/api/lab/studies/${study.study_id}/upload`,{headers:{Origin:origin,'X-CSRF-Token':csrf,'Content-Type':'image/png','X-Request-Id':crypto.randomUUID(),'X-File-Name':'fixture.png'},data:png});expect(upload.ok(),await upload.text()).toBeTruthy();const {result}=await upload.json();
    p.pages=[];p.groups=[{id:'images',title:'Browser image group',choices:['Left','Right'],repeats:cap,trials:[{root_id:'one',asset_id:result.asset_id,image_ms:400,isi_ms:400,correct:'Left'}]}];p.variants[0]!.group_order=['images'];p.variants[0]!.trial_order={images:['one']};
  }else{p.pages[0]!.questions.push({id:'detail',type:'text',title:'补充说明',required:true,max_length:100,condition:{op:'eq',question:'ready',value:'否'}});}
  await post(`/api/lab/studies/${study.study_id}/save`,{request_id:crypto.randomUUID(),revision:1,protocol:p});const version=await post(`/api/lab/studies/${study.study_id}/publish`,{request_id:crypto.randomUUID(),revision:2});await post(`/api/lab/studies/${study.study_id}/admission`,{request_id:crypto.randomUUID(),paused:false});return {study,version,p,post};
}
async function local(page:Page){return page.evaluate(async()=>{const db=await new Promise<IDBDatabase>((res,rej)=>{const q=indexedDB.open('browser-psych-lab-v1');q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error);});try{return await new Promise<{raw:number;queued:number}>((resolve,reject)=>{const tx=db.transaction(['events','outbox']),r=tx.objectStore('events').count(),o=tx.objectStore('outbox').count();tx.oncomplete=()=>resolve({raw:r.result,queued:o.result});tx.onerror=()=>reject(tx.error);});}finally{db.close();}});}
test('research cards and finite survey recover offline exact revisions and reject a second tab',async({page,context})=>{
  const {version,study}=await setup(context);await page.goto('/admin.html');await expect(page.getByRole('heading',{name:'研究',exact:true})).toBeVisible();await page.goto(`/participate.html?version=${version.version_id}`);await page.getByText('否',{exact:true}).click();await expect(page.getByRole('textbox',{name:/补充说明/})).toBeVisible();await page.getByText('是',{exact:true}).click();await expect(page.getByRole('textbox',{name:/补充说明/})).toBeHidden();
  const sid=(await (await context.request.get(`/api/lab/studies/${study.study_id}/sessions`)).json()).sessions[0].session_id;
  const ticket=(await (await context.request.get(`/api/lab/sessions/${sid}`)).json()).admission.ticket_id;
  const second=await context.newPage();await second.goto(`/participate.html?version=${version.version_id}`);await expect(second.locator('#status')).toContainText('只读');await second.close();
  expect((await (await context.request.get(`/api/lab/sessions/${sid}`)).json()).admission.ticket_id).toBe(ticket);
  await context.setOffline(true);await page.getByRole('button',{name:'提交本页'}).click();await expect(page.getByRole('button',{name:'重试保存与核对'})).toBeVisible();const before=await local(page);expect(before.raw).toBeGreaterThanOrEqual(3);expect(before.queued).toBe(before.raw);await context.setOffline(false);await page.reload();await expect(page.locator('#status')).toContainText('研究已完成');const after=await local(page);expect(after.raw).toBe(before.raw);expect(after.queued).toBe(0);
});
test('two complete sessions run while later participants wait before answering; cancellation and refresh keep FIFO',async({page,context,browser})=>{
  const {version}=await setup(context),others=await Promise.all(Array.from({length:3},()=>browser.newContext()));
  try{
    await page.goto(`/participate.html?version=${version.version_id}`);await expect(page.getByRole('button',{name:'提交本页'})).toBeVisible();
    const [second,third,fourth]=await Promise.all([others[0]!.newPage(),others[1]!.newPage(),others[2]!.newPage()]);
    await second.goto(`${origin}/participate.html?version=${version.version_id}`);await expect(second.getByRole('button',{name:'提交本页'})).toBeVisible();
    await third.goto(`${origin}/participate.html?version=${version.version_id}`);await expect(third.locator('#status')).toContainText('等待参加名额 · 排队第 1 位');
    await fourth.goto(`${origin}/participate.html?version=${version.version_id}`);await expect(fourth.locator('#status')).toContainText('排队第 2 位');
    await third.reload();await expect(third.locator('#status')).toContainText('排队第 1 位');await expect(third.getByRole('button',{name:'提交本页'})).toHaveCount(0);
    const rows=(await (await context.request.get(`/api/lab/studies/${version.study_id}/sessions`)).json()).sessions;
    expect(rows.filter((r:{writer_epoch:number})=>r.writer_epoch===0)).toHaveLength(2);
    await third.getByRole('button',{name:'退出等待'}).click();await expect(third.getByRole('button',{name:'重新排队'})).toBeVisible();
    await third.getByRole('button',{name:'重新排队'}).click();await expect(third.locator('#status')).toContainText('排队第 2 位');
    await page.getByText('是',{exact:true}).click();await page.getByRole('button',{name:'提交本页'}).click();await expect(page.locator('#status')).toContainText('研究已完成');
    await expect(fourth.getByRole('button',{name:'提交本页'})).toBeVisible({timeout:12000});await expect(third.getByRole('button',{name:'提交本页'})).toHaveCount(0);
    expect((await (await context.request.get('/api/lab/operations')).json()).state.admission.active).toBe(2);
  }finally{for(const c of others){await finishSessions(c);await c.close();}}
});
test('frozen private image runner seals a fixed Canvas group without group-time HTTP calls',async({page,context})=>{
  const {version,study,post}=await setup(context,true,0);const requests:string[]=[];await page.route('**/api/**',async route=>{if(page.url().includes('run.html')&&(await page.locator('#status').innerText()).startsWith('本组已呈现'))requests.push(route.request().url());await route.continue();});await page.goto(`/participate.html?version=${version.version_id}`);await page.getByRole('button',{name:'准备图片任务'}).click();await page.getByRole('button',{name:'开始本组'}).click();await expect(page.locator('#status')).toContainText('本组已呈现 1 次');await page.getByRole('button',{name:'Left',exact:true}).click();await expect(page.locator('#status')).toContainText('研究已完成',{timeout:10000});expect(requests).toHaveLength(0);
  const sessions=await context.request.get(`/api/lab/studies/${study.study_id}/sessions`);const sid=(await sessions.json()).sessions[0].session_id;const detail=await context.request.get(`/api/lab/sessions/${sid}`);const result=await detail.json();expect(result.state).toBe('COMPLETED');expect(result.permit.state).toBe('CLOSED_NORMAL');expect(result.diagnostics).toHaveLength(0);expect((await local(page)).queued).toBe(0);
  const exported=await post('/api/lab/jobs/export',{request_id:crypto.randomUUID(),job_id:crypto.randomUUID(),study_id:study.study_id});const csv=await context.request.get(`/api/lab/jobs/${exported.job_id}/data.csv`);expect(await csv.text()).toContain('trial_results');
  const login=await context.request.post('/api/auth/login',{headers:{Origin:origin},data:{role:'maintainer',password:'TEST_ONLY-maintainer-password'}}),{csrf}=await login.json(),headers={Origin:origin,'X-CSRF-Token':csrf};expect(login.ok()).toBeTruthy();expect((await context.request.post(`/api/lab/studies/${study.study_id}/admission`,{headers,data:{request_id:crypto.randomUUID(),paused:true}})).ok()).toBeTruthy();const rebuilt=await context.request.post('/api/lab/jobs/rebuild',{headers,data:{request_id:crypto.randomUUID(),job_id:crypto.randomUUID(),study_id:study.study_id}});expect(rebuilt.ok(),await rebuilt.text()).toBeTruthy();expect((await rebuilt.json()).result.projections[0].result[0].answer).toBe('Left');
});
test('misses consume exactly K=2 extra candidates; reload of an unclosed run only terminates UNKNOWN',async({page,context})=>{
  const {version,study}=await setup(context,true,2);await page.goto(`/participate.html?version=${version.version_id}`);await page.getByRole('button',{name:'准备图片任务'}).click();await page.getByRole('button',{name:'开始本组'}).click();await expect(page.locator('#status')).toContainText('本组已呈现 3 次',{timeout:10000});await expect(page.locator('#status')).toContainText('研究已完成',{timeout:10000});
  const rows=await context.request.get(`/api/lab/studies/${study.study_id}/sessions`);const sid=(await rows.json()).sessions[0].session_id;const detail=await (await context.request.get(`/api/lab/sessions/${sid}`)).json();expect(detail.state).toBe('COMPLETED');expect(detail.permit.plan.repeats).toBe(2);expect(detail.diagnostics).toHaveLength(0);
  // A fresh isolated browser identity starts a separate session and crashes during its permit.
  const fresh=await context.browser()!.newContext();try{const p=await fresh.newPage();await p.goto(`${origin}/participate.html?version=${version.version_id}`);await p.getByRole('button',{name:'准备图片任务'}).click();await p.getByRole('button',{name:'开始本组'}).click();await expect(p.locator('#status')).toContainText('本组已呈现 1 次');await p.reload();await expect(p.getByRole('button',{name:'确认旧运行已中断并终止'})).toBeVisible();await p.getByRole('button',{name:'确认旧运行已中断并终止'}).click();await expect(p.locator('#status')).toContainText('此会话已终止');}finally{await finishSessions(fresh);await fresh.close();}
});
test('mobile touch emulation stops on geometry change and keeps historical raw',async({browser,context})=>{
  const {version,study}=await setup(context,true,0),mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});try{const page=await mobile.newPage();await page.goto(`${origin}/participate.html?version=${version.version_id}`);await page.getByRole('button',{name:'准备图片任务'}).tap();await page.getByRole('button',{name:'开始本组'}).tap();await expect(page.locator('#status')).toContainText('本组已呈现 1 次');await page.screenshot({path:'test-results/mobile-run.png'});await page.setViewportSize({width:844,height:390});await expect(page.getByRole('button',{name:'返回核对保存记录'})).toBeVisible();const localState=await local(page);expect(localState.raw).toBeGreaterThan(2);const sessions=await (await context.request.get(`/api/lab/studies/${study.study_id}/sessions`)).json();expect(sessions.sessions[0].state).toBe('TERMINATED');}finally{await finishSessions(mobile);await mobile.close();}
});

test('one-slot preparation queue waits for a slow image and releases before trials',async({page,context,browser})=>{
  test.setTimeout(60000);const {version}=await setup(context,true,0);
  let requested!:()=>void;const downloading=new Promise<void>(r=>requested=r);
  await page.route('**/api/participate/sessions/*/assets/*',async route=>{requested();await new Promise(r=>setTimeout(r,22000));await route.continue();});
  await page.goto(`/participate.html?version=${version.version_id}`);await page.getByRole('button',{name:'准备图片任务'}).click();await downloading;
  const fresh=await browser.newContext();try{const second=await fresh.newPage();let transfers=0;second.on('request',r=>{if(/\/sessions\/[^/]+\/assets\//.test(r.url()))transfers++;});
    await second.goto(`${origin}/participate.html?version=${version.version_id}`);await second.getByRole('button',{name:'准备图片任务'}).click();await expect(second.locator('#status')).toContainText('排队第 1 位');expect(transfers).toBe(0);
    await expect(page.getByRole('button',{name:'开始本组'})).toBeVisible({timeout:30000});await expect(second.getByRole('button',{name:'开始本组'})).toBeVisible({timeout:10000});expect(transfers).toBe(1);
    const operations=await (await context.request.get('/api/lab/operations')).json();expect(operations.preparation.active).toBe(0);expect(operations.preparation.queued).toBe(0);
    const transfersDuringRun:string[]=[];page.on('request',r=>{if(r.url().includes('/preparation'))transfersDuringRun.push(r.url());});
    await page.getByRole('button',{name:'开始本组'}).click();await expect(page.locator('#status')).toContainText('研究已完成',{timeout:10000});expect(transfersDuringRun).toHaveLength(0);
  }finally{await finishSessions(fresh);await fresh.close();}
});
test('frozen runner uses precompressed code and respects encoding refusal',async({context})=>{
  const {version}=await setup(context,true,0),base=`/runners/${version.runner_hash}/`,html=await (await context.request.get(`${base}run.html`)).text(),path=/src="\.\/([^" ]+\.js)"/.exec(html)?.[1];expect(path).toBeTruthy();
  const compressed=await context.request.get(`${base}${path}`,{headers:{'Accept-Encoding':'gzip, identity;q=0'}});expect(compressed.ok()).toBeTruthy();expect(compressed.headers()['content-encoding']).toBe('gzip');expect(compressed.headers()['vary']).toContain('Accept-Encoding');expect(compressed.headers()['cache-control']).toContain('no-transform');
  const plain=await context.request.get(`${base}${path}`,{headers:{'Accept-Encoding':'br;q=0,gzip;q=0,identity;q=1'}});expect(plain.headers()['content-encoding']).toBeUndefined();expect(await compressed.text()).toBe(await plain.text());
  const refused=await context.request.get(`${base}${path}`,{headers:{'Accept-Encoding':'br;q=0,gzip;q=0,identity;q=0'}});expect(refused.status()).toBe(406);
});

test('canceling a queued preparation releases the ticket without issuing a run',async({page,context,browser})=>{
  const {version}=await setup(context,true,0);let received!:()=>void,unblock!:()=>void;
  const incoming=new Promise<void>(r=>received=r),blocked=new Promise<void>(r=>unblock=r);
  await page.route('**/api/participate/sessions/*/assets/*',async route=>{received();await blocked;await route.abort().catch(()=>{});});
  await page.goto(`/participate.html?version=${version.version_id}`);await page.getByRole('button',{name:'准备图片任务'}).click();await incoming;
  const fresh=await browser.newContext();try{const next=await fresh.newPage();await next.goto(`${origin}/participate.html?version=${version.version_id}`);await next.getByRole('button',{name:'准备图片任务'}).click();await expect(next.locator('#status')).toContainText('排队第 1 位');
    await page.getByRole('button',{name:'取消准备'}).click();unblock();await expect(page.locator('#status')).toContainText('已取消准备');await expect(next.getByRole('button',{name:'开始本组'})).toBeVisible({timeout:7000});
    const operations=await (await context.request.get('/api/lab/operations')).json();expect(operations.preparation.active).toBe(0);expect(operations.preparation.queued).toBe(0);
  }finally{unblock();await finishSessions(fresh);await fresh.close();}
});
