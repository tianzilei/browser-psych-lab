当前交互源码第 1 段。连续片段，请与前后段拼接阅读。本阶段只回复 ACK_INTERACTION_01。


=== FILE src/web/participant.ts (complete source; may continue in next chunk) ===
```
import './participant.css';
import './compat.js';
import {applyParticipantBackground} from './participant-theme.js';
import {lockParticipantViewport} from './viewport.js';
import {el,button,uid} from './dom.js';
import {ParticipantAPI} from './participant-api.js';
import {cancelAdmission} from './session-gate.js';
import {mountEnding} from './ending-page.js';
import {recordInteractions} from './interaction-recorder.js';
import {downloadEstimate,downloadSize} from '../shared/download-estimate.js';
import type {Answer} from '../shared/protocol.js';
import {ui,participantError,errorDetails,errorCode,isConnectionFailure} from './participant-ui.js';
const version=new URLSearchParams(location.search).get('version')??'';
const title=document.querySelector<HTMLHeadingElement>('#title')!,status=document.querySelector<HTMLParagraphElement>('#status')!,content=document.querySelector<HTMLDivElement>('#content')!;
const writer=sessionStorage.getItem(`lab-writer-${version}`)??uid();sessionStorage.setItem(`lab-writer-${version}`,writer);let api:ParticipantAPI|null=null,owned=false,busy=false;
let admissionController:AbortController|undefined;
let disposePage:(()=>void)|undefined;
let recorder:ReturnType<typeof recordInteractions>|undefined,question_id:string|undefined;
let waitingForRecovery=false,recoverOnOnline=false;
lockParticipantViewport();
function recovery(error:unknown){
  recorder?.stop();recorder=undefined;
  disposePage?.();disposePage=undefined;void api?.stopAdmission();
  waitingForRecovery=true;recoverOnOnline=isConnectionFailure(error);
  status.textContent=participantError(error,api?'save':'enter');
  const capacity=['SESSION_CAPACITY_FULL','PREPARATION_CAPACITY_FULL'].includes(errorCode(error));
  const retry=button(capacity?'稍后重试':!api||admissionController?.signal.aborted?'重新进入':ui.retrySave,()=>action(restore),'primary');
  const actions=el('div',undefined,'recovery-actions');actions.append(retry,errorDetails(error));content.replaceChildren(actions);
}
async function action(fn:()=>Promise<void>){if(busy)return;busy=true;try{await fn();}catch(error){recovery(error);}finally{busy=false;}}async function restore(){waitingForRecovery=false;recoverOnOnline=false;recorder?.stop();recorder=undefined;disposePage?.();disposePage=undefined;if(!owned){status.textContent=ui.duplicateTab;content.replaceChildren();return;}api??=await ParticipantAPI.open(version,writer);await api.stopAdmission();await api.refresh();const s=api.session;applyParticipantBackground(s.frozen.protocol.layout.background);title.textContent=s.frozen.protocol.title;
  if(s.state==='COMPLETED'){await api.sync();status.textContent=ui.completed;disposePage=mountEnding(content,s.frozen.protocol.ending);return;}
  if(s.state==='TERMINATED'){status.textContent='本次作答已中断，正在保存已有记录…';await api.reconcile();status.textContent='本次作答已中断，已有记录已保存。';const again=button('重新作答',()=>action(async()=>{await api!.reanswer();for(const key of Object.keys(sessionStorage))if(key.startsWith(`lab-step-${version}-`))sessionStorage.removeItem(key);location.reload();}),'primary');content.replaceChildren(again,el('p','重新作答将创建新答卷，原答卷及其关联记录会保留。','support-text'));return;}
  if(!owned){status.textContent=ui.duplicateTab;content.replaceChildren();return;}
  if(s.permit?.state==='ISSUED'&&!(await api.ledger.state()).pending[s.permit.scope]){if(s.task_activity){status.textContent='任务已中断，正在保存已有记录…';await api.terminate('UNKNOWN_RUN');await api.sync();await restore();return;}status.textContent='上次任务未正常结束，请先结束该任务并保存已有记录。';content.replaceChildren(button('结束中断的任务',()=>action(async()=>{await api!.terminate('UNKNOWN_RUN');await api!.sync();await restore();})));return;}
  admissionController=new AbortController();const controller=admissionController;
  status.textContent='正在准备问卷…';content.replaceChildren(button(ui.cancel,()=>{cancelAdmission(controller);location.assign('/');}));
  await api.enter(controller.signal,text=>status.textContent=text,error=>{controller.abort(error);recovery(error);});
  await api.claim();recorder=recordInteractions(document.querySelector('main')!,()=>({page_id:api!.session.frozen.protocol.pages[api!.session.page_index]?.id,question_id}),batch=>api!.ledger.interaction(batch),recovery);const m=await api.ledger.state();for(const [scope,p]of Object.entries(m.pending))if(!p.seal)await api.seal(scope);
  await api.refresh();const page=api.session.frozen.protocol.pages[api.session.page_index];
  if(page){status.textContent=[api.session.frozen.protocol.mode==='TEST_ONLY'?'测试模式':'',api.session.frozen.protocol.pages.length>1?`第 ${api.session.page_index+1}/${api.session.frozen.protocol.pages.length} 页`:''].filter(Boolean).join(' · ');const mount=el('div');mount.className='survey-mount';content.replaceChildren(mount);
    const {mountPage}=await import('./survey-page.js');const local=(await api.ledger.state()).page_values[page.id]??{};
    disposePage=mountPage(mount,page,api.session.answers,local,(name,answer,data)=>{try{api!.admission?.check();}catch(error){recovery(error);return;}void api!.ledger.append(page.id,'PAGE_REVISION',{question_id:name,answer},undefined,data).catch(recovery);},data=>{void action(async()=>{api!.admission?.check();recorder?.stop();recorder=undefined;disposePage?.();status.textContent=ui.saving;content.replaceChildren();await api!.ledger.append(page.id,'PAGE_SNAPSHOT',{answers:data},[...api!.session.path,page.id]);await api!.seal(page.id);await restore();});},{key:`lab-step-${version}-${page.id}`,title:api.session.frozen.protocol.title,screen:id=>{question_id=id;recorder?.screen();}});return;
  }
  if(api.session.group_index<api.session.frozen.protocol.groups.length){const bytes=downloadEstimate(s.frozen,s.group_index);status.textContent=bytes?`接下来进行任务，需下载约 ${downloadSize(bytes)}。`:'接下来进行任务。';content.replaceChildren(button(ui.startTask,()=>{const base=import.meta.env.DEV?'/':`/runners/${api!.session.frozen.runner_hash}/`;location.href=`${base}run.html?version=${version}`;},'primary'));return;}
  recorder?.stop();recorder=undefined;status.textContent=ui.saving;await api.stopAdmission();await api.complete();status.textContent=ui.completed;disposePage=mountEnding(content,api.session.frozen.protocol.ending);
}
window.addEventListener('online',()=>{if(owned&&waitingForRecovery&&recoverOnOnline)void action(restore);});
window.addEventListener('pagehide',()=>{recorder?.stop();admissionController?.abort(new Error('页面已关闭。'));if(owned&&api?.session.state==='ACTIVE'&&api.session.permit?.state!=='ISSUED')void fetch(api.path('release'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request_id:uid(),...api.fence()}),keepalive:true});});
if(!version||!navigator.locks||!crypto.subtle){status.textContent=!navigator.locks?'当前浏览器无法保证单页面作答，请使用支持 Web Locks 的浏览器和 HTTPS 链接。':'参与链接或浏览器能力不完整，无法开始。';}
else void navigator.locks.request(`lab-version-${version}`,{ifAvailable:true},async lock=>{owned=!!lock;await action(restore);if(lock)await new Promise<void>(resolve=>window.addEventListener('pagehide',()=>{owned=false;api?.ledger.db.close();resolve();},{once:true}));});

```


=== FILE src/web/survey-page.ts (complete source; may continue in next chunk) ===
```
import { evaluate, copyAnswer, axisAnswers, answerMissing, inputMatchRegex, inputMatchMessage, type Page, type Answer, type Question } from '../shared/protocol.js';
import { el } from './dom.js';
import { TextPager } from './text-pager.js';
import { scaleInput } from './scale-input.js';
import { pageIntroduction } from './participant-ui.js';

type Answers = Record<string, Answer>;
const copy = copyAnswer;
const snapshot = (answers: Answers): Answers => Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, copy(answer)]));

export function mountPage(element: HTMLDivElement, page: Page, previous: Answers, values: Answers,
  revision: (name: string, answer: Answer, data: Answers) => void, complete: (data: Answers) => void,
  options: { key: string; title: string; screen?:(question_id:string|undefined)=>void }) {
  const invalid = page.questions.find(q => q.type === 'text' && q.input_purpose !== 'personal' || q.type === 'scale' && (!q.min_label?.trim() || !q.max_label?.trim()));
  if (invalid) {
    element.replaceChildren(el('p', invalid.type === 'scale' ? '此版本未配置量表两端文字，请联系研究者更新问卷。' : '此版本含未标记为个人信息的文字题，请联系研究者更新问卷。'));
    return () => {};
  }
  const answers: Answers = {}, visible: number[] = [], inputs = new Map<string, HTMLInputElement>();
  for (const q of page.questions) if (values[q.id] !== undefined) answers[q.id] = copy(values[q.id]!);
  const effective = { ...previous };
  function visibility() {
    visible.length = 0;
    page.questions.forEach((q, i) => {
      const shown = evaluate(q.condition, effective);
      if (shown) visible.push(i);
      effective[q.id] = shown ? answers[q.id] ?? null : null;
    });
  }
  visibility();
  const form = el('form', undefined, 'questionnaire'); form.noValidate = true;
  const progress = el('p', undefined, 'question-progress'), message = el('p', undefined, 'question-error');
  message.setAttribute('role', 'alert');
  const top = el('div', undefined, 'question-meta'); top.append(progress, message);
  const screen = el('div', undefined, 'question-screen');
  const reading = el('div', undefined, 'reading-text'); reading.id = 'question-text'; reading.tabIndex = -1;
  const answerArea = el('div', undefined, 'answer-area'); answerArea.setAttribute('role', 'group'); answerArea.setAttribute('aria-labelledby', reading.id);
  screen.append(reading, answerArea);
  const nav = el('div', undefined, 'question-nav'), back = el('button', '上一题'), next = el('button');
  back.type = next.type = 'button'; nav.append(back, next); form.append(top, screen, nav); element.replaceChildren(form);
  let current = -1, layoutProblem = false, controlQuestion:Question|undefined;
  let pager: TextPager, submitting = false, composing = false, navigating = false, disposed = false, fits = true, editing = false;
  let unlock: ReturnType<typeof setTimeout> | undefined, resizeFrame = 0;
  const saved = sessionStorage.getItem(options.key);
  if (saved) { const index = page.questions.findIndex(q => q.id === saved); if (visible.includes(index)) current = index; }
  const question = () => page.questions[current];
  const intro = pageIntroduction(options.title,page.title,page.instruction);
  if(current<0&&!intro&&visible.length)current=visible[0]!;
  next.className='primary';
  const choices = (q: Question) => q.choices ?? [];
  function selected(q: Question, label: string) {
    const value = answers[q.id];
    return q.type === 'multi' ? Array.isArray(value) && value.includes(label) : value === label;
  }
  function save(q: Question, answer: Answer) {
    const old = answers[q.id];
    const changed = Array.isArray(answer) ? !Array.isArray(old) || answer.length !== old.length || answer.some((a, i) => a !== old[i])
      : answer&&typeof answer==='object'?Object.keys(answer).some(key=>answer[key]!==axisAnswers(old)[key])||Object.keys(answer).length!==Object.keys(axisAnswers(old)).length:answer !== old;
    if (!changed || submitting) return;
    answers[q.id] = copy(answer); message.textContent = '';
    revision(q.id, copy(answer), snapshot(answers));
    if (!composing) visibility();
    navigation();
  }
  function choose(q: Question, label: string) {
    if (submitting) return;
    const picked = selected(q, label);
    save(q, q.type === 'multi' ? choices(q).filter(c => c === label ? !picked : selected(q, c))
      : picked && !q.required ? null : label);
    for (const button of answerArea.querySelectorAll<HTMLButtonElement>('.choice-button'))
      button.setAttribute('aria-pressed', String(selected(q, button.dataset.choice!)));
  }
  function makePager() {
    const q = question();
    const text = q ? q.title : intro;
    pager = new TextPager(text, reading);
  }
  function input(q: Question) {
    let node = inputs.get(q.id);
    if (node) return node;
    node = el('input'); node.type = 'text'; node.name = q.id; node.maxLength = q.max_length!;
    // Native pattern validation has implicit Unicode `v` semantics and has no
    // equivalent for the JS `i`/`m` flags. Keep it as an optimization only for
    // flagless matches; the shared JS matcher remains authoritative.
    if (q.input_match) {
      node.title = inputMatchMessage(q.input_match);
      if (q.input_match.kind === 'preset' || !q.input_match.flags) node.pattern = inputMatchRegex(q.input_match).source;
    }
    node.value = typeof answers[q.id] === 'string' ? answers[q.id] as string : '';
    node.setAttribute('aria-label', q.title); node.autocomplete = 'off'; node.enterKeyHint = 'done';
    const update = () => save(q, node!.value);
    node.addEventListener('input', update); node.addEventListener('change', update);
    node.addEventListener('compositionstart', () => { composing = true; });
    node.addEventListener('compositionend', () => { composing = false; update(); visibility(); });
    node.addEventListener('focus', () => { editing=true;document.body.classList.add('typing');form.style.setProperty('--survey-top',`${element.getBoundingClientRect().top+scrollY}px`); next.textContent = '完成输入'; });
    // Keep the input layout until the explicit Done action. Changing geometry
    // on blur can move the button between pointerdown and click.
    node.addEventListener('blur', requestResize);
    inputs.set(q.id, node); return node;
  }
  function navigation() {
    const q = question(), typing = editing;
    const last = current >= 0 && visible.indexOf(current) === visible.length - 1;
    next.textContent = typing ? '完成输入' : pager.more ? '阅读下一段'
      : !q ? visible.length ? '开始作答' : '提交本页' : last ? '提交本页' : '下一题';
    back.textContent = pager.back ? '阅读上一段' : current < 0 ? '上一段' : '上一题';
    back.hidden = !pager.back&&(current<0||!intro&&current===visible[0]);
    nav.classList.toggle('single-action',back.hidden);
    back.disabled = s