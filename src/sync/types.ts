// ── Sync module types ──

export type ConflictResolution = 'db-wins' | 'file-wins' | 'latest-wins';

// ── File-based config types ──

export interface SpaceSyncConfig {
  enabled: boolean;
  conflictResolution: ConflictResolution;
}

export interface MindSyncConfig {
  version: number;
  spaces: Record<string, SpaceSyncConfig>; // key = space name like "projects/mind"
}

// ── Manifest V1 types ──

export interface SpaceManifestV1Entry {
  memory_id: string; // UUID of the memory
  memory_name: string; // human-readable name
  path: string; // managed file path
  baseline_content_hash: string | null;
  baseline_metadata_hash: string | null;
  baseline_combined_hash: string | null;
  db_changed_at_utc: string;
  frontmatter_changed_at_utc: string;
  last_seen_file_mtime_utc: string;
  last_synced_at_utc: string;
  deleted?: boolean;
  tombstone_at_utc?: string;
  last_export_warning?: string | null;
  last_export_error?: string | null;
  conflict_hint?: string | null;
}

export interface SpaceManifestV1 {
  version: 1;
  space: string; // space name
  space_id: string; // space UUID
  manifest_updated_at_utc: string;
  entries: Record<string, SpaceManifestV1Entry>; // key = memory_id (UUID)
  last_auto_export?: {
    started_at_utc: string;
    total: number;
    exported: number;
    stale_pruned: number;
    errors: number;
    warnings: string[];
  } | null;
}

// ── Sync state types ──

export interface SyncState {
  isExporting: boolean;
  isImporting: boolean;
  lastError: string | null;
}

export interface ExportMemoryInput {
  id: string;
  space: string;
  name: string;
  tier: number;
  pinned: boolean;
  tags: string[];
  links_to: string[];
  created_at: string;
  changed_at: string;
  content: string;
}

export interface ExportResult {
  exported: number;
  failed: number;
  errors: string[];
  warnings?: string[];
}

export interface ImportResult {
  imported: number;
  updated: number;
  linksCreated: number;
  linksFailed: number;
  failed: number;
  errors: string[];
}

export interface SyncStatusDiagnostics {
  space: string;
  counts: {
    dbMemories: number;
    files: number;
    manifestEntries: number;
    missingManagedFiles: number;
    dirtyDb: number;
    dirtyFiles: number;
    conflicts: number;
    tombstones: number;
  };
  warnings: string[];
  conflicts: string[];
  lastAutoExport: SpaceManifestV1['last_auto_export'] | null;
}

// ── File event types ──

export type FileEventType = 'add' | 'change' | 'unlink';

export interface FileEvent {
  type: FileEventType;
  path: string;
  timestamp: number;
}

export interface SyncLock {
  origin: 'db' | 'sync';
  timestamp: number;
  filePath?: string;
}

// ── Frontmatter ──

export interface Frontmatter {
  id: string; // UUID in frontmatter
  space: string;
  name: string;
  tier: number;
  pinned: boolean;
  tags: string[];
  links_to: string[];
  created_at: string;
  changed_at: string;
}
