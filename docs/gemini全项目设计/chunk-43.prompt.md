全项目设计讨论，传输段 43，源码主题：页面交互和管理（源包 14/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

  const stage=el('div',undefined,'runner-stage'),slot=el('div',undefined,'canvas-slot'),controls=el('div',undefined,'response-buttons'),footer=el('div',undefined,'simulation-image-nav');
  if(entry.trial.text!==undefined)slot.append(el('p',entry.trial.text));else if(entry.trial.asset_id&&!entry.trial.asset_id.startsWith('preview-image-')){const image=el('img');image.src=`/api/lab/assets/${entry.trial.asset_id}`;image.alt='模拟图片';image.style.cssText='width:100%;height:100%;object-fit:contain';slot.append(image);}else slot.append(el('p','上传 ZIP 后可查看图片。'));
  for(const choice of entry.group.choices){const b=button(choice,()=>{for(const node of controls.children)node.setAttribute('aria-pressed',String(node===b));status.textContent=`模拟选择：${choice}`;});b.setAttribute('aria-pressed','false');controls.append(b);}
  if(entry.group.rating){slot.append(el('p',entry.group.rating.items?.[0]??entry.group.rating.prompt));for(const [i,b] of Array.from(controls.children).entries())b.setAttribute('aria-label',`评分 ${i+1}：${entry.group.rating.labels[i]}`);footer.append(el('p',`1 · ${entry.group.rating.labels[0]}；${entry.group.choices.length} · ${entry.group.rating.labels.at(-1)}`));}
  controls.style.setProperty('--response-columns',String(Math.min(3,entry.group.choices.length)));
  const previous=button('上一张',()=>{imageIndex--;render();});previous.disabled=imageIndex===0;
  footer.append(previous,button(imageIndex+1<images.length?'下一张':'完成模拟',()=>{imageIndex++;render();}),reset);stage.append(slot,controls,footer);content.append(stage);preventTaskGestures(stage);
}
window.addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==parent||event.data?.type!=='lab-simulation')return;try{p=parseProtocol(event.data.protocol);for(const group of p.groups)if(group.sampling){const seed=Array.from(crypto.getRandomValues(new Uint32Array(4))) as State;if(seed.every(n=>n===0))seed[0]=1;group.trials=sampleTrials(group.trials,group.sampling,seed).roots;}index=0;imageIndex=0;consented=false;answers={};values={};disposeOrientation?.();applyParticipantBackground(p.layout.background);if(p.layout.orientation){const gate=watchOrientation(p.layout.orientation);disposeOrientation=gate.dispose;void gate.passed.then(render);}else render();}catch{status.textContent='模拟 JSON 无效。';}});

```

### src/web/style.css L1–L44

```
:root { font-family: system-ui, sans-serif; color: #20342d; background: #f4f6f2; }
body { margin: 0; }
main { max-width: 920px; margin: 48px auto; padding: 0 20px; }
header { margin-bottom: 32px; }
h1 { font-size: clamp(28px, 5vw, 40px); letter-spacing: -.03em; margin: 12px 0; }
h2 { font-size: 20px; }
p { line-height: 1.7; }
.eyebrow { font-size: 12px; letter-spacing: .12em; color: #52685b; }
section { background: white; border: 1px solid #dce5dc; border-radius: 14px; padding: 24px; margin: 20px 0; }
ul { padding-left: 20px; line-height: 2; }
li[data-status="failed"] { color: #ad332f; }
canvas { max-width: 100%; border-radius: 8px; }
#canvas { height: auto; }
button { font: inherit; background: #20523e; color: white; border: 0; border-radius: 7px; padding: 10px 16px; cursor: pointer; }
button:disabled { opacity: .6; cursor: wait; }
button:focus-visible { outline: 3px solid #92b59f; outline-offset: 3px; }
fieldset { min-width: 0; border: 1px solid #dce5dc; margin-bottom: 20px; padding: 16px; }
label { display: block; padding: 10px 0; }
input[type="radio"] { margin-right: 10px; }
[hidden] { display: none !important; }
input:not([type=radio]):not([type=checkbox]),textarea,select { box-sizing:border-box; width:100%; font:inherit; color:inherit; border:1px solid #b7c8bc; border-radius:6px; padding:10px; background:white; }
textarea { resize:vertical; }
nav,.toolbar { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
nav { margin-bottom:24px; }
.secondary { background:#e7eee8; color:#20342d; }
.muted { color:#53685b; font-size:14px; }
.editor-card,article { padding:18px; border:1px solid #dce5dc; margin:16px 0; border-radius:10px; }
.trial-row { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:12px; align-items:end; }
.asset-row { display:flex; align-items:center; gap:16px; margin:12px 0; }
.asset-row img { width:80px; height:60px; object-fit:contain; }
pre { max-height:600px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; background:#eef3ed; padding:16px; }
.instruction { white-space:pre-wrap; }
.runner-stage { display:flex; flex-direction:column; align-items:center; gap:20px; }
.response-buttons { display:flex; gap:12px; width:100%; max-width:720px; touch-action:none; }
.response-buttons button { flex:1; min-height:56px; user-select:none; touch-action:none; }
#stimulus { border-radius:0; max-width:none; }
#evidence { word-break: break-all; max-height: 12rem; overflow-y: auto; user-select: text; }
body:has(#stimulus) main { margin:16px auto; padding:0 16px; }
body:has(#stimulus) #status { height:60px; overflow:hidden; }
.running { overflow:hidden; touch-action:none; overscroll-behavior:none; }
details { margin:20px 0; } summary { cursor:pointer; }
@media(max-width:600px){main{margin:24px auto;}section{padding:16px;}nav button{font-size:14px;padding:8px;} .response-buttons{gap:6px;} }
@media(orientation:landscape){body:has(#stimulus) main{margin:8px auto;}body:has(#stimulus) .eyebrow{display:none;}body:has(#stimulus) h1{font-size:20px;margin:8px 0;}body:has(#stimulus) #status{height:32px;margin:8px 0;}}

```

### src/web/survey-demo.ts L1–L17

```
import { Model } from 'survey-core';
import { renderSurvey } from 'survey-js-ui';
import 'survey-core/survey-core.min.css';

// This module and its CSS load only on explicit entry into the survey sample.
// Future timing groups must preload all required code before their start gate.
export function mountSurveyDemo(element: HTMLDivElement) {
  const survey = new Model({
    title: '依赖检查问卷',
    completeText: '结束渲染检查',
    completedHtml: '<p>依赖渲染测试已结束。答案未保存。</p>',
    elements: [{ type: 'radiogroup', name: 'component_check', title: '当前问卷是否正常显示？',
      isRequired: true, choices: ['正常显示', '需要检查'] }],
  });
  renderSurvey(survey, element);
}

```

### src/web/survey-page.ts L1–L234

```
import { evaluate, copyAnswer, axisAnswers, answerMissing, inputMatchRegex, inputMatchMessage, type Page, type Answer, type Question } from '../shared/protocol.js';
import { el } from './dom.js';
import { TextPager } from './text-pager.js';
import { scaleInput } from './scale-input.js';

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
  const intro = [options.title, page.title, page.instruction].filter(Boolean).join('\n\n');
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
    const text = q ? `${q.required ? '（必答）' : '（可选）'}${q.type === 'multi' ? ' 可多选' : ''}${q.type==='scales'?'':'\n'}${q.title}` : intro;
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
    back.disabled = submitting || navigating || (current < 0 && !pager.back);
    next.disabled = submitting || navigating || !fits;
  }
  function controlsFit(nodes: HTMLElement[]) {
    const area = answerArea.getBoundingClientRect();
    return nodes.every(node => {
      const r = node.getBoundingClientRect();
      return r.left >= area.left - 1 && r.right <= area.right + 1 && r.top >= area.top - 1 && r.bottom <= area.bottom + 1
        && node.scrollHeight <= node.clientHeight + 1 && node.scrollWidth <= node.clientWidth + 1;
    });
  }
  function renderChoices(q: Question) {
    const buttons = choices(q).map(label => {
      const button = el('button', undefined, 'choice-button'), span = el('span', label, 'choice-label');
      button.type = 'button'; button.dataset.choice = label; button.setAttribute('aria-label', label);
      button.setAttribute('aria-pressed', String(selected(q, label))); button.append(span);
      button.addEventListener('click', () => choose(q, label)); return button;
    });
    answerArea.classList.add('choices-grid'); answerArea.append(...buttons);
    const maxColumns = Math.max(1, Math.min(buttons.length, Math.floor(answerArea.clientWidth / 64)));