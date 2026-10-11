全项目设计讨论，传输段 37，源码主题：实验执行与准备（源包 12/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

      ...(event instanceof KeyboardEvent?{key_code:event.code}:{button:0})};
  }
  const pointer=(event:PointerEvent)=>{
    if(event.type==='pointermove'){
      if(primary.has(event.pointerId)&&(event.buttons&1)===0){primary.delete(event.pointerId);receive(normalized(event,null,event.pointerId,'cancel'));}
      return;
    }
    if(event.type==='pointerdown'&&event.button!==0)return;
    if(event.type==='pointerdown')primary.add(event.pointerId);
    if(event.type==='pointerup'&&event.button!==0){if(primary.has(event.pointerId)){primary.delete(event.pointerId);receive(normalized(event,null,event.pointerId,'cancel'));}return;}
    const choice=plan.geometry?.buttons.find(b=>event.clientX>=b.x&&event.clientX<b.x+b.width&&event.clientY>=b.y&&event.clientY<b.y+b.height)?.choice??null;
    if(choice!==null)event.preventDefault();
    receive(normalized(event,choice,event.pointerId,event.type==='pointerdown'?'down':event.type==='pointerup'?'up':'cancel'));
    if(event.type!=='pointerdown')primary.delete(event.pointerId);
  };
  const keyboard=(event:KeyboardEvent)=>{
    const index=keys.findIndex(([,code])=>code===event.code);if(index<0)return;
    event.preventDefault();if(event.type==='keydown'&&(event.repeat||event.isComposing||event.altKey||event.ctrlKey||event.metaKey))return;
    receive(normalized(event,keys[index]![0],-index-1,event.type==='keydown'?'down':'up'));
  };
  for(const type of ['pointerdown','pointerup','pointercancel','pointermove'])window.addEventListener(type,pointer as EventListener,{passive:false});
  for(const type of ['keydown','keyup'])window.addEventListener(type,keyboard as EventListener);
  return ()=>{
    for(const type of ['pointerdown','pointerup','pointercancel','pointermove'])window.removeEventListener(type,pointer as EventListener);
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

```

### src/web/stimulus.ts L1–L14

```
export function drawTextStimulus(ctx:CanvasRenderingContext2D,canvas:HTMLCanvasElement,text:string,background:string){
  const rgb=background.slice(1).match(/../g)!.map(n=>parseInt(n,16));
  ctx.fillStyle=.2126*rgb[0]!+.7152*rgb[1]!+.0722*rgb[2]!<128?'#ffffff':'#000000';
  ctx.textAlign='center';ctx.textBaseline='middle';
  // Plain text only. Wrap by Unicode character, fitting both width and height.
  let size=Math.min(canvas.width/10,canvas.height/5),lines:string[]=[];
  for(let attempt=0;attempt<60;attempt++){
    ctx.font=`${size}px system-ui,sans-serif`;lines=[];
    for(const paragraph of text.split('\n')){let line='';for(const char of paragraph){if(line&&ctx.measureText(line+char).width>canvas.width*.9){lines.push(line);line='';}line+=char;}lines.push(line);}
    if(lines.length*size*1.4<=canvas.height*.9)break;size*=.9;
  }
  lines.forEach((line,i)=>ctx.fillText(line,canvas.width/2,canvas.height/2+(i-(lines.length-1)/2)*size*1.4));
}

```