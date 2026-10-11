实施后复审差异第 3 段。原版完整源码已在本会话前15段给出；这些是git diff和新增测试连续片段。仅确认接收 PATCH_ACK_03，等最终请求再审计。

-  const measured=await refreshProbe(p),storage=await storageProbe(preparedGroup,p);if(storage.commit_ms>p.budget.commit_ms)throw new Error('此设备的保存速度未满足任务要求，请更换设备或联系研究者。');
+  const measured=await refreshProbe(p);preparing.signal.throwIfAborted();
+  const storage=await storageProbe(preparedGroup,p);preparing.signal.throwIfAborted();if(storage.commit_ms>p.budget.commit_ms)throw new Error('此设备的保存速度未满足任务要求，请更换设备或联系研究者。');
   const canvas=el('canvas'),buttons=group.choices.map(c=>el('button',c));canvas.id='stimulus';const controls=el('div',undefined,'response-buttons');controls.append(...buttons);
   document.body.classList.add('runner-layout');window.scrollTo(0,0);
   const stage=el('div',undefined,'runner-stage'),slot=el('div',undefined,'canvas-slot'),footer=el('div',undefined,'runner-start');slot.append(canvas);stage.append(slot,controls,footer);content.replaceChildren(stage);preventTaskGestures(stage);showResponse(buttons,null);controls.style.setProperty('--response-columns',String(Math.min(buttons.length,Math.max(2,Math.floor(controls.clientWidth/80)))));for(const b of buttons)b.disabled=true;
@@ -64,14 +66,15 @@ async function prepare(){
   const ctx=canvas.getContext('2d',{alpha:false});if(!ctx)throw new Error('此浏览器无法显示任务，请更换浏览器后重试。');ctx.fillStyle=p.layout.background;ctx.fillRect(0,0,canvas.width,canvas.height);
   status.textContent=`${p.mode==='TEST_ONLY'?'测试模式 · ':''}准备就绪。开始后请保持页面可见，并连续完成本组。`;
   let ready:NonNullable<GroupPlan['geometry']>;
-  const start=button(ui.startGroup,async()=>{try{
-    api!.admission?.check();await api!.stopAdmission();start.style.visibility='hidden';if(document.visibilityState!=='visible')throw new Error('页面当前不可见。');const actual=measuredGeometry();if(JSON.stringify(actual)!==JSON.stringify(ready))throw new Error('准备后布局已变化，请重新准备。');
-    const next=await reserve();if(next.variant_id!==reservation.variant_id)throw new Error('预留方案已变化，请重新准备。');reservation=next;
-    const permit=await request<NonNullable<LabSession['permit']>>(api!.path('permit'),{request_id:uid(),...api!.fence(),reservation_id:reservation.reservation_id,readiness:{activity_policy:TASK_ACTIVITY_POLICY.id,...measured,...storage,download:images.download,layout,geometry:ready,assets:images.hashes,decoded_bytes:images.decoded_bytes,protocol_hash:api!.session.frozen.hash}});
-    await api!.refresh();
+  const checkReady=()=>{preparing.signal.throwIfAborted();if(document.visibilityState!=='visible')throw new Error('页面当前不可见。');if(JSON.stringify(measuredGeometry())!==JSON.stringify(ready))throw new Error('准备后布局已变化，请重新准备。');};
+  const start=button(ui.startGroup,async()=>{let permitIssued=false;try{
+    api!.admission?.check();await api!.stopAdmission();start.style.visibility='hidden';checkReady();
+    const next=await reserve(preparing.signal);checkReady();if(next.variant_id!==reservation.variant_id)throw new Error('预留方案已变化，请重新准备。');reservation=next;
+    const permit=await request<NonNullable<LabSession['permit']>>(api!.path('permit'),{request_id:uid(),...api!.fence(),reservation_id:reservation.reservation_id,readiness:{activity_policy:TASK_ACTIVITY_POLICY.id,...measured,...storage,download:images.download,layout,geometry:ready,assets:images.hashes,decoded_bytes:images.decoded_bytes,protocol_hash:api!.session.frozen.hash}},undefined,preparing.signal);
+    permitIssued=true;checkReady();await api!.refresh();checkReady();
     if(rating){start.style.visibility='hidden';await runRating(permit.plan,api!,canvas,buttons,rating.ranges,rating.axes,rating.submit,rating.heading,rating.age,images.byAsset,ctx,status,measuredGeometry,()=>{releaseImages?.();releaseImages=null;},returnToPage,content);}
     else {for(const b of buttons)b.disabled=false;await run(permit.plan,canvas,buttons,images.byAsset,ctx);}
-  }catch(error){releaseImages?.();releaseImages=null;if(api?.session.permit?.state==='ISSUED')await api.terminate('PREPARATION_INTERRUPTED',{message:String(error)}).catch(()=>{});failure(error);}},'primary');footer.append(start);if(rating)start.classList.add('rating-start');
+  }catch(error){releaseImages?.();releaseImages=null;if(permitIssued||api?.session.permit?.state==='ISSUED')await api!.terminate('PREPARATION_INTERRUPTED',{message:String(error)}).catch(()=>{});failure(error);}},'primary');footer.append(start);if(rating)start.classList.add('rating-start');
   ready=measuredGeometry();
 }
 async function run(plan:GroupPlan,canvas:HTMLCanvasElement,buttons:HTMLButtonElement[],images:Map<string,ImageBitmap>,ctx:CanvasRenderingContext2D){
@@ -105,7 +108,7 @@ async function run(plan:GroupPlan,canvas:HTMLCanvasElement,buttons:HTMLButtonEle
   const unload=()=>{if(active){s.interrupt(false);void record({type:'ABORT',at:now(),reason:'PAGE_HIDDEN_OR_CLOSED'});}};window.addEventListener('pagehide',unload);
   function remove(keepInputs=false){stopLiveness();recorder.stop();document.body.classList.remove('running');if(!keepInputs)unbindInput();window.removeEventListener('resize',change);document.removeEventListener('visibilitychange',change);window.removeEventListener('pagehide',unload);window.visualViewport?.removeEventListener('resize',visualChange);window.visualViewport?.removeEventListener('scroll',visualChange);}
   async function finish(){closing=true;active=false;remove(true);try{emit({type:'CLOSING',at:now(),unresolved:[...replay.obligations].some(root=>s.candidates.some(c=>c.root_id===root&&s.executions.get(c.instance_id)==='UNSTARTED'))});replay.finish();await a.ledger.drain();await a.ledger.closeScope(plan.scope,[...a.session.path,plan.group_id]);status.textContent=`本组已结束，${ui.saving}`;await a.seal(plan.scope);remove();await a.sync();releaseImages?.();releaseImages=null;returnToPage();}catch(error){
-    if(stopped)return;const pending=(await a.ledger.state()).pending[plan.scope];if(pending){status.textContent='本组已结束，保存尚未完成。';releaseImages?.();releaseImages=null;document.body.classList.remove('runner-layout');const actions=el('div',undefined,'recovery-actions');actions.append(button(ui.retrySave,async()=>{try{await a.seal(plan.scope);remove();await a.sync();returnToPage();}catch(e){status.textContent=participantError(e);}},'primary'),errorDetails(error));content.replaceChildren(actions);}else{closing=false;await stop(error);}}}
+    remove();if(stopped)return;const pending=(await a.ledger.state()).pending[plan.scope];if(pending){status.textContent='本组已结束，保存尚未完成。';releaseImages?.();releaseImages=null;document.body.classList.remove('runner-layout');const actions=el('div',undefined,'recovery-actions');actions.append(button(ui.retrySave,async()=>{try{await a.seal(plan.scope);remove();await a.sync();returnToPage();}catch(e){status.textContent=participantError(e);}},'primary'),errorDetails(error));content.replaceChildren(actions);}else{closing=false;await stop(error);}}}
   function tick(raf:number){if(stopped||closing)return;const t=now();try{
     if(lastFrame&&t-lastFrame>plan.budget.long_frame_ms)throw new Error('LONG_FRAME');lastFrame=t;
     const e=s.queue[0];if(!e){if(!pending){void finish();return;}}
@@ -126,4 +129,4 @@ async function run(plan:GroupPlan,canvas:HTMLCanvasElement,buttons:HTMLButtonEle
   await stage();if(!stopped){status.textContent='本组即将开始。';frameId=requestAnimationFrame(tick);}
 }
 if(!version||!navigator.locks||!crypto.subtle)failure(new Error(!navigator.locks?'当前浏览器无法保证单页面作答，请使用支持 Web Locks 的浏览器和 HTTPS 链接。':'浏览器能力或参与链接不完整。'));
-else void navigator.locks.request(`lab-version-${version}`,{ifAvailable:true},async lock=>{owned=!!lock;if(!owned){status.textContent=ui.duplicateTab;return;}try{await prepare();}catch(error){await api?.stopAdmission();releaseImages?.();failure(error);}await new Promise<void>(resolve=>window.addEventListener('pagehide',()=>resolve(),{once:true}));});
+else void navigator.locks.request(`lab-version-${version}`,{ifAvailable:true},async lock=>{owned=!!lock;if(!owned){showDuplicateTab(status,content);return;}try{await prepare();}catch(error){await api?.stopAdmission();releaseImages?.();failure(error);}await new Promise<void>(resolve=>window.addEventListener('pagehide',()=>resolve(),{once:true}));});
diff --git a/src/web/survey-page.ts b/src/web/survey-page.ts
index 02a73f6..c2e7272 100644
--- a/src/web/survey-page.ts
+++ b/src/web/survey-page.ts
@@ -56,7 +56,7 @@ export function mountPage(element: HTMLDivElement, page: Page, previous: Answers
     const old = answers[q.id];
     const changed = Array.isArray(answer) ? !Array.isArray(old) || answer.length !== old.length || answer.some((a, i) => a !== old[i])
       : answer&&typeof answer==='object'?Object.keys(answer).some(key=>answer[key]!==axisAnswers(old)[key])||Object.keys(answer).length!==Object.keys(axisAnswers(old)).length:answer !== old;
-    if (!changed || submitting) return;
+    if (!changed || submitting || disposed) return;
     answers[q.id] = copy(answer); message.textContent = '';
     revision(q.id, copy(answer), snapshot(answers));
     if (!composing) visibility();
@@ -190,7 +190,7 @@ export function mountPage(element: HTMLDivElement, page: Page, previous: Answers
     if (q?.type === 'text' && typeof answers[q.id] === 'string' && (answers[q.id] as string).length > q.max_length!) {
       message.textContent = `最多 ${q.max_length} 个字符。`; return false;
     }
-    if (q?.type === 'text' && typeof answers[q.id] === 'string' && q.input_match && !inputMatchRegex(q.input_match).test(answers[q.id] as string)) {
+    if (q?.type === 'text' && typeof answers[q.id] === 'string' && !answerMissing(q,answers[q.id]) && q.input_match && !inputMatchRegex(q.input_match).test(answers[q.id] as string)) {
       message.textContent = inputMatchMessage(q.input_match); return false;
     }
     return true;
@@ -213,7 +213,7 @@ export function mountPage(element: HTMLDivElement, page: Page, previous: Answers
     show(visible.filter(i => i < current).at(-1) ?? -1);
   }
   function navigate(action: () => void) {
-    if (submitting || navigating || composing) return;
+    if (disposed || submitting || navigating || composing) return;
     navigating = true; action(); if (disposed) return; navigation();
     unlock = setTimeout(() => { navigating = false; if (!disposed) navigation(); }, 200);
   }
diff --git a/tests/browser/lab.spec.ts b/tests/browser/lab.spec.ts
index c58aa3f..f2a3fac 100644
--- a/tests/browser/lab.spec.ts
+++ b/tests/browser/lab.spec.ts
@@ -99,6 +99,17 @@ test('research cards and finite survey recover offline exact revisions and rejec
   },version.version_id);
   await context.setOffline(false);await page.reload();await expect(page.locator('#status')).toContainText('研究已完成');const after=await local(page);expect(after.raw).toBe(before.raw);expect(after.queued).toBe(0);
 });
+test('a duplicate participant tab can retry after the original closes and restore durable answers',async({page,context})=>{
+  const {version}=await setup(context);await page.goto(`/participate.html?version=${version.version_id}`);await begin(page);
+  await page.getByRole('button',{name:'是',exact:true}).click();await expect.poll(async()=>(await local(page)).raw).toBeGreaterThan(0);
+  const second=await context.newPage();
+  await second.goto(`/participate.html?version=${version.version_id}`);await expect(second.locator('#status')).toContainText('只读');
+  await expect(second.getByRole('button',{name:'重新尝试',exact:true})).toBeVisible();
+  await second.getByRole('button',{name:'重新尝试',exact:true}).click();await expect(second.locator('#status')).toContainText('只读');
+  await page.close();await second.getByRole('button',{name:'重新尝试',exact:true}).click();await begin(second);
+  await expect(second.getByRole('button',{name:'是',exact:true})).toHaveAttribute('aria-pressed','true');
+  await second.getByRole('button',{name:'提交本页'}).click();await expect(second.locator('#status')).toContainText('研究已完成');
+});
 test('button wizard preserves branches, optional empty choice and numeric zero without scrolling',async({page,context})=>{
   const {version,study}=await setup(context,false,0,p=>{
     p.layout.background='#202020';p.pages[0]!.instruction='按钮作答';p.pages[0]!.questions=[
diff --git a/tests/runner-browser/runner.spec.ts b/tests/runner-browser/runner.spec.ts
index eb81beb..78350cf 100644
--- a/tests/runner-browser/runner.spec.ts
+++ b/tests/runner-browser/runner.spec.ts
@@ -12,7 +12,7 @@ import {stableJSON} from '../../src/shared/protocol.js';
 import sharp from 'sharp';
 import {gunzipSync} from 'node:zlib';
 
-async function start(page:Page,rating=false,age=false){
+async function start(page:Page,rating=false,age=false,configure?:(p:ReturnType<typeof compileQuestionnaire>)=>void){
   const root=mkdtempSync(join(tmpdir(),'bpl-runner-')),db=openDatabase(join(root,'db.sqlite')),store=new LabStore(db,digest('runner'));
   const token=digest('admin'),csrf=randomUUID();store.execute({operation:'lab/admin.issue',data:{token_hash:token,csrf}});
   const admin=(operation:string,data:Record<string,unknown>={})=>store.execute({operation:`lab/${operation}`,credential_hash:token,data:{csrf,...data}}) 