// ── Validation helper functions for repository operations ──

import type { Database } from 'bun:sqlite';

export interface MemoryRow {
  space_id: string;
  fts_id: number;
  id: string;
  space_name: string;
  name: string;
  content: string;
  tier: number;
  pinned: number;
  access_count: number;
  last_accessed_at: string | null;
  created_at: string;
  updated_at: string;
  changed_at: string;
  [key: string]: unknown;
}

/**
 * Require that a space exists in the database.
 * @throws Error if the space does not exist
 */
export function requireSpace(db: Database, name: string): void {
  const row = db.query('SELECT 1 FROM spaces WHERE name = ?').get(name);
  if (!row)
    throw new Error(`Space "${name}" does not exist. Create it first with space_create tool.`);
}

/**
 * Require that a memory exists in the database.
 * @throws Error if the memory does not exist
 * @returns the memory row
 */
export function requireMemory(db: Database, id: string): MemoryRow {
  const row = db.query('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
  if (!row)
    throw new Error(
      `Memory with id ${id} does not exist. Use memory_query or search to find valid IDs.`
    );
  return row;
}
