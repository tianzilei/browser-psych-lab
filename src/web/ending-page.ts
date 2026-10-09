import type {Protocol} from '../shared/protocol.js';
import {el} from './dom.js';
import {TextPager} from './text-pager.js';

export function mountEnding(content:HTMLElement,ending:Protocol['ending'],restart?:()=>void){
  const page=el('section',undefined,'ending-page'),text=el('div',undefined,'reading-text ending-text'),nav=el('div',undefined,'ending-nav');
  text.tabIndex=-1;const previous=el('button','阅读上一段'),next=el('button','阅读下一段');previous.type=next.type='button';nav.append(previous,next);
  if(restart){const reset=el('button','重新模拟');reset.type='button';reset.addEventListener('click',restart);nav.append(reset);}
  page.append(text,nav);content.replaceChildren(page);
  const e=ending??{title:'感谢参与',text:'你的答案已保存。感谢你的时间，现在可以关闭页面。'},pager=new TextPager(`${e.title}\n\n${e.text}`,text);
  let disposed=false,frame=0;
  function render(){if(disposed)return;const fits=pager.show();previous.hidden=!pager.back;next.hidden=!pager.more;next.disabled=!fits;if(!fits)text.textContent='请调整设备方向以阅读结束语。';}
  previous.addEventListener('click',()=>{pager.previous();render();text.focus({preventScroll:true});});
  next.addEventListener('click',()=>{pager.next();render();text.focus({preventScroll:true});});
  const observer=new ResizeObserver(()=>{if(!frame)frame=requestAnimationFrame(()=>{frame=0;render();});});observer.observe(content);render();
  return ()=>{disposed=true;observer.disconnect();cancelAnimationFrame(frame);};
}
