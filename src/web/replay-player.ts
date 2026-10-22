import {el} from './dom.js';
import type {InteractionBatch,InteractionSample,InteractionScreen} from '../shared/interaction.js';
import {resolvePhoto,type PhotoIdentity} from '../shared/photo-identity.js';
import {isReplayScreen} from '../shared/replay-recording.js';
import {renderReplayScreen} from './replay-renderer.js';
export type ReplayItem={time:number;sample:InteractionBatch['samples'][number]};
const actionLabels:Record<string,string>={screen:'页面快照',pointerdown:'按下指针',pointerup:'松开指针',pointermove:'移动指针',pointercancel:'取消指针',keydown:'按下按键',keyup:'松开按键',input:'输入',change:'更改',beforeinput:'输入前',compositionstart:'开始组字',compositionend:'完成组字',focus:'获得焦点',blur:'离开焦点',scroll:'滚动',state:'浏览器状态'};
function upperBound(values:number[],value:number){let low=0,high=values.length;while(low<high){const middle=(low+high)>>>1;if(values[middle]!<=value)low=middle+1;else high=middle;}return low;}
const contextKey=(sample:ReplayItem['sample'])=>JSON.stringify([sample.context.page_id,sample.context.instance_id,sample.context.question_id,sample.context.phase]);

export function mountReplayPlayer(options:{photos?:PhotoIdentity[]|undefined;items:ReplayItem[];canvas:HTMLCanvasElement;controls:HTMLElement;status:HTMLElement;details:HTMLElement;assetURL:(id:string)=>string}){
  const {items,canvas,controls,status,details,assetURL}=options,ctx=canvas.getContext('2d')!;
  const background=document.createElement('canvas'),backgroundContext=background.getContext('2d')!,images=new Map<string,HTMLImageElement>(),decoded=new WeakSet<HTMLImageElement>();
  const screenAt:number[]=[],pointerIndices:number[]=[],pointerTimes:number[]=[],times:number[]=[];
  const assets:{index:number;ids:string[]}[]=[],assetTimes:number[]=[];let priorAssets='';
  let current=0,playing=false,last=0,startedClock=0,clock=0,frame=0,disposed=false,screen=-1,paintedScreen=-2,dirty=true,lastUI=-Infinity,detailsAt=-1,pixelRatio=1;
  items.sort((a,b)=>a.time-b.time);
  for(const [index,item]of items.entries()){
    if(isReplayScreen(item.sample)){
      screen=index;const ids=[...new Set(item.sample.nodes.flatMap(node=>node.asset_id?[node.asset_id]:[]))],key=ids.join(',');
      if(ids.length&&key!==priorAssets){assets.push({index,ids});assetTimes.push(index);priorAssets=key;}
    }screenAt.push(screen);times.push(item.time);
    if(item.sample.type!=='screen'&&Number.isFinite((item.sample as InteractionSample).x)&&Number.isFinite((item.sample as InteractionSample).y)){pointerIndices.push(index);pointerTimes.push(item.time);}
  }
  const first=items[0]?.time??0,duration=Math.max(0,(items.at(-1)?.time??first)-first);
  const play=el('button','播放'),previous=el('button','上一个动作'),next=el('button','下一个动作'),slider=el('input');
  slider.type='range';slider.min='0';slider.max=String(duration);slider.step='any';slider.setAttribute('aria-label','动作时间轴');controls.replaceChildren(previous,play,next,slider);
  play.className='primary';canvas.style.maxWidth='100%';canvas.style.height='auto';canvas.style.border='1px solid var(--control-border,#787878)';canvas.hidden=screen<0;
  function update(){previous.disabled=!items.length||current===0;next.disabled=!items.length||current===items.length-1;play.disabled=slider.disabled=screen<0;}
  function stop(){playing=false;cancelAnimationFrame(frame);play.textContent='播放';}
  function snapshot(){const index=screenAt[current]??-1;return index<0?undefined:items[index]!.sample as InteractionScreen;}
  function image(id:string){
    const existing=images.get(id);if(existing){images.delete(id);images.set(id,existing);return decoded.has(existing)?existing:undefined;}
    const url=assetURL(id);if(!url)return;
    if(images.size>=8){
      const visible=new Set(snapshot()?.nodes.flatMap(node=>node.asset_id?[node.asset_id]:[])??[]),oldest=[...images.keys()].find(key=>!visible.has(key));
      if(oldest===undefined)return;images.get(oldest)!.onload=null;images.delete(oldest);
    }
    const asset=new Image();asset.decoding='async';images.set(id,asset);
    asset.onload=()=>{void asset.decode().then(()=>{
      if(disposed||images.get(id)!==asset)return;decoded.add(asset);
      if(snapshot()?.nodes.some(node=>node.asset_id===id)){dirty=true;if(!playing)draw(true);}
    }).catch(()=>{});};
    asset.src=url;return;
  }
  function prefetch(){
    const keep=new Set<string>(),position=Math.max(0,upperBound(assetTimes,screenAt[current]??-1)-1);
    for(const entry of assets.slice(position,position+4))for(const id of entry.ids){if(keep.size>=4)break;keep.add(id);image(id);}
  }
  function paintBackground(){
    const sample=snapshot(),index=screenAt[current]??-1;
    if(index!==paintedScreen){dirty=true;paintedScreen=index;prefetch();}
    if(!dirty)return;dirty=false;
    const width=sample?.width??canvas.width,height=sample?.height??canvas.height;
    pixelRatio=Math.max(.1,Math.min(devicePixelRatio||1,2,Math.sqrt(8000000/Math.max(1,width*height))));
    const pixelsWide=Math.max(1,Math.round(width*pixelRatio)),pixelsHigh=Math.max(1,Math.round(height*pixelRatio));
    if(background.width!==pixelsWide||background.height!==pixelsHigh){background.width=canvas.width=pixelsWide;background.height=canvas.height=pixelsHigh;}
    canvas.style.width=`${width}px`;
    backgroundContext.setTransform(pixelRatio,0,0,pixelRatio,0,0);backgroundContext.clearRect(0,0,width,height);
    if(sample)renderReplayScreen(backgroundContext,sample,image);
  }
  function pointers(){
    const end=upperBound(pointerTimes,first+clock),start=Math.max(upperBound(pointerTimes,first+clock-1000),end-2048);
    const paths=new Map<string,{x:number;y:number;at:number;type:string}>(),key=snapshot()?contextKey(snapshot()!):'';
    ctx.strokeStyle='#d23b24';ctx.fillStyle='#d23b24';ctx.lineWidth=2;
    for(let i=start;i<end;i++){
      const entry=items[pointerIndices[i]!]!,sample=entry.sample as InteractionSample;
      if(contextKey(sample)!==key)continue;
      const id=`${sample.pointer_type??'mouse'}:${sample.pointer_id??0}`,prior=paths.get(id),x=sample.x!,y=sample.y!;
      if(prior&&entry.time-prior.at<200&&sample.type!=='pointerdown'&&!['pointerup','pointercancel'].includes(prior.type)){
        ctx.globalAlpha=Math.max(.1,1-(first+clock-entry.time)/1000);ctx.beginPath();ctx.moveTo(prior.x,prior.y);ctx.lineTo(x,y);ctx.stroke();
      }
      paths.set(id,{x,y,at:entry.time,type:sample.type});
    }
    for(const point of paths.values()){
      ctx.globalAlpha=Math.max(0,1-(first+clock-point.at)/1000);ctx.beginPath();ctx.arc(point.x,point.y,point.type==='pointerdown'?8:5,0,Math.PI*2);ctx.fill();
    }
    ctx.globalAlpha=1;
  }
  function draw(forceUI=false){
    if(disposed||!items.length)return;paintBackground();
    ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(background,0,0);ctx.setTransform(pixelRatio,0,0,pixelRatio,0,0);pointers();
    const now=performance.now();slider.value=String(clock);
    if(forceUI||now-lastUI>=200){
      lastUI=now;const item=items[current]!,elapsed=(clock/1000).toFixed(3),photo=resolvePhoto(options.photos??[],item.sample.context as Record<string,unknown>);
      slider.setAttribute('aria-valuetext',`动作 ${current+1}/${items.length}，${elapsed} 秒`);
      status.textContent=`动作 ${current+1}/${items.length} · ${elapsed} 秒 · ${actionLabels[item.sample.type]??item.sample.type}${photo?` · 照片 ${photo.photo_filename??photo.photo_id}（第 ${photo.photo_order} 张）`:''}${snapshot()?.nodes_truncated?' · 界面快照已截断':''}`;
      if(current!==detailsAt){details.textContent=JSON.stringify({...item.sample,...(photo?{photo}:{})},null,2);detailsAt=current;}update();
    }
  }
  function tick(now:number){
    if(!playing||disposed)return;clock=Math.min(duration,startedClock+now-last);current=Math.max(0,upperBound(times,first+clock)-1);draw();
    if(clock>=duration){stop();draw(true);}else frame=requestAnimationFrame(tick);
  }
  play.onclick=()=>{
    if(playing){stop();draw(true);return;}if(!items.length||screen<0)return;
    if(clock>=duration){current=0;clock=0;}playing=true;play.textContent='暂停';last=performance.now();startedClock=clock;draw(true);frame=requestAnimationFrame(tick);
  };
  function seek(index:number){stop();current=index;clock=items[current]!.time-first;draw(true);}
  previous.onclick=()=>seek(Math.max(0,current-1));next.onclick=()=>seek(Math.min(items.length-1,current+1));
  slider.oninput=()=>{stop();clock=Math.max(0,Math.min(duration,Number(slider.value)));current=Math.max(0,upperBound(times,first+clock)-1);draw(true);};
  update();if(screen>=0)draw(true);else status.textContent='此答卷没有可回放的界面记录。';
  return ()=>{disposed=true;stop();for(const asset of images.values())asset.onload=null;images.clear();background.width=background.height=1;};
}
