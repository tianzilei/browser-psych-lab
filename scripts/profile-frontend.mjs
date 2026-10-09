import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { root } from './lib.mjs';

// Canonical production build sizes, including dynamically loaded questionnaire code.
// This measures transfer content, not device memory, CPU time or real network latency.
const directory = resolve(root, 'dist/web');
const manifest = JSON.parse(await readFile(resolve(directory, '.vite/manifest.json'), 'utf8'));
async function measure(entry, dynamic) {
  const paths = new Set([entry]);
  const visited = new Set();
  function visit(key) {
    if (visited.has(key)) return;
    visited.add(key);
    const item = manifest[key];
    if (!item) throw new Error(`Missing manifest entry: ${key}`);
    paths.add(item.file);
    for (const file of item.css ?? []) paths.add(file);
    for (const key of item.imports ?? []) visit(key);
    if (dynamic) for (const key of item.dynamicImports ?? []) visit(key);
  }
  visit(entry);
  const files = await Promise.all([...paths].sort().map(async path => {
    const bytes = await readFile(resolve(directory, path));
    return { path, bytes: bytes.length, gzipBytes: gzipSync(bytes).length };
  }));
  return { bytes: files.reduce((n, f) => n + f.bytes, 0), gzipBytes: files.reduce((n, f) => n + f.gzipBytes, 0), files };
}
const report = {
  scope: 'Local production manifest closure; HTML + JS + CSS; gzipSync with defaults; no images, API responses or cache assumptions',
  node: process.version,
  initial: await measure('participate.html', false),
  questionnaire: await measure('participate.html', true),
  runner: await measure('run.html', true),
};
const output = resolve(root, process.argv[2] ?? 'docs/gemini前端讨论/frontend-sizes.json');
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, questionnaireBytes: report.questionnaire.bytes, questionnaireGzipBytes: report.questionnaire.gzipBytes }));
