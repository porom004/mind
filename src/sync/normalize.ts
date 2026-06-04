// ── Space name normalization and path helpers ──

import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Get the directory path for a space's sync files using its UUID.
 * Format: .mind/spaces/<spaceId>/
 */
export function getSpaceDirById(basePath: string, spaceId: string): string {
  return join(basePath, 'spaces', spaceId);
}

/**
 * Get the directory path for a space's sync files using the store to resolve
 * the space UUID. Format: .mind/spaces/<uuid>/
 */
export function getSpaceDir(
  basePath: string,
  spaceName: string,
  store: { getSpace: (name: string) => { id?: string } | null }
): string {
  const space = store.getSpace(spaceName);
  if (space?.id) {
    return join(basePath, 'spaces', space.id);
  }
  throw new Error(`Space "${spaceName}" has no UUID — cannot determine sync directory`);
}

/**
 * Get the manifest.json path for a space.
 */
export function getManifestPath(spaceDir: string): string {
  return join(spaceDir, 'manifest.json');
}

/**
 * Ensure the space directory exists.
 * Creates the directory if it doesn't exist.
 * Returns the space directory path.
 */
export function ensureSpaceDir(spaceDir: string): string {
  // Ensure directory exists
  if (!existsSync(spaceDir)) {
    mkdirSync(spaceDir, { recursive: true });
  }

  return spaceDir;
}

/**
 * Read and parse a manifest.json file.
 * Returns null if manifest doesn't exist.
 */
export function readManifest(spaceDir: string): Record<string, unknown> | null {
  const manifestPath = getManifestPath(spaceDir);
  if (!existsSync(manifestPath)) {
    return null;
  }
  try {
    const content = readFileSync(manifestPath, 'utf8');
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Get the sync base path for a project (projectRoot/.mind).
 */
export function getSyncBasePath(projectRoot: string): string {
  return join(projectRoot, '.mind');
}

/**
 * Find the project root by looking for .mind/config.yml in the given path
 * or any parent directory.
 * Returns null if not found.
 */
export function findProjectRoot(startPath: string): string | null {
  let current = startPath;

  // Limit search to reasonable depth
  for (let i = 0; i < 20; i++) {
    const configPath = join(current, '.mind', 'config.yml');
    if (existsSync(configPath)) {
      return current;
    }

    const parent = join(current, '..');
    if (parent === current) {
      break; // Reached filesystem root
    }
    current = parent;
  }

  return null;
}

/**
 * Get the sync directory for a specific space.
 * Requires projectRoot and a store (to resolve the space UUID).
 */
export function getSpaceSyncDir(
  projectRoot: string,
  spaceName: string,
  store: { getSpace: (name: string) => { id?: string } | null }
): string {
  const basePath = getSyncBasePath(projectRoot);
  return getSpaceDir(basePath, spaceName, store);
}
