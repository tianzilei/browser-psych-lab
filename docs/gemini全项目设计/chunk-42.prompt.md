全项目设计讨论，传输段 42，源码主题：页面交互和管理（源包 14/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

### src/web/replay.ts L1–L16

```
import './style.css';
import {el,request} from './dom.js';
import type {InteractionBatch,InteractionSample,InteractionScreen} from '../shared/interaction.js';
const sid=new URLSearchParams(location.search).get('session')??'',status=document.querySelector('#status')!,details=document.querySelector('#details')!,canvas=document.querySelector<HTMLCanvasElement>('#replay')!,ctx=canvas.getContext('2d')!,controls=document.querySelector('#controls')!;
canvas.style.maxWidth='100%';canvas.style.border='1px solid #888';
type Item={time:number;sample:InteractionBatch['samples'][number]};const items:Item[]=[],images=new Map<string,HTMLImageElement>();let current=0,playing=false,last=0,clock=0,frame=0;
const play=el('button','播放'),previous=el('button','上一个动作'),next=el('button','下一个动作'),slider=el('input');slider.type='range';slider.min='0';slider.step='1';slider.setAttribute('aria-label','动作时间轴');controls.append(previous,play,next,slider);
async function load(){let after=0;for(;;){const result=await request<{batches:(InteractionBatch&{cursor:number})[];next:number;more:boolean}>(`/api/lab/sessions/${sid}/actions?after=${after}`);for(const b of result.batches)for(const s of b.samples)items.push({time:b.time_origin+s.at,sample:s});if(!result.more)break;after=result.next;}items.sort((a,b)=>a.time-b.time);slider.max=String(Math.max(0,items.length-1));if(!items.length){status.textContent='此答卷没有操作回放记录。记录功能部署后的新操作才可回放。';return;}draw();}
function draw(){const item=items[current]!;let screen:InteractionScreen|undefined;for(let i=current;i>=0;i--)if(items[i]!.sample.type==='screen'){screen=items[i]!.sample as InteractionScreen;break;}if(screen){canvas.width=screen.width;canvas.height=screen.height;ctx.fillStyle=screen.background||'#e5e5e5';ctx.fillRect(0,0,canvas.width,canvas.height);for(const n of screen.nodes){const s=n.style;if(n.tag==='canvas'&&n.asset_id){let image=images.get(n.asset_id);if(!image){image=new Image();image.src=`/api/lab/assets/${n.asset_id}`;image.onload=()=>{if(!playing)draw();};images.set(n.asset_id,image);}if(image.complete&&image.naturalWidth){const scale=Math.min(n.width/image.naturalWidth,n.height/image.naturalHeight);ctx.drawImage(image,n.x+(n.width-image.naturalWidth*scale)/2,n.y+(n.height-image.naturalHeight*scale)/2,image.naturalWidth*scale,image.naturalHeight*scale);}continue;}ctx.fillStyle=s['background-color']??'transparent';ctx.fillRect(n.x,n.y,n.width,n.height);if(parseFloat(s['border-top-width']??'0')>0){ctx.strokeStyle=s['border-top-color']??'#000';ctx.strokeRect(n.x,n.y,n.width,n.height);}ctx.fillStyle=s.color??'#000';ctx.font=`${s['font-weight']??'400'} ${s['font-size']??'16px'} ${s['font-family']??'sans-serif'}`;ctx.textBaseline='top';if(n.tag==='range'){ctx.fillRect(n.x,n.y+n.height/2,n.width,2);if(s.answered==='true'){const fraction=(Number(n.value)-Number(s.min))/(Number(s.max)-Number(s.min));ctx.beginPath();ctx.arc(n.x+11+fraction*(n.width-22),n.y+n.height/2,11,0,Math.PI*2);ctx.fill();}}else if(n.text||n.value)ctx.fillText(n.text||n.value||'',n.x,n.y,Math.max(1,n.width));}
    const path=items.slice(Math.max(0,current-200),current+1).filter(i=>i.time>=item.time-1000&&i.sample.type!=='screen'&&(i.sample as InteractionSample).x!==null);ctx.strokeStyle='#d23b24';ctx.lineWidth=2;ctx.beginPath();for(const [i,p]of path.entries()){const s=p.sample as InteractionSample;if(i===0)ctx.moveTo(s.x!,s.y!);else ctx.lineTo(s.x!,s.y!);}ctx.stroke();const action=item.sample as InteractionSample;if(action.x!==null&&action.x!==undefined){ctx.fillStyle='#d23b24';ctx.beginPath();ctx.arc(action.x,action.y!,8,0,Math.PI*2);ctx.fill();}}
  slider.value=String(current);status.textContent=`动作 ${current+1}/${items.length} · ${((item.time-items[0]!.time)/1000).toFixed(3)} 秒 · ${item.sample.type}`;details.textContent=JSON.stringify(item.sample,null,2);}
function stop(){playing=false;cancelAnimationFrame(frame);play.textContent='播放';}
function tick(now:number){if(!playing)return;clock+=now-last;last=now;while(current<items.length-1&&items[current+1]!.time-items[0]!.time<=clock)current++;draw();if(current===items.length-1)stop();else frame=requestAnimationFrame(tick);}
play.onclick=()=>{if(playing){stop();return;}if(!items.length)return;if(current===items.length-1)current=0;playing=true;play.textContent='暂停';clock=items[current]!.time-items[0]!.time;last=performance.now();frame=requestAnimationFrame(tick);};previous.onclick=()=>{stop();current=Math.max(0,current-1);if(items.length)draw();};next.onclick=()=>{stop();current=Math.min(items.length-1,current+1);if(items.length)draw();};slider.oninput=()=>{stop();current=Number(slider.value);draw();};
void load().catch(error=>{status.textContent=String(error);});

```

### src/web/run.html L1–L2

```
<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>图片任务</title></head><body><main id="app"><header><h1 id="title">准备图片任务</h1><p id="status" role="status"></p></header><div id="content"></div></main><script type="module" src="./run.ts"></script></body></html>

```

### src/web/runner.css L1–L40

```
html:has(body.runner-layout),body.runner-layout { height: 100%; overflow: hidden; }
body.runner-layout main { height: var(--viewport-height,100dvh); min-height: 0; overflow: hidden; }
body.runner-layout #status { min-height: 4.8em; }
.runner-stage { min-height: 0; min-width: 0; width: min(100%,960px); height: 100%; justify-self: center; display: grid; grid-template-rows: minmax(0,1fr) auto minmax(48px,auto); gap: 12px; }
.canvas-slot { display: grid; place-items: center; min-height: 0; min-width: 0; overflow: hidden; }
#stimulus { max-width: 100%; max-height: 100%; }
.response-buttons { display: grid; grid-template-columns: repeat(var(--response-columns,2),minmax(0,1fr)); gap: 8px; width: 100%; touch-action: none; }
.response-buttons button { min-width: 0; min-height: 56px; user-select: none; touch-action: none; }
.runner-start { display: grid; grid-template-columns: 1fr; }
.runner-stage { user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; touch-action: none; }
.response-buttons button[aria-pressed=true] { color: var(--background,#e5e5e5); background: var(--foreground,#000000); }
body.running #stimulus,
body.running .response-buttons button { transition: none !important; animation: none !important; }
body.rating-layout #status { min-height: 2.4em; }
.rating-stage { gap: 8px; grid-template-rows: minmax(0,1fr) 190px 48px; }
.rating-stage .canvas-slot { align-items: start; }
.rating-controls { display: grid; gap: 6px; }
.rating-controls p { font-size: 16px; }
.rating-controls .response-buttons { gap: 6px; }
.rating-controls .response-buttons button { min-height: 48px; padding: 8px; }
.rating-age { width: 100%; min-height: 48px; font: inherit; padding: 8px; }
.rating-stage .runner-start { position: relative; height: 48px; display: grid; grid-template-rows: 48px; }
.rating-stage .runner-start button { width: 100%; }
.rating-controls { position: relative; display: grid; grid-template-rows: 36px 146px; gap: 8px; min-height: 0; }
.rating-controls > p { grid-row: 1; }
.rating-controls > .rating-axis,.rating-age-row { grid-row: 2; grid-column: 1; }
.rating-start { position: absolute; inset: 0; }
.rating-ticks { display: flex; justify-content: space-between; margin: -6px 11px 0; font-size: 12px; }
.rating-ticks span[data-selected=true] { font-weight: 700; }
.rating-axis { min-height: 0; padding: 8px 12px; border-radius: 12px; }
.rating-axis[hidden] { display: none !important; }
.rating-geometry-reserve { position: absolute; width: 1px; height: 1px; overflow: hidden; opacity: 0; pointer-events: none; }
.rating-age-row { display: grid; gap: 6px; min-height: 56px; }
.rating-age-row { align-content: center; }
.rating-age-row label { font-weight: 600; }
.rating-age { width: 100%; min-height: 48px; }
.rating-age-row { gap: 4px; align-content: start; }
.rating-age-keypad { display: grid; grid-template-columns: repeat(6,minmax(0,1fr)); gap: 4px; }
.rating-age-keypad button { min-height: 44px; padding: 4px; font-size: 18px; }

```

### src/web/scale-input.ts L1–L46

```
import type { Question, Answer, ScaleAxis } from '../shared/protocol.js';
import { el } from './dom.js';

// Discrete axis, with no implicit answer at the initial thumb position.
export function scaleInput(q: Question | (ScaleAxis & {required:boolean}), answer: Answer | undefined, save: (answer: number|null) => void) {
  const control = el('div', undefined, 'axis-control'), ends = el('div', undefined, 'axis-ends');
  ends.append(el('span', q.min_label), el('span', q.max_label));
  const track = el('div', undefined, 'axis-track'), range = el('input', undefined, 'axis-input');
  range.type = 'range'; range.name = q.id; range.min = String(q.min); range.max = String(q.max); range.step = '1';
  range.setAttribute('aria-label', q.title);
  const ticks = el('div', undefined, 'axis-ticks'); ticks.setAttribute('aria-hidden', 'true');
  for (let value = q.min!; value <= q.max!; value++) ticks.append(el('span'));
  track.append(range, ticks);
  const bottom = el('div', undefined, 'axis-bottom'), output = el('output');
  output.id = `axis-value-${q.id}`; range.setAttribute('aria-describedby', output.id);
  bottom.append(output); control.append(ends, track, bottom);
  function sync(value: Answer | undefined) {
    const chosen = typeof value === 'number';
    range.value = String(chosen ? value : Math.round((q.min! + q.max!) / 2));
    range.dataset.answered = String(chosen);
    const label = chosen ? q.labels?.[value-q.min!] ?? (value===q.min?q.min_label:value===q.max?q.max_label:'两端之间') : '';
    range.setAttribute('aria-valuetext', chosen ? label! : '尚未作答');
    output.textContent = chosen ? `已选：${label}` : '点击或拖动坐标轴选择';
    output.dataset.answered=String(chosen);
    for(const [index,tick]of Array.from(ticks.children).entries())(tick as HTMLElement).dataset.selected=String(chosen&&index===value-q.min!);
  }
  const commit = (value: number|null) => { sync(value); save(value); };
  range.addEventListener('input', () => commit(Number(range.value)));
  range.addEventListener('change', () => commit(Number(range.value)));
  range.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    const rect = range.getBoundingClientRect(), fraction = Math.max(0, Math.min(1, (event.clientX - rect.left - 11) / Math.max(1, rect.width - 22)));
    commit(q.min! + Math.round(fraction * (q.max! - q.min!)));
  });
  range.addEventListener('keydown', event => {
    if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); commit(Number(range.value)); }
  });
  range.addEventListener('keyup', event => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) commit(Number(range.value));
  });
  if (!q.required) {
    const clear = el('button', '清除'); clear.type = 'button'; clear.addEventListener('click', () => commit(null)); bottom.append(clear);
  }
  sync(answer); return control;
}

```

### src/web/simulate.html L1–L2

```
<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>模拟问卷</title></head><body><main><header><h1 id="title">模拟问卷</h1><p id="status">请从管理端生成模拟。</p></header><div id="content"></div></main><script type="module" src="/simulate.ts"></script></body></html>

```

### src/web/simulate.ts L1–L34

```
import './participant.css';
import './runner.css';
import {lockParticipantViewport} from './viewport.js';
import {applyParticipantBackground} from './participant-theme.js';
import {watchOrientation} from './orientation-gate.js';
import {mountPage} from './survey-page.js';
import {mountEnding} from './ending-page.js';
import {mountConsent,showConsentDeclined} from './consent-page.js';
import {parseProtocol,evaluate,type Protocol,type Answer} from '../shared/protocol.js';
import {preventTaskGestures} from './runner-input.js';
import {el,button} from './dom.js';
import {sampleTrials} from '../shared/trial-sampling.js';
import type {State} from '../shared/prng.js';
lockParticipantViewport();
const title=document.querySelector<HTMLHeadingElement>('#title')!,status=document.querySelector<HTMLParagraphElement>('#status')!,content=document.querySelector<HTMLDivElement>('#content')!;
let p:Protocol|undefined,index=0,imageIndex=0,consented=false,answers:Record<string,Answer>={},values:Record<string,Record<string,Answer>>={},dispose:(()=>void)|undefined,disposeOrientation:(()=>void)|undefined;
function render(){if(!p)return;dispose?.();applyParticipantBackground(p.layout.background);title.textContent=p.title;status.textContent='模拟问卷 · 不提交数据';
  if(p.consent&&!consented){dispose=mountConsent(content,p.consent,()=>{consented=true;render();},()=>{dispose?.();status.textContent='未同意参加 · 不提交数据';showConsentDeclined(content,render);});return;}
  while(p.pages[index]&&!evaluate(p.pages[index]!.condition,answers))index++;
  const page=p.pages[index];if(page){const mount=el('div',undefined,'survey-mount');content.replaceChildren(mount);dispose=mountPage(mount,page,answers,values[page.id]??{},(_name,_answer,data)=>{values[page.id]=data;},data=>{Object.assign(answers,data);index++;render();},{key:`simulation-${crypto.randomUUID()}`,title:p.title});return;}
  content.replaceChildren();const images=p.groups.flatMap(group=>group.trials.map(trial=>({group,trial}))),entry=images[imageIndex];
  const reset=button('重新模拟',()=>{index=0;imageIndex=0;consented=false;answers={};values={};render();});
  if(!entry){dispose=mountEnding(content,p.ending,()=>{index=0;imageIndex=0;consented=false;answers={};values={};render();});status.textContent='模拟完成 · 不提交数据';return;}
  title.textContent=entry.group.title;status.textContent=`模拟图片 ${imageIndex+1}/${images.length} · 不提交数据`;