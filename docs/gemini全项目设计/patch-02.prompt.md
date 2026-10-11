这是实施后设计复审 2/7。内容为当前修改源码、测试或采用设计。先吸收本段；只回复“已接收复审2”，等全部7段后再讨论。

-      task_activity:(()=>{const row=this.get<{last_seen:number}>('SELECT last_seen FROM lab_task_activity WHERE session_id=?',sid);return row?{last_seen:row.last_seen,idle_timeout_ms:120000,connection_timeout_ms:300000}:null;})(),
+      task_activity:(()=>{const row=this.get<{last_seen:number}>('SELECT last_seen FROM lab_task_activity WHERE session_id=?',sid);return row?{last_seen:row.last_seen,idle_timeout_ms:TASK_ACTIVITY_POLICY.idle_timeout_ms,connection_timeout_ms:TASK_ACTIVITY_POLICY.connection_timeout_ms}:null;})(),
       seals:this.all<{response:string}>('SELECT response FROM lab_seals WHERE session_id=? ORDER BY rowid',sid).map(r=>JSON.parse(r.response) as Seal),
       completion:s.completion?JSON.parse(s.completion):null,diagnostics:this.all('SELECT code,scope FROM lab_diagnostics WHERE session_id=?',sid),admission:this.admission.view(sid),reanswer:this.get('SELECT old_session_id,new_session_id,created_at FROM lab_reanswer_links WHERE new_session_id=? OR old_session_id=?',sid,sid)??null};
   }
@@ -170,8 +171,8 @@ export class LabStore {
     }).immediate(); if(result instanceof Rejection) throw result.error; return result;
   }
   expireTaskActivity(){
-    return this.db.transaction(()=>{const expired=this.all<{session_id:string}>("SELECT a.session_id FROM lab_task_activity a JOIN lab_sessions s USING(session_id) WHERE a.last_seen<=? AND s.state='ACTIVE' AND a.writer_epoch=s.writer_epoch",this.now()-300000);
-      for(const {session_id:sid} of expired){this.run("UPDATE lab_sessions SET state='TERMINATED',lease_until=0 WHERE session_id=?",sid);this.run("UPDATE lab_permits SET state='CLOSED_UNKNOWN' WHERE session_id=? AND state='ISSUED'",sid);this.admission.ended(sid);this.diagnostic(sid,null,'CONNECTION_TIMEOUT',{timeout_ms:300000});}
+    return this.db.transaction(()=>{const expired=this.all<{session_id:string}>("SELECT a.session_id FROM lab_task_activity a JOIN lab_sessions s USING(session_id) WHERE a.last_seen<=? AND s.state='ACTIVE' AND a.writer_epoch=s.writer_epoch",this.now()-TASK_ACTIVITY_POLICY.connection_timeout_ms);
+      for(const {session_id:sid} of expired){this.run("UPDATE lab_sessions SET state='TERMINATED',lease_until=0 WHERE session_id=?",sid);this.run("UPDATE lab_permits SET state='CLOSED_UNKNOWN' WHERE session_id=? AND state='ISSUED'",sid);this.admission.ended(sid);this.diagnostic(sid,null,'CONNECTION_TIMEOUT',{timeout_ms:TASK_ACTIVITY_POLICY.connection_timeout_ms});}
       this.run("DELETE FROM lab_task_activity WHERE session_id IN (SELECT session_id FROM lab_sessions WHERE state IN ('COMPLETED','TERMINATED'))");return expired.length;
     }).immediate();
   }
@@ -405,7 +406,7 @@ export class LabStore {
     if(op==='participant.activity'){
       if(['COMPLETED','TERMINATED'].includes(s.state))return {status:s.state};this.active(s,d);
       if(!this.get('SELECT 1 FROM lab_task_activity WHERE session_id=? AND writer_epoch=?',sid,s.writer_epoch))throw new ContractError('TASK_ACTIVITY_UNAVAILABLE',409);
-      this.run('UPDATE lab_task_activity SET last_seen=? WHERE session_id=?',this.now(),sid);this.run('UPDATE lab_sessions SET lease_until=? WHERE session_id=?',this.now()+300000,sid);this.admission.join(sid);return {status:'ACTIVE'};
+      this.run('UPDATE lab_task_activity SET last_seen=? WHERE session_id=?',this.now(),sid);this.run('UPDATE lab_sessions SET lease_until=? WHERE session_id=?',this.now()+TASK_ACTIVITY_POLICY.connection_timeout_ms,sid);this.admission.join(sid);return {status:'ACTIVE'};
     }
     if(!['COMPLETED','TERMINATED'].includes(s.state)&&['participant.claim','participant.reserve','participant.permit','participant.seal','participant.finalize','participant.preparation','participant.asset','participant.admission.check'].includes(op)){
       const result=this.admission.join(sid);if(result.status!=='ACTIVE')return new Rejection(new ContractError('SESSION_WAITING',409,result));
@@ -483,7 +484,7 @@ export class LabStore {
         if(group.rating)plan.rating=group.rating;if(selection)plan.sampling=selection.sampling;
         if(plan.roots.reduce((n,t)=>n+(t.image_ms+t.isi_ms+(t.feedback_ms??0))*(plan.repeats+1),0)>p.budget.max_group_ms)throw new ContractError('QUANTIZED_GROUP_BUDGET_EXCEEDED',409);
         const allocation=slot.allocation_id??randomUUID();if(!slot.allocation_id){this.run('UPDATE lab_slots SET allocation_id=? WHERE slot_id=?',allocation,slot.slot_id);this.run('UPDATE lab_sessions SET allocation_id=? WHERE session_id=?',allocation,sid);}
-        const permit=randomUUID();this.run("INSERT INTO lab_permits VALUES (?,?,?,?,?,?,?,?, 'ISSUED')",permit,sid,scope,group.id,s.writer_epoch,stableJSON(plan),digest(stableJSON(plan)),stableJSON(readiness));if(readiness.activity_policy==='idle120-offline300-v1')this.run('INSERT INTO lab_task_activity VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET writer_epoch=excluded.writer_epoch,last_seen=excluded.last_seen',sid,s.writer_epoch,this.now());return this.view(sid).permit;
+        const permit=randomUUID();this.run("INSERT INTO lab_permits VALUES (?,?,?,?,?,?,?,?, 'ISSUED')",permit,sid,scope,group.id,s.writer_epoch,stableJSON(plan),digest(stableJSON(plan)),stableJSON(readiness));if(readiness.activity_policy===TASK_ACTIVITY_POLICY.id)this.run('INSERT INTO lab_task_activity VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET writer_epoch=excluded.writer_epoch,last_seen=excluded.last_seen',sid,s.writer_epoch,this.now());return this.view(sid).permit;
       }
       if(op==='participant.seal')return this.seal(s,d,p);
       if(op==='participant.finalize') {
diff --git a/src/web/participant.ts b/src/web/participant.ts
index 903183c..1d57b86 100644
--- a/src/web/participant.ts
+++ b/src/web/participant.ts
@@ -26,7 +26,7 @@ function recovery(error:unknown){
 }
 async function action(fn:()=>Promise<void>){if(busy)return;busy=true;try{await fn();}catch(error){recovery(error);}finally{busy=false;}}async function restore(){recorder?.stop();recorder=undefined;disposePage?.();disposePage=undefined;if(!owned){status.textContent='此会话已在其他页面打开。此页只读。';content.replaceChildren();return;}api??=await ParticipantAPI.open(version,writer);await api.stopAdmission();await api.refresh();const s=api.session;applyParticipantBackground(s.frozen.protocol.layout.background);title.textContent=s.frozen.protocol.title;title.title=s.frozen.protocol.title;
   if(s.state==='COMPLETED'){await api.sync();status.textContent='研究已完成，数据已保存。';disposePage=mountEnding(content,s.frozen.protocol.ending);return;}
-  if(s.state==='TERMINATED'){status.textContent='此会话已终止。正在补传已保存记录。';await api.reconcile();status.textContent='此会话已终止。已保存记录已补传核对，原始数据保留。或者删除此前答卷以重新回答。';const again=button('删除此前答卷以重新回答',()=>action(async()=>{await api!.reanswer();for(const key of Object.keys(sessionStorage))if(key.startsWith(`lab-step-${version}-`))sessionStorage.removeItem(key);location.reload();}));content.replaceChildren(again,el('p','重新回答会创建新答卷，旧答卷保留并与新答卷关联。'));return;}
+  if(s.state==='TERMINATED'){status.textContent='此会话已终止。正在补传已保存记录。';await api.reconcile();status.textContent='此会话已终止。已保存记录已补传核对，原始数据保留。可以重新作答并建立新答卷。';const again=button('重新作答',()=>action(async()=>{await api!.reanswer();for(const key of Object.keys(sessionStorage))if(key.startsWith(`lab-step-${version}-`))sessionStorage.removeItem(key);location.reload();}));content.replaceChildren(again,el('p','重新回答会创建新答卷，旧答卷保留并与新答卷关联。'));return;}
   if(!owned){status.textContent='此会话已在其他页面打开。此页只读。';content.replaceChildren();return;}
   if(s.permit?.state==='ISSUED'&&!(await api.ledger.state()).pending[s.permit.scope]){if(s.task_activity){status.textContent='任务已中断，正在核对并补传保存记录。';await api.terminate('UNKNOWN_RUN');await api.sync();await restore();return;}status.textContent='检测到未关闭的图片运行。恢复只能关闭未知运行并保留数据。';content.replaceChildren(button('确认旧运行已中断并终止',()=>action(async()=>{await api!.terminate('UNKNOWN_RUN');await api!.sync();await restore();})));return;}
   admissionController=new AbortController();const controller=admissionController;
diff --git a/src/web/run.ts b/src/web/run.ts
index 6f87aaa..4d3f01f 100644
--- a/src/web/run.ts
+++ b/src/web/run.ts
@@ -1,4 +1,5 @@
 import {taskLiveness} from './task-liveness.js';
+import {TASK_ACTIVITY_POLICY} from '../shared/task-policy.js';
 import {recordInteractions} from './interaction-recorder.js';
 import './participant.css';
 import './compat.js';
@@ -65,7 +66,7 @@ async function prepare(){
   const start=button('开始本组',async()=>{try{
     api!.admission?.check();await api!.stopAdmission();start.style.visibility='hidden';if(document.visibilityState!=='visible')throw new Error('页面当前不可见。');const actual=measuredGeometry();if(JSON.stringify(actual)!==JSON.stringify(ready))throw new Error('准备后布局已变化，请重新准备。');
     const next=await reserve();if(next.variant_id!==reservation.variant_id)throw new Error('预留方案已变化，请重新准备。');reservation=next;
-    const permit=await request<NonNullable<LabSession['permit']>>(api!.path('permit'),{request_id:uid(),...api!.fence(),reservation_id:reservation.reservation_id,readiness:{activity_policy:'idle120-offline300-v1',...measured,...storage,download:images.download,layout,geometry:ready,assets:images.hashes,decoded_bytes:images.decoded_bytes,protocol_hash:api!.session.frozen.hash}});
+    const permit=await request<NonNullable<LabSession['permit']>>(api!.path('permit'),{request_id:uid(),...api!.fence(),reservation_id:reservation.reservation_id,readiness:{activity_policy:TASK_ACTIVITY_POLICY.id,...measured,...storage,download:images.download,layout,geometry:ready,assets:images.hashes,decoded_bytes:images.decoded_bytes,protocol_hash:api!.session.frozen.hash}});
     await api!.refresh();
     if(rating){start.style.visibility='hidden';await runRating(permit.plan,api!,canvas,buttons,rating.ranges,rating.axes,rating.submit,rating.heading,rating.age,images.byAsset,ctx,status,measuredGeometry,()=>{releaseImages?.();releaseImages=null;},returnToPage,content);}
     else {for(const b of buttons)b.disabled=false;await run(permit.plan,canvas,buttons,images.byAsset,ctx);}
diff --git a/tests/unit/runner-release.test.mjs b/tests/unit/runner-release.test.mjs
index 26452e4..704c0fa 100644
--- a/tests/unit/runner-release.test.mjs
+++ b/tests/unit/runner-release.test.mjs
@@ -45,6 +45,13 @@ test('runner capability is canonical, bounded and rejects corrupt or unsupported
   async function archive(contract){const bytes=JSON.stringify(contract),files=[{path:'runner-contract.json',hash:digest(bytes)}],runnerHash=digest(JSON.stringify(files));
     await writeFile(join(dist,'web/runner-contract.json'),bytes);await writeFile(join(dist,'release.json'),JSON.stringify({runnerHash,runnerVersion:'canvas-v1',files}));await retainRelease(root,dist);return runnerHash;}
   const hash=await archive({schema:'runner-assets-v1',preparation_queue:true});assert.equal(await new RunnerAssetPolicy(root).get(hash),'ticket');
+  assert.equal(await new RunnerAssetPolicy(root).requiresActivity(hash),false);
+  const active=await archive({schema:'runner-assets-v1',preparation_queue:true,task_activity:'idle120-offline300-v1'});
+  assert.equal(await new RunnerAssetPolicy(root).requiresActivity(active),true);
+  for(const task_activity of ['future-policy',null,false]){
+    const unknown=await archive({schema:'runner-assets-v1',preparation_queue:true,task_activity});
+    await assert.rejects(new RunnerAssetPolicy(root).get(unknown),/UNSUPPORTED_TASK_ACTIVITY_POLICY/);
+  }
   const unsupported=await archive({schema:'future-schema',preparation_queue:true});await assert.rejects(new RunnerAssetPolicy(root).get(unsupported),/UNSUPPORTED/);
   await writeFile(join(root,'research-assets/runners',hash,'runner-contract.json'),'tampered');await assert.rejects(new RunnerAssetPolicy(root).get(hash),/HASH_MISMATCH/);
   await assert.rejects(new RunnerAssetPolicy(root).get('../unsafe'),/INVALID_RUNNER/);
diff --git a/tests/unit/task-liveness.test.mjs b/tests/unit/task-liveness.test.mjs
index a2d28de..5bb8809 100644
--- a/tests/unit/task-liveness.test.mjs
+++ b/tests/unit/task-liveness.test.mjs
@@ -4,13 +4,25 @@ import {taskLiveness} from '../../src/web/task-liveness.ts';
 function setup(t,online=true){
   const target=new EventTarget(),prior=globalThis.document;globalThis.document=target;t.after(()=>{globalThis.document=prior;});
   let now=0,calls=0;const errors=[];t.mock.method(performance,'now',()=>now);t.mock.timers.enable({apis:['setInterval']});
-  t.mock.method(globalThis,'fetch',async()=>{calls++;if(!online)throw new Error('offline');return new Response('{"status":"ACTIVE"}');});
+  t.mock.method(globalThis,'fetch',async()=>{calls++;if(typeof online==='function')return online();if(!online)throw new Error('offline');return new Response('{"status":"ACTIVE"}');});
   const stop=taskLiveness({path:()=>'/activity',fence:()=>({writer_id:'test',writer_epoch:1})},e=>errors.push(e));t.after(stop);