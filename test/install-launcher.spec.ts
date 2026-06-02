import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

let tempDir = '';

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('installer launcher', () => {
  test('generates launcher against the current src/mind.ts entrypoint', () => {
    const installer = readFileSync(join(import.meta.dir, '..', 'scripts', 'install.sh'), 'utf-8');

    expect(installer).toContain('exec bun run "$INSTALL_DIR/src/mind.ts" "\\$@"');
    expect(installer).not.toContain('$INSTALL_DIR/cli/src/mind.ts');
  });

  test('launcher executes the installed src/mind.ts path', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'mind-launcher-smoke-'));
    const installDir = join(tempDir, 'install');
    const binDir = join(tempDir, 'bin');
    const fakeBun = join(binDir, 'bun');
    const launcher = join(binDir, 'mind');
    const invokedPath = join(tempDir, 'invoked-path.txt');

    mkdirSync(join(installDir, 'src'), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(installDir, 'src', 'mind.ts'), '// smoke target\n');
    writeFileSync(
      fakeBun,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'shift',
        `printf '%s' "$1" > "${invokedPath}"`,
      ].join('\n')
    );
    chmodSync(fakeBun, 0o755);
    writeFileSync(
      launcher,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'if ! command -v bun >/dev/null 2>&1; then exit 1; fi',
        `exec bun run "${installDir}/src/mind.ts" "$@"`,
      ].join('\n')
    );
    chmodSync(launcher, 0o755);

    const proc = Bun.spawn([launcher, 'help'], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(await proc.exited).toBe(0);
    expect(readFileSync(invokedPath, 'utf-8')).toBe(join(installDir, 'src', 'mind.ts'));
  });
});
