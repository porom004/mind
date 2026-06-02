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

export interface SpaceManifest {
  space: string;
}

export interface SpaceManifestV2Entry {
  memory_name: string;
  path: string;
  memory_id?: number;
  baseline_content_hash: string;
  baseline_metadata_hash: string;
  baseline_combined_hash: string;
  db_changed_at_utc: string | null;
  frontmatter_changed_at_utc: string | null;
  last_seen_file_mtime_utc: string | null;
  last_synced_at_utc: string;
  deleted?: boolean;
  tombstone_at_utc?: string;
}

export interface SpaceManifestV2 {
  version: 2;
  space: string;
  manifest_updated_at_utc: string;
  entries: Record<string, SpaceManifestV2Entry>;
  last_auto_export?: {
    status: 'ok' | 'warning' | 'error';
    at_utc: string;
    message?: string;
  };
}

// ── Sync state types ──

export interface SyncState {
  isExporting: boolean;
  isImporting: boolean;
  lastError: string | null;
}

export interface ExportMemoryInput {
  id: number;
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
  lastAutoExport: SpaceManifestV2['last_auto_export'] | null;
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
  id: number;
  space: string;
  name: string;
  tier: number;
  pinned: boolean;
  tags: string[];
  links_to: string[];
  created_at: string;
  changed_at: string;
}
