import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

import type { MindStore } from '../store/mind-store';
import type { Memory, MemorySummary } from '../types';

import { parseFrontmatter } from './frontmatter';
import { evaluateSyncState, hashFrontmatterAndContent, readManifestV2 } from './manifest';
import { getSpaceDir } from './normalize';
import type { SyncStatusDiagnostics } from './types';

export function evaluateSyncStatus(
  store: MindStore,
  space: string,
  syncBasePath: string
): SyncStatusDiagnostics {
  const spaceDir = getSpaceDir(syncBasePath, space);
  const manifest = readManifestV2(spaceDir, space);
  const files = listMarkdownFiles(spaceDir);
  const memories = listAllSpaceMemories(store, space);
  const memoryById = new Map<number, Memory>();
  const memoryByName = new Map<string, Memory>();

  for (const summary of memories) {
    const memory = store.getMemoryById(summary.id);
    if (!memory) continue;
    memoryById.set(memory.id, memory);
    memoryByName.set(memory.name, memory);
  }

  const diagnostics: SyncStatusDiagnostics = {
    space,
    counts: {
      dbMemories: memories.length,
      files: files.length,
      manifestEntries: Object.keys(manifest.entries).length,
      missingManagedFiles: 0,
      dirtyDb: 0,
      dirtyFiles: 0,
      conflicts: 0,
      tombstones: 0,
    },
    warnings: [],
    conflicts: [],
    lastAutoExport: manifest.last_auto_export ?? null,
  };

  for (const entry of Object.values(manifest.entries)) {
    if (entry.deleted) {
      diagnostics.counts.tombstones++;
      continue;
    }

    const memory =
      (entry.memory_id ? memoryById.get(entry.memory_id) : undefined) ??
      memoryByName.get(entry.memory_name);
    const filePath = join(spaceDir, entry.path);
    const fileHash = readManagedFileHash(filePath, diagnostics);
    const dbHash = memory ? hashDbMemory(store, memory) : null;

    if (!existsSync(filePath)) {
      diagnostics.counts.missingManagedFiles++;
      diagnostics.warnings.push(`Missing managed file for ${entry.memory_name}: ${entry.path}`);
    }

    const state = evaluateSyncState({
      baselineHash: entry.baseline_combined_hash,
      dbHash,
      fileHash,
      dbExists: memory !== undefined,
      fileExists: fileHash !== null,
    });

    if (state.kind === 'db-dirty') diagnostics.counts.dirtyDb++;
    if (state.kind === 'file-dirty') diagnostics.counts.dirtyFiles++;
    if (state.kind === 'conflict') {
      diagnostics.counts.conflicts++;
      diagnostics.conflicts.push(entry.memory_name);
    }
  }

  return diagnostics;
}

function listMarkdownFiles(spaceDir: string): string[] {
  if (!existsSync(spaceDir)) return [];
  return readdirSync(spaceDir).filter(file => file.endsWith('.md'));
}

function listAllSpaceMemories(store: MindStore, space: string): MemorySummary[] {
  const batchSize = 100;
  const memories: MemorySummary[] = [];
  let offset = 0;

  while (true) {
    const batch = store.queryMemories({ space, limit: batchSize, offset });
    memories.push(...batch);
    if (batch.length < batchSize) return memories;
    offset += batch.length;
  }
}

function readManagedFileHash(filePath: string, diagnostics: SyncStatusDiagnostics): string | null {
  if (!existsSync(filePath)) return null;
  try {
    const parsed = parseFrontmatter(readFileSync(filePath, 'utf-8'));
    return hashFrontmatterAndContent(parsed.frontmatter, parsed.content);
  } catch (err) {
    diagnostics.counts.dirtyFiles++;
    diagnostics.warnings.push(`Unable to parse managed file ${filePath}: ${err}`);
    return null;
  }
}

function hashDbMemory(store: MindStore, memory: Memory): string {
  const linksTo = store
    .getLinks(memory.id)
    .filter(link => link.source_id === memory.id)
    .map(link =>
      link.source_space === link.target_space
        ? link.target_name
        : `${link.target_space}:${link.target_name}`
    );

  return hashFrontmatterAndContent(
    {
      id: memory.id,
      space: memory.space_name,
      name: memory.name,
      tier: memory.tier,
      pinned: memory.pinned,
      tags: memory.tags,
      links_to: linksTo,
      created_at: memory.created_at,
      changed_at: memory.changed_at,
    },
    memory.content
  );
}
