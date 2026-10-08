import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { root, loadEnv } from './lib.mjs';

// Foundation-only probe: read-only readiness, not participant ingestion capacity.
loadEnv();
const assets = [];
for (const name of await readdir(resolve(root, 'dist/web/assets'))) {
  const path = resolve(root, 'dist/web/assets', name);
  if (!/\.(js|css)$/.test(name)) continue;
  const bytes = await readFile(path);
  assets.push({ name, bytes: (await stat(path)).size, gzipBytes: gzipSync(bytes).length });
}
const manifest = JSON.parse(await readFile(resolve(root, 'dist/web/.vite/manifest.json'), 'utf8'));
const initialPaths = new Set();
function visit(key) {
  const item = manifest[key];
  if (!item || initialPaths.has(item.file)) return;
  initialPaths.add(item.file);
  for (const path of item.css ?? []) initialPaths.add(path);
  for (const imported of item.imports ?? []) visit(imported);
}
for (const [key, item] of Object.entries(manifest)) if (item.isEntry) visit(key);
const initialAssets = assets.filter(asset => initialPaths.has(`assets/${asset.name}`));
const child = spawn(process.execPath, [resolve(root, 'dist/server/main.js')], {
  cwd: root,
  env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', chunk => { logs = (logs + chunk.toString()).slice(-64000); });
child.stderr.on('data', () => {});
try {
  let address;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('Probe server exited');
    address = /Server listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(logs)?.[1];
    if (address) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!address) throw new Error('Probe server startup timed out');
  const latencies = [];
  let failures = 0;
  const start = performance.now();
  for (let wave = 0; wave < 10; wave++) {
    await Promise.all(Array.from({ length: 20 }, async () => {
      const before = performance.now();
      try {
        const response = await fetch(`${address}/api/health/ready`, { signal: AbortSignal.timeout(5000) });
        const body = await response.json();
        if (!response.ok || body.mode !== 'TEST_ONLY') failures++;
      } catch { failures++; }
      latencies.push(performance.now() - before);
    }));
  }
  latencies.sort((a, b) => a - b);
  const report = {
    scope: 'TEST_ONLY; 20 concurrent readiness GETs per wave; no participant writes or image preload',
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    assets,
    initialAssetBytes: initialAssets.reduce((sum, asset) => sum + asset.bytes, 0),
    initialGzipBytes: initialAssets.reduce((sum, asset) => sum + asset.gzipBytes, 0),
    initialAssets: initialAssets.map(asset => asset.name),
    requests: latencies.length, concurrency: 20, failures,
    elapsedMs: Number((performance.now() - start).toFixed(2)),
    p50Ms: Number(latencies[Math.ceil(latencies.length * 0.5) - 1].toFixed(2)),
    p95Ms: Number(latencies[Math.ceil(latencies.length * 0.95) - 1].toFixed(2)),
    p99Ms: Number(latencies[Math.ceil(latencies.length * 0.99) - 1].toFixed(2)),
  };
  const text = JSON.stringify(report, null, 2) + '\n';
  if (process.argv[2]) await writeFile(resolve(root, process.argv[2]), text);
  process.stdout.write(text);
  if (failures) process.exitCode = 1;
} finally {
  const exited = new Promise(resolve => child.once('exit', resolve));
  if (child.exitCode === null) { child.kill('SIGTERM'); await exited; }
}
