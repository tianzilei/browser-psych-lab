import type {Protocol} from '../shared/protocol.js';
import {el,button} from './dom.js';
import {TextPager} from './text-pager.js';

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
