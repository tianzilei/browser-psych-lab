import './page-gestures.js';
import './participant.css';
import './runner.css';
import {lockParticipantViewport} from './viewport.js';
import {applyParticipantBackground} from './participant-theme.js';
import {watchOrientation} from './orientation-gate.js';
import {mountPage} from './survey-page.js';
import {mountAdaptivePage} from './adaptive-page.js';
import {pageIntroduction} from './participant-ui.js';
import {mountEnding} from './ending-page.js';
import {mountConsent,showConsentDeclined} from './consent-page.js';
import {parseProtocol,evaluate,type Protocol,type Answer} from '../shared/protocol.js';
import {preventTaskGestures} from './runner-input.js';
import {el,button} from './dom.js';
import {sampleTrials} from '../shared/trial-sampling.js';
import type {State} from '../shared/prng.js';
import {ratingControls,mountRatingQuestions} from './rating-questions.js';
import {waitForFirstRating} from './first-rating-wait.js';
lockParticipantViewport();
const title=document.querySelector<HTMLHeadingElement>('#title')!,status=document.querySelector<HTMLParagraphElement>('#status')!,content=document.querySelector<HTMLDivElement>('#content')!;
let p:Protocol|undefined,index=0,imageIndex=0,consented=false,answers:Record<string,Answer>={},values:Record<string,Record<string,Answer>>={},dispose:(()=>void)|undefined,disposeOrientation:(()=>void)|undefined;
function render(){if(!p)return;dispose?.();applyParticipantBackground(p.layout.background);title.textContent=p.title;status.textContent='模拟问卷 · 不提交数据';
  if(p.consent&&!consented){dispose=mountConsent(content,p.consent,()=>{consented=true;render();},()=>{dispose?.();status.textContent='未同意参加 · 不提交数据';showConsentDeclined(content,render);});return;}
  while(p.pages[index]&&!evaluate(p.pages[index]!.condition,answers))index++;
  const page=p.pages[index];if(page){const mount=el('div',undefined,'survey-mount');content.replaceChildren(mount);
    if(p.questionnaire_layout==='adaptive')dispose=mountAdaptivePage(mount,page,answers,values[page.id]??{},async(_name,_answer,data)=>{values[page.id]=data;},async data=>{Object.assign(answers,data);index++;render();},{
      offset:p.pages.slice(0,index).reduce((n,page)=>n+page.questions.length,0),total:p.pages.reduce((n,page)=>n+page.questions.length,0),last:index===p.pages.length-1,
      introduction:pageIntroduction(p.title,page.title,page.instruction),cursor:async()=>{},error:()=>{status.textContent='模拟显示失败，请检查问卷。';}
    });
    else dispose=mountPage(mount,page,answers,values[page.id]??{},(_name,_answer,data)=>{values[page.id]=data;},data=>{Object.assign(answers,data);index++;render();},{key:`simulation-${crypto.randomUUID()}`,title:p.title});return;}
  content.replaceChildren();const images=p.groups.flatMap(group=>group.trials.map(trial=>({group,trial}))),entry=images[imageIndex];
  const reset=button('重新模拟',()=>{index=0;imageIndex=0;consented=false;answers={};values={};render();});
  if(!entry){dispose=mountEnding(content,p.ending,()=>{index=0;imageIndex=0;consented=false;answers={};values={};render();});status.textContent='模拟完成 · 不提交数据';return;}
  title.textContent=entry.group.title;status.textContent=`模拟图片 ${imageIndex+1}/${images.length} · 不提交数据`;
  if(entry.group.rating){
    const rating=entry.group.rating,stage=el('div',undefined,'runner-stage rating-stage'),slot=el('div',undefined,'canvas-slot'),footer=el('div',undefined,'runner-start'),panel=ratingControls(rating,footer);
    const image=el('img');image.alt='模拟图片';image.style.cssText='width:100%;height:100%;object-fit:contain';
    const hasImage=!!entry.trial.asset_id&&!entry.trial.asset_id.startsWith('preview-image-');if(hasImage){image.src=`/api/lab/assets/${entry.trial.asset_id}`;slot.append(image);}else slot.append(el('p','上传 ZIP 后可查看图片。'));
    const legacy=!!rating.familiarity&&rating.familiarity.position!=='before-age',starting=new AbortController();let disposed=false,timer:ReturnType<typeof setTimeout>|undefined;
    const show=()=>{slot.style.visibility='visible';};
    const questions=mountRatingQuestions(rating,panel,{record:async()=>{},familiarity:async()=>{if(legacy)show();},screen:()=>{},fail:()=>{status.textContent='模拟显示失败，请检查问卷。';},complete:()=>{
      slot.style.visibility='hidden';questions.hide();status.textContent=imageIndex+1<images.length?'请等待下一张。 · 模拟问卷 · 不提交数据':'本张作答完成，请稍候。 · 模拟问卷 · 不提交数据';
      timer=setTimeout(()=>{if(!disposed){imageIndex++;render();}},entry.trial.isi_ms);
    }});
    stage.append(slot,panel.controls,footer);content.append(stage);document.body.classList.add('runner-layout','rating-layout');preventTaskGestures(stage);slot.style.visibility='hidden';
    dispose=()=>{disposed=true;starting.abort();clearTimeout(timer);questions.stop();document.body.classList.remove('runner-layout','rating-layout');};
    void (hasImage?image.decode():Promise.resolve()).then(async()=>{if(disposed)return;await waitForFirstRating(p!,answers,imageIndex,status,starting.signal);if(disposed)return;status.textContent=`模拟图片 ${imageIndex+1}/${images.length} · 不提交数据`;if(!legacy)show();questions.start();}).catch(()=>{if(!disposed)status.textContent='图片加载失败，请重新打开模拟。';});return;
  }
  const stage=el('div',undefined,'runner-stage'),slot=el('div',undefined,'canvas-slot'),controls=el('div',undefined,'response-buttons'),footer=el('div',undefined,'simulation-image-nav');
  if(entry.trial.text!==undefined)slot.append(el('p',entry.trial.text));else if(entry.trial.asset_id&&!entry.trial.asset_id.startsWith('preview-image-')){const image=el('img');image.src=`/api/lab/assets/${entry.trial.asset_id}`;image.alt='模拟图片';image.style.cssText='width:100%;height:100%;object-fit:contain';slot.append(image);}else slot.append(el('p','上传 ZIP 后可查看图片。'));
  for(const choice of entry.group.choices){const b=button(choice,()=>{for(const node of controls.children)node.setAttribute('aria-pressed',String(node===b));status.textContent=`已选择：${choice} · 模拟问卷 · 不提交数据`;});b.setAttribute('aria-pressed','false');controls.append(b);}
  controls.style.setProperty('--response-columns',String(Math.min(3,entry.group.choices.length)));
  const previous=button('上一张',()=>{imageIndex--;render();});previous.disabled=imageIndex===0;
  footer.append(previous,button(imageIndex+1<images.length?'下一张':'完成模拟',()=>{imageIndex++;render();}),reset);stage.append(slot,controls,footer);content.append(stage);preventTaskGestures(stage);
}
window.addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==parent||event.data?.type!=='lab-simulation')return;try{const next=parseProtocol(event.data.protocol);dispose?.();dispose=undefined;p=next;for(const group of p.groups)if(group.sampling){const seed=Array.from(crypto.getRandomValues(new Uint32Array(4))) as State;if(seed.every(n=>n===0))seed[0]=1;group.trials=sampleTrials(group.trials,group.sampling,seed).roots;}index=0;imageIndex=0;consented=false;answers={};values={};disposeOrientation?.();applyParticipantBackground(p.layout.background);if(p.layout.orientation){const gate=watchOrientation(p.layout.orientation);disposeOrientation=gate.dispose;void gate.passed.then(render);}else render();}catch{status.textContent='无法模拟此问卷，请检查 JSON 内容。';}});
