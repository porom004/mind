import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { basename } from 'path';

import type { Frontmatter, SpaceManifest, SpaceManifestV2, SpaceManifestV2Entry } from './types';

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

export function emptyManifest(space: string): SpaceManifestV2 {
  return { version: 2, space, manifest_updated_at_utc: utcNow(), entries: {} };
}

export function readManifestV2(spaceDir: string, space: string): SpaceManifestV2 {
  const path = manifestPath(spaceDir);
  if (!existsSync(path)) return emptyManifest(space);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as SpaceManifest | SpaceManifestV2;
    if ('version' in parsed && parsed.version === 2 && 'entries' in parsed) {
      return { ...parsed, entries: parsed.entries ?? {} } as SpaceManifestV2;
    }
    return emptyManifest((parsed as SpaceManifest).space ?? space);
  } catch {
    return emptyManifest(space);
  }
}

export function writeManifestV2(spaceDir: string, manifest: SpaceManifestV2): void {
  writeFileSync(
    manifestPath(spaceDir),
    JSON.stringify({ ...manifest, manifest_updated_at_utc: utcNow() }, null, 2),
    'utf-8'
  );
}

export function fileMtimeUtc(filePath: string): string | null {
  try {
    return statSync(filePath).mtime.toISOString();
  } catch {
    return null;
  }
}

export function entryKey(memoryId: number | undefined, memoryName: string): string {
  return memoryId ? `id:${memoryId}` : `name:${sha256(memoryName).slice(0, 12)}`;
}

export function buildEntry(args: {
  memoryId: number;
  memoryName: string;
  relativePath: string;
  contentHash: string;
  metadataHash: string;
  dbChangedAt: string | null;
  fileChangedAt: string | null;
  filePath: string;
}): SpaceManifestV2Entry {
  const now = utcNow();
  return {
    memory_name: args.memoryName,
    path: basename(args.relativePath),
    memory_id: args.memoryId,
    baseline_content_hash: args.contentHash,
    baseline_metadata_hash: args.metadataHash,
    baseline_combined_hash: combinedHash(args.contentHash, args.metadataHash),
    db_changed_at_utc: args.dbChangedAt,
    frontmatter_changed_at_utc: args.fileChangedAt,
    last_seen_file_mtime_utc: fileMtimeUtc(args.filePath),
    last_synced_at_utc: now,
  };
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
