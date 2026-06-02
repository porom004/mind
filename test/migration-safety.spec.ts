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
  const db = new Database(dbPath, { create: true });
  initializeDatabase(db);
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
    createCurrentDb(dbPath);
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
    createCurrentDb(dbPath);
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
    createCurrentDb(dbPath);
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
