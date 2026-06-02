// ── Sync module barrel export ──

export * from './types';
export * from './frontmatter';
export * from './config-file';
export * from './normalize';
export { FileSyncService, type SyncStore } from './file-sync-service';
export { FileWatcher } from './file-watcher';
export { AutoSyncService } from './auto-sync-service';
export { SyncCoordinator } from './sync-coordinator';
export { withAutoExport, runWithAutoExportSuppressed } from './auto-export-store';
export * from './manifest';
export { importFromDirectory, importMarkdownFile } from './importer';
export { evaluateSyncStatus } from './status-diagnostics';
export {
  classifyUtcTimestamp,
  resolveConflict,
  shouldUpdateMemory,
  type Conflict,
  type ConflictResult,
  type DBMemory,
  type FileFrontmatter,
} from './conflict-resolver';
export {
  startSyncWatcherDetached,
  stopSyncWatcher,
  getSyncWatcherStatus,
} from './detached-watcher';
