import * as fs from 'fs';
import * as path from 'path';

import { CONFIG } from '../config';

import { runSetupRefresh } from './setup';

interface ReleaseInfo {
  tag_name: string;
}

const DEFAULT_REPO = 'GabrielMartinMoran/mind';

export function getRootPath(): string {
  return path.resolve(import.meta.dir, '..', '..');
}

export function getInstallerPath(): string {
  return path.join(getRootPath(), 'scripts', 'install.sh');
}

export function getLauncherPath(): string {
  return path.join(getRootPath(), 'mind');
}

export function getCurrentVersion(): string {
  const packageJsonPath = path.join(getRootPath(), 'package.json');
  const raw = fs.readFileSync(packageJsonPath, 'utf-8');
  const pkg = JSON.parse(raw) as { version?: string };
  return pkg.version ?? '0.0.0';
}

async function getLatestTag(repo: string): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'mind-cli',
    },
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        `No releases found for ${repo}. Publish a release first or pass --version <tag>.`
      );
    }
    throw new Error(`Failed to fetch latest release: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as ReleaseInfo;
  if (!data.tag_name) {
    throw new Error('Latest release has no tag_name');
  }
  return data.tag_name;
}

export function parseUpdateArgs(args: string[]): {
  check: boolean;
  version?: string;
  repo: string;
  refreshIntegrations: boolean;
} {
  let check = false;
  let version: string | undefined;
  let repo = DEFAULT_REPO;
  let refreshIntegrations = true;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--check') {
      check = true;
      continue;
    }
    if (arg === '--version') {
      version = args[i + 1];
      i++;
      continue;
    }
    if (arg === '--repo') {
      repo = args[i + 1] ?? repo;
      i++;
      continue;
    }
    if (arg === '--no-refresh-integrations') {
      refreshIntegrations = false;
      continue;
    }
  }

  return { check, version, repo, refreshIntegrations };
}

export async function runUpdateCommand(args: string[]): Promise<void> {
  await runUpdateCommandWithDependencies(args, {
    getCurrentVersion,
    getLatestTag,
    getInstallerPath,
    getDbPath: () => CONFIG.dbPath,
    getLauncherPath,
    existsSync: fs.existsSync,
    spawn: (command, options) => Bun.spawn(command, options),
    runSetupRefresh,
    log: message => console.log(message),
    env: process.env,
  });
}

interface UpdateCommandDependencies {
  getCurrentVersion: () => string;
  getLatestTag: (repo: string) => Promise<string>;
  getInstallerPath: () => string;
  getDbPath: () => string;
  getLauncherPath: () => string;
  existsSync: (target: string) => boolean;
  spawn: (
    command: string[],
    options: { env?: Record<string, string | undefined>; stdio: ['ignore', 'inherit', 'inherit'] }
  ) => { exited: Promise<number> };
  runSetupRefresh: (options: { mode: 'detected' }) => Promise<unknown>;
  log: (message: string) => void;
  env: Record<string, string | undefined>;
}

export async function runUpdateCommandWithDependencies(
  args: string[],
  deps: UpdateCommandDependencies
): Promise<void> {
  const { check, version, repo, refreshIntegrations } = parseUpdateArgs(args);

  const current = deps.getCurrentVersion();
  const target = version ?? (await deps.getLatestTag(repo));

  deps.log(`Current version: ${current}`);
  deps.log(`Target version:  ${target}`);

  if (check) {
    if (current === target.replace(/^v/, '')) {
      deps.log('mind is up to date.');
    } else {
      deps.log('A newer version is available. Run `mind update` to install it.');
    }
    return;
  }

  const installerPath = deps.getInstallerPath();
  if (!deps.existsSync(installerPath)) {
    throw new Error(`Installer not found at ${installerPath}`);
  }

  const dbExistedBeforeInstall = deps.existsSync(deps.getDbPath());

  deps.log('Running installer...');

  const proc = deps.spawn(['bash', installerPath], {
    env: {
      ...deps.env,
      MIND_INSTALL_REF: target,
      MIND_INSTALL_REPO: repo,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`Update failed (installer exit code: ${code})`);
  }

  deps.log('Update complete.');
  if (dbExistedBeforeInstall) {
    deps.log('Running post-update database migration check (mind status)...');
    const statusProc = deps.spawn([deps.getLauncherPath(), 'status'], {
      env: deps.env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const statusCode = await statusProc.exited;
    if (statusCode !== 0) {
      throw new Error(
        `Post-update database migration check failed (status exit code: ${statusCode})`
      );
    }
    deps.log('Post-update database migration check complete.');
  } else {
    deps.log('Skipped post-update database migration check (no existing DB).');
  }

  if (refreshIntegrations) {
    deps.log('Refreshing detected mind integrations...');
    await deps.runSetupRefresh({ mode: 'detected' });
  } else {
    deps.log('Skipped integration refresh (--no-refresh-integrations).');
  }
}
