import {defineConfig,devices} from '@playwright/test';
import {fileURLToPath} from 'node:url';

export default defineConfig({testDir:'./runner-browser',testMatch:['list-viewport.spec.ts','rating-simulation.spec.ts'],workers:1,reporter:'list',
  projects:[{name:'mobile-webkit',use:{...devices['iPhone 13'],browserName:'webkit'}}],
  use:{baseURL:'http://127.0.0.1:5178',trace:'retain-on-failure'},
  webServer:{cwd:fileURLToPath(new URL('../',import.meta.url)),command:'node node_modules/vite/bin/vite.js --port 5178',url:'http://127.0.0.1:5178/',timeout:15000,reuseExistingServer:false}});
