当前交互源码第 3 段。连续片段，请与前后段拼接阅读。本阶段只回复 ACK_INTERACTION_03。
    else high = mid - 1;
        }
        // Too little space is reported to the caller instead of clipping a glyph.
        end = this.boundaries[low]!;
        // Consent keeps paragraphs together when at least half a screen can be
        // used. Oversized paragraphs still split at a safe grapheme boundary.
        if(this.preferParagraphs&&end<this.text.length){const boundary=this.text.lastIndexOf('\n\n',end-2)+2;if(boundary>this.start&&boundary-this.start>=(end-this.start)/2)end=boundary;}
      } finally { probe.remove(); }
      if (this.cache.size >= 64) this.cache.clear();
      this.cache.set(key, end);
    }
    this.end = end;
    this.area.textContent = this.text.slice(this.start, end);
    return end > this.start || this.text.length === 0;
  }
}

```


=== FILE src/web/participant-ui.ts (complete source; may continue in next chunk) ===
```
import {el} from './dom.js';
import {RequestError} from './request-error.js';

export const ui={
  retrySave:'重试保存',returnSurvey:'返回问卷',home:'返回主页',cancel:'取消并返回',
  startTask:'准备任务',startGroup:'开始本组',nextQuestion:'下一题',submitRating:'提交评分',
  saving:'正在保存…',completed:'研究已完成，数据已保存。',
  capacity:'当前参加名额已满，请约 30 分钟后重试。',
  duplicateTab:'此问卷已在其他页面打开。请回到原页面继续作答，此页只读。',
  scaleHint:'点击或拖动滑块选择评分',
} as const;

const errors:Record<string,string>={
  SESSION_CAPACITY_FULL:ui.capacity,PREPARATION_CAPACITY_FULL:ui.capacity,
  ADMISSION_EXPIRED:'作答连接已过期，请重新进入。',
  ADMISSION_PAUSED:'此问卷暂未开放，请稍后再试。',COLLECTION_GATE_CLOSED:'此问卷暂未开放，请联系研究者。',
  VERSION_NOT_FOUND:'此问卷链接已失效，请返回主页选择问卷。',
  UNAUTHORIZED:'无法确认作答身份，请使用原浏览器重新打开参与链接。',
  WRITER_FENCED:ui.duplicateTab,RUN_LOCKED:'已有任务正在运行，请回到原页面继续。',
  SESSION_TERMINAL:'本次作答已结束，请返回问卷查看保存状态。',
  RESERVATION_EXPIRED:'任务准备已过期，请返回问卷重新准备。',
  PREPARATION_UNAVAILABLE:'暂时无法准备任务，请返回问卷核对进度。',
  RUNNER_VERSION_UNAVAILABLE:'此任务版本暂时不可用，请联系研究者。',
  ENVIRONMENT_NOT_READY:'当前设备未满足任务要求，请调整设备后重新准备。',
  INVALID_GEOMETRY:'当前屏幕无法完整显示任务，请调整设备后重新准备。',
  RESOURCE_NOT_READY:'任务图片暂时不可用，请联系研究者。',
  PAGES_NOT_SEALED:'问卷尚未保存完成，请返回问卷重试保存。',
  PREVIOUS_STAGE_UNSEALED:'上一部分尚未保存完成，请返回问卷重试保存。',
  REPLAY_REQUIRED:'任务记录尚未核对完成，请重试保存。',
  REPLAY_PROOF_STALE_OR_INVALID:'任务记录核对未通过，请联系研究者。',
  RECONCILIATION_MISMATCH:'记录核对未通过，请保留此浏览器中的记录并联系研究者。',
  CUSTODY_RECEIPT_MISMATCH:'记录保存凭证不一致，请保留此浏览器中的记录并联系研究者。',
  ENVIRONMENT_RECEIPT_MISMATCH:'设备信息保存凭证不一致，请保留此浏览器中的记录并联系研究者。',
  SAVE_NOT_CONFIRMED:'记录保存尚未确认，请重试保存。',
  COMPLETION_NOT_CONFIRMED:'本次作答尚未完成保存，请重试保存。',
};
export function errorCode(error:unknown){
  return error instanceof RequestError?error.code:error instanceof Error?error.message.split('：')[0]!:'';
}
export function isConnectionFailure(error:unknown){
  return error instanceof Error&&(error.name==='TimeoutError'||error.name==='NetworkError'
    ||error instanceof TypeError&&/fetch|network|load/i.test(error.message)
    ||error instanceof RequestError&&[429,503].includes(error.status));
}
export function participantError(error:unknown,context:'save'|'prepare'|'enter'='save'){
  const code=errorCode(error);
  if(errors[code])return errors[code]!;
  if(error instanceof Error){
    if(error.name==='SESSION_WAIT_CANCELED')return '已取消进入，可以重新进入问卷。';
    if(error.name==='QuotaExceededError')return '浏览器存储空间不足，无法继续保存。请保留此浏览器中的记录并联系研究者。';
    if(['InvalidStateError','UnknownError','NotReadableError'].includes(error.name))return '浏览器无法保存记录，请保留此浏览器中的记录并联系研究者。';
    if(isConnectionFailure(error))return context==='save'?'暂时无法连接服务器，保存尚未确认。请检查网络后重试。':'暂时无法连接服务器，请检查网络后重试。';
    // Locally authored explanations are already participant-facing. Codes and
    // browser internals remain in the expandable diagnostic instead.
    if(!(error instanceof RequestError)&&/[\u3400-\u9fff]/u.test(error.message))return error.message;
  }
  return context==='save'?'保存尚未完成，请重试。若仍无法保存，请联系研究者。':context==='enter'?'问卷暂时无法打开，请重试。若仍无法打开，请联系研究者。':'任务准备未完成，请重试。若仍无法开始，请联系研究者。';
}
export function errorDetails(error:unknown){
  const diagnostic=error instanceof RequestError?`HTTP ${error.status}\n${error.code}${error.details===undefined?'':`\n${JSON.stringify(error.details,null,2)}`}`:error instanceof Error?`${error.name}：${error.message}`:String(error);
  const details=el('details',undefined,'error-details');details.append(el('summary','查看错误详情'),el('pre',diagnostic));return details;
}
export function interruptionMessage(reason:unknown){
  const code=reason instanceof Error?reason.message:String(reason);
  if(code==='USER_IDLE_TIMEOUT')return '连续 2 分钟未操作，本组已中断。';
  if(code==='CONNECTION_TIMEOUT')return '长时间无法连接服务器，本组已中断。';
  if(['VISIBILITY_OR_GEOMETRY_CHANGED','VISUAL_VIEWPORT_CHANGED','PAGE_HIDDEN_OR_CLOSED'].includes(code))return '页面已隐藏或显示区域发生变化，本组已中断。';
  if(code==='LONG_FRAME')return '设备未能保持任务要求的显示节奏，本组已中断。';
  return '本组已中断。';
}
/** Deduplicate metadata only for display; never rewrite the frozen protocol. */
export function pageIntroduction(title:string,pageTitle:string,instruction:string){
  const key=(value:string)=>value.replace(/\s+/gu,' ').trim(),blocks:string[]=[];
  if(key(pageTitle)&&key(pageTitle)!==key(title))blocks.push(pageTitle);
  // Keep an authored instruction even when it equals the global title. It may
  // be the only instruction. Identical page title + instruction appear once.
  if(key(instruction)&&!blocks.some(block=>key(block)===key(instruction)))blocks.push(instruction);
  return blocks.join('\n\n');
}

```


=== FILE src/web/consent-page.ts (complete source; may continue in next chunk) ===
```
import type {Protocol} from '../shared/protocol.js';
import {el,button} from './dom.js';
import {TextPager} from './text-pager.js';

export function mountConsent(content:HTMLElement,document:NonNullable<Protocol['consent']>,accept:()=>void,decline:()=>void){
  const page=el('section',undefined,'consent-page'),text=el('div',undefined,'reading-text consent-text');
  text.tabIndex=-1;
  const reading=el('div',undefined,'consent-reading-nav'),decisions=el('div',undefined,'consent-decisions');
  const previous=el('button','阅读上一段'),next=el('button','阅读下一段'),reject=el('button','不同意并退出'),agree=el('button','我已阅读并同意');
  for(const b of [previous,next,reject,agree])b.type='button';
  agree.className='primary';
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
  page.append(el('p','你未同意参加，本次不会开始作答。可以关闭此页面，或重新阅读知情同意书。'),button('重新阅读知情同意书',reread));content.replaceChildren(page);
}

```


=== FILE src/web/consent-gate.ts (complete source; may continue in next chunk) ===
```
import {request} from './dom.js';
import {stableJSON,type Protocol} from '../shared/protocol.js';
import {sha256} from './local-store.js';
import type {Ledger} from './ledger.js';
import {mountConsent,showConsentDeclined} from './consent-page.js';
export interface ConsentReceipt {accepted:true;document_hash:string}

export async function requireConsent(ledger:Ledger):Promise<ConsentReceipt|undefined>{
  const consent=await request<{document:NonNullable<Protocol['consent']>;document_hash:string}|null>(`/api/participate/versions/${ledger.version}/consent`);
  if(!consent)return;
  if(await sha256(stableJSON(consent.document))!==consent.document_hash)throw new Error('知情同意书版本校验失败。');
  const old=(await ledger.state()).consent;
  if(old?.accepted===true&&old.document_hash===consent.document_hash)return old;
  const content=document.querySelector<HTMLElement>('#content')!,status=document.querySelector<HTMLElement>('#status')!;
  status.textContent='参加前请阅读知情同意书。';
  let dispose:()=>void=()=>{},cancel:()=>void=()=>{};
  try{
    await new Promise<void>((resolve,reject)=>{
      cancel=()=>{dispose();reject(new Error('页面已关闭。'));};window.addEventListener('pagehide',cancel,{once:true});
      const read=()=>{dispose();status.textContent='参加前请阅读知情同意书。';dispose=mountConsent(content,consent.document,resolve,()=>{dispose();status.textContent='未同意参加。';showConsentDeclined(content,read);});};read();
    });
  }finally{dispose();window.removeEventListener('pagehide',cancel);}
  const receipt:ConsentReceipt={accepted:true,document_hash:consent.document_hash};
  await ledger.consent(receipt);status.textContent='已同意参加，正在准备问卷…';content.replaceChildren();return receipt;
}

```


=== FILE src/web/ending-page.ts (complete source; may continue in next chunk) ===
```
import type {Protocol} from '../shared/protocol.js';
import {el} from './dom.js';
import {TextPager} from './text-pager.js';
import {ui} from './participant-ui.js';

export function mountEnding(content:HTMLElement,ending:Protocol['ending'],restart?:()=>void){
  const e=ending??{title:'感谢参与',text:'现在可以关闭页面，或返回主页。'};
  const page=el('section',undefined,'ending-page'),title=el('h2',e.title,'ending-title'),text=el('div',undefined,'reading-text ending-text'),nav=el('div',undefined,'ending-nav');
  text.tabIndex=-1;const previous=el('button','阅读上一段'),next=el('button','阅读下一段'),home=el('button',ui.home,'primary');previous.type=next.type=home.type='button';nav.append(previous,next,home);
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


=== FILE src/web/orientation-gate.ts (complete source; may continue in next chunk) ===
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
    dispose=()=>{window.removeEventListener('resize',check);w