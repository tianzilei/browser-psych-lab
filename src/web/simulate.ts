import './participant.css';
import './runner.css';
import {lockParticipantViewport} from './viewport.js';
import {applyParticipantBackground} from './participant-theme.js';
import {watchOrientation} from './orientation-gate.js';
import {mountPage} from './survey-page.js';
import {mountEnding} from './ending-page.js';
import {mountConsent,showConsentDeclined} from './consent-page.js';
import {parseProtocol,evaluate,type Protocol,type Answer} from '../shared/protocol.js';
import {el,button} from './dom.js';
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
  const stage=el('div',undefined,'runner-stage'),slot=el('div',undefined,'canvas-slot'),controls=el('div',undefined,'response-buttons'),footer=el('div',undefined,'simulation-image-nav');
  if(!entry.trial.asset_id.startsWith('preview-image-')){const image=el('img');image.src=`/api/lab/assets/${entry.trial.asset_id}`;image.alt='模拟图片';image.style.cssText='width:100%;height:100%;object-fit:contain';slot.append(image);}else slot.append(el('p','上传 ZIP 后可查看图片。'));
  for(const choice of entry.group.choices){const b=button(choice,()=>{for(const node of controls.children)node.setAttribute('aria-pressed',String(node===b));status.textContent=`模拟选择：${choice}`;});b.setAttribute('aria-pressed','false');controls.append(b);}
  controls.style.setProperty('--response-columns',String(Math.min(3,entry.group.choices.length)));
  const previous=button('上一张',()=>{imageIndex--;render();});previous.disabled=imageIndex===0;
  footer.append(previous,button(imageIndex+1<images.length?'下一张':'完成模拟',()=>{imageIndex++;render();}),reset);stage.append(slot,controls,footer);content.append(stage);
}
window.addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==parent||event.data?.type!=='lab-simulation')return;try{p=parseProtocol(event.data.protocol);index=0;imageIndex=0;consented=false;answers={};values={};disposeOrientation?.();applyParticipantBackground(p.layout.background);if(p.layout.orientation){const gate=watchOrientation(p.layout.orientation);disposeOrientation=gate.dispose;void gate.passed.then(render);}else render();}catch{status.textContent='模拟 JSON 无效。';}});
