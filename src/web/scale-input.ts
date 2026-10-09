import type { Question, Answer, ScaleAxis } from '../shared/protocol.js';
import { el } from './dom.js';

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
  bottom.append(output); control.append(ends, track, bottom);
  function sync(value: Answer | undefined) {
    const chosen = typeof value === 'number';
    range.value = String(chosen ? value : Math.round((q.min! + q.max!) / 2));
    range.dataset.answered = String(chosen);
    const label = chosen ? q.labels?.[value-q.min!] ?? (value===q.min?q.min_label:value===q.max?q.max_label:'两端之间') : '';
    range.setAttribute('aria-valuetext', chosen ? label! : '尚未作答');
    output.textContent = chosen ? `已选：${label}` : '点击或拖动坐标轴选择';
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
    const clear = el('button', '清除'); clear.type = 'button'; clear.addEventListener('click', () => commit(null)); bottom.append(clear);
  }
  sync(answer); return control;
}
