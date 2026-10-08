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
