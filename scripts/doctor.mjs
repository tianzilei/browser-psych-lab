import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { root, run, loadEnv } from './lib.mjs';
import { openDatabase } from '../src/server/database.ts';

loadEnv();
let failures = 0;
async function check(label, callback) {
  try { console.log(`${label}: ${await callback()}`); }
  catch { failures++; console.error(`${label}: FAILED`); }
}
await check('Node', async () => {
  const expected = (await readFile(resolve(root, '.nvmrc'), 'utf8')).trim();
  if (process.versions.node !== expected) throw new Error('Use nvm use');
  return process.version;
});
await check('Dependencies', async () => {
  await run('npm', ['ls', '--depth=0'], { cwd: root });
  return 'installed';
});
await check('SQLite', async () => {
  if (!process.env.DATABASE_PATH) throw new Error('Missing .env');
  await access(resolve(root, process.env.DATABASE_PATH));
  const db = openDatabase(resolve(root, process.env.DATABASE_PATH));
  try {
    if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('Integrity failure');
    return `${db.prepare('SELECT sqlite_version() AS v').get().v}; WAL / FULL / foreign keys`;
  } finally { db.close(); }
});
for (const bucket of ['research-assets', 'research-exports', 'research-backups']) {
  await check(bucket, async () => {
    await access(resolve(root, process.env.STORAGE_ROOT ?? 'var', bucket), constants.R_OK | constants.W_OK);
    return 'readable/writable (same-machine development storage)';
  });
}
const manifest = JSON.parse(await readFile(resolve(root, 'references/manifest.lock.json'), 'utf8'));
for (const repo of manifest.repositories) {
  await check(`Reference ${repo.name}`, async () => {
    const cwd = resolve(root, 'references/checkouts', repo.name);
    const actual = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
    if (actual !== repo.commit) throw new Error('Commit mismatch');
    if ((await run('git', ['status', '--porcelain'], { cwd })).stdout.trim()) throw new Error('Dirty reference');
    for (const license of repo.licenses ?? []) {
      const bytes = await readFile(resolve(cwd, license.path));
      if (createHash('sha256').update(bytes).digest('hex') !== license.sha256) throw new Error('License mismatch');
    }
    return actual.slice(0, 12);
  });
}
for (const file of manifest.files ?? []) {
  await check(`Source ${file.path}`, async () => {
    const bytes = await readFile(resolve(root, 'references', file.path));
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Digest mismatch');
    return file.sha256.slice(0, 12);
  });
}
process.exitCode = failures ? 1 : 0;
