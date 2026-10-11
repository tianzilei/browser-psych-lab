全项目设计讨论，传输段 40，源码主题：页面交互和管理（源包 13/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>可靠保存测试 · Browser Psych Lab</title></head>
<body><main>
  <header><p class="eyebrow">BROWSER PSYCH LAB · TEST_ONLY</p><h1>可靠保存测试问卷</h1>
    <p>此问卷用于开发验证。答案会保存在本机浏览器和测试数据库。</p></header>
  <section><p id="status" role="status" aria-live="polite">正在恢复保存状态…</p>
    <form id="questionnaire" hidden>
      <fieldset><legend>当前问卷是否正常显示？</legend>
        <label><input type="radio" name="answer" value="正常显示" required />正常显示</label>
        <label><input type="radio" name="answer" value="需要检查" required />需要检查</label>
      </fieldset><button type="submit">提交并保存</button>
    </form>
    <button id="retry" type="button" hidden>重试保存与核对</button>
    <button id="unknown-close" type="button" hidden>确认旧运行已中断并终止</button>
    <p id="evidence" aria-live="polite"></p>
  </section><p><a href="/">返回开发检查</a></p>
</main><script type="module" src="/p0.ts"></script></body></html>

```

### src/web/participant-theme.ts L1–L19

```
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
  root.style.setProperty('--background',background);root.style.setProperty('--foreground',dark?'#ffffff':'#000000');root.style.setProperty('--line',dark?'#606060':'#b4b4b4');
  root.dataset.theme = dark ? 'dark' : 'gray';
}

```

### src/web/participant.css L1–L119

```
:root {
  --background: #e5e5e5;
  --foreground: #000000;
  --line: #b4b4b4;
  --font-body: -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",system-ui,sans-serif;
  --font-size-body: 16px;
  --font-size-title: 20px;
  --font-size-status: 13px;
  --font-size-question: 17px;
  --font-size-help: 14px;
  --font-size-ending: 15px;
  --line-body: 1.45;
  --line-tight: 1.25;
  --touch-min: 48px;
  --page-inline: max(16px,3vw);
  --safe-bottom: env(safe-area-inset-bottom,0px);
  font: var(--font-size-body)/var(--line-body) var(--font-body);
  color: #000; background: #e5e5e5; color-scheme: light;
}
* { box-sizing: border-box; }
html,body { width: 100%; min-height: 100%; margin: 0; overflow-x: hidden; overflow-y: auto; overscroll-behavior-y: contain; }
body { touch-action: manipulation; }
main { width: min(100%, 1100px); min-height: 100dvh; margin: 0 auto; padding: max(16px,env(safe-area-inset-top)) var(--page-inline) calc(16px + var(--safe-bottom)); display: grid; grid-template-rows: auto minmax(0,1fr); gap: 12px; }
header { display: grid; grid-template-rows: auto auto; gap: 4px; min-height: 0; }
h1 { font-size: var(--font-size-title); line-height: 1.35; font-weight: 600; margin: 0; overflow-wrap: anywhere; }
#status { font-size: var(--font-size-status); line-height: 1.2; font-weight: 500; margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
#content { grid-row: 2; min-width: 0; min-height: 0; display: grid; align-content: start; justify-items: stretch; }
#content > button { justify-self: center; }
.recovery-actions { width: min(100%, 520px); justify-self: center; display: flex; flex-wrap: wrap; gap: 8px; align-self: start; margin-top: 8px; }
.recovery-actions button { width: 100%; }
@media (min-width: 361px) { .recovery-actions button { flex: 1 1 180px; width: auto; } }
#content:has(.questionnaire),#content:has(.runner-stage),#content:has(.ending-page),#content:has(.consent-page) { align-content: stretch; }
.survey-mount { min-height: 0; }
p { margin: 0; overflow-wrap: anywhere; }
button { min-width: 0; min-height: var(--touch-min); font: inherit; font-size: 16px; line-height: 1.2; padding: 10px 14px; border: 1px solid currentColor; border-radius: 10px; color: inherit; background: transparent; cursor: pointer; overflow-wrap: anywhere; touch-action: manipulation; }
button:disabled { opacity: .5; cursor: default; }
button:focus-visible,input:focus-visible,.reading-text:focus-visible { outline: 2px solid currentColor; outline-offset: -3px; }
.questionnaire { width: min(100%,900px); height: max(240px,calc(var(--viewport-height,100dvh) - var(--survey-top,100px) - 16px)); min-width: 0; justify-self: center; display: grid; grid-template-rows: auto minmax(0,1fr) auto; gap: 12px; }
.question-meta { grid-row: 1; min-height: 0; display: grid; grid-template-rows: 1fr 1fr; }
.question-progress,.question-error { font-size: var(--font-size-status); line-height: 1.25; }
.question-error { font-weight: 600; }
.question-screen { grid-row: 2; min-height: 0; min-width: 0; display: grid; grid-template-rows: minmax(4.5rem,auto) minmax(0,1fr); gap: 12px; }
.question-screen.reading-only { grid-template-rows: minmax(0,1fr) 0; }
.question-screen.selection-question { grid-template-rows: minmax(4.5rem,auto) minmax(0,1fr); }
.question-screen.single-axis-question { grid-template-rows: minmax(6rem,7rem) minmax(220px,1fr); }
.reading-text { font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; min-height: 0; overflow: hidden; }
.answer-area { min-height: 0; min-width: 0; display: grid; grid-template-rows: minmax(0,1fr); gap: 6px; }
.answer-area.choices-grid { grid-template-columns: repeat(var(--choice-columns,1),minmax(0,1fr)); grid-template-rows: repeat(var(--choice-rows,1),minmax(0,1fr)); }
.reading-only .answer-area { padding: 0; }
.choice-button { width: 100%; display: flex; align-items: center; text-align: left; gap: 6px; max-height: 100%; padding: 6px; }
.choice-button::before { content: '○'; flex: none; }
.choice-button[aria-pressed=true] { background: currentColor; }
.choice-button[aria-pressed=true]::before { content: '●'; }
.choice-button[aria-pressed=true] span,.choice-button[aria-pressed=true]::before { color: var(--background); }
.choice-label { display: block; min-width: 0; max-height: 100%; white-space: pre-wrap; overflow: hidden; overflow-wrap: anywhere; }
.axis-control { width: 100%; max-width: 680px; margin-inline: auto; min-width: 0; align-self: center; display: grid; gap: 8px; padding: 1.5rem .75rem; border: 1px solid var(--line); border-radius: 18px; }
.axis-ends { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 12px; font-size: 14px; }
.axis-ends span { overflow-wrap: anywhere; }
.axis-ends span:last-child { text-align: right; }
.axis-track { position: relative; height: 44px; }
.axis-input { appearance: none; -webkit-appearance: none; width: 100%; height: 44px; padding: 0; margin: 0; border: 0; background: transparent; color: inherit; touch-action: none; }
.axis-input:focus-visible { outline: none; }
.axis-control:has(.axis-input:focus-visible) { outline: 2px solid currentColor; outline-offset: 2px; }
.axis-input::-webkit-slider-runnable-track { height: 3px; border-radius: 2px; background: currentColor; }
.axis-input::-moz-range-track { height: 3px; border-radius: 2px; background: currentColor; }
.axis-input::-webkit-slider-thumb { appearance: none; -webkit-appearance: none; width: 22px; height: 22px; margin-top: -10px; border: 1px solid currentColor; border-radius: 50%; background: currentColor; }
.axis-input::-moz-range-thumb { width: 22px; height: 22px; border: 1px solid currentColor; border-radius: 50%; background: currentColor; }
.axis-input[data-answered=false]::-webkit-slider-thumb { opacity: 0; }
.axis-input[data-answered=false]::-moz-range-thumb { opacity: 0; }
.axis-ticks { position: absolute; inset: 50% 11px auto; display: flex; justify-content: space-between; pointer-events: none; transform: translateY(-50%); }
.axis-ticks span { height: 8px; border-left: 1px solid currentColor; }
.axis-ticks span[data-selected=true] { height: 14px; border-left-width: 2px; }
.axis-bottom { display: flex; align-items: center; justify-content: center; gap: 8px; min-width: 0; font-size: 14px; }
.axis-bottom button { flex: none; }
.axis-bottom output { overflow-wrap: anywhere; text-align: center; }
.axis-bottom output[data-answered=true] { font-weight: 600; }
.question-screen.multi-axis-question { grid-template-rows: minmax(32px,14%) minmax(0,1fr); }
.axes-grid { grid-template-columns: repeat(var(--axis-columns,1),minmax(0,1fr)); grid-template-rows: repeat(var(--axis-rows,1),minmax(0,1fr)); gap: 6px; }
.axes-grid .axis-control { height: 100%; align-self: stretch; max-width: none; padding: 2px 8px; border-radius: 10px; gap: 0; grid-template-columns: minmax(0,1fr) minmax(0,1fr); grid-template-rows: minmax(16px,1fr) 44px minmax(16px,1fr); grid-template-areas: 'title feedback' 'track track' 'ends ends'; }
.axis-title { grid-area: title; font-size: 13px; font-weight: 600; overflow-wrap: anywhere; align-self: center; }
.axes-grid .axis-track { grid-area: track; }
.axes-grid .axis-ends { grid-area: ends; font-size: 12px; gap: 8px; align-self: center; }
.axes-grid .axis-bottom { grid-area: feedback; font-size: 12px; justify-content: end; gap: 4px; }
.axes-grid .axis-bottom output { text-align: right; }
.axes-grid .axis-control:has(button) { grid-template-rows: minmax(44px,1fr) 44px minmax(16px,1fr); }
.axes-grid .axis-bottom button { min-height: 44px; padding: 2px 6px; font-size: 12px; }
.ending-page { width: min(100%,900px); min-height: 100%; justify-self: center; display: flex; flex-direction: column; gap: 12px; }
.ending-title { flex: 0 0 auto; margin: 0; font-size: 22px; line-height: 1.35; font-weight: 600; }
.ending-text { height: max(160px,calc(var(--viewport-height,100dvh) - 200px)); flex: 0 0 auto; min-height: 0; overflow: auto; font-size: var(--font-size-ending); line-height: 1.6; align-self: stretch; }
.ending-nav { flex: 0 0 auto; display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; padding-bottom: var(--safe-bottom); }
.ending-nav button { flex: 1 1 140px; max-width: 300px; }
.consent-page { width: min(100%,900px); height: 100%; min-height: 0; min-width: 0; justify-self: center; display: grid; grid-template-rows: minmax(0,1fr) auto auto; gap: min(2dvh,12px); }
.consent-text { font-size: clamp(16px,2.8dvh,20px); }
.consent-reading-nav,.consent-decisions { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 8px; }
.consent-decisions button { padding: 8px 4px; }
.consent-decisions button:last-child { font-weight: 600; }
.consent-declined { display: grid; gap: 24px; width: min(100%,600px); justify-self: center; }
@media (max-height: 450px) { .axis-control { padding: 0 8px; gap: 0; border-radius: 10px; } }
.orientation-gate { position: fixed; inset: 0; z-index: 100; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4dvh; background: var(--background); color: var(--foreground); padding: 5%; text-align: center; }
.orientation-gate[hidden] { display: none; }
.orientation-gate p { font-size: clamp(18px,4vw,24px); margin: 0; }
.orientation-gate span { font-size: 14px; }
.orientation-device { width: 48px; height: 76px; border: 2px solid currentColor; border-radius: 9px; }
.orientation-device[data-orientation=landscape] { width: 76px; height: 48px; }
.simulation-image-nav { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 6px; }
.question-nav { grid-row: 3; display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 8px; min-height: 0; padding-bottom: var(--safe-bottom); }
input[type=text] { align-self: center; width: 100%; min-width: 0; height: 44px; font: inherit; color: inherit; background: transparent; border: 1px solid currentColor; padding: 8px; border-radius: 0; touch-action: manipulation; }
body.typing main { grid-template-rows: 0 minmax(0,100%); }
body.typing header { display: none; }
body.typing .questionnaire { height: max(120px,calc(var(--viewport-height,100dvh) - var(--survey-top,16px) - 16px)); grid-template-rows: 0 minmax(0,1fr) auto; }
body.typing .question-meta { display: none; }
body.typing .question-screen { grid-template-rows: 0 minmax(0,100%); }
body.typing .reading-text { visibility: hidden; }
@media (max-width: 360px) {
  .recovery-actions,.ending-nav { display: grid; grid-template-columns: 1fr; }
  .recovery-actions button,.ending-nav button { max-width: none; }
}
[hidden] { display: none !important; }

```

### src/web/participate.html L1–L2

```
<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content"/><title>参与研究</title></head><body><main><header><h1 id="title">准备会话</h1><p id="status" role="status" aria-live="polite">正在核对保存状态…</p></header><div id="content"></div></main><script type="module" src="/participant.ts"></script></body></html>

```

### src/web/questionnaire-list.ts L1–L24

```
﻿import './style.css';
import {el} from './dom.js';

type Questionnaire={version_id:string;title:string};
const status=document.querySelector<HTMLParagraphElement>('#status')!;
const list=document.querySelector<HTMLDivElement>('#questionnaires')!;
try {
  const response=await fetch('/api/questionnaires');
  if(!response.ok) throw new Error('加载失败');
  const data=await response.json() as {questionnaires:Questionnaire[]};
  list.replaceChildren();
  if(!data.questionnaires.length){status.textContent='当前没有开放的问卷。';}
  else {
    status.textContent='请选择要参加的问卷。';
    for(const questionnaire of data.questionnaires){
      const card=el('article');
      card.append(el('h3',questionnaire.title));
      const link=el('a','开始填写');
      link.href=`/participate.html?version=${encodeURIComponent(questionnaire.version_id)}`;