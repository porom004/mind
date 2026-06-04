import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { basename } from 'path';

import type { Frontmatter, SpaceManifestV1, SpaceManifestV1Entry } from './types';

export type ManifestSyncState =
  | { kind: 'no-op' }
  | { kind: 'db-dirty' }
  | { kind: 'file-dirty' }
  | { kind: 'false-conflict' }
  | { kind: 'conflict' }
  | { kind: 'untracked-file' };

export function utcNow(): string {
  return new Date().toISOString();
}

export function normalizeUtcTimestamp(value: string | null | undefined): string | null {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const normalizedInput = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed;
  const epoch = Date.parse(normalizedInput);
  if (!Number.isFinite(epoch)) return null;
  if (epoch > Date.now() + 5 * 60 * 1000) return null;
  return new Date(epoch).toISOString();
}

export function parseUtcTimestampEpoch(value: string | null | undefined): number | null {
  const normalized = normalizeUtcTimestamp(value);
  if (!normalized) return null;
  const epoch = Date.parse(normalized);
  return Number.isFinite(epoch) ? epoch : null;
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `${JSON.stringify(key)}:${canonicalize(val)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashContent(content: string): string {
  return sha256(content.replace(/\r\n/g, '\n'));
}

export function hashMetadata(metadata: {
  name: string;
  tier: number;
  pinned: boolean;
  tags: string[];
  links_to: string[];
}): string {
  return sha256(
    canonicalize({
      name: metadata.name,
      tier: metadata.tier,
      pinned: metadata.pinned,
      tags: [...metadata.tags].sort(),
      links_to: [...metadata.links_to].sort(),
    })
  );
}

export function combinedHash(contentHash: string, metadataHash: string): string {
  return sha256(`${contentHash}:${metadataHash}`);
}

export function evaluateSyncState(input: {
  baselineHash: string | null;
  dbHash: string | null;
  fileHash: string | null;
  dbExists: boolean;
  fileExists: boolean;
}): ManifestSyncState {
  if (!input.baselineHash) {
    if (input.dbExists && input.fileExists) return { kind: 'untracked-file' };
    if (input.dbExists) return { kind: 'db-dirty' };
    if (input.fileExists) return { kind: 'file-dirty' };
    return { kind: 'no-op' };
  }

  const dbDirty = input.dbHash !== input.baselineHash;
  const fileDirty = input.fileHash !== input.baselineHash;
  if (!dbDirty && !fileDirty) return { kind: 'no-op' };
  if (dbDirty && !fileDirty) return { kind: 'db-dirty' };
  if (!dbDirty && fileDirty) return { kind: 'file-dirty' };
  return input.dbHash === input.fileHash ? { kind: 'false-conflict' } : { kind: 'conflict' };
}

export function manifestPath(spaceDir: string): string {
  return `${spaceDir}/manifest.json`;
}

export function fileMtimeUtc(filePath: string): string | null {
  try {
    return statSync(filePath).mtime.toISOString();
  } catch {
    return null;
  }
}

/**
 * Compute the manifest entry key for a memory.
 * Uses the memory UUID string directly.
 */
export function entryKey(memoryId: string, memoryName: string): string {
  return memoryId ? String(memoryId) : `name:${sha256(memoryName).slice(0, 12)}`;
}

export function hashFrontmatterAndContent(frontmatter: Frontmatter, content: string): string {
  return combinedHash(
    hashContent(content),
    hashMetadata({
      name: frontmatter.name,
      tier: frontmatter.tier,
      pinned: frontmatter.pinned,
      tags: frontmatter.tags,
      links_to: frontmatter.links_to,
    })
  );
}

// ── Manifest V1 functions ──

export function emptyManifestV1(space: string, spaceId: string): SpaceManifestV1 {
  return {
    version: 1,
    space,
    space_id: spaceId,
    manifest_updated_at_utc: new Date().toISOString(),
    entries: {},
    last_auto_export: null,
  };
}

export function readManifestV1(spaceDir: string, space: string, spaceId: string): SpaceManifestV1 {
  const manifestPath_ = manifestPath(spaceDir);
  try {
    if (!existsSync(manifestPath_)) return emptyManifestV1(space, spaceId);
    const raw = readFileSync(manifestPath_, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.version !== 1) {
      // Fall back to empty manifest for non-V1 manifests
      return emptyManifestV1(space, spaceId);
    }
    return {
      version: 1,
      space: parsed.space ?? space,
      space_id: parsed.space_id ?? spaceId,
      manifest_updated_at_utc: parsed.manifest_updated_at_utc ?? utcNow(),
      entries: parsed.entries ?? {},
      last_auto_export: parsed.last_auto_export ?? null,
    } as SpaceManifestV1;
  } catch {
    return emptyManifestV1(space, spaceId);
  }
}

export function writeManifestV1(spaceDir: string, manifest: SpaceManifestV1): void {
  manifest.manifest_updated_at_utc = new Date().toISOString();
  const ordered = {
    version: manifest.version,
    space: manifest.space,
    space_id: manifest.space_id,
    manifest_updated_at_utc: manifest.manifest_updated_at_utc,
    entries: manifest.entries,
    last_auto_export: manifest.last_auto_export,
  };
  writeFileSync(manifestPath(spaceDir), JSON.stringify(ordered, null, 2), 'utf-8');
}

export function buildEntryV1(args: {
  memoryId: string;
  memoryName: string;
  relativePath: string;
  contentHash: string;
  metadataHash: string;
  dbChangedAt: string | null;
  fileChangedAt: string | null;
  filePath: string;
}): SpaceManifestV1Entry {
  const now = utcNow();
  return {
    memory_id: args.memoryId,
    memory_name: args.memoryName,
    path: basename(args.relativePath),
    baseline_content_hash: args.contentHash,
    baseline_metadata_hash: args.metadataHash,
    baseline_combined_hash: combinedHash(args.contentHash, args.metadataHash),
    db_changed_at_utc: args.dbChangedAt ?? now,
    frontmatter_changed_at_utc: args.fileChangedAt ?? now,
    last_seen_file_mtime_utc: fileMtimeUtc(args.filePath) ?? now,
    last_synced_at_utc: now,
  };
}
