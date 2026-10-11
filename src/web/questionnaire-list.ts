import './participant.css';
import './questionnaire-list.css';
import {el,button,request} from './dom.js';

type Questionnaire={version_id:string;title:string};
const status=document.querySelector<HTMLParagraphElement>('#status')!;
const list=document.querySelector<HTMLDivElement>('#questionnaires')!;
const actions=document.querySelector<HTMLDivElement>('#list-actions')!;
async function load(){
  status.textContent='正在加载问卷…';actions.replaceChildren();
  try{
    const data=await request<{questionnaires:Questionnaire[]}>('/api/questionnaires');
    list.replaceChildren();status.textContent=data.questionnaires.length?'请选择要参加的问卷。':'当前没有开放的问卷。';
    for(const questionnaire of data.questionnaires){
      const card=el('article'),link=el('a','进入问卷','questionnaire-link');
      link.href=`/participate.html?version=${encodeURIComponent(questionnaire.version_id)}`;
      link.setAttribute('aria-label',`进入问卷：${questionnaire.title}`);
      card.append(el('h2',questionnaire.title),link);list.append(card);
    }
  }catch{
    status.textContent='问卷列表未能加载，请检查网络后重试。';actions.append(button('重新加载',load));
  }
}
void load();
