import {el} from './dom.js';
import type {InteractionBatch,InteractionSample} from '../shared/interaction.js';
import {resolvePhoto,type PhotoIdentity} from '../shared/photo-identity.js';
import {isReplayScreen} from '../shared/replay-recording.js';
export type ReplayItem={time:number;sample:InteractionBatch['samples'][number]};
const actionLabels:Record<string,string>={screen:'页面快照',pointerdown:'按下指针',pointerup:'松开指针',pointermove:'移动指针',pointercancel:'取消指针',keydown:'按下按键',keyup:'松开按键',input:'输入',change:'更改',beforeinput:'输入前',compositionstart:'开始组字',compositionend:'完成组字',focus:'获得焦点',blur:'离开焦点',scroll:'滚动',state:'浏览器状态'};
export function mountReplayPlayer(options:{photos?:PhotoIdentity[]|undefined;items:ReplayItem[];canvas:HTMLCanvasElement;controls:HTMLElement;status:HTMLElement;details:HTMLElement;assetURL:(id:string)=>string}){
  const {items,canvas,controls,status,details,assetURL}=options,ctx=canvas.getContext('2d')!,images=new Map<string,HTMLImageElement>(),screenAt:number[]=[];
  let current=0,playing=false,last=0,clock=0,frame=0,disposed=false,screen=-1;
  items.sort((a,b)=>a.time-b.time);for(const [i,item]of items.entries()){if(isReplayScreen(item.sample))screen=i;screenAt.push(screen);}
  const play=el('button','播放'),previous=el('button','上一个动作'),next=el('button','下一个动作'),slider=el('input');slider.type='range';slider.min='0';slider.max=String(Math.max(0,items.length-1));slider.step='1';slider.setAttribute('aria-label','动作时间轴');controls.replaceChildren(previous,play,next,slider);
  canvas.style.maxWidth='100%';canvas.style.border='1px solid #888';canvas.hidden=screen<0;
  function update(){previous.disabled=!items.length||current===0;next.disabled=!items.length||current===items.length-1;play.disabled=slider.disabled=screen<0;}
  function stop(){playing=false;cancelAnimationFrame(frame);play.textContent='播放';}
  function draw(){
    if(disposed||!items.length)return;const item=items[current]!,snapshot=items[screenAt[current]??-1]?.sample;
    const screen=isReplayScreen(snapshot)?snapshot:undefined;ctx.clearRect(0,0,canvas.width,canvas.height);
    if(screen){
      if(canvas.width!==screen.width)canvas.width=screen.width;if(canvas.height!==screen.height)canvas.height=screen.height;
      ctx.fillStyle=screen.background||'#e5e5e5';ctx.fillRect(0,0,canvas.width,canvas.height);
      for(const n of screen.nodes){
        const s=n.style;
        if(n.tag==='canvas'&&n.asset_id){
          let image=images.get(n.asset_id);if(!image){const url=assetURL(n.asset_id);if(!url)continue;image=new Image();image.onload=()=>draw();image.src=url;images.set(n.asset_id,image);}
          if(image.complete&&image.naturalWidth){const scale=Math.min(n.width/image.naturalWidth,n.height/image.naturalHeight);ctx.drawImage(image,n.x+(n.width-image.naturalWidth*scale)/2,n.y+(n.height-image.naturalHeight*scale)/2,image.naturalWidth*scale,image.naturalHeight*scale);}continue;
        }
        ctx.fillStyle=s['background-color']??'transparent';ctx.fillRect(n.x,n.y,n.width,n.height);
        if(parseFloat(s['border-top-width']??'0')>0){ctx.strokeStyle=s['border-top-color']??'#000';ctx.strokeRect(n.x,n.y,n.width,n.height);}
        ctx.fillStyle=s.color??'#000';ctx.font=`${s['font-weight']??'400'} ${s['font-size']??'16px'} ${s['font-family']??'sans-serif'}`;ctx.textBaseline='top';
        if(n.tag==='range'){
          ctx.fillRect(n.x,n.y+n.height/2,n.width,2);
          if(s.answered==='true'){const fraction=(Number(n.value)-Number(s.min))/(Number(s.max)-Number(s.min));ctx.beginPath();ctx.arc(n.x+11+fraction*(n.width-22),n.y+n.height/2,11,0,Math.PI*2);ctx.fill();}
        }else if(n.text||n.value)ctx.fillText(n.text||n.value||'',n.x,n.y,Math.max(1,n.width));
      }
      const path=items.slice(Math.max(0,current-200),current+1).filter(i=>i.time>=item.time-1000&&i.sample.type!=='screen'&&Number.isFinite((i.sample as InteractionSample).x)&&Number.isFinite((i.sample as InteractionSample).y));
      ctx.strokeStyle='#d23b24';ctx.lineWidth=2;ctx.beginPath();for(const [i,p]of path.entries()){const s=p.sample as InteractionSample;if(i===0)ctx.moveTo(s.x!,s.y!);else ctx.lineTo(s.x!,s.y!);}ctx.stroke();
      const action=item.sample as InteractionSample;if(Number.isFinite(action.x)&&Number.isFinite(action.y)){ctx.fillStyle='#d23b24';ctx.beginPath();ctx.arc(action.x!,action.y!,8,0,Math.PI*2);ctx.fill();}
    }
    slider.value=String(current);const elapsed=((item.time-items[0]!.time)/1000).toFixed(3);slider.setAttribute('aria-valuetext',`动作 ${current+1}/${items.length}，${elapsed} 秒`);
    const photo=resolvePhoto(options.photos??[],item.sample.context as Record<string,unknown>);status.textContent=`动作 ${current+1}/${items.length} · ${elapsed} 秒 · ${actionLabels[item.sample.type]??item.sample.type}${photo?` · 照片 ${photo.photo_filename??photo.photo_id}（第 ${photo.photo_order} 张）`:''}`;details.textContent=JSON.stringify({...item.sample,...(photo?{photo}: {})},null,2);update();
  }
  function tick(now:number){if(!playing||disposed)return;clock+=now-last;last=now;const before=current;while(current<items.length-1&&items[current+1]!.time-items[0]!.time<=clock)current++;if(before!==current)draw();if(current===items.length-1)stop();else frame=requestAnimationFrame(tick);}
  play.onclick=()=>{if(playing){stop();return;}if(!items.length||screen<0)return;if(current===items.length-1)current=0;playing=true;play.textContent='暂停';clock=items[current]!.time-items[0]!.time;last=performance.now();draw();frame=requestAnimationFrame(tick);};
  previous.onclick=()=>{stop();current=Math.max(0,current-1);draw();};next.onclick=()=>{stop();current=Math.min(items.length-1,current+1);draw();};slider.oninput=()=>{stop();current=Number(slider.value);draw();};
  update();if(screen>=0)draw();else status.textContent='此答卷没有可回放的界面记录。';
  return ()=>{disposed=true;stop();for(const image of images.values())image.onload=null;};
}
