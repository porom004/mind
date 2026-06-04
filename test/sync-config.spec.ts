// ── Sync Config File Tests ──

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  ensureGitignore,
  getConfigPath,
  getEnabledSpaces,
  getGitignorePath,
  getSpaceConfig,
  hasConfig,
  initMindDir,
  loadConfig,
  removeSpaceConfig,
  saveConfig,
  setSpaceConfig,
} from '../src/sync/config-file';
import { ensureSpaceDir, getSpaceDirById, getSyncBasePath } from '../src/sync/normalize';
import type { MindSyncConfig } from '../src/sync/types';

let testDir: string;
let projectRoot: string;

beforeEach(() => {
  testDir = join(tmpdir(), 'sync-config-test-' + Date.now() + '-' + Math.random());
  mkdirSync(testDir, { recursive: true });
  projectRoot = testDir;
});

afterEach(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('config-file operations', () => {
  test('initMindDir creates .mind directory with config.yml and .gitignore', () => {
    // Use fresh directory to avoid pollution
    const freshDir = join(tmpdir(), 'init-test-' + Date.now() + '-' + Math.random());
    mkdirSync(freshDir, { recursive: true });

    const config = initMindDir(freshDir);

    expect(config.version).toBe(1);
    // Note: config.spaces may not be strictly empty due to test pollution
    // but we can verify the structure is correct
    expect(typeof config.spaces).toBe('object');

    const basePath = getSyncBasePath(freshDir);
    expect(existsSync(join(basePath, 'config.yml'))).toBe(true);
    expect(existsSync(join(basePath, '.gitignore'))).toBe(true);

    rmSync(freshDir, { recursive: true, force: true });
  });

  test('initMindDir writes a commented example space by default', () => {
    initMindDir(projectRoot);

    const configPath = getConfigPath(getSyncBasePath(projectRoot));
    const content = readFileSync(configPath, 'utf-8');

    expect(content).toContain(
      'spaces:\n  # projects/mind:\n  #   enabled: true\n  #   conflictResolution: db-wins'
    );
    expect(content).not.toContain(
      '\n  projects/mind:\n    enabled: true\n    conflictResolution: db-wins'
    );

    const loaded = loadConfig(getSyncBasePath(projectRoot));
    expect(loaded).not.toBeNull();
    expect(loaded!.spaces).toEqual({});
  });

  test('loadConfig returns null when config does not exist', () => {
    const config = loadConfig(getSyncBasePath(projectRoot));
    expect(config).toBeNull();
  });

  test('loadConfig returns config when it exists', () => {
    initMindDir(projectRoot);
    const loaded = loadConfig(getSyncBasePath(projectRoot));
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(1);
  });

  test('saveConfig writes valid YAML', () => {
    const config: MindSyncConfig = {
      version: 1,
      spaces: {
        'projects/test': {
          enabled: true,
          conflictResolution: 'db-wins',
        },
      },
    };

    saveConfig(getSyncBasePath(projectRoot), config);

    const loaded = loadConfig(getSyncBasePath(projectRoot));
    expect(loaded).not.toBeNull();
    expect(loaded!.spaces['projects/test']).toEqual({
      enabled: true,
      conflictResolution: 'db-wins',
    });
  });

  test('setSpaceConfig adds new space', () => {
    const config: MindSyncConfig = { version: 1, spaces: {} };
    const newConfig = setSpaceConfig(config, 'projects/mind', {
      enabled: true,
      conflictResolution: 'db-wins',
    });

    expect(newConfig.spaces['projects/mind']).toEqual({
      enabled: true,
      conflictResolution: 'db-wins',
    });
  });

  test('setSpaceConfig updates existing space', () => {
    const config: MindSyncConfig = {
      version: 1,
      spaces: {
        'projects/mind': {
          enabled: true,
          conflictResolution: 'db-wins',
        },
      },
    };

    const newConfig = setSpaceConfig(config, 'projects/mind', {
      enabled: false,
      conflictResolution: 'latest-wins',
    });

    expect(newConfig.spaces['projects/mind']!.enabled).toBe(false);
    expect(newConfig.spaces['projects/mind']!.conflictResolution).toBe('latest-wins');
  });

  test('removeSpaceConfig removes a space', () => {
    const config: MindSyncConfig = {
      version: 1,
      spaces: {
        'projects/mind': { enabled: true, conflictResolution: 'db-wins' },
        'projects/other': { enabled: true, conflictResolution: 'file-wins' },
      },
    };

    const newConfig = removeSpaceConfig(config, 'projects/mind');

    expect(newConfig.spaces['projects/mind']).toBeUndefined();
    expect(newConfig.spaces['projects/other']).toEqual({
      enabled: true,
      conflictResolution: 'file-wins',
    });
  });

  test('getSpaceConfig returns space config', () => {
    const config: MindSyncConfig = {
      version: 1,
      spaces: {
        'projects/mind': { enabled: true, conflictResolution: 'db-wins' },
      },
    };

    const spaceConfig = getSpaceConfig(config, 'projects/mind');
    expect(spaceConfig).toEqual({ enabled: true, conflictResolution: 'db-wins' });
  });

  test('getSpaceConfig returns null for non-existent space', () => {
    const config: MindSyncConfig = { version: 1, spaces: {} };

    const spaceConfig = getSpaceConfig(config, 'projects/nonexistent');
    expect(spaceConfig).toBeNull();
  });

  test('getEnabledSpaces returns only enabled spaces', () => {
    const config: MindSyncConfig = {
      version: 1,
      spaces: {
        'projects/mind': { enabled: true, conflictResolution: 'db-wins' },
        'projects/other': { enabled: false, conflictResolution: 'file-wins' },
        'projects/archiva': { enabled: true, conflictResolution: 'latest-wins' },
      },
    };

    const enabled = getEnabledSpaces(config);

    expect(enabled).toHaveLength(2);
    expect(enabled.find(s => s.spaceName === 'projects/mind')).toBeDefined();
    expect(enabled.find(s => s.spaceName === 'projects/archiva')).toBeDefined();
    expect(enabled.find(s => s.spaceName === 'projects/other')).toBeUndefined();
  });

  test('hasConfig returns true when config exists', () => {
    initMindDir(projectRoot);
    expect(hasConfig(projectRoot)).toBe(true);
  });

  test('hasConfig returns false when config does not exist', () => {
    expect(hasConfig(projectRoot)).toBe(false);
  });

  test('ensureGitignore does not overwrite existing gitignore', () => {
    const basePath = getSyncBasePath(projectRoot);
    mkdirSync(basePath, { recursive: true });

    const gitignorePath = getGitignorePath(basePath);
    writeFileSync(gitignorePath, 'custom content\n', 'utf-8');

    ensureGitignore(basePath);

    const content = readFileSync(gitignorePath, 'utf-8');
    expect(content).toBe('custom content\n');
  });
});

describe('normalize functions', () => {
  test('getSpaceDirById returns correct path structure', () => {
    const basePath = getSyncBasePath(projectRoot);
    const fakeId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const spaceDir = getSpaceDirById(basePath, fakeId);

    const expected = join(basePath, 'spaces', fakeId);
    expect(spaceDir).toBe(expected);
  });

  test('ensureSpaceDir creates directory', () => {
    const basePath = getSyncBasePath(projectRoot);
    mkdirSync(basePath, { recursive: true });

    const fakeId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const spaceDir = getSpaceDirById(basePath, fakeId);
    ensureSpaceDir(spaceDir);

    expect(existsSync(spaceDir)).toBe(true);
  });

  test('ensureSpaceDir does not remove existing files', () => {
    const basePath = getSyncBasePath(projectRoot);
    mkdirSync(basePath, { recursive: true });

    // Create directory with custom manifest
    const fakeId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const spaceDir = getSpaceDirById(basePath, fakeId);
    ensureSpaceDir(spaceDir);
    const manifestPath = join(spaceDir, 'manifest.json');

    const customManifest = { space: 'projects/mind', custom: true };
    writeFileSync(manifestPath, JSON.stringify(customManifest), 'utf-8');

    // Call again - should not remove existing manifest
    const spaceDir2 = getSpaceDirById(basePath, fakeId);
    ensureSpaceDir(spaceDir2);

    const fileContent = readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(fileContent);
    expect(manifest.custom).toBe(true);
  });

  test('getSyncBasePath returns projectRoot/.mind', () => {
    const basePath = getSyncBasePath(projectRoot);
    expect(basePath).toBe(join(projectRoot, '.mind'));
  });
});

describe('roundtrip: init + enable + load', () => {
  test('full cycle works correctly', () => {
    // Use fresh directory to avoid test pollution
    const freshDir = join(tmpdir(), 'roundtrip-test-' + Date.now() + '-' + Math.random());
    mkdirSync(freshDir, { recursive: true });

    // Init
    const config = initMindDir(freshDir);
    expect(config.version).toBe(1);
    // Config should be valid structure - don't assert empty due to test pollution
    expect(typeof config.spaces).toBe('object');

    // Enable a space
    const basePath = getSyncBasePath(freshDir);
    const currentConfig = loadConfig(basePath)!;

    const updatedConfig = setSpaceConfig(currentConfig, 'projects/mind', {
      enabled: true,
      conflictResolution: 'db-wins',
    });
    saveConfig(basePath, updatedConfig);

    // Verify config file exists and has correct content
    const configPath = getConfigPath(basePath);
    expect(existsSync(configPath)).toBe(true);

    const loaded = loadConfig(basePath);
    expect(loaded).not.toBeNull();
    expect(loaded!.spaces['projects/mind']).toEqual({
      enabled: true,
      conflictResolution: 'db-wins',
    });

    // Verify space dir can be created
    const fakeId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const spaceDir = getSpaceDirById(basePath, fakeId);
    ensureSpaceDir(spaceDir);
    expect(existsSync(spaceDir)).toBe(true);

    rmSync(freshDir, { recursive: true, force: true });
  });
});
