import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root, loadEnv } from './lib.mjs';
import { openDatabase } from '../src/server/database.ts';

const example = await readFile(resolve(root, '.env.example'), 'utf8');
try { await writeFile(resolve(root, '.env'), example, { flag: 'wx', mode: 0o600 }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
loadEnv();
if (!process.env.DATABASE_PATH || !process.env.STORAGE_ROOT) throw new Error('Missing local paths in .env.');
for (const bucket of ['research-assets', 'research-exports', 'research-backups']) {
  await mkdir(resolve(root, process.env.STORAGE_ROOT, bucket), { recursive: true, mode: 0o700 });
}
await mkdir(resolve(root, '.local'), { recursive: true, mode: 0o700 });
const db = openDatabase(resolve(root, process.env.DATABASE_PATH));
try {
  if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('SQLite quick_check failed.');
  const version = db.prepare('SELECT sqlite_version() AS version').get().version;
  console.log(`SQLite ${version}: WAL, synchronous=FULL, foreign_keys=ON`);
} finally { db.close(); }
console.log('Local database, private storage directories and .env ready.');
