全项目设计讨论，传输段 34，源码主题：实验执行与准备（源包 12/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

### src/web/run.ts L1–L128

```
import {taskLiveness} from './task-liveness.js';
import {recordInteractions} from './interaction-recorder.js';
import './participant.css';
import './compat.js';
import './runner.css';
import {applyParticipantBackground} from './participant-theme.js';
import {lockParticipantViewport} from './viewport.js';
lockParticipantViewport();
import {el,button,uid,request} from './dom.js';
import {ParticipantAPI} from './participant-api.js';
import {prepareImages,refreshProbe,storageProbe} from './prepare.js';
import {awaitPreparation} from './preparation-gate.js';
import {bindRunnerInput,preventTaskGestures,showResponse} from './runner-input.js';
import {drawTextStimulus} from './stimulus.js';
import {cancelAdmission} from './session-gate.js';
import {RunReplay} from '../shared/run-replay.js';
import {ratingControls,runRating} from './rating-run.js';
import type {GroupPlan,InputRecord,RunRecord,LabSession,GroupReservation} from '../shared/lab-contract.js';
import type {ScheduleAudit} from '../shared/scheduler.js';
const version=new URLSearchParams(location.search).get('version')??'',writer=sessionStorage.getItem(`lab-writer-${version}`)??uid();
sessionStorage.setItem(`lab-writer-${version}`,writer);
const content=document.querySelector<HTMLDivElement>('#content')!,status=document.querySelector<HTMLParagraphElement>('#status')!,title=document.querySelector<HTMLHeadingElement>('#title')!;
let api:ParticipantAPI|null=null,active=false,owned=false,releaseImages:(()=>void)|null=null,frameId=0;
const returnToPage=()=>{location.href=`/participate.html?version=${version}`;};
function failure(error:unknown){document.body.classList.remove('runner-layout');status.textContent=error instanceof Error?error.message:'准备失败。';content.replaceChildren(button('返回保存与核对',returnToPage));}
function geometry(canvas:HTMLCanvasElement,buttons:HTMLButtonElement[]):NonNullable<GroupPlan['geometry']>{const rect=(e:HTMLElement)=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};};return {viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},canvas:rect(canvas),buttons:buttons.map(b=>({choice:b.textContent!,...rect(b)}))};}
async function prepare(){
  api=await ParticipantAPI.open(version,writer);await api.refresh();applyParticipantBackground(api.session.frozen.protocol.layout.background);if(api.session.state==='COMPLETED'||api.session.state==='TERMINATED'||api.session.permit?.state==='ISSUED'){returnToPage();return;}
  const preparing=new AbortController(),pageHidden=()=>preparing.abort(new Error('准备页面已关闭。'));
  window.addEventListener('pagehide',pageHidden,{once:true});
  content.replaceChildren(button('取消进入',()=>cancelAdmission(preparing)));
  await api.enter(preparing.signal,text=>status.textContent=text,error=>{preparing.abort(error);releaseImages?.();releaseImages=null;failure(error);});
  await api.claim();if(api.session.page_index<api.session.frozen.protocol.pages.length){returnToPage();return;}
  const reserve=(signal?:AbortSignal)=>request<GroupReservation>(api!.path('reserve'),{request_id:uid(),...api!.fence()},undefined,signal);
  let reservation=await reserve();
  const p=api.session.frozen.protocol,variant=p.variants.find(v=>v.id===reservation.variant_id)!,group=p.groups.find(g=>g.id===variant.group_order[api!.session.group_index]);
  if(!group){returnToPage();return;}title.textContent=group.title;status.textContent='下载 0%';
  const preparedGroup=reservation.selection?{...group,trials:reservation.selection.roots}:group;
  content.replaceChildren(button('取消准备',()=>preparing.abort(new Error('已取消准备，可返回后重试。'))));
  let renewal:Promise<void>=Promise.resolve(),renewTimer:ReturnType<typeof setTimeout>|undefined,renewing=true;
  const renew=()=>{renewTimer=setTimeout(()=>{
    renewal=(async()=>{try{const next=await reserve(preparing.signal);if(next.variant_id!==reservation.variant_id)throw new Error('预留方案已变化，请重新准备。');reservation=next;}
      catch(error){preparing.abort(error);}finally{if(renewing&&!preparing.signal.aborted)renew();}})();
  },60000);};renew();
  let images:Awaited<ReturnType<typeof prepareImages>>;
  try{const gate=await awaitPreparation(api,preparing.signal,text=>status.textContent=text,error=>preparing.abort(error));
    try{images=await prepareImages(api.session,preparedGroup,text=>status.textContent=text,preparing.signal,gate.headers);releaseImages=images.release;gate.check();}
    finally{await gate.release();}
  }
  finally{renewing=false;clearTimeout(renewTimer);await renewal;window.removeEventListener('pagehide',pageHidden);}
  preparing.signal.throwIfAborted();
  const measured=await refreshProbe(p),storage=await storageProbe(preparedGroup,p);if(storage.commit_ms>p.budget.commit_ms)throw new Error('本地事务耗时超过此版本预算，无法开始该组。');
  const canvas=el('canvas'),buttons=group.choices.map(c=>el('button',c));canvas.id='stimulus';const controls=el('div',undefined,'response-buttons');controls.append(...buttons);
  document.body.classList.add('runner-layout');window.scrollTo(0,0);
  const stage=el('div',undefined,'runner-stage'),slot=el('div',undefined,'canvas-slot'),footer=el('div',undefined,'runner-start');slot.append(canvas);stage.append(slot,controls,footer);content.replaceChildren(stage);preventTaskGestures(stage);showResponse(buttons,null);controls.style.setProperty('--response-columns',String(Math.min(buttons.length,Math.max(2,Math.floor(controls.clientWidth/80)))));for(const b of buttons)b.disabled=true;
  const rating=group.rating?ratingControls(group.rating.items??[group.rating.prompt],group.rating.labels,buttons,footer,group.rating.age_prompt):undefined;
  if(rating){stage.classList.add('rating-stage');controls.replaceWith(rating.controls);document.body.classList.add('rating-layout');}
  const measuredGeometry=()=>{const g=geometry(canvas,buttons);if(rating){const r=rating.ranges[0]!.getBoundingClientRect();g.buttons=group.choices.map((choice,i)=>({choice,x:r.x+r.width*i/group.choices.length,y:r.y,width:r.width/group.choices.length,height:r.height}));}return g;};
  const layout=innerWidth>innerHeight?'landscape':'portrait',min=layout==='portrait'?p.layout.portrait_min_width:p.layout.landscape_min_width;
  const width=Math.floor(Math.min(slot.clientWidth,720,slot.clientHeight*p.layout.aspect));if(width<min)throw new Error('屏幕可用区域不足，请在开始前调整方向。');
  canvas.style.width=`${width}px`;canvas.style.height=`${width/p.layout.aspect}px`;canvas.width=Math.round(width*devicePixelRatio);canvas.height=Math.round(width/p.layout.aspect*devicePixelRatio);
  const ctx=canvas.getContext('2d',{alpha:false});if(!ctx)throw new Error('Canvas 不可用。');ctx.fillStyle=p.layout.background;ctx.fillRect(0,0,canvas.width,canvas.height);
  status.textContent=`${p.mode==='TEST_ONLY'?'测试数据 · ':''}资源已校验。请保持页面可见与设备方向，开始后连续完成本组。`;
  let ready:NonNullable<GroupPlan['geometry']>;
  const start=button('开始本组',async()=>{try{
    api!.admission?.check();await api!.stopAdmission();start.style.visibility='hidden';if(document.visibilityState!=='visible')throw new Error('页面当前不可见。');const actual=measuredGeometry();if(JSON.stringify(actual)!==JSON.stringify(ready))throw new Error('准备后布局已变化，请重新准备。');
    const next=await reserve();if(next.variant_id!==reservation.variant_id)throw new Error('预留方案已变化，请重新准备。');reservation=next;
    const permit=await request<NonNullable<LabSession['permit']>>(api!.path('permit'),{request_id:uid(),...api!.fence(),reservation_id:reservation.reservation_id,readiness:{activity_policy:'idle120-offline300-v1',...measured,...storage,download:images.download,layout,geometry:ready,assets:images.hashes,decoded_bytes:images.decoded_bytes,protocol_hash:api!.session.frozen.hash}});
    await api!.refresh();
    if(rating){start.style.visibility='hidden';await runRating(permit.plan,api!,canvas,buttons,rating.ranges,rating.axes,rating.submit,rating.heading,rating.age,images.byAsset,ctx,status,measuredGeometry,()=>{releaseImages?.();releaseImages=null;},returnToPage,content);}
    else {for(const b of buttons)b.disabled=false;await run(permit.plan,canvas,buttons,images.byAsset,ctx);}
  }catch(error){releaseImages?.();releaseImages=null;if(api?.session.permit?.state==='ISSUED')await api.terminate('PREPARATION_INTERRUPTED',{message:String(error)}).catch(()=>{});failure(error);}});footer.append(start);if(rating)start.classList.add('rating-start');
  ready=measuredGeometry();
}
async function run(plan:GroupPlan,canvas:HTMLCanvasElement,buttons:HTMLButtonElement[],images:Map<string,ImageBitmap>,ctx:CanvasRenderingContext2D){
  const a=api!,origin=performance.now(),now=()=>performance.now()-origin,replay=new RunReplay(plan),s=replay.scheduler;
  let pending=false,stopped=false,closing=false,lastFrame=0,feedbackCleared=false;active=true;document.body.classList.add('running');
  const record=(r:RunRecord)=>a.ledger.append(plan.scope,'GROUP_RECORD',{record:{...r,clock_origin:origin}});
  const emit=(r:RunRecord)=>{r.clock_origin=origin;replay.apply(r);void record(r).catch(stop);};
  const clear=()=>{ctx.save();ctx.clearRect(0,0,canvas.width,canvas.height);ctx.fillStyle=a.session.frozen.protocol.layout.background;ctx.fillRect(0,0,canvas.width,canvas.height);ctx.restore();canvas.style.visibility='hidden';};
  async function stop(reason:unknown){if(stopped)return;stopped=true;active=false;cancelAnimationFrame(frameId);clear();remove();s.interrupt(false);
    status.textContent='本组已中断，已保存记录正在补传。';await record({type:'ABORT',at:now(),reason:String(reason).slice(0,150)}).catch(()=>{});
    try{await a.terminate('SOFTWARE_RUN_INTERRUPTED',{reason:String(reason).slice(0,150)});await a.sync();}catch{status.textContent='本组已中断。部分记录仍在本机，恢复页面可继续补传。';}
    releaseImages?.();releaseImages=null;document.body.classList.remove('runner-layout');content.replaceChildren(button('返回核对保存记录',returnToPage));}
  async function stage(){if(stopped||pending||s.executions.size===0||s.queue.some(e=>s.executions.get(e.candidate.instance_id)==='STAGED')||!s.queue.some(e=>s.executions.get(e.candidate.instance_id)==='UNSTARTED'))return;
    try{const t=now(),op=s.stage(uid(),t,'single-next-instance-before-target');pending=true;await record({type:'OP',at:t,operation:op});if(!stopped)emit({type:'COMMIT',at:now(),op_id:op.op_id});}catch(error){await stop(error);}finally{pending=false;}}
  async function afterWindow(root:string){try{if(replay.obligations.has(root)&&!pending){const t=now(),op=s.proposeRepeat(root,uid(),uid(),t,'window-first-legal-answer-or-miss');if(op){pending=true;await record({type:'OP',at:t,operation:op});if(!stopped)emit({type:'COMMIT',at:now(),op_id:op.op_id});pending=false;}}await stage();}catch(error){await stop(error);}}
  function input(r:InputRecord){if(stopped)return;if(closing){void a.ledger.append(`d-${plan.scope}`,'INPUT_DIAGNOSTIC',{reason:'GROUP_CLOSING',...r}).catch(stop);return;}try{
    const mono=r.input_time!,result=[...replay.results.values()].find(v=>mono>=v.onset&&(v.clear===null||mono<v.clear));
    const valid=r.action==='down'&&!!result&&!replay.pointers.has(r.pointer_id!)&&replay.pointers.size===0&&r.choice!==null;
    const old=result?.answer,oldTime=result?.input_time;r.valid=valid;emit(r);
    if(result&&valid&&result.answer!==null){showResponse(buttons,result.answer);status.textContent=`已记录：${result.answer}；请等待下一刺激。`;}
    if(result&&result.clear!==null&&valid&&(oldTime===null||mono<oldTime!)&&old!==result.answer&&(plan.roots.find(t=>t.root_id===result.root_id)!.correct===null||result.correct===true)&&replay.obligations.has(result.root_id)){
      const t=now(),opid=uid(),op=s.correctRoot(result.root_id,t,opid,'verified-earlier-first-input');replay.obligations.delete(result.root_id);if(op)pending=true;
      void record({type:'CORRECTION',at:t,root_id:result.root_id,op_id:opid,evidence:'verified-earlier-first-input',...(op?{operation:op}:{})}).then(async()=>{if(op&&!stopped){emit({type:'COMMIT',at:now(),op_id:op.op_id});pending=false;await stage();}}).catch(stop);
    }
  }catch(error){void stop(error);}}
  const recorder=recordInteractions(document.querySelector('main')!,()=>{const result=[...replay.results.values()].find(v=>v.clear===null);const root=plan.roots.find(t=>t.root_id===result?.root_id);return {instance_id:result?.instance_id,asset_id:root?.asset_id,stimulus_text:root?.text,phase:closing?'closing':'running'};},batch=>a.ledger.interaction(batch),error=>{void stop(error);});
  const change=()=>{if(document.visibilityState!=='visible'||JSON.stringify(geometry(canvas,buttons))!==JSON.stringify(plan.geometry))void stop('VISIBILITY_OR_GEOMETRY_CHANGED');};
  const stopLiveness=taskLiveness(a,reason=>{void stop(reason);});
  const unbindInput=bindRunnerInput(plan,origin,input);
  window.addEventListener('resize',change);document.addEventListener('visibilitychange',change);const visualChange=()=>void stop('VISUAL_VIEWPORT_CHANGED');window.visualViewport?.addEventListener('resize',visualChange);window.visualViewport?.addEventListener('scroll',visualChange);
  const unload=()=>{if(active){s.interrupt(false);void record({type:'ABORT',at:now(),reason:'PAGE_HIDDEN_OR_CLOSED'});}};window.addEventListener('pagehide',unload);
  function remove(keepInputs=false){stopLiveness();recorder.stop();document.body.classList.remove('running');if(!keepInputs)unbindInput();window.removeEventListener('resize',change);document.removeEventListener('visibilitychange',change);window.removeEventListener('pagehide',unload);window.visualViewport?.removeEventListener('resize',visualChange);window.visualViewport?.removeEventListener('scroll',visualChange);}