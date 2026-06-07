import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, test } from 'bun:test';

import {
  getCurrentVersion,
  getInstallerPath,
  getRootPath,
  parseUpdateArgs,
  runUpdateCommandWithDependencies,
} from '../src/cli/self-update';

describe('self-update path resolution', () => {
  test('resolves repo-local paths under the current src layout', () => {
    const expectedRepoRoot = path.resolve(import.meta.dir, '..');
    const oneLevelAboveRepo = path.resolve(expectedRepoRoot, '..');

    expect(getRootPath()).toBe(expectedRepoRoot);
    expect(getRootPath()).not.toBe(oneLevelAboveRepo);
    expect(fs.existsSync(path.join(getRootPath(), 'package.json'))).toBe(true);
    expect(fs.existsSync(getInstallerPath())).toBe(true);
  });

  test('reads the current version from the repo-local package.json', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(path.resolve(import.meta.dir, '..'), 'package.json'), 'utf-8')
    ) as { version: string };

    expect(getCurrentVersion()).toBe(packageJson.version);
  });

  test('refreshes integrations by default after update with explicit opt-out', () => {
    expect(parseUpdateArgs([]).refreshIntegrations).toBe(true);
    expect(parseUpdateArgs(['--no-refresh-integrations']).refreshIntegrations).toBe(false);
  });

  test('runs post-update status with the new runtime when the DB existed before install', async () => {
    const events: string[] = [];

    await runUpdateCommandWithDependencies(['--version', 'v9.9.9'], {
      getCurrentVersion: () => '1.0.0',
      getLatestTag: async () => 'v9.9.9',
      getInstallerPath: () => '/tmp/install.sh',
      getDbPath: () => '/tmp/mind.db',
      getLauncherPath: () => '/tmp/mind',
      existsSync: target => target === '/tmp/install.sh' || target === '/tmp/mind.db',
      spawn: command => {
        events.push(`spawn:${command.join(' ')}`);
        return { exited: Promise.resolve(0) };
      },
      runSetupRefresh: async () => {
        events.push('refresh');
      },
      log: message => events.push(message),
      env: {},
    });

    expect(events).toContain('spawn:/tmp/mind status');
    expect(events.indexOf('spawn:/tmp/mind status')).toBeLessThan(events.indexOf('refresh'));
    expect(events.join('\n')).not.toContain('db');
  });

  test('skips post-update status when no DB existed before install', async () => {
    const events: string[] = [];

    await runUpdateCommandWithDependencies(['--version', 'v9.9.9'], {
      getCurrentVersion: () => '1.0.0',
      getLatestTag: async () => 'v9.9.9',
      getInstallerPath: () => '/tmp/install.sh',
      getDbPath: () => '/tmp/mind.db',
      getLauncherPath: () => '/tmp/mind',
      existsSync: target => target === '/tmp/install.sh',
      spawn: command => {
        events.push(`spawn:${command.join(' ')}`);
        return { exited: Promise.resolve(0) };
      },
      runSetupRefresh: async () => {
        events.push('refresh');
      },
      log: message => events.push(message),
      env: {},
    });

    expect(events).not.toContain('spawn:/tmp/mind status');
    expect(events).toContain('Skipped post-update database migration check (no existing DB).');
  });

  test('fails update when post-update status migration check fails', async () => {
    const events: string[] = [];

    await expect(
      runUpdateCommandWithDependencies(['--version', 'v9.9.9'], {
        getCurrentVersion: () => '1.0.0',
        getLatestTag: async () => 'v9.9.9',
        getInstallerPath: () => '/tmp/install.sh',
        getDbPath: () => '/tmp/mind.db',
        getLauncherPath: () => '/tmp/mind',
        existsSync: target => target === '/tmp/install.sh' || target === '/tmp/mind.db',
        spawn: command => {
          events.push(`spawn:${command.join(' ')}`);
          return { exited: Promise.resolve(command[0] === '/tmp/mind' ? 42 : 0) };
        },
        runSetupRefresh: async () => {
          events.push('refresh');
        },
        log: message => events.push(message),
        env: {},
      })
    ).rejects.toThrow('Post-update database migration check failed (status exit code: 42)');

    expect(events).toContain('spawn:/tmp/mind status');
    expect(events).not.toContain('refresh');
  });
});
