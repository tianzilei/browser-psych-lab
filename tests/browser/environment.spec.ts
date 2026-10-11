import { test, expect } from '@playwright/test';

test('authenticated diagnostics keep native DB, SurveyJS, IndexedDB and frame checks off the home page', async ({ page,context }) => {
  const errors: string[] = [];
  const surveyRequests: string[] = [];
  page.on('request', request => {
    if (request.url().includes('/assets/survey-demo-')) surveyRequests.push(request.url());
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'问卷列表'})).toBeVisible();await expect(page.locator('a[href="/admin.html"]')).toHaveCount(0);await expect(page.locator('#checks')).toHaveCount(0);
  await page.goto('/diagnostics.html');await expect(page).toHaveURL(/\/$/);
  const login=await context.request.post('/api/auth/login',{headers:{Origin:'http://127.0.0.1:3107'},data:{password:'TEST_ONLY-browser-password'}});expect(login.ok()).toBe(true);
  await page.goto('/diagnostics.html');
  await expect(page.locator('#checks li')).toHaveCount(4);
  await expect(page.locator('#checks li[data-status="failed"]')).toHaveCount(0);
  await expect(page.locator('#checks')).toContainText('SQLite');
  expect(surveyRequests).toHaveLength(0);
  await page.getByRole('button', { name: '加载问卷样例' }).click();
  await page.getByText('正常显示', { exact: true }).click();
  await expect(page.getByRole('radio', { name: '正常显示', exact: true })).toBeChecked();
  await page.getByRole('button', { name: '结束渲染检查' }).click();
  await expect(page.locator('#survey')).toContainText('答案未保存');
  expect(surveyRequests.length).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('development database and private storage are not served', async ({ request }) => {
  for (const path of ['/var/database/browser-psych-lab.sqlite', '/research-assets/example', '/.env']) {
    expect((await request.get(path)).status()).toBe(404);
  }
});

test('public bundles use precompression and separate cache rules from HTML/API', async ({ request }) => {
  const html = await request.get('/');
  expect(html.headers()['cache-control']).toBe('no-cache');
  const entryPath = /src="([^" ]+\.js)"/.exec(await html.text())?.[1];
  expect(entryPath).toBeTruthy();
  const asset = await request.get(entryPath!, { headers: { 'Accept-Encoding': 'br' } });
  expect(asset.headers()['content-encoding']).toBe('br');
  expect((asset.headers()['vary'] ?? '').toLowerCase().split(',').map(value => value.trim())).toContain('accept-encoding');
  expect(asset.headers()['cache-control']).toContain('immutable');
  const health = await request.get('/api/health/ready');
  expect(health.headers()['cache-control']).toBe('no-store');
});
