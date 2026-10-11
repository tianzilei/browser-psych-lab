当前交互源码第 2 段。连续片段，请与前后段拼接阅读。本阶段只回复 ACK_INTERACTION_02。
ubmitting || navigating || back.hidden;
    next.disabled = submitting || navigating || !fits;
  }
  function controlsFit(nodes: HTMLElement[]) {
    const area = answerArea.getBoundingClientRect();
    const bounds = screen.getBoundingClientRect();
    if(area.left<bounds.left-1||area.right>bounds.right+1||area.top<bounds.top-1||area.bottom>bounds.bottom+1)return false;
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
    progress.textContent = !q ? `作答说明${pager.more || pager.back ? ` · 第 ${pager.number} 段` : ''}`
      : `第 ${visible.indexOf(current) + 1}/${visible.length} 题 · ${q.required?'必答':'可选'}${q.type==='multi'?' · 可多选':''}${pager.more || pager.back ? ` · 题干第 ${pager.number} 段` : ''}`;
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
      layoutProblem = true; message.textContent = '当前屏幕无法完整显示本题。';
      answerArea.replaceChildren(el('p', '请调整设备尺寸；若仍无法作答，请联系研究者。'));
      answerArea.className = 'answer-area';
      answerArea.style.removeProperty('--choice-columns'); answerArea.style.removeProperty('--choice-rows');
    }
    controlQuestion=fits&&!pager.more?q:undefined;
    navigation(); if (focus) reading.focus({ preventScroll: true });options.screen?.(q?.id);
  }
  function show(index: number) {
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
    editing=false;document.body.classList.remove('typing');
    current = index; layoutProblem = false; message.textContent = '';
    sessionStorage.setItem(options.key, page.questions[index]?.id ?? ''); makePager(); render(true);
  }
  function validate(index: number) {
    const q = page.questions[index];
    if (q?.required && answerMissing(q,answers[q.id])) { message.textContent = q.type==='scales'?'请完成每项评分后继续。':q.type === 'scale' ? '请选择评分后继续。' : q.type === 'text' ? '请填写答案后继续。' : '请选择答案后继续。'; return false; }
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

```


=== FILE src/web/scale-input.ts (complete source; may continue in next chunk) ===
```
import type { Question, Answer, ScaleAxis } from '../shared/protocol.js';
import { el } from './dom.js';
import {ui} from './participant-ui.js';

// Discrete axis, with no implicit answer at the initial thumb position.
export function scaleInput(q: Question | (ScaleAxis & {required:boolean}), answer: Answer | undefined, save: (answer: number|null) => void) {
  const control = el('div', undefined, 'axis-control'), ends = el('div', undefined, 'axis-ends');
  ends.append(el('span', q.min_label), el('span', q.max_label));
  const track = el('div', undefined, 'axis-track'), range = el('input', undefined, 'axis-input');
  range.type = 'range'; range.name = q.id; range.min = String(q.min); range.max = String(q.max); range.step = '1';
  range.setAttribute('aria-label', q.title);
  const ticks = el('div', undefined, 'axis-ticks'); ticks.setAttribute('aria-hidden', 'true');
  for (let value = q.min!; value <= q.max!; value++) ticks.append(el('span'));
  track.append(range, ticks);
  const bottom = el('div', undefined, 'axis-bottom'), output = el('output');
  output.id = `axis-value-${q.id}`; range.setAttribute('aria-describedby', output.id);
  output.setAttribute('aria-live','off');
  bottom.append(output); control.append(ends, track, bottom);
  function sync(value: Answer | undefined) {
    const chosen = typeof value === 'number';
    range.value = String(chosen ? value : Math.round((q.min! + q.max!) / 2));
    range.dataset.answered = String(chosen);
    const label = chosen ? q.labels?.[value-q.min!] ?? (value===q.min?q.min_label:value===q.max?q.max_label:String(value)) : '';
    const display=chosen&&!q.labels?`${value}${label===String(value)?'':` · ${label}`}`:label;
    range.setAttribute('aria-valuetext', chosen ? display! : '尚未作答');
    output.textContent = chosen ? `已选择：${display}` : ui.scaleHint;
    output.dataset.answered=String(chosen);
    for(const [index,tick]of Array.from(ticks.children).entries())(tick as HTMLElement).dataset.selected=String(chosen&&index===value-q.min!);
  }
  const commit = (value: number|null) => { sync(value); save(value); };
  range.addEventListener('input', () => commit(Number(range.value)));
  range.addEventListener('change', () => commit(Number(range.value)));
  range.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    const rect = range.getBoundingClientRect(), fraction = Math.max(0, Math.min(1, (event.clientX - rect.left - 11) / Math.max(1, rect.width - 22)));
    commit(q.min! + Math.round(fraction * (q.max! - q.min!)));
  });
  range.addEventListener('keydown', event => {
    if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); commit(Number(range.value)); }
  });
  range.addEventListener('keyup', event => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) commit(Number(range.value));
  });
  if (!q.required) {
    const clear = el('button', '清除选择'); clear.type = 'button'; clear.addEventListener('click', () => commit(null)); bottom.append(clear);
  }
  sync(answer); return control;
}

```


=== FILE src/web/text-pager.ts (complete source; may continue in next chunk) ===
```
// Measure only the current text screen, on navigation or a size change. Text is
// never deleted, and grapheme boundaries preserve emoji and combining marks.
export class TextPager {
  private boundaries: number[];
  private starts = [0];
  private index = 0;
  end = 0;
  private cache = new Map<string, number>();
  constructor(readonly text: string, readonly area: HTMLElement,readonly preferParagraphs=false) {
    this.boundaries = [0];
    if (typeof Intl.Segmenter === 'function') {
      for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text))
        this.boundaries.push(part.index + part.segment.length);
    } else {
      let end = 0;
      for (const char of text) { end += char.length; this.boundaries.push(end); }
    }
  }
  get start() { return this.starts[this.index]!; }
  get number() { return this.index + 1; }
  get more() { return this.end < this.text.length; }
  get back() { return this.index > 0; }
  next() { if (this.more) { this.starts.splice(this.index + 1); this.starts.push(this.end); this.index++; } }
  previous() { if (this.back) this.index--; }
  show() {
    const { width, height } = this.area.getBoundingClientRect();
    const key = `${this.start}/${width}/${height}`;
    let end = this.cache.get(key);
    if (end === undefined) {
      const probe = this.area.cloneNode(false) as HTMLElement;
      probe.removeAttribute('id'); probe.removeAttribute('tabindex'); probe.setAttribute('aria-hidden', 'true');
      Object.assign(probe.style, { position: 'fixed', left: '0', top: '0', width: `${width}px`, height: `${height}px`,
        visibility: 'hidden', pointerEvents: 'none', contain: 'strict' });
      document.body.append(probe);
      const first = this.boundaries.indexOf(this.start);
      let low = first, high = this.boundaries.length - 1;
      try {
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          probe.textContent = this.text.slice(this.start, this.boundaries[mid]);
          if (probe.scrollHeight <= probe.clientHeight && probe.scrollWidth <= probe.clientWidth) low = mid;
      