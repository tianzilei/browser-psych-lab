全项目设计讨论，传输段 54，源码主题：构建及配置（源包 18/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

### package.json L1–L58

```
{
  "name": "browser-psych-lab",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=24.21.0 <25",
    "npm": ">=11 <12"
  },
  "packageManager": "npm@11.19.0",
  "scripts": {
    "setup": "node scripts/setup.mjs",
    "references:fetch": "node scripts/references.mjs",
    "doctor": "node scripts/doctor.mjs",
    "dev": "node scripts/dev.mjs",
    "dev:server": "tsx watch src/server/main.ts",
    "dev:web": "vite --config vite.config.ts",
    "typecheck": "tsc -p tsconfig.server.json --noEmit && tsc -p tsconfig.web.json",
    "build": "tsc -p tsconfig.server.json && vite build --config vite.config.ts && node scripts/precompress.mjs && node scripts/release.mjs",
    "auth:setup": "node --import tsx scripts/auth-setup.mjs",
    "start": "node dist/server/main.js",
    "smoke": "node scripts/smoke.mjs",
    "profile:foundation": "node scripts/profile-foundation.mjs",
    "preview:questionnaire": "node scripts/preview-questionnaire.mjs",
    "images:prepare": "node --import tsx scripts/prepare-images.mjs",
    "test:browser": "playwright test",
    "test:runner": "playwright test --config tests/runner-browser.config.ts",
    "test:unit": "node --import tsx --test tests/unit/*.test.mjs",
    "check": "npm run typecheck && npm run build && npm run smoke && npm run test:unit && npm run test:browser",
    "backup": "node scripts/backup.mjs",
    "restore": "node dist/server/restore.js",
    "profile:mixed": "node --import tsx scripts/profile-mixed.mjs",
    "profile:bandwidth": "node --import tsx scripts/profile-bandwidth.mjs"
  },
  "dependencies": {
    "@fastify/static": "10.1.5",
    "better-sqlite3": "13.0.3",
    "fastify": "5.12.5"
  },
  "devDependencies": {
    "@playwright/test": "1.64.0",
    "@types/better-sqlite3": "9.6.0",
    "@types/node": "24.19.1",
    "idb": "8.0.4",
    "sharp": "0.35.5",
    "survey-core": "3.2.0",
    "survey-js-ui": "3.2.0",
    "tsx": "4.23.15",
    "typescript": "6.0.3",
    "vite": "8.3.3"
  },
  "allowScripts": {
    "better-sqlite3@13.0.3": true,
    "esbuild@0.28.2": true,
    "fsevents": false
  }
}

```

### vite.config.ts L1–L34

```
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

try { process.loadEnvFile(); } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

export default defineConfig({
  base: './',
  root: fileURLToPath(new URL('./src/web', import.meta.url)),
  build: {
    manifest: true,
    outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    rolldownOptions: { input: {
      index: fileURLToPath(new URL('./src/web/index.html', import.meta.url)),
      diagnostics: fileURLToPath(new URL('./src/web/diagnostics.html', import.meta.url)),
      admin: fileURLToPath(new URL('./src/web/admin.html', import.meta.url)),
      replay: fileURLToPath(new URL('./src/web/replay.html', import.meta.url)),
      simulate: fileURLToPath(new URL('./src/web/simulate.html', import.meta.url)),
      participate: fileURLToPath(new URL('./src/web/participate.html', import.meta.url)),
      run: fileURLToPath(new URL('./src/web/run.html', import.meta.url)),
      p0: fileURLToPath(new URL('./src/web/p0.html', import.meta.url)),
    } },
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${process.env.PORT ?? 3000}` },
  },
});

```

### tsconfig.base.json L1–L12

```
{
  "compilerOptions": {
    "target": "ES2022",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true
  }
}

```

### tsconfig.server.json L1–L13

```
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "types": ["node"],
    "sourceMap": true
  },
  "include": ["src/server/**/*.ts", "src/shared/**/*.ts"]
}

```

### tsconfig.web.json L1–L12

```
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "noEmit": true,
    "types": ["vite/client", "node"]
  },
  "include": ["src/web/**/*.ts", "vite.config.ts", "playwright.config.ts", "tests/**/*.ts"]
}

```

### playwright.config.ts L1–L18

```
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

```

### tests/runner-browser.config.ts L1–L7

```
import {defineConfig,devices} from '@playwright/test';
import {fileURLToPath} from 'node:url';
// Exercises the real runner and SQLite store without the POSIX-only file server.
export default defineConfig({testDir:'./runner-browser',workers:1,reporter:'list',
  use:{baseURL:'http://127.0.0.1:5178',trace:'retain-on-failure',...devices['Desktop Chrome']},
  webServer:{cwd:fileURLToPath(new URL('../',import.meta.url)),command:'node node_modules/vite/bin/vite.js --port 5178',url:'http://127.0.0.1:5178/run.html',timeout:15000,reuseExistingServer:false}});

```

### .env.example L1–L12

```
# Local development defaults. npm run setup creates .env without overwriting it.
NODE_ENV=development
HOST=127.0.0.1
PORT=3000
WEB_PORT=5173
DATABASE_PATH=./var/database/browser-psych-lab.sqlite
STORAGE_ROOT=./var
SESSION_CONCURRENCY=2
PREPARATION_CONCURRENCY=1
# Optional fixed browser origin (required for deployment behind a reverse proxy).
# PUBLIC_ORIGIN=https://your-study.example

```