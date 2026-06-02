import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

import { normalizeTags } from '../helpers/tags';
import type { MindStore } from '../store/mind-store';
import type { Memory, Tier } from '../types';

import { runWithAutoExportSuppressed } from './auto-export-store';
import { shouldUpdateMemory } from './conflict-resolver';
import { parseFrontmatter } from './frontmatter';
import type { ConflictResolution, Frontmatter, ImportResult } from './types';

export interface SingleFileImportResult {
  action: 'imported' | 'updated' | 'skipped' | 'deleted' | 'failed';
  memoryName?: string;
  linksCreated?: number;
  linksFailed?: number;
  error?: string;
}

interface ValidatedMetadata {
  tier: Tier;
  pinned: boolean;
  tags: string[];
  linksTo: string[];
}

export async function importMarkdownFile(
  store: MindStore,
  space: string,
  filePath: string,
  conflictResolution: ConflictResolution
): Promise<SingleFileImportResult> {
  try {
    const content = await Bun.file(filePath).text();
    let frontmatter: Frontmatter;
    let body: string;

    try {
      ({ frontmatter, content: body } = parseFrontmatter(content));
    } catch (err) {
      return { action: 'failed', error: `Invalid frontmatter: ${err}` };
    }

    const validation = validateMetadata(frontmatter);
    const existing = store.getMemory(space, frontmatter.name);
    let memory: Memory;
    let action: 'imported' | 'updated';

    if (existing) {
      if (!shouldUpdateMemory(existing.changed_at, frontmatter.changed_at, conflictResolution)) {
        return { action: 'skipped', memoryName: frontmatter.name };
      }
      memory = await applyExistingMemoryUpdate(store, existing, body, validation);
      action = 'updated';
    } else {
      memory = await runWithAutoExportSuppressed(() =>
        store.addMemory(space, frontmatter.name, body, {
          tags: validation.tags,
          tier: validation.tier,
          pinned: validation.pinned,
        })
      );
      action = 'imported';
    }

    const links = await createLinksTo(store, space, memory.id, validation.linksTo, filePath);
    return {
      action,
      memoryName: memory.name,
      linksCreated: links.created,
      linksFailed: links.failed,
      error: links.errors.join('\n'),
    };
  } catch (err) {
    return { action: 'failed', error: String(err) };
  }
}

export async function importFromDirectory(
  store: MindStore,
  space: string,
  basePath: string,
  conflictResolution: ConflictResolution
): Promise<ImportResult> {
  const result: ImportResult = {
    imported: 0,
    updated: 0,
    linksCreated: 0,
    linksFailed: 0,
    failed: 0,
    errors: [],
  };

  if (!existsSync(basePath)) {
    result.errors.push(`Directory does not exist: ${basePath}`);
    return result;
  }

  const files = readdirSync(basePath).filter(file => file.endsWith('.md'));
  for (const file of files) {
    const filePath = join(basePath, file);
    const fileResult = await importMarkdownFile(store, space, filePath, conflictResolution);
    if (fileResult.action === 'imported') result.imported++;
    if (fileResult.action === 'updated') result.updated++;
    if (fileResult.action === 'failed') result.failed++;
    result.linksCreated += fileResult.linksCreated ?? 0;
    result.linksFailed += fileResult.linksFailed ?? 0;
    if (fileResult.error) result.errors.push(fileResult.error);
  }

  return result;
}

function validateMetadata(frontmatter: Frontmatter): ValidatedMetadata {
  if (![1, 2, 3].includes(frontmatter.tier)) {
    throw new Error(`Invalid tier "${frontmatter.tier}". Expected 1, 2, or 3.`);
  }
  if (typeof frontmatter.pinned !== 'boolean') {
    throw new Error('Invalid pinned value. Expected true or false.');
  }
  if (!Array.isArray(frontmatter.tags) || !frontmatter.tags.every(tag => typeof tag === 'string')) {
    throw new Error('Invalid tags. Expected a list of strings.');
  }
  if (
    !Array.isArray(frontmatter.links_to) ||
    !frontmatter.links_to.every(ref => typeof ref === 'string')
  ) {
    throw new Error('Invalid links_to. Expected a list of strings.');
  }

  return {
    tier: frontmatter.tier as Tier,
    pinned: frontmatter.pinned,
    tags: normalizeTags(frontmatter.tags),
    linksTo: frontmatter.links_to,
  };
}

async function applyExistingMemoryUpdate(
  store: MindStore,
  existing: Memory,
  content: string,
  metadata: ValidatedMetadata
): Promise<Memory> {
  const moved = await runWithAutoExportSuppressed(() =>
    store.moveMemory(existing.id, {
      space: existing.space_name,
      content,
      tier: metadata.tier,
    })
  );
  await runWithAutoExportSuppressed(() => store.setMemoryTags(existing.id, metadata.tags));
  if (metadata.pinned !== moved.pinned) {
    await runWithAutoExportSuppressed(() =>
      metadata.pinned ? store.pin(existing.id) : store.unpin(existing.id)
    );
  }
  return store.getMemoryById(existing.id) ?? moved;
}

async function createLinksTo(
  store: MindStore,
  space: string,
  sourceId: number,
  linksTo: string[],
  filePath: string
): Promise<{ created: number; failed: number; errors: string[] }> {
  let created = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const linkRef of linksTo) {
    const targetId = resolveMemoryRef(store, space, linkRef);
    if (!targetId) {
      failed++;
      errors.push(`Link target not found: ${linkRef} (in ${filePath})`);
      continue;
    }
    try {
      await runWithAutoExportSuppressed(() => store.link(sourceId, targetId));
      created++;
    } catch (err) {
      failed++;
      errors.push(`Failed to create link: ${linkRef} -> ${err}`);
    }
  }

  return { created, failed, errors };
}

function resolveMemoryRef(store: MindStore, space: string, ref: string): number | null {
  const parsed = store.resolveMemoryRef(ref);
  const target = parsed ? store.getMemory(parsed.space, parsed.name) : store.getMemory(space, ref);
  return target?.id ?? null;
}
