import type {InteractionContext,ScreenBox,ScreenNode} from '../shared/interaction.js';

const fontProperties=['color','font-family','font-size','font-weight','font-style','letter-spacing','direction','text-decoration-line','text-decoration-color'] as const;
const sides=['top','right','bottom','left'] as const;
const box=(rect:DOMRect):ScreenBox=>({x:rect.x,y:rect.y,width:rect.width,height:rect.height});
const number=(value:string)=>parseFloat(value)||0;
function intersect(a:ScreenBox,b:ScreenBox):ScreenBox {
  const x=Math.max(a.x,b.x),y=Math.max(a.y,b.y);
  return {x,y,width:Math.max(0,Math.min(a.x+a.width,b.x+b.width)-x),height:Math.max(0,Math.min(a.y+a.height,b.y+b.height)-y)};
}
function font(style:CSSStyleDeclaration){return Object.fromEntries(fontProperties.filter(key=>!['normal','none','ltr','400'].includes(style.getPropertyValue(key))).map(key=>[key,style.getPropertyValue(key)]));}
function decoration(style:CSSStyleDeclaration){
  const result:Record<string,string>={};
  if(style.backgroundColor!=='rgba(0, 0, 0, 0)')result['background-color']=style.backgroundColor;
  const radii=['border-top-left-radius','border-top-right-radius','border-bottom-right-radius','border-bottom-left-radius'];
  if(radii.every(key=>style.getPropertyValue(key)===style.borderTopLeftRadius)){if(number(style.borderTopLeftRadius))result['border-radius']=style.borderTopLeftRadius;}
  else for(const key of radii)result[key]=style.getPropertyValue(key);
  if(number(style.outlineWidth)&&style.outlineStyle!=='none')for(const key of ['outline-width','outline-style','outline-color','outline-offset'])result[key]=style.getPropertyValue(key);
  if(sides.every(side=>['width','style','color'].every(part=>style.getPropertyValue(`border-${side}-${part}`)===style.getPropertyValue(`border-top-${part}`)))){
    if(number(style.borderTopWidth))for(const part of ['width','style','color'])result[`border-${part}`]=style.getPropertyValue(`border-top-${part}`);
  }else for(const side of sides)if(number(style.getPropertyValue(`border-${side}-width`))){
    for(const part of ['width','style','color'])result[`border-${side}-${part}`]=style.getPropertyValue(`border-${side}-${part}`);
  }
  return result;
}

/** Only geometry and paint data, never executable HTML or external CSS. */
export function captureScreenNodes(root:HTMLElement,context:InteractionContext,append:(node:ScreenNode)=>boolean){
  let full=false;
  function emit(node:ScreenNode,clip:ScreenBox,opacity:number){
    if(full)return;
    const visible=intersect(node,clip);if(!visible.width||!visible.height)return;
    if(visible.x!==node.x||visible.y!==node.y||visible.width!==node.width||visible.height!==node.height)node.clip=clip;
    if(opacity!==1)node.style.opacity=String(opacity);
    if(!append(node))full=true;
  }
  function text(child:Text,style:CSSStyleDeclaration,clip:ScreenBox,opacity:number){
    const value=child.textContent??'';if(!value.trim())return;
    const range=document.createRange(),preserve=/pre|break-spaces/.test(style.whiteSpace);
    // Find the browser's line boundaries without one layout query per character.
    let start=0;
    while(start<value.length&&!full){
      let low=start+1,high=value.length;
      while(low<high){const end=Math.ceil((low+high)/2);range.setStart(child,start);range.setEnd(child,end);if(range.getClientRects().length<=1)low=end;else high=end-1;}
      // Never split a surrogate pair.
      if(low<value.length&&/[\uD800-\uDBFF]/.test(value[low-1]!))low++;
      range.setStart(child,start);range.setEnd(child,low);
      const rect=range.getBoundingClientRect(),content=value.slice(start,low);
      emit({...box(rect),tag:'text',text:preserve?content:content.replace(/\s+/g,' '),style:font(style)},clip,opacity);
      start=low;
    }
  }
  function pseudo(element:HTMLElement,selector:string,bounds:ScreenBox,clip:ScreenBox,opacity:number){
    const style=getComputedStyle(element,selector);
    if(style.content==='none'||style.content==='normal'||style.display==='none'||style.visibility!=='visible')return;
    const left=number(style.left),top=number(style.top),right=number(style.right),bottom=number(style.bottom);
    const parent=getComputedStyle(element),originX=bounds.x+number(parent.borderLeftWidth),originY=bounds.y+number(parent.borderTopWidth);
    const parentWidth=element.clientWidth,parentHeight=element.clientHeight;
    let width=style.width==='auto'?parentWidth-left-right:number(style.width),height=style.height==='auto'?parentHeight-top-bottom:number(style.height);
    if(style.boxSizing!=='border-box'){width+=number(style.paddingLeft)+number(style.paddingRight)+number(style.borderLeftWidth)+number(style.borderRightWidth);height+=number(style.paddingTop)+number(style.paddingBottom)+number(style.borderTopWidth)+number(style.borderBottomWidth);}
    const x=originX+(style.left==='auto'?parentWidth-right-width:left),y=originY+(style.top==='auto'?parentHeight-bottom-height:top);
    const paint={...decoration(style),...font(style)};
    if(style.transform!=='none'){paint.transform=style.transform;paint['transform-origin']=style.transformOrigin;}
    emit({x,y,width,height,tag:'pseudo',text:style.content.slice(1,-1),style:paint},clip,opacity*Number(style.opacity));
  }
  function visit(element:HTMLElement,parentClip:ScreenBox,parentOpacity:number){
    if(full)return;
    const style=getComputedStyle(element),opacity=parentOpacity*Number(style.opacity);
    if(style.display==='none'||opacity===0)return;
    const bounds=box(element.getBoundingClientRect());
    let childClip=parentClip;
    if([style.overflowX,style.overflowY].some(value=>/hidden|clip|scroll|auto/.test(value))){
      const inner={x:bounds.x+element.clientLeft,y:bounds.y+element.clientTop,width:element.clientWidth,height:element.clientHeight};
      childClip=intersect(parentClip,{x:/visible/.test(style.overflowX)?parentClip.x:inner.x,y:/visible/.test(style.overflowY)?parentClip.y:inner.y,width:/visible/.test(style.overflowX)?parentClip.width:inner.width,height:/visible/.test(style.overflowY)?parentClip.height:inner.height});
    }
    if(style.visibility==='visible'&&bounds.width&&bounds.height){
      const node:ScreenNode={...bounds,tag:element.tagName.toLowerCase(),text:'',style:decoration(style)};
      if(element instanceof HTMLInputElement){
        Object.assign(node.style,font(style));for(const key of ['padding-top','padding-right','padding-bottom','padding-left','text-align','line-height'])node.style[key]=style.getPropertyValue(key);
        node.tag=element.type==='range'?'range':'input';node.input_type=element.type;node.value=element.value;node.checked=element.checked;node.disabled=element.disabled;node.placeholder=element.placeholder;
        if(element.placeholder)node.style['placeholder-color']=getComputedStyle(element,'::placeholder').color;
        if(element.type==='range'){Object.assign(node.style,{min:element.min||'0',max:element.max||'100',answered:element.dataset.answered??'true',thumb:style.getPropertyValue('--q-thumb')||'22px',track:style.getPropertyValue('--q-track')||'3px'});}
      }else if(element instanceof HTMLTextAreaElement||element instanceof HTMLSelectElement){
        Object.assign(node.style,font(style));for(const key of ['padding-top','padding-right','padding-bottom','padding-left','text-align','line-height'])node.style[key]=style.getPropertyValue(key);
        node.value=element instanceof HTMLSelectElement?element.selectedOptions[0]?.textContent??'':element.value;node.disabled=element.disabled;
      }else if(element instanceof HTMLButtonElement)node.disabled=element.disabled;
      if(element instanceof HTMLCanvasElement){node.asset_id=context.asset_id;node.text=element.dataset.replayText??context.stimulus_text??'';node.canvas_width=element.width;node.canvas_height=element.height;}
      emit(node,parentClip,opacity);
      pseudo(element,'::before',bounds,childClip,opacity);
    }
    for(const child of element.childNodes){
      if(full)break;
      if(child instanceof HTMLElement)visit(child,childClip,opacity);
      else if(child instanceof Text&&style.visibility==='visible')text(child,style,childClip,opacity);
    }
    if(style.visibility==='visible')pseudo(element,'::after',bounds,childClip,opacity);
  }
  // Ancestors outside the recording root can also hide or clip its contents.
  let clip:ScreenBox={x:0,y:0,width:innerWidth,height:innerHeight},opacity=1;
  for(let ancestor=root.parentElement;ancestor;ancestor=ancestor.parentElement){
    const style=getComputedStyle(ancestor);opacity*=Number(style.opacity);if(style.display==='none')return;
    // Root/body overflow is propagated to the viewport; a fixed participant
    // surface may leave their own DOMRects empty while remaining visible.
    if(ancestor!==document.body&&ancestor!==document.documentElement&&/hidden|clip|scroll|auto/.test(style.overflowX+' '+style.overflowY))clip=intersect(clip,box(ancestor.getBoundingClientRect()));
  }
  visit(root,clip,opacity);
}
