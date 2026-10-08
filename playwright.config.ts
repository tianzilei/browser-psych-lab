import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:3107', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node scripts/browser-server.mjs',
    env: { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '3107' },
    url: 'http://127.0.0.1:3107/api/health/ready',
    reuseExistingServer: false,
    timeout: 15000,
  },
});
