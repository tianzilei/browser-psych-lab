import { mkdir, readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { root, run } from './lib.mjs';

const manifest = JSON.parse(await readFile(resolve(root, 'references/manifest.lock.json'), 'utf8'));
const base = resolve(root, 'references/checkouts');
await mkdir(base, { recursive: true });
let failed = false;
for (const repo of manifest.repositories) {
  try {
    if (!/^[a-zA-Z0-9._-]+$/.test(repo.name) || !/^[0-9a-f]{40}$/.test(repo.commit)) {
      throw new Error('Invalid locked identity');
    }
    const cwd = resolve(base, repo.name);
    await mkdir(cwd, { recursive: true });
    try { await access(resolve(cwd, '.git')); } catch {
      await run('git', ['init', '--quiet', cwd]);
      await run('git', ['remote', 'add', 'origin', repo.url], { cwd });
    }
    const remote = (await run('git', ['remote', 'get-url', 'origin'], { cwd })).stdout.trim();
    if (remote !== repo.url) throw new Error('Unexpected remote; directory left untouched');
    const changes = (await run('git', ['status', '--porcelain'], { cwd })).stdout.trim();
    if (changes) throw new Error('Local changes; directory left untouched');
    let current;
    try { current = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim(); } catch {}
    if (current && current !== repo.commit) throw new Error('Different checkout; directory left untouched');
    if (!current) {
      await run('git', ['-c', 'core.hooksPath=/dev/null', 'fetch', '--quiet', '--depth=1', 'origin', repo.commit],
        { cwd, timeout: 180000, maxBuffer: 1024 * 1024 });
      await run('git', ['-c', 'core.hooksPath=/dev/null', 'checkout', '--quiet', '--detach', repo.commit], { cwd });
    }
    const actual = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
    if (actual !== repo.commit) throw new Error('Commit verification failed');
    for (const license of repo.licenses ?? []) {
      const bytes = await readFile(resolve(cwd, license.path));
      if (createHash('sha256').update(bytes).digest('hex') !== license.sha256) {
        throw new Error('License evidence mismatch');
      }
    }
    console.log(`${repo.name}: ${actual.slice(0, 12)} ready`);
  } catch (error) {
    console.error(`${repo.name}: fetch/verification failed (${error.code ?? 'check failed'}). Rerun to retry.`);
    failed = true;
  }
}
for (const file of manifest.files ?? []) {
  const bytes = await readFile(resolve(root, 'references', file.path));
  if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
    console.error(`${file.path}: digest mismatch`);
    failed = true;
  }
}
if (failed) process.exitCode = 1;
