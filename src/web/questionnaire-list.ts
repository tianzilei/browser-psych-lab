import './style.css';
import {el} from './dom.js';

type Questionnaire={version_id:string;title:string};
const status=document.querySelector<HTMLParagraphElement>('#status')!;
const list=document.querySelector<HTMLDivElement>('#questionnaires')!;
try {
  const response=await fetch('/api/questionnaires');
  if(!response.ok) throw new Error('加载失败');
  const data=await response.json() as {questionnaires:Questionnaire[]};
  list.replaceChildren();
  if(!data.questionnaires.length){status.textContent='当前没有开放的问卷。';}
  else {
    status.textContent='请选择要参加的问卷。';
    for(const questionnaire of data.questionnaires){
      const card=el('article');
      card.append(el('h3',questionnaire.title));
      const link=el('a','开始填写');
      link.href=`/participate.html?version=${encodeURIComponent(questionnaire.version_id)}`;
      card.append(link); list.append(card);
    }
  }
} catch { status.textContent='问卷列表暂时无法加载，请稍后重试。'; }
