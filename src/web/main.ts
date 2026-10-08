import { openDB, deleteDB } from 'idb';
import './style.css';

const checks = document.querySelector<HTMLUListElement>('#checks')!;
function show(label: string, passed: boolean, detail: string) {
  const item = document.createElement('li');
  item.dataset.status = passed ? 'ok' : 'failed';
  item.textContent = `${label}：${detail}`;
  checks.append(item);
}

try {
  const response = await fetch('/api/health/ready', { signal: AbortSignal.timeout(5000) });
  const body = await response.json() as { database?: string };
  show('应用与数据库', response.ok, response.ok ? `${body.database}，存储目录就绪` : '服务尚未就绪');
} catch { show('应用与数据库', false, '连接失败'); }

const probeName = `browser-psych-lab-probe-${crypto.randomUUID()}`;
try {
  const db = await openDB(probeName, 1, { upgrade(db) { db.createObjectStore('probe'); } });
  try {
    const tx = db.transaction('probe', 'readwrite');
    await tx.store.put('TEST_ONLY', 'value');
    await tx.done;
    show('IndexedDB', await db.get('probe', 'value') === 'TEST_ONLY', '写入事务完成并回读');
  } finally { db.close(); }
} catch { show('IndexedDB', false, '本地存储不可用'); }
finally { await deleteDB(probeName).catch(() => {}); }

const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
const context = canvas.getContext('2d');
if (context) {
  await new Promise<void>(resolve => requestAnimationFrame(() => {
    context.fillStyle = '#e9f0eb';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#20523e';
    context.font = '18px sans-serif';
    context.fillText('Canvas + requestAnimationFrame · TEST_ONLY', 18, 56);
    resolve();
  }));
}
show('Canvas 与帧回调', Boolean(context), context ? '可用；尚未测量时序' : '不可用');
show('Web Locks', Boolean(navigator.locks), navigator.locks ? '接口可用；单写者合同待实现' : '接口不可用');

const loadSurvey = document.querySelector<HTMLButtonElement>('#load-survey')!;
const surveyStatus = document.querySelector<HTMLParagraphElement>('#survey-status')!;
loadSurvey.addEventListener('click', () => {
  loadSurvey.disabled = true;
  surveyStatus.textContent = '正在加载问卷样例…';
  void import('./survey-demo').then(({ mountSurveyDemo }) => {
    mountSurveyDemo(document.querySelector<HTMLDivElement>('#survey')!);
    loadSurvey.hidden = true;
    surveyStatus.textContent = '';
  }).catch(() => {
    loadSurvey.disabled = false;
    surveyStatus.textContent = '问卷样例加载失败，可重试。';
  });
});
