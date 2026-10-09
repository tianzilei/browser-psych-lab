继续前一轮前端讨论，以下是实际实现，请进行代码审查，关注会导致错误答案、分支不一致、丢修订、IME焦点异常或冻结色不一致的具体问题。不需要网络搜索。

取舍：采用原生四型表单，正式路径不加载SurveyJS，灰#e5e5e5/深#202020和历史自定义色基于已有冻结layout.background。单次相对亮度计算决定黑/白中性色和原生控件color-scheme；CSS常量，无主题运行中监听。participant.ts和run.ts各在获取冻结协议后、挂载/测几何之前apply背景。run继续使用Canvas精确protocol.layout.background；保留既有ONSET事件计数文案和软件时序/几何变化中断合同，不将DOM禁止建议视为性能已实测结论。UI去掉品牌眉题、白色卡片、绿色按钮，无外部字体/图片/动画。SurveyJS只留开发样例显式加载。共享合同字符上限保持研究/页/组标题200、题干1000、说明8000、选项200、答案1..4000；编辑器maxLength与number bounds同源，小字提示标题120/题300/选项80为建议；不截断历史文本。页最多30题，每题最多20选项。
你的前轮节流文本建议与保留全部原始修订冲突，我们不采用debounce。每个实际变化的input（含IME composing）即时revision、快照复制原始值，直到compositionend才重算文本分支。不被条件引用的题目不会触发显隐计算。
本机构建参与问卷HTML+JS+CSS（manifest递归imports+dynamicImports，gzipSync同方法）：改前2,235,611 raw /444,959 gzip B，改后39,520 raw /17,190 gzip B。只说明资产减少，不声称CPU/内存/时序有确定比例改善。
请检查以下源码。明确区分真实bug、可选改善、不能从源码推出的推测，不需泛泛清单。末尾写 FRONTEND_CODE_REVIEW_COMPLETE。

import { evaluate, type Page, type Answer, type Condition, type Question } from '../shared/protocol.js';
import { el } from './dom.js';

type Answers = Record<string, Answer>;
type Control = HTMLInputElement;
interface Row { question: Question; box: HTMLFieldSetElement; controls: Control[]; error: HTMLParagraphElement }
const copyAnswer = (answer: Answer): Answer => Array.isArray(answer) ? [...answer] : answer;
function snapshot(answers: Answers): Answers {
  return Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, copyAnswer(answer)]));
}

export function mountPage(element: HTMLDivElement, page: Page, previous: Answers, values: Answers,
  revision: (name: string, answer: Answer, data: Answers) => void, complete: (data: Answers) => void) {
  const form = el('form', undefined, 'questionnaire');
  let composing = false;
  // Validate only visible questions, including the "at least one" multi-choice rule.
  form.noValidate = true;
  const answers: Answers = {}, rows: Row[] = [], byName = new Map<string, Row>(), dependencies = new Set<string>();
  const effective = { ...previous };
  function collect(condition?: Condition) {
    if (!condition) return;
    if ('question' in condition) dependencies.add(condition.question);
    else if (condition.op === 'not') collect(condition.arg);
    else for (const arg of condition.args) collect(arg);
  }
  for (const question of page.questions) {
    collect(question.condition);
    if (values[question.id] !== undefined) answers[question.id] = copyAnswer(values[question.id]!);
    const box = el('fieldset'), legend = el('legend', question.title), error = el('p', undefined, 'question-error');
    legend.id = `q-${question.id}-label`;
    error.id = `q-${question.id}-error`;
    error.hidden = true;
    if (question.required) legend.append(el('span', '（必答）', 'required-note'));
    box.append(legend);
    const controls: Control[] = [], value = answers[question.id];
    if (question.type === 'text') {
      const input = el('input');
      input.type = 'text'; input.name = question.id; input.maxLength = question.max_length!;
      input.value = typeof value === 'string' ? value : '';
      input.autocomplete = 'off';
      input.setAttribute('aria-labelledby', legend.id);
      input.required = question.required;
      controls.push(input); box.append(input);
    } else {
      const choices = question.type === 'scale'
        ? Array.from({ length: question.max! - question.min! + 1 }, (_, i) => String(question.min! + i))
        : question.choices!;
      const options = el('div', undefined, question.type === 'scale' ? 'scale-options' : 'choice-options');
      for (const choice of choices) {
        const label = el('label'), input = el('input');
        input.type = question.type === 'multi' ? 'checkbox' : 'radio';
        input.name = question.id; input.value = choice;
        input.checked = question.type === 'multi' ? Array.isArray(value) && value.includes(choice)
          : question.type === 'scale' ? value === Number(choice) : value === choice;
        if (question.type !== 'multi') input.required = question.required;
        controls.push(input); label.append(input, document.createTextNode(choice)); options.append(label);
      }
      box.append(options);
    }
    for (const input of controls) input.setAttribute('aria-describedby', error.id);
    box.append(error); form.append(box);
    const row = { question, box, controls, error };
    rows.push(row); byName.set(question.id, row);
  }
  const submit = el('button', '提交本页'); submit.type = 'submit'; form.append(submit);
  function clearError(row: Row) {
    row.error.hidden = true;
    for (const input of row.controls) input.removeAttribute('aria-invalid');
  }
  function visibility() {
    for (const row of rows) {
      const shown = evaluate(row.question.condition, effective);
      if (row.box.hidden === shown) {
        row.box.hidden = !shown; row.box.disabled = !shown;
        if (!shown) clearError(row);
      }
      effective[row.question.id] = shown ? answers[row.question.id] ?? null : null;
    }
  }
  function update(event: Event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || submit.disabled) return;
    const row = byName.get(input.name);
    if (!row || row.box.disabled || !row.controls.includes(input)) return;
    const text = row.question.type === 'text';
    if (text ? event.type === 'change' : event.type !== 'change') return;
    const answer: Answer = text ? input.value : row.question.type === 'multi'
      ? row.controls.filter(c => c.checked).map(c => c.value)
      : row.question.type === 'scale' ? Number(input.value) : input.value;
    const old = answers[input.name];
    const changed = Array.isArray(answer) ? !Array.isArray(old) || answer.length !== old.length || answer.some((v, i) => v !== old[i]) : answer !== old;
    if (changed) {
      answers[input.name] = answer; clearError(row);
      // Keep every input revision; never debounce persistence or reset an IME value.
      revision(input.name, copyAnswer(answer), snapshot(answers));
    }
    if (dependencies.has(input.name) && (!(event instanceof InputEvent) || !event.isComposing)) visibility();
  }
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  form.addEventListener('compositionstart', () => { composing = true; });
  form.addEventListener('compositionend', event => { composing = false; update(event); });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (submit.disabled || composing) return;
    visibility();
    let first: Control | undefined;
    for (const row of rows) {
      if (row.box.hidden) continue;
      const answer = answers[row.question.id] ?? null;
      const empty = answer === null || answer === '' || (Array.isArray(answer) && answer.length === 0);
      const message = empty && row.question.required ? '请完成此题。'
        : row.question.type === 'text' && typeof answer === 'string' && answer.length > row.question.max_length!
          ? `最多 ${row.question.max_length} 个字符。` : '';
      if (message) {
        row.error.textContent = message; row.error.hidden = false;
        for (const input of row.controls) input.setAttribute('aria-invalid', 'true');
        first ??= row.controls[0];
      } else clearError(row);
    }
    if (first) { first.focus(); return; }
    submit.disabled = true;
    complete(snapshot(answers));
  });
  visibility(); element.replaceChildren(form);
}
export const BACKGROUNDS = { gray: '#e5e5e5', dark: '#202020' } as const;

// Apply once before mounting a page or measuring a group. The frozen protocol
// supplies the exact color; system preferences never change an ongoing study.
export function applyParticipantBackground(background: string) {
  const rgb = background.slice(1).match(/../g)!.map(hex => {
    const channel = parseInt(hex, 16) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  const luminance = .2126 * rgb[0]! + .7152 * rgb[1]! + .0722 * rgb[2]!;
  const dark = luminance < .179;
  const root = document.documentElement;
  root.style.backgroundColor = background;
  root.style.color = dark ? '#ffffff' : '#000000';
  root.style.colorScheme = dark ? 'dark' : 'light';
  root.dataset.theme = dark ? 'dark' : 'gray';
}
:root { font: 16px/1.5 system-ui, sans-serif; color: #000; background: #e5e5e5; color-scheme: light; }
body { margin: 0; }
main { max-width: 680px; margin: 24px auto; padding: 0 16px; }
header { margin-bottom: 24px; }
h1 { font-size: 24px; margin: 0 0 12px; }
h2 { font-size: 20px; margin: 0 0 12px; }
p { margin: 12px 0; }
h1,h2,legend,label,p { overflow-wrap: anywhere; }
.instruction { white-space: pre-wrap; }
fieldset { min-width: 0; margin: 0 0 20px; padding: 12px; border: 1px solid currentColor; }
legend { padding: 0 4px; font-weight: 600; }
.required-note { font-size: 14px; font-weight: 400; }
label { display: flex; align-items: baseline; gap: 8px; padding: 10px 0; cursor: pointer; }
input { font: inherit; color: inherit; }
input[type="text"] { box-sizing: border-box; width: 100%; padding: 10px; border: 1px solid currentColor; background: transparent; border-radius: 0; }
input[type="radio"],input[type="checkbox"] { flex: none; margin: 0; accent-color: currentColor; }
button { min-height: 44px; max-width: 100%; font: inherit; padding: 10px 16px; border: 1px solid currentColor; border-radius: 0; color: inherit; background: transparent; cursor: pointer; overflow-wrap: anywhere; }
button:disabled { opacity: .6; cursor: wait; }
button:focus-visible,input:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
.scale-options { display: flex; flex-wrap: wrap; gap: 0 16px; }
.scale-options label { min-width: 44px; }
.question-error { font-size: 14px; font-weight: 600; }
[hidden] { display: none !important; }
@media(max-width:600px) { main { margin: 16px auto; } }
main { max-width: 920px; margin: 16px auto; }
#status { height: 60px; overflow: hidden; }
.runner-stage { display: flex; flex-direction: column; align-items: center; gap: 20px; }
.response-buttons { display: flex; gap: 12px; width: 100%; max-width: 720px; touch-action: none; }
.response-buttons button { flex: 1; min-width: 0; min-height: 56px; user-select: none; touch-action: none; }
.running { overflow: hidden; touch-action: none; overscroll-behavior: none; }
@media(max-width:600px) { .response-buttons { gap: 6px; } }
@media(orientation:landscape) { main { margin: 8px auto; } h1 { font-size: 20px; margin: 8px 0; } #status { height: 32px; margin: 8px 0; } }
