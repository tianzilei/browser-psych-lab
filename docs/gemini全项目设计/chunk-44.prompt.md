全项目设计讨论，传输段 44，源码主题：页面交互和管理（源包 14/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

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

```

### src/web/text-pager.ts L1–L58

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
          else high = mid - 1;
        }
        // Too little space is reported to the caller instead of clipping a glyph.
        end = this.boundaries[low]!;
        // Consent keeps paragraphs together when at least half a screen can be
        // used. Oversized paragraphs still split at a safe grapheme boundary.
        if(this.preferParagraphs&&end<this.text.length){const boundary=this.text.lastIndexOf('\n\n',end-2)+2;if(boundary>this.start&&boundary-this.start>=(end-this.start)/2)end=boundary;}
      } finally { probe.remove(); }
      if (this.cache.size >= 64) this.cache.clear();
      this.cache.set(key, end);
    }
    this.end = end;
    this.area.textContent = this.text.slice(this.start, end);
    return end > this.start || this.text.length === 0;
  }
}

```

### src/web/viewport.ts L1–L30

```
// Event-driven visible viewport sizing. No polling or animation loop.
export function lockParticipantViewport() {
  const root = document.documentElement;
  let frame = 0;
  const size = () => {
    frame = 0;
    const viewport = window.visualViewport;
    root.style.setProperty('--viewport-width', `${viewport?.width ?? innerWidth}px`);
    root.style.setProperty('--viewport-height', `${viewport?.height ?? innerHeight}px`);
    root.style.setProperty('--viewport-left', `${viewport?.offsetLeft ?? 0}px`);
    root.style.setProperty('--viewport-top', `${viewport?.offsetTop ?? 0}px`);
  };
  const resize = () => { if (!frame) frame = requestAnimationFrame(size); };
  const move = (event: TouchEvent) => {
    if (document.body.classList.contains('runner-layout')) event.preventDefault();
  };
  size();
  window.addEventListener('resize', resize);
  window.visualViewport?.addEventListener('resize', resize);
  window.visualViewport?.addEventListener('scroll', resize);
  document.addEventListener('touchmove', move, { passive: false });
  window.addEventListener('pagehide', () => {
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', resize);
    window.visualViewport?.removeEventListener('resize', resize);
    window.visualViewport?.removeEventListener('scroll', resize);
    document.removeEventListener('touchmove', move);
  }, { once: true });
}

```

### src/web/wait.ts L1–L10

```
export function wait(ms:number,signal?:AbortSignal){return new Promise<void>((resolve,reject)=>{
  const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal?.reason);};
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
});}
export function overloadDelay(response:Response,attempt:number){
  const header=response.headers.get('Retry-After'),seconds=header===null?NaN:Number(header);
  return (Number.isFinite(seconds)&&seconds>=0?Math.min(5000,Math.max(250,seconds*1000)):Math.min(5000,250*2**attempt))+Math.random()*250;
}

```