全项目设计讨论，传输段 39，源码主题：页面交互和管理（源包 13/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

export function mountConsent(content:HTMLElement,document:NonNullable<Protocol['consent']>,accept:()=>void,decline:()=>void){
  const page=el('section',undefined,'consent-page'),text=el('div',undefined,'reading-text consent-text');
  text.tabIndex=-1;
  const reading=el('div',undefined,'consent-reading-nav'),decisions=el('div',undefined,'consent-decisions');
  const previous=el('button','阅读上一段'),next=el('button','阅读下一段'),reject=el('button','不同意并退出'),agree=el('button','我已阅读并同意');
  for(const b of [previous,next,reject,agree])b.type='button';
  reading.append(previous,next);decisions.append(reject,agree);page.append(text,reading,decisions);content.replaceChildren(page);
  const pager=new TextPager(`${document.title}\n\n${document.text}`,text,true);
  let disposed=false,frame=0,fits=false;
  function render(){if(disposed)return;fits=pager.show();previous.hidden=!pager.back;next.hidden=!pager.more;next.disabled=!fits;reading.hidden=!pager.back&&!pager.more;agree.disabled=!fits||pager.more;if(!fits)text.textContent='可见空间不足，请调整设备尺寸以阅读知情同意书。';}
  previous.addEventListener('click',()=>{pager.previous();render();text.focus({preventScroll:true});});
  next.addEventListener('click',()=>{pager.next();render();text.focus({preventScroll:true});});
  reject.addEventListener('click',decline);
  agree.addEventListener('click',()=>{if(fits&&!pager.more){agree.disabled=true;reject.disabled=true;accept();}});
  const observer=new ResizeObserver(()=>{if(!frame)frame=requestAnimationFrame(()=>{frame=0;render();});});observer.observe(content);render();
  return ()=>{disposed=true;observer.disconnect();cancelAnimationFrame(frame);};
}

export function showConsentDeclined(content:HTMLElement,reread:()=>void){
  const page=el('section',undefined,'consent-declined');
  page.append(el('p','你未同意参加，本次不会创建作答会话。可以关闭此页面退出。'),button('重新阅读知情同意书',reread));content.replaceChildren(page);
}

```

### src/web/diagnostics.html L1–L4

```
﻿<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>开发检查 · Browser Psych Lab</title></head>
<body><main><header><p class="eyebrow">BROWSER PSYCH LAB · TEST_ONLY</p><h1>开发环境已连接</h1><p>此页检查基础组件。<a href="/p0.html">打开可靠保存测试问卷</a>，验证本地保存与服务器封存。</p></header><section aria-labelledby="environment-heading"><h2 id="environment-heading">环境检查</h2><ul id="checks" aria-live="polite"></ul><canvas id="canvas" width="480" height="100" aria-label="Canvas 绘制检查"></canvas></section><section aria-labelledby="survey-heading"><h2 id="survey-heading">问卷渲染样例</h2><p>按需加载问卷样例，答案不保存。</p><button id="load-survey" type="button">加载问卷样例</button><p id="survey-status" role="status"></p><div id="survey"></div></section></main><script type="module" src="/diagnostics.ts"></script></body></html>

```

### src/web/diagnostics.ts L1–L7

```
try {
  const response=await fetch('/api/auth/me');
  if(response.ok)await import('./main.js');
  else location.replace('/');
} catch {location.replace('/');}
export {};

```

### src/web/dom.ts L1–L26

```
import {wait,overloadDelay} from './wait.js';
export function el<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,cls?:string){const element=document.createElement(tag);if(text!==undefined)element.textContent=text;if(cls)element.className=cls;return element;}
export function button(label:string,action:()=>void|Promise<void>,cls?:string){const b=el('button',label,cls);b.type='button';b.addEventListener('click',()=>{b.disabled=true;void Promise.resolve().then(action).finally(()=>{b.disabled=false;});});return b;}
export function field(label:string,value:string,type='text'){const box=el('label');box.append(el('span',label));const input=el('input');input.type=type;input.value=value;box.append(input);return {box,input};}
export function area(label:string,value:string,rows=3){const box=el('label');box.append(el('span',label));const input=el('textarea');input.value=value;input.rows=rows;box.append(input);return {box,input};}
export function select(label:string,values:{value:string;label:string}[],value:string){const box=el('label');box.append(el('span',label));const input=el('select');for(const v of values){const option=el('option',v.label);option.value=v.value;input.append(option);}input.value=value;box.append(input);return {box,input};}
export function uid(){return crypto.randomUUID();}
export async function request<T>(url:string,data?:unknown,csrf?:string,signal?:AbortSignal):Promise<T>{
  const body=data===undefined?undefined:JSON.stringify(data),started=performance.now();
  const heavy=/\/seal$|\/api\/lab\/jobs\/(?:backup|export|rebuild)$|\/api\/lab\/jobs\/[^/]+\/recover$|\/api\/lab\/assets\/[^/]+\/delete$/.test(url);
  const budget=heavy?180000:60000,attemptBudget=heavy?150000:15000;
  for(let attempt=0;;attempt++){
    signal?.throwIfAborted();const remaining=budget-(performance.now()-started);
    if(remaining<=0)throw new Error('保存与核对等待超时，请保留页面记录后重试。');
    const timeout=AbortSignal.timeout(Math.max(1,Math.floor(Math.min(attemptBudget,remaining))));
    const response=await fetch(url,{...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':csrf}:{})},body}),signal:signal?AbortSignal.any([signal,timeout]):timeout});
    // Only explicit overload responses are retried. Reuse the exact serialized
    // request and its request/event identities; an ambiguous timeout surfaces.
    if((response.status===503||response.status===429)&&attempt<7){
      await response.body?.cancel();await wait(Math.min(overloadDelay(response,attempt),Math.max(0,budget-(performance.now()-started))),signal);continue;
    }
    const result=await response.json() as {code?:string;details?:unknown};
    if(!response.ok){if(['SESSION_CAPACITY_FULL','PREPARATION_CAPACITY_FULL'].includes(result.code??''))throw new Error('当前作答人数较多，建议30分钟后再进行答题。已保存的答卷保留。');throw new Error(`${result.code??'REQUEST_FAILED'}${result.details?`：${JSON.stringify(result.details)}`:''}`);}return result as T;
  }
}

```

### src/web/ending-page.ts L1–L20

```
import type {Protocol} from '../shared/protocol.js';
import {el} from './dom.js';
import {TextPager} from './text-pager.js';

export function mountEnding(content:HTMLElement,ending:Protocol['ending'],restart?:()=>void){
  const e=ending??{title:'感谢参与',text:'你的答案已保存。感谢你的时间，现在可以关闭页面。'};
  const page=el('section',undefined,'ending-page'),title=el('h2',e.title,'ending-title'),text=el('div',undefined,'reading-text ending-text'),nav=el('div',undefined,'ending-nav');
  text.tabIndex=-1;const previous=el('button','阅读上一段'),next=el('button','阅读下一段'),home=el('button','回到主页');previous.type=next.type=home.type='button';nav.append(previous,next,home);
  home.addEventListener('click',()=>{window.location.assign('/');});
  if(restart){const reset=el('button','重新模拟');reset.type='button';reset.addEventListener('click',restart);nav.append(reset);}
  page.append(title,text,nav);content.replaceChildren(page);
  const pager=new TextPager(e.text,text);
  let disposed=false,frame=0;
  function render(){if(disposed)return;const fits=pager.show();previous.hidden=!pager.back;next.hidden=!pager.more;next.disabled=!fits;if(!fits)text.textContent='请调整设备方向以阅读结束语。';}
  previous.addEventListener('click',()=>{pager.previous();render();text.focus({preventScroll:true});});
  next.addEventListener('click',()=>{pager.next();render();text.focus({preventScroll:true});});
  const observer=new ResizeObserver(()=>{if(!frame)frame=requestAnimationFrame(()=>{frame=0;render();});});observer.observe(content);render();
  return ()=>{disposed=true;observer.disconnect();cancelAnimationFrame(frame);};
}

```

### src/web/index.html L1–L3

```
﻿<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>问卷列表 · Browser Psych Lab</title></head>
<body><main><header><p class="eyebrow">BROWSER PSYCH LAB</p><h1>问卷列表</h1><p id="status" role="status" aria-live="polite">正在加载可参加的问卷…</p></header><section aria-labelledby="list-heading"><h2 id="list-heading">可参加的问卷</h2><div id="questionnaires"></div></section></main><script type="module" src="/questionnaire-list.ts"></script></body></html>

```

### src/web/main.ts L1–L59

```
import { openDB, deleteDB } from 'idb';
import './style.css';

const checks = document.querySelector<HTMLUListElement>('#checks')!;
function show(label: string, passed: boolean, detail: string) {
  const item = document.createElement('li');
  item.dataset.status = passed ? 'ok' : 'failed';
  item.textContent = `${label}：${detail}`;
  checks.append(item);
}

try {
  const response = await fetch('/api/health/ready', { signal: AbortSignal.timeout(5000) });
  const body = await response.json() as { database?: string };
  show('应用与数据库', response.ok, response.ok ? `${body.database}，存储目录就绪` : '服务尚未就绪');
} catch { show('应用与数据库', false, '连接失败'); }

const probeName = `browser-psych-lab-probe-${crypto.randomUUID()}`;
try {
  const db = await openDB(probeName, 1, { upgrade(db) { db.createObjectStore('probe'); } });
  try {
    const tx = db.transaction('probe', 'readwrite');
    await tx.store.put('TEST_ONLY', 'value');
    await tx.done;
    show('IndexedDB', await db.get('probe', 'value') === 'TEST_ONLY', '写入事务完成并回读');
  } finally { db.close(); }
} catch { show('IndexedDB', false, '本地存储不可用'); }
finally { await deleteDB(probeName).catch(() => {}); }

const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
const context = canvas.getContext('2d');
if (context) {
  await new Promise<void>(resolve => requestAnimationFrame(() => {
    context.fillStyle = '#e9f0eb';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#20523e';
    context.font = '18px sans-serif';
    context.fillText('Canvas + requestAnimationFrame · TEST_ONLY', 18, 56);
    resolve();
  }));
}
show('Canvas 与帧回调', Boolean(context), context ? '可用；尚未测量时序' : '不可用');
show('Web Locks', Boolean(navigator.locks), navigator.locks ? '接口可用；单写者合同待实现' : '接口不可用');

const loadSurvey = document.querySelector<HTMLButtonElement>('#load-survey')!;
const surveyStatus = document.querySelector<HTMLParagraphElement>('#survey-status')!;
loadSurvey.addEventListener('click', () => {
  loadSurvey.disabled = true;
  surveyStatus.textContent = '正在加载问卷样例…';
  void import('./survey-demo').then(({ mountSurveyDemo }) => {
    mountSurveyDemo(document.querySelector<HTMLDivElement>('#survey')!);
    loadSurvey.hidden = true;
    surveyStatus.textContent = '';
  }).catch(() => {
    loadSurvey.disabled = false;
    surveyStatus.textContent = '问卷样例加载失败，可重试。';
  });
});

```

### src/web/orientation-gate.ts L1–L40

```
import {request,el} from './dom.js';
import {applyParticipantBackground} from './participant-theme.js';
type Orientation='portrait'|'landscape';
let last:Orientation|undefined,lastWidth=0;
export function currentOrientation():Orientation {
  const width=document.documentElement.clientWidth||innerWidth,height=document.documentElement.clientHeight||innerHeight;
  const typing=document.activeElement instanceof HTMLInputElement&&document.activeElement.type!=='range'||document.activeElement instanceof HTMLTextAreaElement;
  // A keyboard can shrink the layout viewport. Preserve orientation while its width is unchanged.
  if(typing&&last&&Math.abs(width-lastWidth)<2)return last;
  lastWidth=width;return last=width>height?'landscape':'portrait';
}
let gate:Promise<void>|undefined,requiredOrientation:Orientation|null=null;
export async function requireOrientation(version:string){await(gate??=initialize(version).catch(error=>{gate=undefined;throw error;}));if(requiredOrientation)await waitForOrientation(requiredOrientation);}
function waitForOrientation(required:Orientation){return new Promise<void>(resolve=>{
  const check=()=>{if(currentOrientation()!==required)return;window.removeEventListener('resize',check);window.removeEventListener('orientationchange',check);screen.orientation?.removeEventListener('change',check);resolve();};
  window.addEventListener('resize',check);window.addEventListener('orientationchange',check);screen.orientation?.addEventListener('change',check);check();
});}
async function initialize(version:string){
  const meta=await request<{title:string;background:string;orientation:Orientation|null}>(`/api/participate/versions/${version}/metadata`);
  applyParticipantBackground(meta.background);
  const title=document.querySelector<HTMLElement>('#title');if(title){title.textContent=meta.title;title.title=meta.title;}
  requiredOrientation=meta.orientation;
  if(!meta.orientation)return; // Historical frozen protocols keep their original behavior.
  await watchOrientation(meta.orientation).passed;
}
export function watchOrientation(required:Orientation){
  const overlay=el('div',undefined,'orientation-gate');overlay.id='orientation-gate';overlay.setAttribute('role','alert');
  const icon=el('div',undefined,'orientation-device');icon.dataset.orientation=required;icon.setAttribute('aria-hidden','true');
  overlay.append(icon,el('p',required==='portrait'?'请将设备调整为竖屏':'请将设备调整为横屏'),el('span','方向正确后自动继续'));
  document.body.append(overlay);const main=document.querySelector('main');
  let dispose=()=>{};
  const passed=new Promise<void>(resolve=>{
    const check=()=>{const valid=currentOrientation()===required;overlay.hidden=valid;if(main)main.inert=!valid;if(valid)resolve();};
    window.addEventListener('resize',check);window.addEventListener('orientationchange',check);screen.orientation?.addEventListener('change',check);
    dispose=()=>{window.removeEventListener('resize',check);window.removeEventListener('orientationchange',check);screen.orientation?.removeEventListener('change',check);window.removeEventListener('pagehide',dispose);overlay.remove();if(main)main.inert=false;};
    window.addEventListener('pagehide',dispose,{once:true});check();
  });
  return {passed,dispose};
}

```

### src/web/p0.html L1–L20

```
<!doctype html>
<html lang="zh-CN">