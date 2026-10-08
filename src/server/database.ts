import Database from 'better-sqlite3';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

// Connection policy shared by the dedicated writer and isolated setup/smoke scripts.
export function openDatabase(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { timeout: 3000 });
  try {
    const version = db.prepare('SELECT sqlite_version() AS version').get() as { version: string };
    const [major = 0, minor = 0, patch = 0] = version.version.split('.').map(Number);
    if (major < 3 || (major === 3 && (minor < 51 || (minor === 51 && patch < 3)))) {
      throw new Error('SQLite >=3.51.3 is required for the WAL-reset fix.');
    }
    const journal = db.pragma('journal_mode = WAL', { simple: true });
    if (journal !== 'wal') throw new Error('Database filesystem does not support WAL.');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 3000');
    for (const [name, expected] of [['synchronous', 2], ['foreign_keys', 1], ['busy_timeout', 3000]] as const) {
      if (db.pragma(name, { simple: true }) !== expected) throw new Error(`Database ${name} policy failed.`);
    }
    if (process.platform === 'darwin') {
      db.pragma('fullfsync = ON');
      db.pragma('checkpoint_fullfsync = ON');
    }
    chmodSync(path, 0o600);
    return db;
  } catch (error) { db.close(); throw error; }
}
