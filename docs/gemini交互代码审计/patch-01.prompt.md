实施后复审差异第 1 段。原版完整源码已在本会话前15段给出；这些是git diff和新增测试连续片段。仅确认接收 PATCH_ACK_01，等最终请求再审计。
diff --git a/src/web/interaction-recorder.ts b/src/web/interaction-recorder.ts
index 144d1f0..4527679 100644
--- a/src/web/interaction-recorder.ts
+++ b/src/web/interaction-recorder.ts
@@ -38,6 +38,16 @@ export function recordInteractions(root:HTMLElement,context:()=>InteractionConte
     if (frame!==undefined) {cancelAnimationFrame(frame);frame=undefined;}
     microtask=false;
     const at=performance.now(),c=current(),nodes:ScreenNode[]=[];let truncated=false;
+    const state=browserState(),base={context:c,width:state.width,height:state.height,dpr:state.dpr,scroll_x:state.scroll_x,scroll_y:state.scroll_y,
+      visual_viewport:state.visual_viewport,background:getComputedStyle(document.documentElement).backgroundColor};
+    // A single screen must fit in a diagnostic batch and its 128 KiB ledger
+    // envelope. Bound encoded bytes as well as node count; input samples remain intact.
+    let snapshotBytes=encoder.encode(JSON.stringify({type:'screen',at,...base,nodes:[],nodes_truncated:false,capture})).length;
+    const appendNode=(node:ScreenNode)=>{
+      const size=encoder.encode(JSON.stringify(node)).length+(nodes.length?1:0);
+      if(nodes.length>=1900||snapshotBytes+size>75000){truncated=true;return false;}
+      nodes.push(node);snapshotBytes+=size;return true;
+    };
     elements: for (const e of root.querySelectorAll<HTMLElement>('*')) {
       const r=box(e),computed=getComputedStyle(e);
       if (!r.width||!r.height||computed.visibility!=='visible'||computed.display==='none'||e.closest('[style*="opacity: 0"]')) continue;
@@ -49,14 +59,13 @@ export function recordInteractions(root:HTMLElement,context:()=>InteractionConte
       } else if (e instanceof HTMLTextAreaElement||e instanceof HTMLSelectElement) {node.value=e.value;node.disabled=e.disabled;}
       if (e instanceof HTMLButtonElement) node.disabled=e.disabled;
       if (e instanceof HTMLCanvasElement) {node.asset_id=c.asset_id;node.text=c.stimulus_text??'';}
-      if (nodes.length>=1900) {truncated=true;break;}nodes.push(node);
+      if (!appendNode(node)) break;
       for (const child of e.childNodes) if (child.nodeType===Node.TEXT_NODE&&child.textContent?.trim()) {
         const range=document.createRange();range.selectNodeContents(child);const rect=range.getBoundingClientRect();
-        if (nodes.length>=1900) {truncated=true;break elements;}nodes.push({x:rect.x,y:rect.y,width:rect.width,height:rect.height,tag:'text',text:child.textContent,style});
+        if (!appendNode({x:rect.x,y:rect.y,width:rect.width,height:rect.height,tag:'text',text:child.textContent,style})) break elements;
       }
     }
-    const state=browserState(),snapshot={context:c,width:state.width,height:state.height,dpr:state.dpr,scroll_x:state.scroll_x,scroll_y:state.scroll_y,
-      visual_viewport:state.visual_viewport,background:getComputedStyle(document.documentElement).backgroundColor,nodes,nodes_truncated:truncated};
+    const snapshot={...base,nodes,nodes_truncated:truncated};
     const signature=JSON.stringify(snapshot);if (signature===lastScreen) return;lastScreen=signature;
     add({type:'screen',at,...snapshot,capture});
   }
diff --git a/src/web/participant-ui.ts b/src/web/participant-ui.ts
index f2eddda..fc00dd6 100644
--- a/src/web/participant-ui.ts
+++ b/src/web/participant-ui.ts
@@ -1,4 +1,4 @@
-import {el} from './dom.js';
+import {el,button} from './dom.js';
 import {RequestError} from './request-error.js';
 
 export const ui={
@@ -10,6 +10,11 @@ export const ui={
   scaleHint:'点击或拖动滑块选择评分',
 } as const;
 
+export function showDuplicateTab(status:HTMLElement,content:HTMLElement){
+  status.textContent=ui.duplicateTab;
+  content.replaceChildren(button('重新尝试',()=>location.reload(),'primary'));
+}
+
 const errors:Record<string,string>={
   SESSION_CAPACITY_FULL:ui.capacity,PREPARATION_CAPACITY_FULL:ui.capacity,
   ADMISSION_EXPIRED:'作答连接已过期，请重新进入。',
diff --git a/src/web/participant.ts b/src/web/participant.ts
index 33f82b6..8777aba 100644
--- a/src/web/participant.ts
+++ b/src/web/participant.ts
@@ -9,7 +9,7 @@ import {mountEnding} from './ending-page.js';
 import {recordInteractions} from './interaction-recorder.js';
 import {downloadEstimate,downloadSize} from '../shared/download-estimate.js';
 import type {Answer} from '../shared/protocol.js';
-import {ui,participantError,errorDetails,errorCode,isConnectionFailure} from './participant-ui.js';
+import {ui,participantError,errorDetails,errorCode,isConnectionFailure,showDuplicateTab} from './participant-ui.js';
 const version=new URLSearchParams(location.search).get('version')??'';
 const title=document.querySelector<HTMLHeadingElement>('#title')!,status=document.querySelector<HTMLParagraphElement>('#status')!,content=document.querySelector<HTMLDivElement>('#content')!;
 const writer=sessionStorage.getItem(`lab-writer-${version}`)??uid();sessionStorage.setItem(`lab-writer-${version}`,writer);let api:ParticipantAPI|null=null,owned=false,busy=false;
@@ -27,10 +27,10 @@ function recovery(error:unknown){
   const retry=button(capacity?'稍后重试':!api||admissionController?.signal.aborted?'重新进入':ui.retrySave,()=>action(restore),'primary');
   const actions=el('div',undefined,'recovery-actions');actions.append(retry,errorDetails(error));content.replaceChildren(actions);
 }
-async function action(fn:()=>Promise<void>){if(busy)return;busy=true;try{await fn();}catch(error){recovery(error);}finally{busy=false;}}async function restore(){waitingForRecovery=false;recoverOnOnline=false;recorder?.stop();recorder=undefined;disposePage?.();disposePage=undefined;if(!owned){status.textContent=ui.duplicateTab;content.replaceChildren();return;}api??=await ParticipantAPI.open(version,writer);await api.stopAdmission();await api.refresh();const s=api.session;applyParticipantBackground(s.frozen.protocol.layout.background);title.textContent=s.frozen.protocol.title;
+async function action(fn:()=>Promise<void>){if(busy)return;busy=true;try{await fn();}catch(error){recovery(error);}finally{busy=false;}}async function restore(){waitingForRecovery=false;recoverOnOnline=false;recorder?.stop();recorder=undefined;disposePage?.();disposePage=undefined;if(!owned){showDuplicateTab(status,content);return;}api??=await ParticipantAPI.open(version,writer);await api.stopAdmission();await api.refresh();const s=api.session;applyParticipantBackground(s.frozen.protocol.layout.background);title.textContent=s.frozen.protocol.title;
   if(s.state==='COMPLETED'){await api.sync();status.textContent=ui.completed;disposePage=mountEnding(content,s.frozen.protocol.ending);return;}
   if(s.state==='TERMINATED'){status.textContent='本次作答已中断，正在保存已有记录…';await api.reconcile();status.textContent='本次作答已中断，已有记录已保存。';const again=button('重新作答',()=>action(async()=>{await api!.reanswer();for(const key of Object.keys(sessionStorage))if(key.startsWith(`lab-step-${version}-`))sessionStorage.removeItem(key);location.reload();}),'primary');content.replaceChildren(again,el('p','重新作答将创建新答卷，原答卷及其关联记录会保留。','support-text'));return;}
-  if(!owned){status.textContent=ui.duplicateTab;content.replaceChildren();return;}
+  if(!owned){showDuplicateTab(status,content);return;}
   if(s.permit?.state==='ISSUED'&&!(await api.ledger.state()).pending[s.permit.scope]){if(s.task_activity){status.textContent='任务已中断，正在保存已有记录…';await api.terminate('UNKNOWN_RUN');await api.sync();await restore();return;}status.textContent='上次任务未正常结束，请先结束该任务并保存已有记录。';content.replaceChildren(button('结束中断的任务',()=>action(async()=>{await api!.terminate('UNKNOWN_RUN');await api!.sync();await restore();})));return;}
   admissionController=new AbortController();const controller=admissionController;
   status.textContent='正在准备问卷…';content.replaceChildren(button(ui.cancel,()=>{cancelAdmission(controller);location.assign('/');}));
diff --git a/src/web/rating-run.ts b/src/web/rating-run.ts
index 5eb08ad..995d2b7 100644
--- a/src/web/rating-run.ts
+++ b/src/web/rating-run.ts
@@ -19,21 +19,26 @@ export function ratingControls(prompts:string[],labels:string[],buttons:HTMLButt
 }
 export async function runRating(plan:GroupPlan,a:ParticipantAPI,canvas:HTMLCanvasElement,buttons:HTMLButtonElement[],ranges:HTMLInputElement[],axes:HTMLElement[],submit:HTMLButtonElement,heading:HTMLElement,age:HTMLInputElement|null,images:Map<string,ImageBitmap>,ctx:CanvasRenderingContext2D,status:HTMLElement,geometry:()=>NonNullable<GroupPlan['geometry']>,release:()=>void,returnToPage:()=>void,content:HTMLElement){
   const replay=new RunReplay(plan),origin=performance.now(),now=()=>performance.now()-origin;const items=plan.rating?.items?.length??1;const total=items+(age?1:0),ageMin=plan.rating?.age_min??0,ageMax=plan.rating?.age_max??120;const ageRow=age?.closest<HTMLElement>('.rating-age-row');let question=0,index=0,phase:'waiting'|'rating'|'isi'|'closing'='waiting',intentReady=false,selected:number|null=null,answers:number[]=[];let submission:{values:number[];at:number}|null=null,frame=0,lastFrame=0,stopped=false,clearAt=0,answerSaved=false;
-  const instance=()=>`${plan.roots[index]!.root_id}:1`,persist=(r:RunRecord)=>a.ledger.append(plan.scope,'GROUP_RECORD',{record:r}),emit=(r:RunRecord)=>{r.clock_origin=origin;replay.apply(r);return persist(r)};const blank=()=>{ctx.fillStyle=a.session.frozen.protocol.layout.background;ctx.fillRect(0,0,canvas.width,canvas.height);canvas.style.visibility='hidden';};const visible=(show:boolean)=>{const c=axes[0]?.parentElement;if(c){c.style.visibility=show?'visible':'hidden';c.style.opacity=show?'1':'0';c.style.pointerEvents=show?'auto':'none';}submit.style.visibility=show?'visible':'hidden';};const disable=()=>{for(const b of buttons)b.disabled=true;for(const r of ranges)r.disabled=true;submit.disabled=true;};
-  const recorder=recordInteractions(document.querySelector('main')!,()=>({instance_id:instance(),item:question,phase,asset_id:plan.roots[index]?.asset_id}),batch=>a.ledger.interaction(batch),error=>{void stop(error);});
-  const resetQuestion=(q:number)=>{for(const [i,r] of ranges.entries()){r.disabled=i!==q;r.dataset.answered='false';r.setAttribute('aria-valuetext','尚未作答');r.value='5';const out=r.closest('.axis-control')?.querySelector('output');if(out)out.textContent=ui.scaleHint;r.closest('.axis-control')?.querySelectorAll('.rating-ticks span').forEach(t=>(t as HTMLElement).dataset.selected='false');}axes.forEach((axis,i)=>axis.style.visibility=i===q?'visible':'hidden');};
+  const endDrags:(()=>void)[]=[];
+  const instance=()=>`${plan.roots[index]!.root_id}:1`,persist=(r:RunRecord)=>a.ledger.append(plan.scope,'GROUP_RECORD',{record:r}),emit=(r:RunRecord)=>{r.clock_origin=origin;replay.apply(r);return persist(r)};const blank=()=>{ctx.fillStyle=a.session.frozen.protocol.layout.background;ctx.fillRect(0,0,canvas.width,canvas.height);canvas.style.visibility='hidden';};const visible=(show:boolean)=>{const c=axes[0]?.parentElement;if(c){c.style.visibility=show?'visible':'hidden';c.style.opacity=show?'1':'0';c.style.pointerEvents=show?'auto':'none';}submit.style.visibility=show?'visible':'hidden';};const disable=()=>{for(const end of endDrags)end();for(const b of buttons)b.disabled=true;for(const r of ranges)r.disabled=true;submit.disabled=true;};
+  const recorder=recordInteractions(document.querySelector('main')!,()=>({instance_id:plan.roots[index]?instance():undefined,item:question,phase,asset_id:plan.roots[index]?.asset_id}),batch=>a.ledger.interaction(batch),error=>{void stop(error);});
+  const resetQuestion=(q:number)=>{for(const end of endDrags)end();for(const [i,r] of ranges.entries()){r.disabled=i!==q;r.dataset.answered='false';r.setAttribute('aria-valuetext','尚未作答');r.value='5';const out=r.closest('.axis-control')?.querySelector('output');if(out)out.textContent=ui.scaleHint;r.closest('.axis-control')?.querySelectorAll('.rating-ticks span').forEach(t=>(t as HTMLElement).dataset.selected='false');}axes.forEach((axis,i)=>axis.style.visibility=i===q?'visible':'hidden');};
   const stopLiveness=taskLiveness(a,reason=>{void stop(reason);});
   async function intent(){intentReady=false;await emit({type:'RATING_INTENT',at:now(),instance_id:instance()});if(!stopped)intentReady=true;}function remove(){stopLiveness();recorder.stop();document.body.classList.remove('running');window.removeEventListener('resize',change);document.removeEventListener('visibilitychange',change);window.removeEventListener('pagehide',hidden);window.visualViewport?.removeEventListener('resize',visualChange);window.visualViewport?.removeEventListener('scroll',visualChange);}async function stop(error:unknown){if(stopped)return;stopped=true;cancelAnimationFrame(frame);blank();disable();remove();await persist({type:'ABORT',at:now(),clock_origin:origin,reason:String(error).slice(0,150)}).catch(()=>{});const explanation=interruptionMessage(error);status.textContent=`${explanation}正在保存已有记录…`;try{await a.terminate('SOFTWARE_RUN_INTERRUPTED',{reason:String(error).slice(0,150)});await a.sync();status.textContent=`${explanation}已有记录已保存。`;}catch{status.textContent=`