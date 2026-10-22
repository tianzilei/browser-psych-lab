// Local examples only. No persistence, telemetry, or participant API calls.
const root = document.documentElement;
const palette = {
  gray: { bg: '#E5E5E5', fg: '#000000', border: '#787878', error: '#9D2424' },
  dark: { bg: '#202020', fg: '#FFFFFF', border: '#8C8C8C', error: '#FFB4AB' },
};
for (const button of document.querySelectorAll('[data-theme]')) {
  button.addEventListener('click', () => {
    const theme = button.dataset.theme;
    root.dataset.qTheme = theme;
    for (const peer of document.querySelectorAll('[data-theme]')) peer.setAttribute('aria-pressed', String(peer === button));
    for (const label of document.querySelectorAll('[data-token]')) label.textContent = palette[theme][label.dataset.token];
  });
}

for (const group of document.querySelectorAll('[data-choice-group]')) {
  const mode = group.dataset.choiceGroup;
  const buttons = [...group.querySelectorAll('button')];
  const feedback = document.querySelector(`[data-choice-feedback="${mode}"]`);
  for (const button of buttons) button.addEventListener('click', () => {
    const pressed = button.getAttribute('aria-pressed') === 'true';
    if (mode === 'single') for (const peer of buttons) peer.setAttribute('aria-pressed', String(peer === button));
    else button.setAttribute('aria-pressed', String(!pressed));
    const chosen = buttons.filter(peer => peer.getAttribute('aria-pressed') === 'true');
    feedback.textContent = mode === 'single' ? `已选择：${chosen[0].textContent.trim()}` : `已选择 ${chosen.length} 项`;
  });
  group.addEventListener('keydown', event => {
    const directions = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
    if (!(event.key in directions) && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + directions[event.key] + buttons.length) % buttons.length;
    buttons[next].focus();
  });
}

for (const scale of document.querySelectorAll('[data-scale]')) {
const range = scale.querySelector('input');
const scaleOutput = scale.querySelector('output');
const scaleLabels = (scale.dataset.labels ?? '非常不满意|不满意|一般|满意|非常满意').split('|');
function chooseScale(value) {
  range.dataset.answered = String(value !== null);
  if (value !== null) range.value = String(value);
  const text = value === null ? '尚未作答' : `${value} · ${scaleLabels[value - 1]}`;
  range.setAttribute('aria-valuetext', text);
  scaleOutput.textContent = value === null ? '点击或拖动滑块选择评分' : `已选择：${text}`;
  for (const [index, tick] of [...scale.querySelectorAll('.q-ticks span')].entries()) tick.dataset.selected = String(index + 1 === value);
}
range.addEventListener('input', () => chooseScale(Number(range.value)));
range.addEventListener('change', () => chooseScale(Number(range.value)));
range.addEventListener('pointerdown', event => {
  if (!event.isPrimary || event.button !== 0) return;
  const rect = range.getBoundingClientRect();
  const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left - 11) / Math.max(1, rect.width - 22)));
  chooseScale(1 + Math.round(fraction * 4));
});
range.addEventListener('keydown', event => {
  if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); chooseScale(Number(range.value)); }
});
range.addEventListener('keyup', event => {
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) chooseScale(Number(range.value));
});
scale.querySelector('[data-scale-clear]')?.addEventListener('click', () => { range.value = '3'; chooseScale(null); });
}

const personalForm = document.getElementById('personal-form');
const code = document.getElementById('participant-code');
const codeError = document.getElementById('code-error');
const codeStatus = document.getElementById('code-status');
let attempted = false, composing = false;
function validateCode() {
  const valid = /^\d{6}$/.test(code.value);
  code.setAttribute('aria-invalid', String(!valid));
  codeError.hidden = valid;
  codeError.textContent = valid ? '' : code.value ? '请输入完整的 6 位数字编号。' : '请填写参与编号后继续。';
  return valid;
}
personalForm.addEventListener('submit', event => {
  event.preventDefault();
  if (composing) return;
  attempted = true;
  if (validateCode()) codeStatus.textContent = '格式正确，可继续作答（演示）。';
  else { codeStatus.textContent = '请检查编号。'; code.focus(); }
});
code.addEventListener('compositionstart', () => { composing = true; });
code.addEventListener('compositionend', () => { composing = false; if (attempted) validateCode(); });
code.addEventListener('input', () => { codeStatus.textContent = '仅演示格式校验'; if (attempted && !composing) validateCode(); });

const keypadInput = document.getElementById('keypad-value');
const keypad = document.getElementById('keypad');
const keypadError = document.getElementById('keypad-error');
const keypadNext = document.getElementById('keypad-next');
const keypadHelp = document.getElementById('keypad-help');
const keypadStatus = document.getElementById('keypad-status');
let keypadMode = 'phone';
function syncKeypad() {
  const value = keypadInput.value;
  const valid = keypadMode === 'phone' ? /^1\d{10}$/.test(value) : /^\d{1,3}$/.test(value) && Number(value) >= 18 && Number(value) <= 100;
  // Phone: do not flag an unfinished prefix as an error. Age follows the runner's immediate range validation.
  const invalid = !!value && (keypadMode === 'age' ? !valid : value[0] !== '1' || value.length === 11 && !valid);
  keypadInput.setAttribute('aria-invalid', String(invalid));
  keypadError.hidden = !invalid;
  keypadError.textContent = invalid ? keypadMode === 'phone' ? '请输入以 1 开头的 11 位手机号码。' : '请输入 18–100 岁。' : '';
  keypadNext.disabled = !valid;
  keypadStatus.textContent = '仅演示输入，不保存个人信息';
}
function enterKey(key) {
  const value = keypadInput.value, maxLength = keypadMode === 'phone' ? 11 : 3;
  if (key === 'clear') keypadInput.value = '';
  else if (key === 'delete') keypadInput.value = value.slice(0, -1);
  else if (value.length < maxLength && /^\d$/.test(key)) keypadInput.value += key;
  if (value !== keypadInput.value) keypadInput.dispatchEvent(new Event('input', { bubbles: true }));
}
keypad.addEventListener('click', event => {
  const button = event.target.closest('[data-key]');
  if (!button) return;
  enterKey(button.dataset.key);
  keypadInput.focus({ preventScroll: true });
});
keypadInput.addEventListener('keydown', event => {
  if (/^\d$/.test(event.key) || event.key === 'Backspace') { event.preventDefault(); enterKey(event.key === 'Backspace' ? 'delete' : event.key); }
});
keypadInput.addEventListener('input', syncKeypad);
for (const button of document.querySelectorAll('[data-keypad-mode]')) button.addEventListener('click', () => {
  keypadMode = button.dataset.keypadMode;
  keypad.dataset.mode = keypadMode;
  keypadInput.value = '';
  for (const peer of document.querySelectorAll('[data-keypad-mode]')) peer.setAttribute('aria-pressed', String(peer === button));
  const phone = keypadMode === 'phone';
  document.getElementById('keypad-label').textContent = phone ? '您的手机号码' : '您估计这位医生的年龄是？';
  keypadHelp.textContent = phone ? '11 位中国大陆手机号码' : '示例范围：18–100 岁；正式范围由冻结协议决定';
  keypad.setAttribute('aria-label', phone ? '手机号数字键盘' : '年龄数字键盘');
  keypadNext.textContent = phone ? '下一题' : '提交评分';
  syncKeypad();
});
keypadNext.addEventListener('click', () => { keypadStatus.textContent = '格式正确（演示），没有提交数据。'; });

let navigationTimer;
document.querySelector('[data-nav-demo]').addEventListener('click', event => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = '正在保存…';
  document.getElementById('nav-status').textContent = '提交期间锁定主操作（演示）';
  clearTimeout(navigationTimer);
  navigationTimer = setTimeout(() => {
    button.disabled = false;
    button.textContent = '下一题';
    document.getElementById('nav-status').textContent = '演示结束，没有保存数据。';
  }, 900);
});

const links = [...document.querySelectorAll('.sidebar nav a')];
const sections = [...document.querySelectorAll('main > section')];
const sectionObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    for (const link of links) {
      if (link.hash === `#${entry.target.id}`) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
  }
}, { rootMargin: '-5% 0px -65% 0px', threshold: 0 });
for (const section of sections) sectionObserver.observe(section);
