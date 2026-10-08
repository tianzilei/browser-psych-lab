import {Model} from 'survey-core';
import {renderSurvey} from 'survey-js-ui';
import 'survey-core/survey-core.min.css';
import {evaluate,type Page,type Answer} from '../shared/protocol.js';
export function mountPage(element:HTMLDivElement,page:Page,previous:Record<string,Answer>,values:Record<string,Answer>,revision:(name:string,answer:Answer,data:Record<string,Answer>)=>void,complete:(data:Record<string,Answer>)=>void){
  const survey=new Model({showTitle:false,showCompletePage:false,completeText:'提交本页',clearInvisibleValues:'none',elements:page.questions.map(q=>({name:q.id,title:q.title,isRequired:q.required,
    type:q.type==='single'?'radiogroup':q.type==='multi'?'checkbox':q.type==='scale'?'rating':'text',...(q.choices?{choices:q.choices}:{}),...(q.type==='scale'?{rateMin:q.min,rateMax:q.max}:{}),...(q.type==='text'?{maxLength:q.max_length}:{}),}))});
  survey.onTextMarkdown.add((_sender,o)=>{const span=document.createElement('span');span.textContent=o.text;o.html=span.innerHTML;});
  const visible=()=>{const effective={...previous};for(const q of page.questions){const shown=evaluate(q.condition,effective);survey.getQuestionByName(q.id)!.visible=shown;effective[q.id]=shown?(survey.data as Record<string,Answer>)[q.id]??null:null;}};
  survey.data=values;visible();survey.onValueChanged.add((_sender,o)=>{visible();revision(o.name,o.value??null,survey.data as Record<string,Answer>);});
  survey.onComplete.add(()=>complete(survey.data as Record<string,Answer>));renderSurvey(survey,element);return survey;
}
