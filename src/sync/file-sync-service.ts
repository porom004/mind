// ── FileSyncService: exports memories from DB to filesystem ──

import {
  existsSync as _existsSync,
  readFileSync as _readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';

import type { Link, Memory, MemorySummary } from '../types';

import { generateMarkdown, parseFrontmatter } from './frontmatter';
import {
  buildEntryV1,
  combinedHash,
  entryKey,
  evaluateSyncState,
  hashContent,
  hashFrontmatterAndContent,
  hashMetadata,
  normalizeUtcTimestamp,
  parseUtcTimestampEpoch,
  readManifestV1,
  writeManifestV1,
} from './manifest';
import { ensureSpaceDir, getSpaceDirById } from './normalize';
import type { ConflictResolution, ExportResult, SpaceManifestV1 } from './types';

/**
 * Minimal interface for store operations needed by FileSyncService.
 * This allows FileSyncService to work with any compatible implementation.
 */
export interface SyncStore {
  getSpace(name: string): { id?: string } | null;
  listMemories(space: string, filter?: any): MemorySummary[];
  getMemoryById(id: string): Memory | null;
  getLinks(memoryId: string): Link[];
  queryMemories(filter?: {
    space?: string;
    tier?: number;
    limit?: number;
    offset?: number;
  }): MemorySummary[];
}

export class FileSyncService {
  constructor(
    private readonly store: SyncStore,
    private readonly options: { conflictResolution?: ConflictResolution } = {}
  ) {}

  /**
   * Export all memories from a space to files using UUID-based directories.
   * .mind/spaces/<space_uuid>/memory-name.md
   *
   * Creates the space directory and manifest.json if they don't exist.
   * Exports ALL tiers (T1+T2+T3) for a complete snapshot.
   */
  async exportSpaceToFiles(space: string, basePath: string): Promise<ExportResult> {
    const result: ExportResult = { exported: 0, failed: 0, errors: [], warnings: [] };

    // Resolve space UUID for directory naming
    const spaceInfo = this.store.getSpace(space);
    const spaceId = spaceInfo?.id;
    if (!spaceId) {
      result.failed++;
      result.errors.push(`Space "${space}" has no UUID — cannot determine sync directory`);
      return result;
    }

    // Resolve the space directory using UUID
    const spaceDir = getSpaceDirById(basePath, spaceId);

    // Ensure the directory exists
    try {
      ensureSpaceDir(spaceDir);
    } catch (err) {
      result.failed++;
      result.errors.push(`Failed to create space directory: ${err}`);
      return result;
    }

    const manifest = readManifestV1(spaceDir, space, spaceId);
    const seenKeys = new Set<string>();
    const usedPaths = new Set<string>();

    for (const entry of Object.values(manifest.entries)) {
      usedPaths.add(entry.path);
    }

    // Export ALL memories in the space (all tiers) via paginated queryMemories
    const BATCH_SIZE = 100;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const memories = this.store.queryMemories({ space, limit: BATCH_SIZE, offset });

      if (memories.length === 0) {
        break;
      }

      for (const memorySummary of memories) {
        try {
          const memory = this.store.getMemoryById(memorySummary.id);
          if (!memory) {
            result.failed++;
            result.errors.push(`Memory ${memorySummary.name} not found`);
            continue;
          }

          // Get links for this memory
          const links = this.store.getLinks(memory.id);
          const links_to = this.buildLinksTo(memory.id, links, space);

          // Generate file content
          const frontmatterData = {
            id: memory.id,
            space: memory.space_name,
            name: memory.name,
            tier: memory.tier,
            pinned: memory.pinned,
            tags: memory.tags,
            links_to,
            created_at: memory.created_at,
            changed_at: memory.changed_at,
          };

          const contentHash = hashContent(memory.content);
          const metadataHash = hashMetadata({
            name: memory.name,
            tier: memory.tier,
            pinned: memory.pinned,
            tags: memory.tags,
            links_to,
          });
          const currentDbHash = combinedHash(contentHash, metadataHash);
          const key = entryKey(memory.id, memory.name);
          seenKeys.add(key);

          const previous = manifest.entries[key];
          const relativePath = this.filePathForMemory(memory, previous?.path, usedPaths);
          const filePath = join(spaceDir, relativePath);
          const fileHash = this.readFileHash(filePath);
          const state = evaluateSyncState({
            baselineHash: previous?.baseline_combined_hash ?? null,
            dbHash: currentDbHash,
            fileHash,
            dbExists: true,
            fileExists: fileHash !== null,
          });

          if (state.kind === 'conflict' && !this.dbShouldWin(memory.changed_at, filePath)) {
            result.failed++;
            result.errors.push(`Conflict for ${memory.name}: file side wins; DB export skipped`);
            result.warnings?.push(`Conflict for ${memory.name}: DB export skipped`);
            continue;
          }

          if (previous?.path && previous.path !== relativePath) {
            this.pruneManagedFile(spaceDir, previous.path, result, manifest);
          }

          const markdown = generateMarkdown(frontmatterData, memory.content);
          writeFileSync(filePath, markdown, 'utf-8');
          manifest.entries[key] = buildEntryV1({
            memoryId: memory.id,
            memoryName: memory.name,
            relativePath,
            contentHash,
            metadataHash,
            dbChangedAt: normalizeUtcTimestamp(memory.changed_at),
            fileChangedAt: normalizeUtcTimestamp(memory.changed_at),
            filePath,
          });
          result.exported++;
        } catch (err) {
          result.failed++;
          result.errors.push(`Failed to export ${memorySummary.name}: ${err}`);
        }
      }

      offset += memories.length;
      hasMore = memories.length === BATCH_SIZE;
    }

    this.pruneDeletedMemories(spaceDir, manifest, seenKeys, result);
    writeManifestV1(spaceDir, manifest);

    return result;
  }

  private readFileHash(filePath: string): string | null {
    if (!_existsSync(filePath)) return null;
    try {
      const parsed = parseFrontmatter(_readFileSync(filePath, 'utf-8'));
      return hashFrontmatterAndContent(parsed.frontmatter, parsed.content);
    } catch {
      return null;
    }
  }

  private dbShouldWin(dbChangedAt: string | null, filePath: string): boolean {
    const strategy = this.options.conflictResolution ?? 'db-wins';
    if (strategy === 'db-wins') return true;
    if (strategy === 'file-wins') return false;

    try {
      const dbEpoch = parseUtcTimestampEpoch(dbChangedAt);
      const fileEpoch = _existsSync(filePath) ? statSync(filePath).mtime.getTime() : 0;
      return dbEpoch !== null && dbEpoch >= fileEpoch;
    } catch {
      return false;
    }
  }

  private pruneDeletedMemories(
    spaceDir: string,
    manifest: SpaceManifestV1,
    seenKeys: Set<string>,
    result: ExportResult
  ): void {
    for (const [key, entry] of Object.entries(manifest.entries)) {
      if (seenKeys.has(key) || entry.deleted) continue;
      this.pruneManagedFile(spaceDir, entry.path, result, manifest);
      manifest.entries[key] = {
        ...entry,
        deleted: true,
        tombstone_at_utc: new Date().toISOString(),
      };
    }
  }

  private pruneManagedFile(
    spaceDir: string,
    relativePath: string,
    result: ExportResult,
    manifest: SpaceManifestV1
  ): void {
    const isManaged = Object.values(manifest.entries).some(entry => entry.path === relativePath);
    if (!isManaged) return;
    const filePath = join(spaceDir, relativePath);
    try {
      if (_existsSync(filePath)) unlinkSync(filePath);
    } catch (err) {
      result.warnings?.push(`Failed to prune managed file ${relativePath}: ${err}`);
    }
  }

  private filePathForMemory(
    memory: Memory,
    previousPath: string | undefined,
    usedPaths: Set<string>
  ): string {
    const preferred = `${this.sanitizeFilename(memory.name)}.md`;
    if (previousPath) {
      usedPaths.delete(previousPath);
    }
    if (!usedPaths.has(preferred)) {
      usedPaths.add(preferred);
      return preferred;
    }
    const suffix = String(
      typeof memory.id === 'string'
        ? memory.id.slice(0, 8)
        : (memory.id ?? Math.abs(this.hashCode(memory.name)))
    ).slice(0, 8);
    const collisionSafe = `${this.sanitizeFilename(memory.name)}-${suffix}.md`;
    usedPaths.add(collisionSafe);
    return collisionSafe;
  }

  private hashCode(value: string): number {
    return [...value].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) | 0, 0);
  }

  /**
   * Build links_to array from memory links.
   * Uses space:name format for cross-space links, bare name for same-space.
   */
  private buildLinksTo(memoryId: string, links: Link[], _defaultSpace: string): string[] {
    return links
      .filter(link => link.source_id === memoryId)
      .map(link => {
        if (link.source_space === link.target_space) {
          // Same space - use bare name
          return link.target_name;
        }
        // Cross-space - use space:name format
        return `${link.target_space}:${link.target_name}`;
      });
  }

  /**
   * Sanitize filename to be safe for filesystem.
   */
  private sanitizeFilename(name: string): string {
    const sanitized = name
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    return sanitized || 'unnamed';
  }
}
