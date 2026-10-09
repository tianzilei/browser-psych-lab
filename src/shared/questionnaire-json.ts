import {ContractError,object,id} from './contract.js';
import {parseProtocol,sampleProtocol,validateQuestionnaire,type Protocol} from './protocol.js';

export interface ImageReference {package:string;path:string}
export function packageName(v:unknown):string {
  if(typeof v!=='string'||v.length>100||!/^[-a-zA-Z0-9_][a-zA-Z0-9_.-]*\.zip$/.test(v))throw new ContractError('INVALID_PACKAGE_NAME');return v;
}
export function imagePath(v:unknown):string {
  if(typeof v!=='string'||v.length>200||v.split('/').some(p=>!p||p==='.'||p==='..'||!/^[-a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(p))||! /\.(png|jpe?g|webp)$/i.test(v))throw new ContractError('INVALID_IMAGE_PATH');return v;
}
export function parseQuestionnaireText(source:string):unknown {
  if(new TextEncoder().encode(source).length>512*1024)throw new Error('JSON 文件不能超过 512 KiB。');
  try{return JSON.parse(source.replace(/^\uFEFF/,''));}catch(error){throw new Error(`JSON 语法错误：${error instanceof Error?error.message:String(error)}`);}
}
export function compileQuestionnaire(value:unknown,resolveImage:(ref:ImageReference)=>string=()=>{throw new ContractError('IMAGE_PACKAGE_REQUIRED');},strict=true):Protocol {
  const input=object(value);
  if(input.schema==='study-v1'){const p=parseProtocol(input);validateQuestionnaire(p,strict);return p;}
  const allowed=['schema','title','mode','background','orientation','pages','groups','variants','layout','budget','consent','ending'];
  if(input.schema!=='questionnaire-v1'||Object.keys(input).some(k=>!allowed.includes(k)))throw new ContractError('UNKNOWN_QUESTIONNAIRE_FIELD');
  if(!['portrait','landscape'].includes(String(input.orientation)))throw new ContractError('ORIENTATION_REQUIRED');
  const base=sampleProtocol(),groups=input.groups??[];
  if(!Array.isArray(groups))throw new ContractError('INVALID_PROTOCOL_LIST');
  const compiled=groups.map(v=>{const g=object(v);if(!Array.isArray(g.trials))throw new ContractError('INVALID_PROTOCOL_LIST');
    return {...g,id:g.id,trials:g.trials.map(v=>{const t=object(v);if(!t.image)return t;
      if(t.asset_id!==undefined)throw new ContractError('AMBIGUOUS_IMAGE_REFERENCE');
      const image=object(t.image);if(Object.keys(image).some(k=>!['package','path'].includes(k)))throw new ContractError('INVALID_IMAGE_REFERENCE');
      const {image:_,...rest}=t;return {...rest,asset_id:resolveImage({package:packageName(image.package),path:imagePath(image.path)})};})};});
  const pages=input.pages;
  if(!Array.isArray(pages))throw new ContractError('INVALID_PROTOCOL_LIST');
  const normalized=pages.map(v=>{const page=object(v);if(!Array.isArray(page.questions))throw new ContractError('INVALID_PROTOCOL_LIST');
    return {...page,title:page.title??'',instruction:page.instruction??'',questions:page.questions.map(v=>{
      const q=object(v);
      if(q.type==='scales'){
        if(!Array.isArray(q.axes))throw new ContractError('INVALID_SCALE_AXES');
        return {...q,required:q.required??true,axes:q.axes.map(v=>{const axis=object(v);
          if(!Array.isArray(axis.labels)||axis.labels.length<2||axis.labels.length>21)throw new ContractError('SCALE_LABELS_REQUIRED');
          const min=axis.min??1;if(typeof min!=='number')throw new ContractError('INVALID_PROTOCOL_NUMBER');
          return {...axis,min,max:axis.max??min+axis.labels.length-1,min_label:axis.min_label??axis.labels[0],max_label:axis.max_label??axis.labels.at(-1)};})};
      }
      if(q.type!=='scale')return {...q,required:q.required??true};
      if(!Array.isArray(q.labels)||q.labels.length<2||q.labels.length>21)throw new ContractError('SCALE_LABELS_REQUIRED');
      const min=q.min??1;if(typeof min!=='number')throw new ContractError('INVALID_PROTOCOL_NUMBER');
      return {...q,required:q.required??true,min,max:q.max??min+q.labels.length-1,min_label:q.min_label??q.labels[0],max_label:q.max_label??q.labels.at(-1)};
    })};});
  const layout=input.layout===undefined?{}:object(input.layout);
  if(layout.background!==undefined||layout.orientation!==undefined)throw new ContractError('AMBIGUOUS_LAYOUT');
  const p=parseProtocol({schema:'study-v1',title:input.title,mode:input.mode??'TEST_ONLY',pages:normalized,groups:compiled,
    variants:input.variants??[{id:'standard',weight:1,group_order:compiled.map(g=>id(g.id)),trial_order:Object.fromEntries(compiled.map(g=>[g.id,g.trials.map(t=>id(t.root_id))]))}],
    layout:{...base.layout,...layout,background:input.background??'#e5e5e5',orientation:input.orientation},budget:{...base.budget,...(input.budget===undefined?{}:object(input.budget))},...(input.consent!==undefined?{consent:input.consent}:{}),...(input.ending!==undefined?{ending:input.ending}:{})});
  validateQuestionnaire(p,strict);return p;
}
export function questionnaireTemplate(){return {schema:'questionnaire-v1',title:'移动端模拟问卷',background:'#e5e5e5',orientation:'portrait',consent:{title:'知情同意书（模拟测试）',text:'这是用于检查样式和交互的模拟问卷。请只填写虚构的个人信息。\n\n同意后系统会保存模拟答案、操作记录和浏览器、系统、屏幕、网络等可获取的设备信息。信息用于检查作答和保存功能。\n\n你可以选择不参加，或在作答过程中关闭页面退出。已经提交的测试记录会保留在本机测试数据库中。\n\n如同意以上说明，请点击“我已阅读并同意”。'},ending:{title:'感谢参与',text:'你的答案已保存。感谢你的时间，现在可以关闭页面。'},pages:[{id:'survey',instruction:'请选择最符合你的答案。',questions:[
  {id:'experience',type:'scale',title:'这次操作是否方便？',labels:['非常不方便','不方便','一般','方便','非常方便']},
  {id:'feelings',type:'scales',title:'请从两个方面评价当前体验。',axes:[{id:'ease',title:'操作便利',labels:['很不方便','不方便','一般','方便','很方便']},{id:'clarity',title:'内容清晰',labels:['很不清晰','不清晰','一般','清晰','很清晰']}]},
  {id:'device',type:'single',title:'你正在使用哪种设备？',required:true,choices:['手机','平板','电脑']},
  {id:'nickname',type:'text',title:'模拟昵称（选填）',required:false,input_purpose:'personal',max_length:20}
]}]};}
