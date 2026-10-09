import {defineConfig,devices} from '@playwright/test';
import {fileURLToPath} from 'node:url';
// Exercises the real runner and SQLite store without the POSIX-only file server.
export default defineConfig({testDir:'./runner-browser',workers:1,reporter:'list',
  use:{baseURL:'http://127.0.0.1:5178',trace:'retain-on-failure',...devices['Desktop Chrome']},
  webServer:{cwd:fileURLToPath(new URL('../',import.meta.url)),command:'node node_modules/vite/bin/vite.js --port 5178',url:'http://127.0.0.1:5178/run.html',timeout:15000,reuseExistingServer:false}});
