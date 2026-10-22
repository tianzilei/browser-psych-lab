import type {InteractionBatch,InteractionContext,InteractionSample,ScreenNode} from '../shared/interaction.js';
import {browserState,networkState,type NetworkNavigator} from './browser-state.js';
import {captureScreenNodes} from './screen-capture.js';

// Diagnostics keep all delivered/coalesced samples separate from answer seals.
export function recordInteractions(root:HTMLElement,context:()=>InteractionContext,save:(batch:InteractionBatch)=>Promise<unknown>,fail:(error:unknown)=>void,enabled=true) {
  // Disable capture at the source: no listeners, layout reads, encoding or batches.
  if (!enabled) return {screen:()=>{},flush:()=>Promise.resolve(),stop:()=>Promise.resolve()};
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
  function screen(capture:'explicit'|'microtask'|'animation-frame'='explicit') {
    if (closed) return;
    if (frame!==undefined) {cancelAnimationFrame(frame);frame=undefined;}
    microtask=false;
    const at=performance.now(),c=current(),nodes:ScreenNode[]=[];let truncated=false;
    const state=browserState(),base={context:c,width:state.width,height:state.height,dpr:state.dpr,scroll_x:state.scroll_x,scroll_y:state.scroll_y,
      visual_viewport:state.visual_viewport,background:getComputedStyle(document.documentElement).backgroundColor,render_version:2 as const,language:root.closest('[lang]')?.getAttribute('lang')||document.documentElement.lang||'zh-CN'};
    // A single screen must fit in a diagnostic batch and its 128 KiB ledger
    // envelope. Bound encoded bytes as well as node count; input samples remain intact.
    let snapshotBytes=encoder.encode(JSON.stringify({type:'screen',at,...base,nodes:[],nodes_truncated:false,capture})).length;
    const appendNode=(node:ScreenNode)=>{
      const size=encoder.encode(JSON.stringify(node)).length+(nodes.length?1:0);
      if(nodes.length>=1900||snapshotBytes+size>75000){truncated=true;return false;}
      nodes.push(node);snapshotBytes+=size;return true;
    };
    captureScreenNodes(root,c,appendNode);
    const snapshot={...base,nodes,nodes_truncated:truncated};
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
    // Custom range controls update their value in pointer handlers without
    // dispatching input. Read their settled DOM once per frame while dragging.
    if(e.type==='pointermove'){if(target instanceof HTMLInputElement&&target.type==='range'&&e instanceof PointerEvent&&e.buttons)scheduleScreen(true);}
    else if(e.type!=='wheel')scheduleScreen();
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
  // Rendering can settle after an async save or layout callback, after the
  // original input's microtask snapshot has already been taken.
  const observer=new MutationObserver(()=>scheduleScreen(true));
  observer.observe(root,{subtree:true,childList:true,characterData:true,attributes:true});
  listen(document.fonts,'loadingdone',()=>scheduleScreen(true));
  screen();
  return {screen:()=>screen(),flush,stop:()=>{
    if (!closed) {if (microtask||frame!==undefined||observer.takeRecords().length) screen();closed=true;observer.disconnect();for (const [target,type,handler] of listeners) target.removeEventListener(type,handler,true);}
    return flush();
  }};
}
