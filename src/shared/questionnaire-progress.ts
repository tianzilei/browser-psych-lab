import {ContractError,type Manifest} from './contract.js';
import {evaluate,pageSnapshot,type Answer,type Page} from './protocol.js';

/** Rebuild a presentation projection; never edit persisted raw values/events. */
export function recoverQuestionnaireProgress(pages:readonly Page[],server:{
  answers:Record<string,Answer>;path:string[];page_index:number;
},local:{page_values:Record<string,Record<string,Answer>>;pending:Record<string,{manifest:Pick<Manifest,'scope'|'path'>}>}){
  const answers={...server.answers},path=[...server.path];
  let page_index=server.page_index;
  for(;page_index<pages.length;page_index++){
    const page=pages[page_index]!,pending=local.pending[page.id];
    if(!evaluate(page.condition,answers)){
      if(pending)throw new ContractError('LOCAL_QUESTIONNAIRE_PATH_CONFLICT');
      for(const q of page.questions)answers[q.id]=null;
      continue;
    }
    if(!pending)break; // Editable drafts belong to the renderer, not prior answers.
    const expected=[...path,page.id];
    if(pending.manifest.scope!==page.id||JSON.stringify(pending.manifest.path)!==JSON.stringify(expected))
      throw new ContractError('LOCAL_QUESTIONNAIRE_PATH_CONFLICT');
    const checked=pageSnapshot(page,answers,local.page_values[page.id]??{});
    Object.assign(answers,Object.fromEntries(Object.entries(checked).map(([id,v])=>[id,v.answer])));
    path.push(page.id);
  }
  return {answers,path,page_index};
}
