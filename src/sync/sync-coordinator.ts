import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import type { MindStore } from '../store/mind-store';

import { loadConfig } from './config-file';
import { FileSyncService } from './file-sync-service';
import { getSpaceDir, getSyncBasePath } from './normalize';
import type { ExportResult } from './types';

const LOCK_DIR = '.mind-sync';
const LOCK_FILE = '.syncing';
const LOCK_TTL_MS = 5000;

export interface SyncCoordinatorOptions {
  projectRoot?: string;
  source?: 'cli' | 'mcp' | 'api';
}

export class SyncCoordinator {
  private readonly projectRoot: string;
  private readonly source: 'cli' | 'mcp' | 'api';

  constructor(
    private readonly store: MindStore,
    options: SyncCoordinatorOptions = {}
  ) {
    this.projectRoot = options.projectRoot ?? process.env.MIND_SYNC_ROOT ?? process.cwd();
    this.source = options.source ?? 'cli';
  }

  async autoExportSpace(space: string): Promise<ExportResult | null> {
    const basePath = getSyncBasePath(this.projectRoot);
    const config = loadConfig(basePath);
    const spaceConfig = config?.spaces?.[space];
    if (!spaceConfig?.enabled) return null;

    const spaceDir = getSpaceDir(basePath, space);
    this.writeDbOriginLock(space);
    const result = await new FileSyncService(this.store, {
      conflictResolution: spaceConfig.conflictResolution,
    }).exportSpaceToFiles(space, basePath);

    const hasWarnings = (result.warnings?.length ?? 0) > 0 || result.failed > 0;
    this.store.addLog({
      source: this.source,
      operation: 'sync.auto_export',
      level: hasWarnings ? 'warn' : 'info',
      inputData: { space, path: spaceDir },
      outputData: {
        exported: result.exported,
        failed: result.failed,
        warnings: result.warnings ?? [],
      },
      errorMessage: result.errors.join('; ') || undefined,
    });
    return result;
  }

  async autoExportSpaces(spaces: Iterable<string | null | undefined>): Promise<void> {
    const uniqueSpaces = [...new Set([...spaces].filter(Boolean) as string[])];
    for (const space of uniqueSpaces) {
      try {
        await this.autoExportSpace(space);
      } catch (err) {
        this.store.addLog({
          source: this.source,
          operation: 'sync.auto_export',
          level: 'error',
          inputData: { space },
          errorMessage: String(err),
        });
      }
    }
  }

  writeDbOriginLock(space: string): void {
    const spaceDir = getSpaceDir(getSyncBasePath(this.projectRoot), space);
    const metadataDir = join(spaceDir, LOCK_DIR);
    mkdirSync(metadataDir, { recursive: true });
    writeFileSync(
      join(metadataDir, LOCK_FILE),
      JSON.stringify({ origin: 'db', timestamp: Date.now(), ttl_ms: LOCK_TTL_MS }),
      'utf-8'
    );
  }

  isDbOriginLocked(space: string): boolean {
    const lockPath = join(
      getSpaceDir(getSyncBasePath(this.projectRoot), space),
      LOCK_DIR,
      LOCK_FILE
    );
    if (!existsSync(lockPath)) return false;
    try {
      const lock = JSON.parse(readFileSync(lockPath, 'utf-8')) as {
        origin: string;
        timestamp: number;
      };
      return lock.origin === 'db' && Date.now() - lock.timestamp < LOCK_TTL_MS;
    } catch {
      return false;
    }
  }
}
