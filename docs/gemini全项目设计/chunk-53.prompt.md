全项目设计讨论，传输段 53，源码主题：运维工具和部署（源包 17/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

### scripts/setup.mjs L1–L22

```
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

```

### scripts/smoke.mjs L1–L51

```
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../src/server/database.ts';
import Database from 'better-sqlite3';

// This disposable fixture exercises the native driver; it does not touch research data.
const directory = await mkdtemp(resolve(tmpdir(), 'browser-psych-lab-smoke-'));
const path = resolve(directory, 'source.sqlite');
const db = openDatabase(path);
let reader;
try {
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(db.pragma('synchronous', { simple: true }), 2);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  db.exec('CREATE TABLE events (id TEXT PRIMARY KEY, raw BLOB NOT NULL) STRICT');
  const raw = Buffer.from('{"kind":"TEST_ONLY","text":"原始字节"}', 'utf8');
  const insert = db.prepare('INSERT INTO events VALUES (?, ?)');
  db.transaction(() => insert.run('fixture-1', raw)).immediate();
  assert.throws(() => insert.run('fixture-1', Buffer.from('conflict')), /UNIQUE/);
  assert.deepEqual(db.prepare('SELECT raw FROM events WHERE id=?').get('fixture-1').raw, raw);
  assert.throws(() => db.transaction(() => {
    insert.run('rolled-back', raw);
    throw new Error('injected failure');
  }).immediate(), /injected failure/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 1);

  reader = new Database(path, { readonly: true });
  reader.exec('BEGIN');
  assert.equal(reader.prepare('SELECT count(*) AS n FROM events').get().n, 1);
  insert.run('fixture-2', raw);
  assert.equal(reader.prepare('SELECT count(*) AS n FROM events').get().n, 1);
  reader.exec('COMMIT');
  assert.equal(reader.prepare('SELECT count(*) AS n FROM events').get().n, 2);
  reader.close(); reader = undefined;

  const backupPath = resolve(directory, 'backup.sqlite');
  await db.backup(backupPath);
  const restored = new Database(backupPath, { readonly: true });
  try {
    assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(restored.prepare('SELECT count(*) AS n FROM events').get().n, 2);
    assert.deepEqual(restored.prepare('SELECT raw FROM events WHERE id=?').get('fixture-1').raw, raw);
  } finally { restored.close(); }
  console.log('PASS: WAL/FULL, exact bytes, uniqueness, commit/rollback, stable read view, backup/reopen.');
} finally {
  reader?.close(); db.close();
  await rm(directory, { recursive: true, force: true });
}

```