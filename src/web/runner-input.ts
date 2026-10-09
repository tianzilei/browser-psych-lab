import type {GroupPlan,InputRecord} from '../shared/lab-contract.js';

// Keep listeners through ISI so a held press cannot answer the next stimulus.
export function bindRunnerInput(plan:GroupPlan,origin:number,receive:(record:InputRecord)=>void){
  const keys=plan.choices.map(choice=>[choice,plan.response_keys?.[choice]] as const);
  function normalized(event:PointerEvent|KeyboardEvent,choice:string|null,pointer:number,action:InputRecord['action']):InputRecord{
    const at=performance.now()-origin,raw=event.timeStamp;
    return {type:'INPUT',at,input_time:raw<=performance.now()+1?raw-origin:raw-performance.timeOrigin-origin,
      pointer_id:pointer,action,valid:false,choice,raw_timestamp:raw,time_origin:performance.timeOrigin,
      pointer_type:event instanceof KeyboardEvent?'keyboard':event.pointerType,
      x:event instanceof PointerEvent?event.clientX:0,y:event instanceof PointerEvent?event.clientY:0,
      ...(event instanceof KeyboardEvent?{key_code:event.code}:{button:0})};
  }
  const pointer=(event:PointerEvent)=>{
    if(event.type!=='pointercancel'&&event.button!==0)return;
    const choice=plan.geometry?.buttons.find(b=>event.clientX>=b.x&&event.clientX<b.x+b.width&&event.clientY>=b.y&&event.clientY<b.y+b.height)?.choice??null;
    if(choice!==null)event.preventDefault();
    receive(normalized(event,choice,event.pointerId,event.type==='pointerdown'?'down':event.type==='pointerup'?'up':'cancel'));
  };
  const keyboard=(event:KeyboardEvent)=>{
    const index=keys.findIndex(([,code])=>code===event.code);if(index<0)return;
    event.preventDefault();if(event.type==='keydown'&&(event.repeat||event.isComposing||event.altKey||event.ctrlKey||event.metaKey))return;
    receive(normalized(event,keys[index]![0],-index-1,event.type==='keydown'?'down':'up'));
  };
  for(const type of ['pointerdown','pointerup','pointercancel'])window.addEventListener(type,pointer as EventListener,{passive:false});
  for(const type of ['keydown','keyup'])window.addEventListener(type,keyboard as EventListener);
  return ()=>{
    for(const type of ['pointerdown','pointerup','pointercancel'])window.removeEventListener(type,pointer as EventListener);
    for(const type of ['keydown','keyup'])window.removeEventListener(type,keyboard as EventListener);
  };
}
export function preventTaskGestures(element:HTMLElement){
  const suppress=(event:Event)=>event.preventDefault();
  for(const type of ['contextmenu','selectstart','dragstart'])element.addEventListener(type,suppress);
  return ()=>{for(const type of ['contextmenu','selectstart','dragstart'])element.removeEventListener(type,suppress);};
}
export function showResponse(buttons:HTMLButtonElement[],choice:string|null){
  for(const b of buttons)b.setAttribute('aria-pressed',String(b.textContent===choice));
}
