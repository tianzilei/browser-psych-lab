当前交互源码第 5 段。连续片段，请与前后段拼接阅读。本阶段只回复 ACK_INTERACTION_05。
ndomUUID(),session_id:s.session_id,version_id:s.frozen.version_id,protocol_hash:s.frozen.hash,
      writer_id:this.writer,writer_epoch:s.writer_epoch,scope,sequence:head.sequence,previous:head.previous,clock_epoch:this.clock,time_ms:performance.now(),kind,payload};
    const raw=JSON.stringify(e),bytes=encoder.encode(raw);if(bytes.length>128*1024)throw new Error('EVENT_BUDGET_EXCEEDED');
    const hash=await sha256(bytes),row:EventRow={event_id:e.event_id,hash,raw,session_id:s.session_id,scope,sequence:e.sequence,receipt:null,byte_length:bytes.length};
    const tx=this.db.transaction(['events','outbox','meta'],'readwrite',{durability:'strict'});
    try{const current=(await tx.objectStore('meta').get(this.version))!;const actual=current.heads[scope]??{sequence:0,previous:null};if(actual.sequence!==head.sequence)throw new Error('LOCAL_WRITER_FORK');
      await tx.objectStore('events').add(row);await tx.objectStore('outbox').add(row);current.heads[scope]={sequence:e.sequence+1,previous:{event_id:e.event_id,hash}};
      if(pageValues)current.page_values[scope]=pageValues;
      if(pendingPath){const old=await tx.objectStore('events').index('scope').getAll(scope);current.pending[scope]={request_id:crypto.randomUUID(),manifest:{manifest_id:crypto.randomUUID(),scope,path:pendingPath,events:old.filter(v=>v.session_id===s.session_id).sort((a,b)=>a.sequence-b.sequence).map(({event_id,hash})=>({event_id,hash}))},seal:null};}
      await tx.objectStore('meta').put(current,this.version);await tx.done;return row;
    }catch(error){try{tx.abort();}catch{}await tx.done.catch(()=>{});throw error;}
  });}
  closeScope(scope:string,path:string[]){return this.serialized(async()=>{
    const m=await this.state();if(m.pending[scope])return m.pending[scope]!;const rows=await this.db.getAllFromIndex('events','scope',scope);const pending:PendingSeal={request_id:crypto.randomUUID(),manifest:{manifest_id:crypto.randomUUID(),scope,path,events:rows.filter(e=>e.session_id===m.session!.session_id).sort((a,b)=>a.sequence-b.sequence).map(({event_id,hash})=>({event_id,hash}))},seal:null};
    const tx=this.db.transaction('meta','readwrite',{durability:'strict'});const current=(await tx.store.get(this.version))!;current.pending[scope]=pending;await tx.store.put(current,this.version);await tx.done;return pending;
  });}
  async batch(){const m=await this.state();const tx=this.db.transaction('outbox');let cursor=await tx.store.index('session').openCursor(m.session!.session_id);const batch:EventRow[]=[];let size=0;
    while(cursor&&batch.length<16){const bytes=cursor.value.byte_length??encoder.encode(cursor.value.raw).length;if(size+bytes>256*1024&&batch.length)break;batch.push(cursor.value);size+=bytes;cursor=await cursor.continue();}await tx.done;return batch;}
  acknowledge(receipts:Receipt[]){return this.serialized(async()=>{const tx=this.db.transaction(['events','outbox'],'readwrite',{durability:'strict'});try{for(const r of receipts){const e=await tx.objectStore('events').get(r.event_id);if(!e||e.hash!==r.hash||e.scope!==r.scope||r.custody!=='PERSISTED'||!r.receipt_id||!['ACCEPTED','RECEIVED_PENDING','QUARANTINED'].includes(r.disposition))throw new Error('CUSTODY_MISMATCH');e.receipt=r;await tx.objectStore('events').put(e);await tx.objectStore('outbox').delete(e.event_id);}await tx.done;}catch(error){try{tx.abort();}catch{}await tx.done.catch(()=>{});throw error;}});}
  seal(scope:string,seal:Seal){return this.serialized(async()=>{const m=await this.state();const p=m.pending[scope];if(!p||seal.status!=='SEALED'||seal.algorithm!=='exact-set-and-chain-v1'||manifestText(seal.manifest)!==manifestText(p.manifest)||seal.manifest_hash!==await sha256(manifestText(p.manifest)))throw new Error('SEAL_MISMATCH');
    const tx=this.db.transaction('meta','readwrite',{durability:'strict'});const latest=(await tx.store.get(this.version))!;latest.pending[scope]!.seal=seal;await tx.store.put(latest,this.version);await tx.done;});}
  async drain(){await this.chain;if(this.failure)throw this.failure;}
  interaction(batch:import('../shared/interaction.js').InteractionBatch){const scope=`d-ui-${this.clock}-${Math.floor(this.diagnosticCount++/4000)}`;return this.append(scope,'INPUT_DIAGNOSTIC',{interaction:batch});}
  termination(reason:string,evidence:unknown){return this.serialized(async()=>{const m=await this.state();m.termination??={request_id:crypto.randomUUID(),reason,evidence};const tx=this.db.transaction('meta','readwrite',{durability:'strict'});await tx.store.put(m,this.version);await tx.done;return m.termination;});}
  reconciliation(scope:string,path:string[]){return this.serialized(async()=>{const m=await this.state(),head=m.heads[scope]!,key=`${scope}-${head.sequence}`;m.reconciliations??={};
    if(!m.reconciliations[key]){const events=(await this.db.getAllFromIndex('events','scope',scope)).filter(e=>e.session_id===m.session!.session_id).sort((a,b)=>a.sequence-b.sequence);m.reconciliations[key]={request_id:crypto.randomUUID(),manifest:{manifest_id:crypto.randomUUID(),scope,events:events.map(({event_id,hash})=>({event_id,hash})),path},unknown:m.pending[scope]?.seal?[]:['unfinished-or-unknown-position']};const tx=this.db.transaction('meta','readwrite',{durability:'strict'});await tx.store.put(m,this.version);await tx.done;}return m.reconciliations[key]!;});}
}

```


=== FILE src/web/dom.ts (complete source; may continue in next chunk) ===
```
import {wait,overloadDelay} from './wait.js';
import {prepareJsonPost} from './json-transport.js';
import {RequestError} from './request-error.js';
export function el<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,cls?:string){const element=document.createElement(tag);if(text!==undefined)element.textContent=text;if(cls)element.className=cls;return element;}
export function button(label:string,action:()=>void|Promise<void>,cls?:string){const b=el('button',label,cls);b.type='button';b.addEventListener('click',()=>{b.disabled=true;void Promise.resolve().then(action).finally(()=>{b.disabled=false;});});return b;}
export function field(label:string,value:string,type='text'){const box=el('label');box.append(el('span',label));const input=el('input');input.type=type;input.value=value;box.append(input);return {box,input};}
export function area(label:string,value:string,rows=3){const box=el('label');box.append(el('span',label));const input=el('textarea');input.value=value;input.rows=rows;box.append(input);return {box,input};}
export function select(label:string,values:{value:string;label:string}[],value:string){const box=el('label');box.append(el('span',label));const input=el('select');for(const v of values){const option=el('option',v.label);option.value=v.value;input.append(option);}input.value=value;box.append(input);return {box,input};}
export function uid(){return crypto.randomUUID();}
export async function request<T>(url:string,data?:unknown,csrf?:string,signal?:AbortSignal):Promise<T>{
  const body=data===undefined?undefined:JSON.stringify(data),started=performance.now();
  const prepared=body===undefined?undefined:await prepareJsonPost(url,body);
  const heavy=/\/seal$|\/api\/lab\/jobs\/(?:backup|export|rebuild)$|\/api\/lab\/jobs\/[^/]+\/recover$|\/api\/lab\/assets\/[^/]+\/delete$/.test(url);
  const budget=heavy?180000:60000,attemptBudget=heavy?150000:15000;
  for(let attempt=0;;attempt++){
    signal?.throwIfAborted();const remaining=budget-(performance.now()-started);
    if(remaining<=0)throw new DOMException('Request time budget exceeded','TimeoutError');
    const timeout=AbortSignal.timeout(Math.max(1,Math.floor(Math.min(attemptBudget,remaining))));
    const response=await fetch(url,{...(prepared===undefined?{}:{method:'POST',headers:{...prepared.headers,...(csrf?{'X-CSRF-Token':csrf}:{})},body:prepared.body}),signal:signal?AbortSignal.any([signal,timeout]):timeout});
    // Only explicit overload responses are retried. Reuse the exact serialized
    // request and its request/event identities; an ambiguous timeout surfaces.
    if((response.status===503||response.status===429)&&attempt<7){
      await response.body?.cancel();await wait(Math.min(overloadDelay(response,attempt),Math.max(0,budget-(performance.now()-started))),signal);continue;
    }
    const result=await response.json() as {code?:string;details?:unknown};
    if(!response.ok)throw new RequestError(result.code??'REQUEST_FAILED',response.status,result.details);return result as T;
  }
}

```


=== FILE src/web/request-error.ts (complete source; may continue in next chunk) ===
```
/** Keep transport codes available for diagnostics without using them as UI copy. */
export class RequestError extends Error {
  constructor(readonly code:string,readonly status:number,readonly details?:unknown){
    super(`${code}${details==null?'':`：${JSON.stringify(details)}`}`);
    this.name='RequestError';
  }
}

```


=== FILE src/web/run.ts (complete source; may continue in next chunk) ===
```
import {taskLiveness} from './task-liveness.js';
import {TASK_ACTIVITY_POLICY} from '../shared/task-policy.js';
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
import {ui,participantError,errorDetails,interruptionMessage} from './participant-ui.js';
import {RunReplay} from '../shared/run-replay.js';
import {ratingControls,runRating} from './rating-run.js';
import type {GroupPlan,InputRecord,RunRecord,LabSession,GroupReservation} from '../shared/lab-contract.js';
import type {ScheduleAudit} from '../shared/scheduler.js';
const version=new URLSearchParams(location.search).get('version')??'',writer=sessionStorage.getItem(`lab-writer-${version}`)??uid();
sessionStorage.setItem(`lab-writer-${version}`,writer);
const content=document.querySelector<HTMLDivElement>('#content')!,status=document.querySelector<HTMLParagraphElement>('#status')!,title=document.querySelector<HTMLHeadingElement>('#title')!;
let api:ParticipantAPI|null=null,active=false,owned=false,releaseImages:(()=>void)|null=null,frameId=0;
const returnToPage=()=>{location.href=`/participate.html?version=${version}`;};
function failure(error:unknown){document.body.classList.remove('runner-layout','rating-layout','running');status.textContent=participantError(error,'prepare');const actions=el('div',undefined,'recovery-actions');actions.append(button(ui.returnSurvey,returnToPage,'primary'),errorDetails(error));content.replaceChildren(actions);}
function geometry(canvas:HTMLCanvasElement,buttons:HTMLButtonElement[]):NonNullable<GroupPlan['geometry']>{const rect=(e:HTMLElement)=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};};return {viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},canvas:rect(canvas),buttons:buttons.map(b=>({choice:b.textContent!,...rect(b)}))};}
async function prepare(){
  api=await ParticipantAPI.open(version,writer);await api.refresh();applyParticipantBackground(api.session.frozen.protocol.layout.background);if(api.session.state==='COMPLETED'||api.session.state==='TERMINATED'||api.session.permit?.state==='ISSUED'){returnToPage();return;}
  const preparing=new AbortController(),pageHidden=()=>preparing.abort(new Error('准备页面已关闭。'));
  window.addEventListener('pagehide',pageHidden,{once:true});
  status.textContent='正在准备任务…';content.replaceChildren(button(ui.cancel,()=>{cancelAdmission(preparing);returnToPage();}));
  await api.enter(preparing.signal,text=>status.textContent=text,error=>{preparing.abort(error);releaseImages?.();releaseImages=null;failure(error);});
  await api.claim();if(api.session.page_index<api.session.frozen.protocol.pages.length){returnToPage();return;}
  const reserve=(signal?:AbortSignal)=>request<GroupReservation>(api!.path('reserve'),{request_id:uid(),...api!.fence()},undefined,signal);
  let reservation=await reserve();
  const p=api.session.frozen.protocol,variant=p.variants.find(v=>v.id===reservation.variant_id)!,group=p.groups.find(g=>g.id===variant.group_order[api!.session.group_index]);
  if(!group){returnToPage();return;}title.textContent=group.title;status.textContent='正在准备任务…';
  const preparedGroup=reservation.selection?{...group,trials:reservation.selection.roots}:group;
  content.replaceChildren(button(ui.cancel,()=>{cancelAdmission(preparing);returnToPage();}));
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
  const measured=await refreshProbe(p),storage=await storageProbe(preparedGroup,p);if(storage.commit_ms>p.budget.commit_ms)throw new Error('此设备的保存速度未满