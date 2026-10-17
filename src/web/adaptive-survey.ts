import {evaluate,pageSnapshot,type Answer} from '../shared/protocol.js';
import {recoverQuestionnaireProgress} from '../shared/questionnaire-progress.js';
import {questionnaireCapacity} from '../shared/questionnaire-capacity.js';
import type {ParticipantAPI} from './participant-api.js';
import {el} from './dom.js';
import {mountAdaptivePage} from './adaptive-page.js';
import {pageIntroduction,isConnectionFailure,errorCode,participantError} from './participant-ui.js';

/** One upload owner, with a server-position fence and durable local UI cursor. */
export async function mountAdaptiveSurvey(content:HTMLElement,status:HTMLElement,api:ParticipantAPI,options:{
  error:(error:unknown)=>void;complete:()=>Promise<void>;
  reconnect:()=>Promise<void>;screen?:(id:string|undefined)=>void;
}){
  await api.ledger.drain();
  const protocol=api.session.frozen.protocol,local=await api.ledger.state();
  const restored=recoverQuestionnaireProgress(protocol.pages,api.session,local);
  const {answers,path}=restored;
  const panel=el('div',undefined,'adaptive-survey'),save=el('div',undefined,'adaptive-save');
  const saveText=el('p'),budgetText=el('p'),copy=el('div'),retry=el('button','重试保存');retry.type='button';retry.hidden=true;budgetText.hidden=true;saveText.hidden=true;save.hidden=true;
  saveText.setAttribute('role','status');saveText.setAttribute('aria-live','polite');copy.append(saveText,budgetText);save.append(copy,retry);
  const mount=el('div',undefined,'survey-mount');panel.append(save,mount);content.replaceChildren(panel);
  let disposed=false,disposePage:()=>void=()=>{},running=false,requested=false,finishing=false;
  let timer:ReturnType<typeof setTimeout>|undefined;
  let retryAttempts=0,retryDelay=15000;
  let editIndex=restored.page_index;
  const total=protocol.pages.reduce((n,p)=>n+p.questions.length,0);
  const baseStatus=protocol.mode==='TEST_ONLY'?'测试模式':'';
  status.textContent=baseStatus;
  function showMessages(){
    save.hidden=saveText.hidden&&budgetText.hidden&&retry.hidden;
    panel.classList.toggle('adaptive-has-message',!save.hidden);
  }
  function note(text:string,canRetry=false){
    if(disposed)return;
    saveText.hidden=!finishing&&!canRetry;
    const visible=saveText.hidden?'':text;
    if(saveText.textContent!==visible)saveText.textContent=visible;
    retry.hidden=!canRetry;showMessages();
  }
  function retryable(error:unknown){return isConnectionFailure(error)||['ADMISSION_EXPIRED','SESSION_CAPACITY_FULL','SESSION_WAITING'].includes(errorCode(error));}
  function confirmed(){return `服务器已确认保存 ${Math.round(api.session.page_index/Math.max(1,protocol.pages.length)*100)}%。`;}
  function queuedRetry(){
    clearTimeout(timer);
    const next=new Date(Date.now()+retryDelay).toLocaleTimeString('zh-CN',{hour12:false});
    note(`${finishing?confirmed()+'完成状态尚未确认，请保留页面。':'答案已保存在本机。'}系统将于 ${next} 自动重试，联网后立即尝试。`,true);
    timer=setTimeout(trigger,retryDelay);
  }
  async function upload(){
    if(running||disposed)return;running=true;retry.disabled=true;
    try{
      do{
        requested=false;await api.ledger.drain();
        if(!navigator.onLine){note('答案已保存在本机，联网后自动上传。',true);break;}
        note(finishing?confirmed()+'正在同步剩余答案，请等到完成后关闭页面。':'本机已保存，正在后台同步…');
        await api.refresh();
        if(api.session.state==='COMPLETED'){await options.complete();break;}
        // Reacquire an expired connection without replacing the active form.
        let admitted=false;try{api.admission?.check();admitted=!!api.admission;}catch{}
        if(!admitted)await options.reconnect();
        let m=await api.ledger.state();
        // A lost seal response may leave the server ahead of the local receipt.
        // Validate and copy the server's exact seal instead of reopening a scope.
        for(const seal of api.session.seals){const scope=seal.manifest.scope;if(m.pending[scope]&&!m.pending[scope]!.seal)await api.ledger.seal(scope,seal);}
        for(;;){
          if(disposed)break;
          const page=protocol.pages[api.session.page_index];if(!page)break;
          await api.sync(page.id);
          m=await api.ledger.state();
          if(!m.pending[page.id])break;
          await api.seal(page.id);
          if(finishing)note(confirmed()+'正在确认保存，请等候。');
        }
        if(disposed)break;
        const pending=await api.ledger.batch();
        note(pending.length?'答案已保存在本机，等待按顺序上传。':'当前答案已同步至服务器。');
        if(finishing&&api.session.page_index===protocol.pages.length){
          // Full completion is gated on all exact-set seals and finalization.
          note(confirmed()+'正在确认完成，请保留页面。');await options.complete();break;
        }
        retryAttempts=0;retryDelay=15000;
      }while(requested&&!disposed);
    }catch(error){
      if(!disposed){
        if(retryable(error)){
          retryDelay=Math.min(60000,15000*2**Math.min(retryAttempts++,2));
          if(['SESSION_CAPACITY_FULL','SESSION_WAITING'].includes(errorCode(error)))retryDelay=60000;
          note(isConnectionFailure(error)?'答案已保存在本机，连接恢复后自动上传。':participantError(error,'save'),true);
        }
        else options.error(error);
      }
    }finally{running=false;retry.disabled=false;
      if(requested&&!disposed){requested=false;schedule();}
      else if(retry.hidden===false&&!disposed)queuedRetry();
    }
  }
  function trigger(){clearTimeout(timer);requested=true;void upload();}
  function schedule(){clearTimeout(timer);timer=setTimeout(trigger,700);}
  function offline(){note(`答案已保存在本机，联网后自动上传。${finishing?'请等到显示完成后再关闭页面。':''}`,true);}
  function reconnect(){retryAttempts=0;retryDelay=15000;trigger();}
  retry.addEventListener('click',reconnect);window.addEventListener('online',reconnect);window.addEventListener('offline',offline);
  async function showCapacity(scope:string){
    const capacity=questionnaireCapacity(await api.ledger.scopeUsage(scope));
    budgetText.hidden=!capacity.warning;
    budgetText.textContent=capacity.readonly?'本段修改已接近保存上限，当前已保存答案可继续提交。':'本段反复修改较多，请核对后继续，避免达到保存上限。';
    showMessages();
    return capacity;
  }
  async function show(){
    if(disposed)return;
    await api.ledger.drain();const state=await api.ledger.state();
    while(editIndex<protocol.pages.length){
      const page=protocol.pages[editIndex]!;
      if(state.pending[page.id]||editIndex<api.session.page_index){editIndex++;continue;}
      if(!evaluate(page.condition,answers)){for(const q of page.questions)answers[q.id]=null;editIndex++;continue;}
      break;
    }
    disposePage();
    const page=protocol.pages[editIndex];
    if(!page){finishing=true;mount.replaceChildren(el('p','作答已结束，正在确认保存。请在显示完成后关闭页面。','adaptive-waiting'));trigger();return;}
    const offset=protocol.pages.slice(0,editIndex).reduce((n,p)=>n+p.questions.length,0);
    const values=state.page_values[page.id]??{};
    const capacity=await showCapacity(page.id);
    const preceding={...answers};for(const q of page.questions)delete preceding[q.id];
    disposePage=mountAdaptivePage(mount,page,preceding,values,async(name,answer,data)=>{
      const row=await api.ledger.append(page.id,'PAGE_REVISION',{question_id:name,answer},undefined,data);
      await showCapacity(page.id);
      note(navigator.onLine?'本机已保存，正在后台同步…':'答案已保存在本机，联网后自动上传。',!navigator.onLine);schedule();return row;
    },async data=>{
      await api.ledger.drain();
      const checked=pageSnapshot(page,preceding,data);
      await api.ledger.append(page.id,'PAGE_SNAPSHOT',{answers:data},[...path,page.id],data);
      path.push(page.id);Object.assign(answers,Object.fromEntries(Object.entries(checked).map(([id,v])=>[id,v.answer])));
      editIndex++;await show();trigger();
    },{
      offset,total,last:editIndex===protocol.pages.length-1,readonly:capacity.readonly,
      start:state.survey_cursor?.scope===page.id?state.survey_cursor.question_id:undefined,
      history:state.survey_cursor?.scope===page.id?state.survey_cursor.history:undefined,
      introduction:pageIntroduction(protocol.title,page.title,page.instruction),
      cursor:(id,history)=>api.ledger.surveyCursor(page.id,id,history),error:options.error,screen:options.screen
    });
  }
  await show();schedule();
  return()=>{disposed=true;disposePage();clearTimeout(timer);window.removeEventListener('online',reconnect);window.removeEventListener('offline',offline);};
}
