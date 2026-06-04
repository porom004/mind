import { existsSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  getAutomaticMigrationBackupPaths,
  openDatabaseWithSafeMigrations,
} from '../src/store/migration-safety';
import { SCHEMA_VERSION, initializeDatabase } from '../src/store/schema';

let counter = 0;
const cleanupPaths: string[] = [];

function tempDbPath(): string {
  const dbPath = join(tmpdir(), `mind-migration-safety-${Date.now()}-${counter++}.db`);
  cleanupPaths.push(dbPath);
  return dbPath;
}

function cleanupDbPath(dbPath: string): void {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, ...backupPaths(dbPath)]) {
    rmSync(path, { force: true });
  }
}

function backupPaths(dbPath: string): string[] {
  if (!existsSync(dirname(dbPath))) return [];
  const prefix = `${basename(dbPath)}.migration-backup.`;
  return readdirSync(dirname(dbPath))
    .filter(name => name.startsWith(prefix))
    .map(name => join(dirname(dbPath), name))
    .sort();
}

function createCurrentDb(dbPath: string): void {
  // Create a v8 (current) database for tests that should not trigger migration
  const db = new Database(dbPath, { create: true });
  initializeDatabase(db);
  db.exec(
    "INSERT INTO spaces (id, name, description) VALUES ('00000000000000000000000000000001', 'project', 'migration test')"
  );
  db.exec(
    "INSERT INTO memories (id, fts_id, space_id, name, content, tier) VALUES ('00000000000000000000000000000002', 1, '00000000000000000000000000000001', 'kept', 'important data', 2)"
  );
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

function createV7Database(dbPath: string): void {
  // Create a v7-compatible database for migration testing
  const v7Schema =
    'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);' +
    "CREATE TABLE IF NOT EXISTS spaces (name TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '', hidden INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));" +
    'CREATE TABLE IF NOT EXISTS space_tags (space_name TEXT NOT NULL REFERENCES spaces(name) ON DELETE CASCADE ON UPDATE CASCADE, tag TEXT NOT NULL, PRIMARY KEY (space_name, tag));' +
    "CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, space_name TEXT NOT NULL REFERENCES spaces(name) ON DELETE CASCADE ON UPDATE CASCADE, name TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', tier INTEGER NOT NULL DEFAULT 2 CHECK (tier BETWEEN 1 AND 3), pinned INTEGER NOT NULL DEFAULT 0, access_count INTEGER NOT NULL DEFAULT 0, last_accessed_at TEXT, embedding BLOB, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), changed_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(space_name, name));" +
    'CREATE TABLE IF NOT EXISTS memory_tags (memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE, tag TEXT NOT NULL, PRIMARY KEY (memory_id, tag));' +
    "CREATE TABLE IF NOT EXISTS links (source_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE, target_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE, label TEXT NOT NULL DEFAULT 'related', created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (source_id, target_id), CHECK (source_id != target_id));" +
    "CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(name, content, tokenize='porter unicode61');" +
    'CREATE INDEX IF NOT EXISTS idx_memories_space ON memories(space_name);' +
    'CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(tier);' +
    'CREATE INDEX IF NOT EXISTS idx_memories_space_tier ON memories(space_name, tier);' +
    "CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, operation TEXT NOT NULL, level TEXT DEFAULT 'info', input_data TEXT, output_data TEXT, error_message TEXT, caller_info TEXT, duration_ms INTEGER, timestamp TEXT NOT NULL DEFAULT (datetime('now')));" +
    'CREATE INDEX IF NOT EXISTS idx_logs_timestamp_source ON logs(timestamp, source);' +
    'CREATE INDEX IF NOT EXISTS idx_logs_operation ON logs(operation);';
  const db = new Database(dbPath, { create: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(v7Schema);
  db.run("INSERT INTO meta (key, value) VALUES ('schema_version', '7')");
  db.exec("INSERT INTO spaces (name, description) VALUES ('project', 'migration test')");
  db.exec(
    "INSERT INTO memories (space_name, name, content, tier) VALUES ('project', 'kept', 'important data', 2)"
  );
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

function markDbOutdated(dbPath: string): void {
  const db = new Database(dbPath);
  db.run('UPDATE meta SET value = ? WHERE key = ?', ['6', 'schema_version']);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

afterEach(() => {
  for (const dbPath of cleanupPaths.splice(0)) cleanupDbPath(dbPath);
});

describe('automatic migration safety', () => {
  test('backs up an existing outdated database before migrating and preserves data', () => {
    const dbPath = tempDbPath();
    createV7Database(dbPath);
    markDbOutdated(dbPath);

    const db = openDatabaseWithSafeMigrations(dbPath);
    const migratedVersion = db
      .query('SELECT value FROM meta WHERE key = ?')
      .get('schema_version') as {
      value: string;
    };
    const memory = db.query('SELECT content FROM memories WHERE name = ?').get('kept') as {
      content: string;
    };
    db.close();

    const backups = backupPaths(dbPath);
    expect(backups).toHaveLength(1);
    expect(migratedVersion.value).toBe(String(SCHEMA_VERSION));
    expect(memory.content).toBe('important data');

    const backupDb = new Database(backups[0]!, { readonly: true });
    const backupVersion = backupDb
      .query('SELECT value FROM meta WHERE key = ?')
      .get('schema_version') as {
      value: string;
    };
    backupDb.close();
    expect(backupVersion.value).toBe('6');
  });

  test('restores the backup and removes stale WAL files when validation fails', () => {
    const dbPath = tempDbPath();
    createV7Database(dbPath);
    markDbOutdated(dbPath);

    expect(() =>
      openDatabaseWithSafeMigrations(dbPath, {
        validateDatabase: () => {
          throw new Error('forced validation failure');
        },
      })
    ).toThrow(/restored backup.*forced validation failure/);

    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);

    const restoredDb = new Database(dbPath, { readonly: true });
    const version = restoredDb
      .query('SELECT value FROM meta WHERE key = ?')
      .get('schema_version') as {
      value: string;
    };
    const memory = restoredDb.query('SELECT content FROM memories WHERE name = ?').get('kept') as {
      content: string;
    };
    restoredDb.close();

    expect(version.value).toBe('6');
    expect(memory.content).toBe('important data');
  });

  test('does not create a migration backup for a current database', () => {
    const dbPath = tempDbPath();
    createCurrentDb(dbPath);

    const db = openDatabaseWithSafeMigrations(dbPath);
    db.close();

    expect(backupPaths(dbPath)).toHaveLength(0);
  });

  test('does not create a migration backup for a fresh database', () => {
    const dbPath = tempDbPath();

    const db = openDatabaseWithSafeMigrations(dbPath);
    db.close();

    expect(existsSync(dbPath)).toBe(true);
    expect(backupPaths(dbPath)).toHaveLength(0);
  });

  test('retains only the last three automatic migration backups per database path', () => {
    const dbPath = tempDbPath();
    createV7Database(dbPath);
    markDbOutdated(dbPath);

    const oldBackups = ['20000101T000000000Z', '20000102T000000000Z', '20000103T000000000Z'];
    oldBackups.forEach((stamp, index) => {
      const path = join(dirname(dbPath), `${basename(dbPath)}.migration-backup.${stamp}.db`);
      writeFileSync(path, `old-backup-${index}`);
      const mtime = new Date(Date.UTC(2000, 0, index + 1));
      utimesSync(path, mtime, mtime);
    });

    const db = openDatabaseWithSafeMigrations(dbPath);
    db.close();

    const backups = getAutomaticMigrationBackupPaths(dbPath);
    expect(backups).toHaveLength(3);
    expect(backups.some(path => path.includes('20000101T000000000Z'))).toBe(false);
  });
});
