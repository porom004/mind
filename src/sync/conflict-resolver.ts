// ── Conflict Resolution for Sync ──

const FUTURE_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

export type TimestampClassification =
  | { kind: 'valid'; epoch: number }
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'far-future'; epoch: number };

export function classifyUtcTimestamp(value: string | null | undefined): TimestampClassification {
  if (!value || typeof value !== 'string' || !value.trim()) return { kind: 'missing' };

  const trimmed = value.trim();
  const normalizedInput = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed;
  const epoch = Date.parse(normalizedInput);
  if (!Number.isFinite(epoch)) return { kind: 'invalid' };
  if (epoch > Date.now() + FUTURE_TIMESTAMP_TOLERANCE_MS) return { kind: 'far-future', epoch };
  return { kind: 'valid', epoch };
}

function parseComparableTimestampEpoch(value: string | null | undefined): number | null {
  const classification = classifyUtcTimestamp(value);
  return classification.kind === 'valid' ? classification.epoch : null;
}
import type { ConflictResolution } from './types';

export interface DBMemory {
  id: string;
  name: string;
  content: string;
  changed_at: string | null;
}

/**
 * Minimal frontmatter structure needed for conflict resolution.
 */
export interface FileFrontmatter {
  name: string;
  tier: number;
  pinned: boolean;
  tags: string[];
  links_to: string[];
  created_at: string;
  changed_at: string;
}

export interface Conflict {
  memoryId: string;
  memoryName: string;
  space: string;
  dbMemory: DBMemory | null; // null if doesn't exist in DB
  fileFrontmatter: FileFrontmatter;
  fileContent: string;
  dbChangedAt: string | null;
  fileChangedAt: string;
}

export interface ConflictResult {
  resolution: 'use-db' | 'use-file' | 'skip';
  reason: string;
}

/**
 * Resolve a conflict between DB and file based on the resolution strategy.
 */
export function resolveConflict(conflict: Conflict, strategy: ConflictResolution): ConflictResult {
  switch (strategy) {
    case 'db-wins':
      return { resolution: 'use-db', reason: 'db-wins strategy' };

    case 'file-wins':
      return { resolution: 'use-file', reason: 'file-wins strategy' };

    case 'latest-wins': {
      const dbTimestamp = classifyUtcTimestamp(conflict.dbChangedAt);
      const fileTimestamp = classifyUtcTimestamp(conflict.fileChangedAt);
      if (fileTimestamp.kind === 'far-future') {
        return { resolution: 'skip', reason: 'file timestamp is too far in the future' };
      }
      if (dbTimestamp.kind === 'far-future') {
        return { resolution: 'skip', reason: 'db timestamp is too far in the future' };
      }
      if (dbTimestamp.kind !== 'valid' || fileTimestamp.kind !== 'valid') {
        return { resolution: 'skip', reason: 'invalid timestamp for latest-wins comparison' };
      }
      return fileTimestamp.epoch > dbTimestamp.epoch
        ? { resolution: 'use-file', reason: 'file is newer' }
        : { resolution: 'use-db', reason: 'db is newer or equal' };
    }
  }
}

/**
 * Determine whether to update an existing memory based on conflict resolution strategy.
 * This is a simplified version for cases where we have direct access to both changed_at values.
 */
export function shouldUpdateMemory(
  existingChangedAt: string | null | undefined,
  fileFrontmatterChangedAt: string | null | undefined,
  strategy: ConflictResolution
): boolean {
  switch (strategy) {
    case 'db-wins':
      // DB always wins - never update from file
      return false;

    case 'file-wins':
      // File always wins - always update
      return true;

    case 'latest-wins':
      return shouldUseFileForLatestWins(existingChangedAt, fileFrontmatterChangedAt);

    default:
      return false;
  }
}

function shouldUseFileForLatestWins(
  existingChangedAt: string | null | undefined,
  fileFrontmatterChangedAt: string | null | undefined
): boolean {
  const existingEpoch = parseComparableTimestampEpoch(existingChangedAt);
  const fileEpoch = parseComparableTimestampEpoch(fileFrontmatterChangedAt);

  if (existingEpoch === null || fileEpoch === null) return false;
  return fileEpoch > existingEpoch;
}
