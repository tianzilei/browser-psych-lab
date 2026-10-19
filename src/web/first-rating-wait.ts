import type {Answer,Protocol} from '../shared/protocol.js';
import {usesNumericKeypad} from './numeric-keypad.js';
import {wait} from './wait.js';

/** Keep the first photo hidden for three seconds after phone entry and preparation. */
export async function waitForFirstRating(protocol:Protocol,answers:Record<string,Answer>,index:number,status:HTMLElement,signal:AbortSignal){
  if(index!==0||!protocol.pages.some(page=>page.questions.some(q=>usesNumericKeypad(q)&&/^1[0-9]{10}$/.test(String(answers[q.id]??'')))))return;
  status.textContent='即将开始第一题，请等待 3 秒…';
  await wait(3000,signal);
}
