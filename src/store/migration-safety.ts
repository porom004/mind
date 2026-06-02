import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from 'fs';
import { basename, dirname, join } from 'path';

import { Database } from 'bun:sqlite';

import { SCHEMA_VERSION, initializeDatabase } from './schema';

type ValidateDatabase = (db: Database) => void;

interface MigrationSafetyOptions {
  validateDatabase?: ValidateDatabase;
  now?: () => Date;
}

let backupCounter = 0;

const BACKUP_KEEP_COUNT = 3;
const BACKUP_MARKER = '.migration-backup.';

export function openDatabaseWithSafeMigrations(
  dbPath: string,
  options: MigrationSafetyOptions = {}
): Database {
  const existedBeforeOpen = existsSync(dbPath);
  const db = new Database(dbPath, { create: true });
  const startingVersion = existedBeforeOpen ? readSchemaVersionIfPossible(db) : null;
  const needsMigrationBackup = startingVersion !== null && startingVersion < SCHEMA_VERSION;

  if (!needsMigrationBackup) {
    initializeDatabase(db);
    return db;
  }

  const backupPath = createMigrationBackup(db, dbPath, options.now?.() ?? new Date());

  try {
    initializeDatabase(db);
    const validate = options.validateDatabase ?? validateMigratedDatabase;
    validate(db);
    pruneAutomaticMigrationBackups(dbPath);
    return db;
  } catch (error) {
    closeQuietly(db);
    try {
      restoreMigrationBackup(dbPath, backupPath);
      pruneAutomaticMigrationBackups(dbPath);
    } catch (restoreError) {
      throw new Error(
        `Automatic DB migration failed and restore from backup ${backupPath} failed: ${errorMessage(restoreError)} (migration error: ${errorMessage(error)})`
      );
    }
    throw new Error(
      `Automatic DB migration failed; restored backup from ${backupPath}: ${errorMessage(error)}`
    );
  }
}

export function getAutomaticMigrationBackupPaths(dbPath: string): string[] {
  const parent = dirname(dbPath);
  if (!existsSync(parent)) return [];

  const prefix = `${basename(dbPath)}${BACKUP_MARKER}`;
  return readdirSync(parent)
    .filter(name => name.startsWith(prefix))
    .map(name => join(parent, name))
    .sort((left, right) => compareBackupNewestFirst(left, right));
}

function readSchemaVersionIfPossible(db: Database): number | null {
  try {
    const row = db.query('SELECT value FROM meta WHERE key = ?').get('schema_version') as {
      value: string;
    } | null;
    if (!row) return null;

    const version = Number.parseInt(row.value, 10);
    return Number.isFinite(version) ? version : null;
  } catch {
    return null;
  }
}

function createMigrationBackup(db: Database, dbPath: string, now: Date): string {
  const backupPath = nextBackupPath(dbPath, now);
  db.exec(`VACUUM INTO ${sqlString(backupPath)}`);
  return backupPath;
}

function nextBackupPath(dbPath: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:.]/g, '');
  const parent = dirname(dbPath);
  const base = basename(dbPath);

  let candidate = join(
    parent,
    `${base}${BACKUP_MARKER}${stamp}-${process.pid}-${backupCounter++}.db`
  );
  while (existsSync(candidate)) {
    candidate = join(
      parent,
      `${base}${BACKUP_MARKER}${stamp}-${process.pid}-${backupCounter++}.db`
    );
  }
  return candidate;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function validateMigratedDatabase(db: Database): void {
  const version = readSchemaVersionIfPossible(db);
  if (version !== SCHEMA_VERSION) {
    throw new Error(`expected schema version ${SCHEMA_VERSION}, found ${version ?? 'unknown'}`);
  }

  const quickCheck = db.query('PRAGMA quick_check').get() as { quick_check: string } | null;
  if (quickCheck?.quick_check !== 'ok') {
    throw new Error(`PRAGMA quick_check failed: ${quickCheck?.quick_check ?? 'no result'}`);
  }

  const foreignKeyProblems = db.query('PRAGMA foreign_key_check').all() as unknown[];
  if (foreignKeyProblems.length > 0) {
    throw new Error(`PRAGMA foreign_key_check found ${foreignKeyProblems.length} problem(s)`);
  }
}

function restoreMigrationBackup(dbPath: string, backupPath: string): void {
  removeDatabaseFiles(dbPath);
  copyFileSync(backupPath, dbPath);
}

function removeDatabaseFiles(dbPath: string): void {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    rmSync(path, { force: true });
  }
}

function pruneAutomaticMigrationBackups(dbPath: string): void {
  const backups = getAutomaticMigrationBackupPaths(dbPath);
  for (const backupPath of backups.slice(BACKUP_KEEP_COUNT)) {
    rmSync(backupPath, { force: true });
  }
}

function compareBackupNewestFirst(left: string, right: string): number {
  const leftStat = statSync(left);
  const rightStat = statSync(right);
  if (rightStat.mtimeMs !== leftStat.mtimeMs) return rightStat.mtimeMs - leftStat.mtimeMs;
  return right.localeCompare(left);
}

function closeQuietly(db: Database): void {
  try {
    db.close();
  } catch {
    // Best-effort close before replacing database files.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
