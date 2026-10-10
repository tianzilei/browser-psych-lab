import { evaluate, copyAnswer, axisAnswers, answerMissing, inputMatchRegex, inputMatchMessage, type Page, type Answer, type Question } from '../shared/protocol.js';
import { el } from './dom.js';
import { TextPager } from './text-pager.js';
import { scaleInput } from './scale-input.js';

type Answers = Record<string, Answer>;
const copy = copyAnswer;
const snapshot = (answers: Answers): Answers => Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, copy(answer)]));

export function mountPage(element: HTMLDivElement, page: Page, previous: Answers, values: Answers,
  revision: (name: string, answer: Answer, data: Answers) => void, complete: (data: Answers) => void,
  options: { key: string; title: string }) {
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
    for (let columns = 1; columns <= maxColumns; columns++) {
      const rows = Math.ceil(buttons.length / columns);
      if ((answerArea.clientHeight - 6 * (rows - 1)) / rows < 44) continue;
      answerArea.style.setProperty('--choice-columns', String(columns));
      answerArea.style.setProperty('--choice-rows', String(rows));
      if (controlsFit([...buttons, ...buttons.map(b => b.firstElementChild as HTMLElement)])) return true;
    }
    return false;
  }
  function render(focus = false) {
    if (disposed) return;
    form.style.setProperty('--survey-top',`${element.getBoundingClientRect().top+scrollY}px`);
    const q = question();
    if (q?.type === 'text' && editing) { navigation(); return; }
    screen.classList.toggle('reading-only', !q);
    screen.classList.toggle('selection-question', q?.type !== 'text' && !!q);
    screen.classList.toggle('single-axis-question', q?.type === 'scale');
    screen.classList.toggle('multi-axis-question', q?.type === 'scales');
    fits = pager.show();
    if (layoutProblem) { message.textContent = ''; layoutProblem = false; }
    progress.textContent = !q ? `研究说明 · 第 ${pager.number} 段`
      : `题目 ${visible.indexOf(current) + 1}/${visible.length}${pager.more || pager.back ? ` · 题干第 ${pager.number} 段` : ''}`;
    const reuse=controlQuestion===q&&fits&&!pager.more&&(q?.type==='scale'||q?.type==='scales')&&!!answerArea.querySelector('.axis-control');
    if(!reuse)answerArea.replaceChildren();answerArea.className = 'answer-area';
    answerArea.style.removeProperty('--choice-columns'); answerArea.style.removeProperty('--choice-rows');
    if (fits && q && !pager.more) {
      if (q.type === 'text') answerArea.append(input(q));
      else if (q.type === 'scale') {
        const axis = reuse?answerArea.firstElementChild as HTMLElement:scaleInput(q, answers[q.id], value => save(q, value));if(!reuse)answerArea.append(axis);
        fits = controlsFit([axis, ...axis.querySelectorAll<HTMLElement>('.axis-ends span,input,output,button')]);
      } else if(q.type==='scales'){
        const axes=reuse?Array.from(answerArea.querySelectorAll<HTMLElement>('.axis-control')):q.axes!.map(axis=>{const node=scaleInput({...axis,id:`${q.id}-${axis.id}`,required:q.required},axisAnswers(answers[q.id])[axis.id],value=>{
          const values=Object.fromEntries(q.axes!.map(axis=>[axis.id,axisAnswers(answers[q.id])[axis.id]??null]));values[axis.id]=value;save(q,values);
        });node.prepend(el('span',axis.title,'axis-title'));node.dataset.axisId=axis.id;return node;});
        answerArea.classList.add('axes-grid');if(!reuse)answerArea.append(...axes);fits=false;
        for(let columns=1;columns<=Math.min(3,Math.floor(answerArea.clientWidth/240)||1);columns++){
          answerArea.style.setProperty('--axis-columns',String(columns));answerArea.style.setProperty('--axis-rows',String(Math.ceil(axes.length/columns)));
          if(controlsFit([...axes,...axes.flatMap(axis=>Array.from(axis.querySelectorAll<HTMLElement>('.axis-title,.axis-ends span,input,output,button')))])){fits=true;break;}
        }
      } else fits = renderChoices(q);
    }
    if (!fits) {
      layoutProblem = true; message.textContent = '内容放不下，请调整设备或缩短文字。';
      answerArea.replaceChildren(el('p', '请调整设备方向或联系研究者。所有选项须在同一屏完整显示。'));
      answerArea.className = 'answer-area';
      answerArea.style.removeProperty('--choice-columns'); answerArea.style.removeProperty('--choice-rows');
    }
    controlQuestion=fits&&!pager.more?q:undefined;
    navigation(); if (focus) reading.focus({ preventScroll: true });
  }
  function show(index: number) {
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
    editing=false;document.body.classList.remove('typing');
    current = index; layoutProblem = false; message.textContent = '';
    sessionStorage.setItem(options.key, page.questions[index]?.id ?? ''); makePager(); render(true);
  }
  function validate(index: number) {
    const q = page.questions[index];
    if (q?.required && answerMissing(q,answers[q.id])) { message.textContent = q.type==='scales'?'请完成每个坐标轴后继续。':q.type === 'scale' ? '请选择分值后继续。' : q.type === 'text' ? '请填写个人信息后继续。' : '请选择答案后继续。'; return false; }
    if (q?.type === 'text' && typeof answers[q.id] === 'string' && (answers[q.id] as string).length > q.max_length!) {
      message.textContent = `最多 ${q.max_length} 个字符。`; return false;
    }
    if (q?.type === 'text' && typeof answers[q.id] === 'string' && q.input_match && !inputMatchRegex(q.input_match).test(answers[q.id] as string)) {
      message.textContent = inputMatchMessage(q.input_match); return false;
    }
    return true;
  }
  function forward() {
    if (composing || (!fits && !editing)) return;
    if (editing) { editing=false;document.body.classList.remove('typing');inputs.get(question()!.id)?.blur();requestResize();return; }
    if (pager.more) { pager.next(); render(true); return; }
    if (current < 0 && visible.length) { show(visible[0]!); return; }
    if (current >= 0 && !validate(current)) return;
    visibility(); const nextIndex = visible.find(i => i > current);
    if (nextIndex !== undefined) { show(nextIndex); return; }
    const missing = visible.find(i => page.questions[i]!.required && answerMissing(page.questions[i]!,answers[page.questions[i]!.id]));
    if (missing !== undefined) { show(missing); validate(missing); return; }
    submitting = true; navigation(); complete(snapshot(answers));
  }
  function backward() {
    if (composing) return;
    if (pager.back) { pager.previous(); render(true); return; }
    show(visible.filter(i => i < current).at(-1) ?? -1);
  }
  function navigate(action: () => void) {
    if (submitting || navigating || composing) return;
    navigating = true; action(); if (disposed) return; navigation();
    unlock = setTimeout(() => { navigating = false; if (!disposed) navigation(); }, 200);
  }
  next.addEventListener('click', () => navigate(forward)); back.addEventListener('click', () => navigate(backward));
  form.addEventListener('submit', event => { event.preventDefault(); navigate(forward); });
  answerArea.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...answerArea.querySelectorAll<HTMLButtonElement>('.choice-button')];
    if (!buttons.length) return;
    event.preventDefault(); const old = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (old + (event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1) + buttons.length) % buttons.length;
    buttons[index]!.focus({ preventScroll: true });
  });
  function requestResize() {
    if (!resizeFrame) resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; render(); });
  }
  makePager(); render();
  const observer = new ResizeObserver(requestResize); observer.observe(screen);
  return () => {
    disposed = true; observer.disconnect(); cancelAnimationFrame(resizeFrame); clearTimeout(unlock);
    document.body.classList.remove('typing');
  };
}
