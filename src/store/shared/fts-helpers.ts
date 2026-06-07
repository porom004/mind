// ── FTS helper class for manual FTS5 sync ──
// bun:sqlite has a bug with content-sync triggers, so FTS is synced manually

import type { Database } from 'bun:sqlite';

export class FtsHelper {
  constructor(private db: Database) {}

  /**
   * Insert a memory into the FTS index.
   * @param ftsId - the integer surrogate for FTS5 rowid (not the UUID primary key)
   */
  insert(ftsId: number, name: string, content: string): void {
    this.db.run('INSERT INTO memories_fts(rowid, name, content) VALUES (?, ?, ?)', [
      ftsId,
      name,
      content,
    ]);
  }

  /**
   * Delete a memory from the FTS index.
   * @param ftsId - the integer surrogate for FTS5 rowid
   */
  delete(ftsId: number): void {
    this.db.run('DELETE FROM memories_fts WHERE rowid = ?', [ftsId]);
  }

  /**
   * Update a memory in the FTS index (delete + insert).
   * @param ftsId - the integer surrogate for FTS5 rowid
   */
  update(ftsId: number, name: string, content: string): void {
    this.delete(ftsId);
    this.insert(ftsId, name, content);
  }
}
