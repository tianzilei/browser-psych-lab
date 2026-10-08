import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
const {passwordHash}=await import('../dist/server/auth.js');
process.env.ADMIN_PASSWORD_HASH=await passwordHash('TEST_ONLY-browser-password');
process.env.MAINTAINER_PASSWORD_HASH=await passwordHash('TEST_ONLY-maintainer-password');
process.env.SESSION_CONCURRENCY='2';
process.env.PREPARATION_CONCURRENCY='1';
const directory = await mkdtemp(join(tmpdir(), 'bpl-browser-'));
process.env.DATABASE_PATH = join(directory, 'database.sqlite');
process.env.STORAGE_ROOT = directory;
for (const bucket of ['research-assets', 'research-exports', 'research-backups'])
  await mkdir(join(directory, bucket), { mode: 0o700 });
process.once('exit', () => { rmSync(directory, { recursive: true, force: true }); });
try { await import('../dist/server/main.js'); }
catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
