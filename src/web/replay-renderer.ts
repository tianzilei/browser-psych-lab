import type {InteractionScreen,ScreenBox,ScreenNode} from '../shared/interaction.js';
import {drawTextStimulus} from './stimulus.js';

const number=(value:string|undefined,fallback=0)=>Number.isFinite(parseFloat(value??''))?parseFloat(value!):fallback;
function rounded(ctx:CanvasRenderingContext2D,box:ScreenBox,style:Record<string,string>,inset=0){
  const radius=(key:string)=>{const raw=style[key]??style['border-radius']??'0';return raw.includes('%')?Math.min(box.width,box.height)*number(raw)/100:number(raw);};
  const radii=['border-top-left-radius','border-top-right-radius','border-bottom-right-radius','border-bottom-left-radius'].map(key=>Math.max(0,radius(key)-inset));
  ctx.beginPath();ctx.roundRect(box.x+inset,box.y+inset,Math.max(0,box.width-inset*2),Math.max(0,box.height-inset*2),radii);
}
function setFont(ctx:CanvasRenderingContext2D,style:Record<string,string>){
  ctx.font=`${style['font-style']??'normal'} ${style['font-weight']??'400'} ${style['font-size']??'16px'} ${style['font-family']??'sans-serif'}`;
  ctx.fillStyle=style.color??'#000';ctx.textAlign='left';ctx.textBaseline='alphabetic';ctx.direction=style.direction==='rtl'?'rtl':'ltr';ctx.letterSpacing=style['letter-spacing']==='normal'?'0px':style['letter-spacing']??'0px';
}
function drawText(ctx:CanvasRenderingContext2D,text:string,x:number,y:number,height:number,style:Record<string,string>){
  setFont(ctx,style);const metrics=ctx.measureText(text),ascent=metrics.fontBoundingBoxAscent,descent=metrics.fontBoundingBoxDescent;
  const baseline=y+(height-ascent-descent)/2+ascent;
  ctx.fillText(text,ctx.direction==='rtl'?x+metrics.width:x,baseline);
  if(style['text-decoration-line']?.includes('underline')){ctx.strokeStyle=style['text-decoration-color']??style.color??'#000';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x,baseline+2);ctx.lineTo(x+metrics.width,baseline+2);ctx.stroke();}
}
function legacyText(ctx:CanvasRenderingContext2D,node:ScreenNode){
  const {style:s}=node,text=node.text||node.value||'';setFont(ctx,s);
  const padding=node.tag==='text'?0:number(s.padding),x=node.x+padding,width=Math.max(1,node.width-padding*2),lineHeight=number(s['line-height'],number(s['font-size'],16)*1.2);
  let line='',row=0;
  const render=()=>{const measured=ctx.measureText(line).width,align=s['text-align'];drawText(ctx,line,x+(align==='center'?(width-measured)/2:align==='right'?width-measured:0),node.y+padding+row++*lineHeight,lineHeight,s);line='';};
  for(const char of text){if(char==='\n'){render();continue;}if(line&&ctx.measureText(line+char).width>width)render();line+=char;}if(line)render();
}
function control(ctx:CanvasRenderingContext2D,node:ScreenNode){
  const {style:s,x,y,width,height}=node;
  if(node.tag==='range'){
    const thumb=number(s.thumb,22),track=number(s.track,3),min=number(s.min),max=number(s.max,100),fraction=Math.max(0,Math.min(1,(number(node.value)-min)/Math.max(1,max-min)));
    ctx.fillStyle=s.color??'#000';ctx.fillRect(x,y+(height-track)/2,width,track);
    if(s.answered!=='false'){ctx.beginPath();ctx.arc(x+thumb/2+fraction*Math.max(0,width-thumb),y+height/2,thumb/2,0,Math.PI*2);ctx.fill();}return;
  }
  if(node.input_type==='radio'||node.input_type==='checkbox'){
    const size=Math.min(width,height),cx=x+width/2,cy=y+height/2;ctx.strokeStyle=s.color??'#000';ctx.lineWidth=1;
    ctx.beginPath();if(node.input_type==='radio')ctx.arc(cx,cy,size/2-1,0,Math.PI*2);else ctx.roundRect(cx-size/2+1,cy-size/2+1,size-2,size-2,2);ctx.stroke();
    if(node.checked){ctx.fillStyle=s.color??'#000';if(node.input_type==='radio'){ctx.beginPath();ctx.arc(cx,cy,size/4,0,Math.PI*2);ctx.fill();}else{ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(cx-size*.3,cy);ctx.lineTo(cx-size*.05,cy+size*.25);ctx.lineTo(cx+size*.3,cy-size*.25);ctx.stroke();}}return;
  }
  const padding=(s.padding??'0').split(/\s+/),left=number(s['padding-left'],number(padding[3]??padding[1]??padding[0]))+number(s['border-left-width']??s['border-width']),right=number(s['padding-right'],number(padding[1]??padding[0]))+number(s['border-right-width']??s['border-width']);
  const top=number(s['padding-top'],number(padding[0]))+number(s['border-top-width']??s['border-width']),text=node.value||node.placeholder||'',paint=!node.value&&node.placeholder?{...s,color:s['placeholder-color']??s.color??'#000'}:s;
  ctx.save();ctx.beginPath();ctx.rect(x+left,y,width-left-right,height);ctx.clip();setFont(ctx,s);
  const measured=ctx.measureText(text).width,align=s['text-align'],contentWidth=width-left-right;
  const lineHeight=number(s['line-height'],number(s['font-size'],16)*1.2),startY=node.tag==='textarea'?y+top:y+(height-lineHeight)/2;
  for(const [index,line]of text.split('\n').entries())drawText(ctx,line,x+left+(align==='center'?(contentWidth-measured)/2:align==='right'?contentWidth-measured:0),startY+index*lineHeight,lineHeight,paint);
  ctx.restore();
}
function paintBox(ctx:CanvasRenderingContext2D,node:ScreenNode,legacy:boolean){
  const {style:s,x,y,width,height}=node;
  if(s['background-color']){ctx.fillStyle=s['background-color'];rounded(ctx,node,s);ctx.fill();}
  const border=number(s['border-width']??(legacy?s['border-top-width']:undefined));
  if(border){ctx.lineWidth=border;ctx.strokeStyle=s['border-color']??s['border-top-color']??'#000';if((s['border-style']??s['border-top-style'])==='dashed')ctx.setLineDash([border*3,border*2]);rounded(ctx,node,s,border/2);ctx.stroke();ctx.setLineDash([]);}
  else for(const [side,from,to]of [
    ['top',[x,y],[x+width,y]],['right',[x+width,y],[x+width,y+height]],['bottom',[x,y+height],[x+width,y+height]],['left',[x,y],[x,y+height]],
  ] as const){const w=number(s[`border-${side}-width`]);if(!w)continue;ctx.lineWidth=w;ctx.strokeStyle=s[`border-${side}-color`]??'#000';ctx.beginPath();ctx.moveTo(...from);ctx.lineTo(...to);ctx.stroke();}
  const outline=number(s['outline-width']);if(outline){const gap=number(s['outline-offset'])+outline/2;ctx.lineWidth=outline;ctx.strokeStyle=s['outline-color']??'#000';rounded(ctx,{x:x-gap,y:y-gap,width:width+gap*2,height:height+gap*2},s);ctx.stroke();}
}

/** Paint a snapshot once; the player composites only its pointer layer per frame. */
export function renderReplayScreen(ctx:CanvasRenderingContext2D,screen:InteractionScreen,image:(id:string)=>HTMLImageElement|undefined){
  // Detached cache canvases otherwise use the OS fallback language, which can
  // select different CJK glyphs even for the same system-ui font string.
  ctx.canvas.lang=screen.language||document.documentElement.lang||'zh-CN';
  ctx.fillStyle=screen.background||'#e5e5e5';ctx.fillRect(0,0,screen.width,screen.height);
  for(const node of screen.nodes){
    if(node.x>=screen.width||node.y>=screen.height||node.x+node.width<=0||node.y+node.height<=0)continue;
    const s=node.style;ctx.save();ctx.globalAlpha=Math.max(0,Math.min(1,number(s.opacity,1)));
    if(node.clip&&[node.clip.x,node.clip.y,node.clip.width,node.clip.height].every(Number.isFinite)){ctx.beginPath();ctx.rect(node.clip.x,node.clip.y,node.clip.width,node.clip.height);ctx.clip();}
    if(s.transform){try{const matrix=new DOMMatrix(s.transform),origin=(s['transform-origin']??'0 0').split(' '),ox=node.x+number(origin[0]),oy=node.y+number(origin[1]);ctx.translate(ox,oy);ctx.transform(matrix.a,matrix.b,matrix.c,matrix.d,matrix.e,matrix.f);ctx.translate(-ox,-oy);}catch{/* Keep malformed legacy style data local to this node. */}}
    paintBox(ctx,node,screen.render_version!==2);
    if(node.tag==='canvas'){
      const border=number(s['border-width']??s['border-top-width']),bounds={x:node.x+border,y:node.y+border,width:Math.max(0,node.width-border*2),height:Math.max(0,node.height-border*2)};
      if(node.text){
        const width=node.canvas_width??bounds.width,height=node.canvas_height??bounds.height;
        ctx.save();ctx.translate(bounds.x,bounds.y);ctx.scale(bounds.width/Math.max(1,width),bounds.height/Math.max(1,height));drawTextStimulus(ctx,{width,height},node.text,screen.background);ctx.restore();
      }else if(node.asset_id){const asset=image(node.asset_id);if(asset?.naturalWidth){const scale=Math.min(bounds.width/asset.naturalWidth,bounds.height/asset.naturalHeight),width=asset.naturalWidth*scale,height=asset.naturalHeight*scale;ctx.drawImage(asset,bounds.x+(bounds.width-width)/2,bounds.y+(bounds.height-height)/2,width,height);}}
    }else if(['range','input','textarea','select'].includes(node.tag))control(ctx,node);
    else if(node.text||node.value){if(screen.render_version===2)drawText(ctx,node.text||node.value||'',node.x,node.y,node.height,s);else legacyText(ctx,node);}
    ctx.restore();
  }
}
