当前交互源码第 9 段。连续片段，请与前后段拼接阅读。本阶段只回复 ACK_INTERACTION_09。
IDLE_TIMEOUT');
    else if(performance.now()-lastAck>=policy.connection_timeout_ms)fail('CONNECTION_TIMEOUT');
  },policy.client_check_interval_ms);
  const renew=setInterval(()=>{
    if(closed||inFlight||performance.now()-last>=policy.idle_timeout_ms)return;
    inFlight=true;
    void fetch(api.path('activity'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(api.fence()),signal:AbortSignal.timeout(policy.request_timeout_ms)}).then(async response=>{
      if(closed)return;
      if(response.ok){
        const value=await response.json() as {status:string};
        if(closed)return;
        if(value.status==='ACTIVE')lastAck=performance.now();else fail('SERVER_TASK_TERMINATED');
      }else if([401,409].includes(response.status))fail('SERVER_TASK_TERMINATED');
    }).catch(()=>{}).finally(()=>{inFlight=false;});
  },policy.renewal_interval_ms);
  return stop;
}

```


=== FILE src/web/interaction-recorder.ts (complete source; may continue in next chunk) ===
```
import type {InteractionBatch,InteractionContext,InteractionSample,ScreenNode} from '../shared/interaction.js';
import {browserState,networkState,type NetworkNavigator} from './browser-state.js';

// Diagnostics keep all delivered/coalesced samples separate from answer seals.
export function recordInteractions(root:HTMLElement,context:()=>InteractionContext,save:(batch:InteractionBatch)=>Promise<unknown>,fail:(error:unknown)=>void) {
  const encoder = new TextEncoder(), listeners:[EventTarget,string,EventListener][] = [];
  let samples:InteractionBatch['samples'] = [], bytes = 0, closed = false, pending = Promise.resolve();
  let timer:ReturnType<typeof setTimeout>|undefined, frame:number|undefined, microtask = false;
  let onset = performance.now(), position = '', lastScreen = '';
  const box = (element:Element) => {const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
  function flush() {
    clearTimeout(timer);timer=undefined;
    if (!samples.length) return pending;
    const batch:InteractionBatch={schema:'interaction-v1',time_origin:performance.timeOrigin,samples};samples=[];bytes=0;
    // Keep earlier outstanding saves in the drain barrier, without a second unbounded queue.
    const saved=save(batch).then(()=>{}).catch(fail);
    pending=Promise.all([pending,saved]).then(()=>{});return pending;
  }
  function add(sample:InteractionBatch['samples'][number]) {
    if (closed) return;
    const size=encoder.encode(JSON.stringify(sample)).length;
    if (bytes+size>90000) void flush();
    samples.push(sample);bytes+=size;
    if (samples.length>=64) void flush();else timer??=setTimeout(()=>{void flush();},100);
  }
  function current() {
    const c=context(),key=JSON.stringify([c.page_id,c.question_id,c.instance_id,c.item,c.phase]);
    if (key!==position) {position=key;onset=performance.now();}return c;
  }
  function identify(node:Element) {
    if (node.id) return `#${node.id}`;
    const path:string[]=[];let e:Element|null=node;
    while (e&&e!==root) {path.unshift(`${e.tagName.toLowerCase()}:nth-child(${Array.from(e.parentElement?.children??[]).indexOf(e)+1})`);e=e.parentElement;}return path.join('>');
  }
  const styles=['color','background-color','border-top-width','border-top-style','border-top-color','border-radius','font-family','font-size','font-weight','line-height','text-align','padding','opacity','white-space'] as const;
  function screen(capture:'explicit'|'microtask'|'animation-frame'='explicit') {
    if (closed) return;
    if (frame!==undefined) {cancelAnimationFrame(frame);frame=undefined;}
    microtask=false;
    const at=performance.now(),c=current(),nodes:ScreenNode[]=[];let truncated=false;
    elements: for (const e of root.querySelectorAll<HTMLElement>('*')) {
      const r=box(e),computed=getComputedStyle(e);
      if (!r.width||!r.height||computed.visibility!=='visible'||computed.display==='none'||e.closest('[style*="opacity: 0"]')) continue;
      const style=Object.fromEntries(styles.map(k=>[k,computed.getPropertyValue(k)]));
      const node:ScreenNode={...r,tag:e.tagName.toLowerCase(),text:'',style};
      if (e instanceof HTMLInputElement) {
        node.value=e.value;node.tag=e.type==='range'?'range':'input';node.disabled=e.disabled;node.checked=e.checked;
        if (e.type==='range') {node.style.min=e.min;node.style.max=e.max;node.style.answered=e.dataset.answered??'false';}
      } else if (e instanceof HTMLTextAreaElement||e instanceof HTMLSelectElement) {node.value=e.value;node.disabled=e.disabled;}
      if (e instanceof HTMLButtonElement) node.disabled=e.disabled;
      if (e instanceof HTMLCanvasElement) {node.asset_id=c.asset_id;node.text=c.stimulus_text??'';}
      if (nodes.length>=1900) {truncated=true;break;}nodes.push(node);
      for (const child of e.childNodes) if (child.nodeType===Node.TEXT_NODE&&child.textContent?.trim()) {
        const range=document.createRange();range.selectNodeContents(child);const rect=range.getBoundingClientRect();
        if (nodes.length>=1900) {truncated=true;break elements;}nodes.push({x:rect.x,y:rect.y,width:rect.width,height:rect.height,tag:'text',text:child.textContent,style});
      }
    }
    const state=browserState(),snapshot={context:c,width:state.width,height:state.height,dpr:state.dpr,scroll_x:state.scroll_x,scroll_y:state.scroll_y,
      visual_viewport:state.visual_viewport,background:getComputedStyle(document.documentElement).backgroundColor,nodes,nodes_truncated:truncated};
    const signature=JSON.stringify(snapshot);if (signature===lastScreen) return;lastScreen=signature;
    add({type:'screen',at,...snapshot,capture});
  }
  function scheduleScreen(deferFrame=false) {
    if (closed) return;
    if (deferFrame) {frame??=requestAnimationFrame(()=>{frame=undefined;screen('animation-frame');});return;}
    if (microtask) return;microtask=true;
    queueMicrotask(()=>{if (microtask&&!closed) screen('microtask');});
  }
  const timestamp=(e:Event) => e.timeStamp<=performance.now()+1?e.timeStamp:e.timeStamp-performance.timeOrigin;
  function event(e:Event) {
    const target=e.target instanceof Element?e.target:root,c=current(),targetBox=box(target),targetName=identify(target);
    const coalesced=e instanceof PointerEvent&&e.type==='pointermove'?e.getCoalescedEvents?.():undefined;
    const list=coalesced?.length?coalesced:[e];
    for (const item of list) {
      const p=item instanceof PointerEvent?item:null,k=item instanceof KeyboardEvent?item:null,m=item instanceof MouseEvent?item:null;
      const at=timestamp(item),sample:InteractionSample={type:e.type,at,raw_timestamp:item.timeStamp,rt_ms:Math.max(0,at-onset),
        context:c,target:targetName,box:targetBox,x:m?.clientX??null,y:m?.clientY??null,trusted:e.isTrusted,
        ...(m?{page_x:m.pageX,page_y:m.pageY,movement_x:m.movementX,movement_y:m.movementY,button:m.button,buttons:m.buttons,detail:m.detail}:{}),
        ...(m||k?{alt_key:(m??k)!.altKey,ctrl_key:(m??k)!.ctrlKey,meta_key:(m??k)!.metaKey,shift_key:(m??k)!.shiftKey}:{}),
        ...(p?{pointer_id:p.pointerId,pointer_type:p.pointerType,pressure:p.pressure,width:p.width,height:p.height,tilt_x:p.tiltX,tilt_y:p.tiltY,
          twist:p.twist,tangential_pressure:p.tangentialPressure,is_primary:p.isPrimary,coalesced:!!coalesced?.length}:{}),
        ...(k?{key:k.key,code:k.code,repeat:k.repeat,location:k.location,is_composing:k.isComposing}:{}),
        ...(target instanceof HTMLInputElement||target instanceof HTMLTextAreaElement||target instanceof HTMLSelectElement?{value:target.value}:{}),
        ...(e instanceof InputEvent?{input_type:e.inputType,data:e.data,is_composing:e.isComposing}:{}),
        ...(e instanceof CompositionEvent?{data:e.data}:{}),
        ...(e instanceof WheelEvent?{delta_x:e.deltaX,delta_y:e.deltaY,delta_z:e.deltaZ,delta_mode:e.deltaMode}:{})};
      add(sample);
    }
    if (!['pointermove','wheel'].includes(e.type)) scheduleScreen();
  }
  function stateEvent(type:string,e:Event,layout=false,deferFrame=false) {
    const at=timestamp(e);
    add({type,at,raw_timestamp:e.timeStamp,context:current(),target:type,box:null,x:null,y:null,trusted:e.isTrusted,
      state:{...browserState(),...(type==='connectionchange'?{network:networkState()}:{}),
        ...(e instanceof PageTransitionEvent?{persisted:e.persisted}:{})}});
    if (layout) {if (deferFrame) scheduleScreen(true);else screen();}
    if (['pagehide','freeze','visibilitychange'].includes(type)) void flush();
  }
  function listen(target:EventTarget,type:string,handler:EventListener) {
    target.addEventListener(type,handler,{capture:true,passive:true});listeners.push([target,type,handler]);
  }
  for (const type of ['pointerdown','pointermove','pointerup','pointercancel','gotpointercapture','lostpointercapture','click','dblclick','contextmenu','wheel',
    'keydown','keyup','beforeinput','input','change','focusin','focusout','compositionstart','compositionupdate','compositionend','copy','cut','paste']) listen(root,type,event);
  for (const type of ['resize','scroll','focus','blur','online','offline','pagehide','pageshow'])
    listen(window,type,e=>stateEvent(type,e,['resize','scroll','focus','blur'].includes(type),type==='scroll'));
  for (const type of ['visibilitychange','fullscreenchange','freeze','resume']) listen(document,type,e=>stateEvent(type,e,true));
  if (visualViewport) for (const type of ['resize','scroll']) listen(visualViewport,type,e=>stateEvent(`visualviewport.${type}`,e,true,type==='scroll'));
  if (window.screen.orientation) listen(window.screen.orientation,'change',e=>stateEvent('orientationchange',e,true));
  const connection=(navigator as NetworkNavigator).connection;if (connection) listen(connection,'change',e=>stateEvent('connectionchange',e));
  screen();
  return {screen:()=>screen(),flush,stop:()=>{
    if (!closed) {if (microtask||frame!==undefined) screen();closed=true;for (const [target,type,handler] of listeners) target.removeEventListener(type,handler,true);}
    return flush();
  }};
}

```


=== FILE src/web/browser-state.ts (complete source; may continue in next chunk) ===
```
export type NetworkNavigator = Navigator & {connection?:EventTarget & {
  effectiveType?:string;type?:string;downlink?:number;downlinkMax?:number;rtt?:number;saveData?:boolean;
}};
export const finite = (value:number|undefined) => value !== undefined && Number.isFinite(value) ? value : null;
export function networkState() {
  const n = navigator as NetworkNavigator, c = n.connection;
  return {online:n.onLine, connection:c ? {type:c.type ?? null, effective_type:c.effectiveType ?? null,
    downlink_mbps:finite(c.downlink), downlink_max_mbps:finite(c.downlinkMax), rtt_ms:finite(c.rtt), save_data:c.saveData ?? null} : null};
}
export function browserState() {
  const v = visualViewport;
  return {visibility:document.visibilityState, focused:document.hasFocus(),
    fullscreen:!!document.fullscreenElement, picture_in_picture:!!document.pictureInPictureElement,
    online:navigator.onLine, width:innerWidth, height:innerHeight, dpr:devicePixelRatio,
    scroll_x:scrollX, scroll_y:scrollY, orientation_type:screen.orientation?.type ?? null,
    orientation_angle:screen.orientation?.angle ?? null,
    visual_viewport:v ? {x:v.offsetLeft,y:v.offsetTop,width:v.width,height:v.height,scale:v.scale} : null};
}

```


=== FILE src/shared/protocol.ts (complete source; may continue in next chunk) ===
```
import { ContractError, id, object } from './contract.js';
import {parseTiming,parseTimingDefaults,parseOrdering,orderTrials} from './trial-design.js';
import {parseSampling,type Sampling} from './trial-sampling.js';
export const LAB_SCHEMA = 'lab-events-v1';
export const RUNNER_VERSION = 'canvas-v1';
// UTF-16 character budgets. Keep these unchanged for existing frozen protocols.
export const TEXT_LIMITS = { title: 200, question: 1000, instruction: 8000, choice: 200, answer: 4000, endpoint: 40 } as const;
export type Condition = { op: 'eq' | 'neq' | 'includes'; question: string; axis?: string; value: string | number }
  | { op: 'and' | 'or'; args: Condition[] } | { op: 'not'; arg: Condition };
export type AxisAnswer = Record<string, number | null>;
export type Answer = string | string[] | number | AxisAnswer | null;
export type InputPreset = 'digits' | 'integer' | 'decimal' | 'letters' | 'alphanumeric' | 'chinese' | 'phone_cn' | 'email';
export type InputMatch =
  | { kind: 'preset'; preset: InputPreset; message?: string }
  | { kind: 'regex'; pattern: string; flags?: string; message?: string };
export interface ScaleAxis {id:string;title:string;min:number;max:number;min_label:string;max_label:string;labels:string[]}
export interface Question { id: string; type: 'single' | 'multi' | 'scale' | 'scales' | 'text'; title: string;
  required: boolean; axes?: ScaleAxis[]; choices?: string[]; min?: number; max?: number; min_label?: string; max_label?: string; labels?: string[]; max_length?: number; input_purpose?: 'personal'; input_match?: InputMatch; condition?: Condition }
export interface Page { id: string; title: string; instruction: string; condition?: Condition; questions: Question[] }
export interface TimingSpec {base: number; jitter: number}
export interface TimingDefaults {stimulus_ms?: TimingSpec; isi_ms?: TimingSpec; feedback_ms?: TimingSpec}
export interface Ordering {mode: 'fixed' | 'shuffle' | 'category' | 'balanced'; max_run?: number}
export interface Feedback {correct: string; incorrect: string; miss: string; neutral: string}
export interface Rating {prompt:string;labels:string[];items?:string[];age_prompt?:string;age_min?:number;age_max?:number}
export interface Trial { root_id: string; asset_id?: string; text?: string; category?: string; image_ms: number; isi_ms: number; correct: string | null;
  timing?: TimingDefaults; timing_general?: (keyof TimingDefaults)[]; feedback_ms?: number }
export interface Group { id: string; title: string; choices: string[]; repeats: number; trials: Trial[];
  rating?: