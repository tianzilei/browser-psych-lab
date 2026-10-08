import { test, expect, type Page } from '@playwright/test';

async function evidence(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('browser-psych-lab-p0-v1');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<{ raw: number; queued: number; pending: boolean; eventId: string | null; hash: string | null }>((resolve, reject) => {
        const tx = db.transaction(['events', 'outbox', 'meta']);
        const raw = tx.objectStore('events').count(); const queued = tx.objectStore('outbox').count();
        const state = tx.objectStore('meta').get('state');
        tx.oncomplete = () => resolve({ raw: raw.result, queued: queued.result, pending: !!state.result?.submission,
          eventId: state.result?.submission?.event.event_id ?? null, hash: state.result?.submission?.event.hash ?? null });
        tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  });
}
async function answer(page: Page) {
  await page.getByRole('radio', { name: '正常显示', exact: true }).check();
  await page.getByRole('button', { name: '提交并保存' }).click();
}
test('reliable questionnaire completes with immutable local raw retained after custody/seal', async ({ page }) => {
  const requests: string[] = []; page.on('request', r => requests.push(r.url()));
  await page.goto('/p0.html'); await expect(page.locator('#status')).toHaveText('可以作答。');
  await answer(page); await expect(page.locator('#status')).toContainText('保存完成');
  expect(await evidence(page)).toMatchObject({ raw: 1, queued: 0, pending: true });
  expect(requests.some(url => url.includes('survey-demo'))).toBe(false);
  await page.reload(); await expect(page.locator('#status')).toContainText('保存完成');
});
test('offline submission keeps raw/outbox atomically, then reload recovers the same identity', async ({ page, context }) => {
  await page.goto('/p0.html'); await expect(page.locator('#status')).toHaveText('可以作答。');
  await context.setOffline(true); await answer(page);
  await expect(page.getByRole('button', { name: '重试保存与核对' })).toBeVisible();
  const saved = await evidence(page); expect(saved).toMatchObject({ raw: 1, queued: 1, pending: true });
  await context.setOffline(false); await page.reload();
  await expect(page.locator('#status')).toContainText('保存完成');
  const recovered = await evidence(page);
  expect(recovered.eventId).toBe(saved.eventId); expect(recovered.hash).toBe(saved.hash); expect(recovered.queued).toBe(0);
});
test('lost ACK after server commit retries exact bytes and keeps receipt identity', async ({ page }) => {
  await page.goto('/p0.html'); await expect(page.locator('#status')).toHaveText('可以作答。');
  let firstReceipt = ''; let requests = 0;
  await page.route('**/ingest', async route => {
    requests++;
    const response = await route.fetch();
    const body = await response.json() as { receipts: { receipt_id: string }[] };
    if (requests === 1) { firstReceipt = body.receipts[0]!.receipt_id; await route.abort(); }
    else { expect(body.receipts[0]!.receipt_id).toBe(firstReceipt); await route.fulfill({ response }); }
  });
  await answer(page); await expect(page.getByRole('button', { name: '重试保存与核对' })).toBeVisible();
  const pending = await evidence(page); expect(pending.queued).toBe(1);
  await page.getByRole('button', { name: '重试保存与核对' }).click();
  await expect(page.locator('#status')).toContainText('保存完成'); expect(requests).toBe(2);
  expect((await evidence(page)).eventId).toBe(pending.eventId);
});
test('a second tab stays read-only without terminating the active session', async ({ page, context }) => {
  await page.goto('/p0.html'); await expect(page.locator('#status')).toHaveText('可以作答。');
  const second = await context.newPage(); await second.goto('/p0.html');
  await expect(second.locator('#status')).toContainText('此页只读');
  await expect(second.getByRole('button', { name: '提交并保存' })).toBeHidden();
  await answer(page); await expect(page.locator('#status')).toContainText('保存完成');
  await second.close();
});
for (const operation of ['seal', 'finalize']) test(`lost ${operation} ACK recovers the original durable result`, async ({ page }) => {
  await page.goto('/p0.html'); await expect(page.locator('#status')).toHaveText('可以作答。');
  let originalId = ''; let attempts = 0;
  await page.route(`**/${operation}`, async route => {
    attempts++; const response = await route.fetch();
    const result = await response.json() as { seal_id?: string; completion_id?: string };
    const receiptId = result.seal_id ?? result.completion_id!;
    if (attempts === 1) { originalId = receiptId; await route.abort(); }
    else { expect(receiptId).toBe(originalId); await route.fulfill({ response }); }
  });
  await answer(page); await expect(page.getByRole('button', { name: '重试保存与核对' })).toBeVisible();
  const saved = await evidence(page); expect(saved).toMatchObject({ raw: 1, queued: 0 });
  await page.getByRole('button', { name: '重试保存与核对' }).click();
  await expect(page.locator('#status')).toContainText('保存完成');
  expect((await evidence(page)).eventId).toBe(saved.eventId); expect(originalId).toBeTruthy();
});
test('aborted local submission leaves neither raw nor outbox nor pending page state', async ({ page }) => {
  await page.addInitScript(() => {
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<typeof original>) {
      const tx = original.apply(this, args);
      if (Array.isArray(args[0]) && args[0].includes('events') && args[0].includes('meta') && args[1] === 'readwrite') {
        const meta = tx.objectStore('meta'); const put = meta.put.bind(meta);
        meta.put = function (...values: Parameters<typeof put>) {
          const request = put(...values);
          request.addEventListener('success', () => tx.abort(), { once: true }); return request;
        };
        const objectStore = tx.objectStore.bind(tx);
        tx.objectStore = name => name === 'meta' ? meta : objectStore(name);
      }
      return tx;
    } as typeof original;
  });
  await page.goto('/p0.html'); await expect(page.locator('#status')).toHaveText('可以作答。');
  await answer(page); await expect(page.getByRole('button', { name: '重试保存与核对' })).toBeVisible();
  expect(await evidence(page)).toMatchObject({ raw: 0, queued: 0, pending: false });
});
test('cross-origin writes and unauthenticated session reads take no custody', async ({ request }) => {
  const response = await request.post('/api/p0/sessions', { headers: { Origin: 'https://foreign.invalid' },
    data: { request_id: 'cross-origin', credential: 'a'.repeat(64) } });
  expect(response.status()).toBe(403); expect((await response.json()).ingestion).toBe('NOT_INGESTED');
  const oversized = await request.post('/api/p0/sessions', { headers: { Origin: 'http://127.0.0.1:3107' },
    data: { request_id: 'oversized', credential: 'a'.repeat(64), extra: 'x'.repeat(300 * 1024) } });
  expect(oversized.status()).toBe(413); expect((await oversized.json()).ingestion).toBe('NOT_INGESTED');
  expect((await request.get('/api/p0/sessions/unknown')).status()).toBe(401);
});
