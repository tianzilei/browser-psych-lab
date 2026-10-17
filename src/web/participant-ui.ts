import {el,button} from './dom.js';
import {RequestError} from './request-error.js';

export const ui={
  retrySave:'重试保存',returnSurvey:'返回问卷',home:'返回主页',cancel:'取消并返回',
  startTask:'准备任务',startGroup:'开始本组',nextQuestion:'下一题',submitRating:'提交评分',
  saving:'正在保存…',completed:'研究已完成，数据已保存。',
  capacity:'当前参加名额已满，请约 30 分钟后重试。',
  duplicateTab:'此问卷已在其他页面打开。请回到原页面继续作答，此页只读。',
  scaleHint:'点击或拖动滑块选择评分',
} as const;

export function showDuplicateTab(status:HTMLElement,content:HTMLElement){
  status.textContent=ui.duplicateTab;
  content.replaceChildren(button('重新尝试',()=>location.reload(),'primary'));
}

const errors:Record<string,string>={
  SESSION_CAPACITY_FULL:ui.capacity,PREPARATION_CAPACITY_FULL:ui.capacity,
  ADMISSION_EXPIRED:'作答连接已过期，请重新进入。',
  ADMISSION_PAUSED:'此问卷暂未开放，请稍后再试。',COLLECTION_GATE_CLOSED:'此问卷暂未开放，请联系研究者。',
  VERSION_NOT_FOUND:'此问卷链接已失效，请返回主页选择问卷。',
  UNAUTHORIZED:'无法确认作答身份，请使用原浏览器重新打开参与链接。',
  WRITER_FENCED:ui.duplicateTab,RUN_LOCKED:'已有任务正在运行，请回到原页面继续。',
  SESSION_TERMINAL:'本次作答已结束，请返回问卷查看保存状态。',
  RESERVATION_EXPIRED:'任务准备已过期，请返回问卷重新准备。',
  PREPARATION_UNAVAILABLE:'暂时无法准备任务，请返回问卷核对进度。',
  RUNNER_VERSION_UNAVAILABLE:'此任务版本暂时不可用，请联系研究者。',
  ENVIRONMENT_NOT_READY:'当前设备未满足任务要求，请调整设备后重新准备。',
  INVALID_GEOMETRY:'当前屏幕无法完整显示任务，请调整设备后重新准备。',
  RESOURCE_NOT_READY:'任务图片暂时不可用，请联系研究者。',
  PAGES_NOT_SEALED:'问卷尚未保存完成，请返回问卷重试保存。',
  PREVIOUS_STAGE_UNSEALED:'上一部分尚未保存完成，请返回问卷重试保存。',
  REPLAY_REQUIRED:'任务记录尚未核对完成，请重试保存。',
  REPLAY_PROOF_STALE_OR_INVALID:'任务记录核对未通过，请联系研究者。',
  RECONCILIATION_MISMATCH:'记录核对未通过，请保留此浏览器中的记录并联系研究者。',
  CUSTODY_RECEIPT_MISMATCH:'记录保存凭证不一致，请保留此浏览器中的记录并联系研究者。',
  ENVIRONMENT_RECEIPT_MISMATCH:'设备信息保存凭证不一致，请保留此浏览器中的记录并联系研究者。',
  SAVE_NOT_CONFIRMED:'记录保存尚未确认，请重试保存。',
  LOCAL_QUESTIONNAIRE_PATH_CONFLICT:'本机作答路径与保存记录不一致，请保留此浏览器中的记录并联系研究者。',
  LOCAL_QUESTIONNAIRE_EDIT_LIMIT:'本段修改量已达到保存上限，已有记录仍保留。重试保存可恢复已保存的答案；若仍无法完成，请联系研究者。',
  SCOPE_BUDGET_EXCEEDED:'操作记录超过保存上限，保存尚未完成。请保留当前页面并联系研究者。',
  COMPLETION_NOT_CONFIRMED:'本次作答尚未完成保存，请重试保存。',
};
export function errorCode(error:unknown){
  return error instanceof RequestError?error.code:error instanceof Error?error.message.split('：')[0]!:'';
}
export function isConnectionFailure(error:unknown){
  return error instanceof Error&&(error.name==='TimeoutError'||error.name==='NetworkError'
    ||error instanceof TypeError&&/fetch|network|load/i.test(error.message)
    ||error instanceof RequestError&&[429,503].includes(error.status));
}
export function participantError(error:unknown,context:'save'|'prepare'|'enter'='save'){
  const code=errorCode(error);
  if(errors[code])return errors[code]!;
  if(error instanceof Error){
    if(error.name==='SESSION_WAIT_CANCELED')return '已取消进入，可以重新进入问卷。';
    if(error.name==='QuotaExceededError')return '浏览器存储空间不足，无法继续保存。请保留此浏览器中的记录并联系研究者。';
    if(['InvalidStateError','UnknownError','NotReadableError'].includes(error.name))return '浏览器无法保存记录，请保留此浏览器中的记录并联系研究者。';
    if(isConnectionFailure(error))return context==='save'?'暂时无法连接服务器，保存尚未确认。请检查网络后重试。':'暂时无法连接服务器，请检查网络后重试。';
    // Locally authored explanations are already participant-facing. Codes and
    // browser internals remain in the expandable diagnostic instead.
    if(!(error instanceof RequestError)&&/[\u3400-\u9fff]/u.test(error.message))return error.message;
  }
  return context==='save'?'保存尚未完成，请重试。若仍无法保存，请联系研究者。':context==='enter'?'问卷暂时无法打开，请重试。若仍无法打开，请联系研究者。':'任务准备未完成，请重试。若仍无法开始，请联系研究者。';
}
export function errorDetails(error:unknown){
  const diagnostic=error instanceof RequestError?`HTTP ${error.status}\n${error.code}${error.details===undefined?'':`\n${JSON.stringify(error.details,null,2)}`}`:error instanceof Error?`${error.name}：${error.message}`:String(error);
  const details=el('details',undefined,'error-details');details.append(el('summary','查看错误详情'),el('pre',diagnostic));return details;
}
export function interruptionMessage(reason:unknown){
  const code=reason instanceof Error?reason.message:String(reason);
  if(code==='USER_IDLE_TIMEOUT')return '连续 2 分钟未操作，本组已中断。';
  if(code==='CONNECTION_TIMEOUT')return '长时间无法连接服务器，本组已中断。';
  if(['VISIBILITY_OR_GEOMETRY_CHANGED','VISUAL_VIEWPORT_CHANGED','PAGE_HIDDEN_OR_CLOSED'].includes(code))return '页面已隐藏或显示区域发生变化，本组已中断。';
  if(code==='LONG_FRAME')return '设备未能保持任务要求的显示节奏，本组已中断。';
  return '本组已中断。';
}
/** Deduplicate metadata only for display; never rewrite the frozen protocol. */
export function pageIntroduction(title:string,pageTitle:string,instruction:string){
  const key=(value:string)=>value.replace(/\s+/gu,' ').trim(),blocks:string[]=[];
  // Older CSV imports stored replacement characters around the page number.
  // Repair that known title shape for display while preserving frozen records.
  const readablePageTitle=pageTitle.replace(/\uFFFD{2}第 ([1-9][0-9]*) 页\uFFFD{2}$/u,'（第 $1 页）');
  if(key(readablePageTitle)&&key(readablePageTitle)!==key(title))blocks.push(readablePageTitle);
  // Keep an authored instruction even when it equals the global title. It may
  // be the only instruction. Identical page title + instruction appear once.
  if(key(instruction)&&!blocks.some(block=>key(block)===key(instruction)))blocks.push(instruction);
  return blocks.join('\n\n');
}
