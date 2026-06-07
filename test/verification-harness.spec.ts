import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

const repoRoot = join(import.meta.dir, '..');
const realBun = Bun.which('bun') ?? process.execPath;
const placeholderArtifactPaths = [
  join(repoRoot, '${VERIFY_STUB_LOG}'),
  join(repoRoot, '${VERIFY_STUB_OPENCODE_CONFIG_LOG}'),
];

const tempDirs: string[] = [];

function cleanupPlaceholderArtifacts() {
  for (const filePath of placeholderArtifactPaths) {
    rmSync(filePath, { force: true });
  }
}

cleanupPlaceholderArtifacts();

afterEach(() => {
  cleanupPlaceholderArtifacts();
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeExecutable(filePath: string, body: string) {
  writeFileSync(filePath, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  chmodSync(filePath, 0o755);
}

function setupStubCommands(binDir: string) {
  writeExecutable(
    join(binDir, 'git'),
    String.raw`
printf 'git %s\n' "$*" >> "${'${VERIFY_STUB_LOG:-/dev/null}'}"
if [ "${'${1:-}'}" = "-C" ]; then
  shift 2
fi
case "$*" in
  "status --short --branch --untracked-files=all")
    printf '## main\n M src/example.ts\n'
    ;;
  "diff --check")
    exit "${'${VERIFY_STUB_GIT_DIFF_CHECK_EXIT:-0}'}"
    ;;
  "diff --stat HEAD --")
    printf ' src/example.ts | 2 ++\n 1 file changed, 2 insertions(+)\n'
    ;;
  "diff --numstat HEAD --")
    printf '2\t0\tsrc/example.ts\n'
    ;;
  "diff --binary --no-ext-diff HEAD --")
    printf 'diff --git a/src/example.ts b/src/example.ts\n'
    ;;
  "ls-files --others --exclude-standard")
    ;;
  *)
    printf 'unexpected git args: %s\n' "$*" >&2
    exit 99
    ;;
esac`
  );

  writeExecutable(
    join(binDir, 'bun'),
    String.raw`
printf 'bun %s\n' "$*" >> "${'${VERIFY_STUB_LOG:-/dev/null}'}"
case "$*" in
  "run format:check")
    exit "${'${VERIFY_STUB_FORMAT_EXIT:-0}'}"
    ;;
  "run lint")
    exit "${'${VERIFY_STUB_LINT_EXIT:-0}'}"
    ;;
  "run typecheck")
    exit "${'${VERIFY_STUB_TYPECHECK_EXIT:-0}'}"
    ;;
  "test test/ web/test")
    exit "${'${VERIFY_STUB_TEST_EXIT:-0}'}"
    ;;
  *)
    printf 'unexpected bun args: %s\n' "$*" >&2
    exit 99
    ;;
esac`
  );

  writeExecutable(
    join(binDir, 'opencode'),
    String.raw`
printf 'opencode %s\n' "$*" >> "${'${VERIFY_STUB_LOG:-/dev/null}'}"
stdin_payload="$(cat)"
if [ -n "${'${VERIFY_STUB_OPENCODE_STDIN_LOG:-}'}" ]; then
  printf '%s' "$stdin_payload" > "${'${VERIFY_STUB_OPENCODE_STDIN_LOG}'}"
fi
if [ -n "${'${VERIFY_STUB_OPENCODE_CONFIG_LOG:-}'}" ]; then
  printf '%s' "${'${OPENCODE_CONFIG_CONTENT:-}'}" > "${'${VERIFY_STUB_OPENCODE_CONFIG_LOG}'}"
fi
if [ "${'${VERIFY_STUB_OPENCODE_FAIL_ON_STEP_CAP:-0}'}" = "1" ] && printf '%s' "${'${OPENCODE_CONFIG_CONTENT:-}'}" | grep -F '"steps": 1' >/dev/null; then
  printf 'Maximum Steps Reached\nThe agent hit its configured step limit before producing the required JSON verdict.\n'
  exit 0
fi
args=("$@")
idx=1
while [ "$idx" -lt "$#" ]; do
  current="${'${args[$idx]}'}"
  case "$current" in
    --format|--agent|--model|--file|--attach|--title|--session|--port|--hostname|--command)
      idx=$((idx + 2))
      ;;
    --continue|--fork|--share|--dangerously-skip-permissions)
      idx=$((idx + 1))
      ;;
    --*)
      idx=$((idx + 1))
      ;;
    *)
      printf 'File not found: %s\n' "$current" >&2
      exit 4
      ;;
  esac
done
printf '%s\n' "${'${VERIFY_STUB_OPENCODE_OUTPUT:-}'}"
exit "${'${VERIFY_STUB_OPENCODE_EXIT:-0}'}"
`
  );

  writeExecutable(
    join(binDir, 'docker'),
    String.raw`
printf 'docker %s\n' "$*" >> "${'${VERIFY_STUB_LOG:-/dev/null}'}"
exit "${'${VERIFY_STUB_DOCKER_EXIT:-0}'}"
`
  );
}

function runScript(scriptName: string, env: Record<string, string>, args: string[] = []) {
  return Bun.spawnSync(['bash', join(repoRoot, 'scripts', scriptName), ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

function createLocalArtifacts(root: string) {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'result.json'),
    JSON.stringify(
      {
        stage: 'local-gates',
        status: 'pass',
        classification: 'all-hard-gates-passed',
        failed_gates: [],
      },
      null,
      2
    )
  );
  writeFileSync(join(root, 'worktree_status.txt'), '## main\n M src/example.ts\n');
  writeFileSync(join(root, 'worktree_diff_stat.txt'), ' src/example.ts | 2 ++\n');
  writeFileSync(join(root, 'worktree_diff_numstat.txt'), '2\t0\tsrc/example.ts\n');
  writeFileSync(join(root, 'worktree.patch'), 'diff --git a/src/example.ts b/src/example.ts\n');
  writeFileSync(join(root, 'untracked_files.txt'), '');
}

type StageSummary = {
  status: string;
};

type HarnessSummary = {
  status: string;
  stages: {
    local_gates: StageSummary;
    opencode: StageSummary;
    docker: StageSummary;
  };
};

describe('verification harness scripts', () => {
  test('run_full_test orchestrates hard gates, OpenCode review, and advisory docker', () => {
    const tempDir = makeTempDir('mind-verification-harness-');
    const binDir = join(tempDir, 'bin');
    const artifactDir = join(tempDir, 'artifacts');
    const logPath = join(tempDir, 'stub.log');
    const configLogPath = join(tempDir, 'opencode-config.json');
    const stdinLogPath = join(tempDir, 'opencode-stdin.txt');

    mkdirSync(binDir, { recursive: true });
    setupStubCommands(binDir);

    const result = runScript('run_full_test.sh', {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      VERIFY_BUN_BIN: realBun,
      VERIFY_ARTIFACT_DIR: artifactDir,
      VERIFY_STUB_LOG: logPath,
      VERIFY_STUB_DOCKER_EXIT: '1',
      VERIFY_STUB_OPENCODE_CONFIG_LOG: configLogPath,
      VERIFY_STUB_OPENCODE_STDIN_LOG: stdinLogPath,
      VERIFY_STUB_OPENCODE_FAIL_ON_STEP_CAP: '1',
      VERIFY_STUB_OPENCODE_OUTPUT:
        '{"type":"message","message":{"content":[{"type":"text","text":"{\\"verdict\\":\\"pass\\",\\"summary\\":\\"verified\\",\\"failures\\":[],\\"warnings\\":[]}"}]}}',
      VERIFY_OPENCODE_MODEL: 'test/model',
    });

    expect(result.exitCode).toBe(0);

    const summary = JSON.parse(
      readFileSync(join(artifactDir, 'summary.json'), 'utf-8')
    ) as HarnessSummary;

    expect(summary.status).toBe('pass');
    expect(summary.stages.local_gates.status).toBe('pass');
    expect(summary.stages.opencode.status).toBe('pass');
    expect(summary.stages.docker.status).toBe('warn');

    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('diff --check');
    expect(log).toContain('bun run format:check');
    expect(log).toContain('bun run lint');
    expect(log).toContain('bun run typecheck');
    expect(log).toContain('bun test test/ web/test');
    expect(log).toContain('opencode run');
    expect(log).toContain('--format json');
    expect(log).toContain('--agent verification-harness');
    expect(log).not.toContain('Review only the attached machine-generated verification artifacts.');
    expect(log).toContain('docker build');

    const stdinPrompt = readFileSync(stdinLogPath, 'utf-8');
    expect(stdinPrompt).toContain(
      'Review only the attached machine-generated verification artifacts.'
    );
    expect(stdinPrompt).toContain('Return exactly one JSON object and nothing else:');

    const config = readFileSync(configLogPath, 'utf-8');
    expect(config).toContain('verification-harness');
    expect(config).toContain('"*": "deny"');
  });

  test('verify_local_gates fails when a hard gate fails', () => {
    const tempDir = makeTempDir('mind-verification-local-');
    const binDir = join(tempDir, 'bin');
    const artifactDir = join(tempDir, 'artifacts');
    const logPath = join(tempDir, 'stub.log');

    mkdirSync(binDir, { recursive: true });
    setupStubCommands(binDir);

    const result = runScript(
      'verify_local_gates.sh',
      {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        VERIFY_BUN_BIN: realBun,
        VERIFY_STUB_LOG: logPath,
        VERIFY_STUB_LINT_EXIT: '2',
      },
      [artifactDir]
    );

    expect(result.exitCode).toBe(1);

    const summary = JSON.parse(readFileSync(join(artifactDir, 'result.json'), 'utf-8')) as {
      status: string;
      failed_gates: string[];
    };

    expect(summary.status).toBe('fail');
    expect(summary.failed_gates).toContain('lint');
  });

  test('verify_opencode_run returns failure when OpenCode emits a fail verdict', () => {
    const tempDir = makeTempDir('mind-verification-opencode-fail-');
    const binDir = join(tempDir, 'bin');
    const opencodeDir = join(tempDir, 'opencode');
    const localDir = join(tempDir, 'local');
    const logPath = join(tempDir, 'stub.log');

    mkdirSync(binDir, { recursive: true });
    setupStubCommands(binDir);
    createLocalArtifacts(localDir);

    const result = runScript(
      'verify_opencode_run.sh',
      {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        VERIFY_BUN_BIN: realBun,
        VERIFY_STUB_LOG: logPath,
        VERIFY_STUB_OPENCODE_OUTPUT:
          '{"type":"message","message":{"content":[{"type":"text","text":"{\\"verdict\\":\\"fail\\",\\"summary\\":\\"lint failed\\",\\"failures\\":[{\\"id\\":\\"lint\\",\\"severity\\":\\"hard\\",\\"reason\\":\\"lint gate failed\\",\\"artifact\\":\\"result.json\\"}],\\"warnings\\":[]}"}]}}',
      },
      [opencodeDir, localDir]
    );

    expect(result.exitCode).toBe(1);

    const summary = JSON.parse(readFileSync(join(opencodeDir, 'result.json'), 'utf-8')) as {
      status: string;
      classification: string;
      verdict: { verdict: string };
    };

    expect(summary.status).toBe('fail');
    expect(summary.classification).toBe('model-verdict-fail');
    expect(summary.verdict.verdict).toBe('fail');
  });

  test('verify_opencode_run errors when OpenCode output has no parseable verdict', () => {
    const tempDir = makeTempDir('mind-verification-opencode-error-');
    const binDir = join(tempDir, 'bin');
    const opencodeDir = join(tempDir, 'opencode');
    const localDir = join(tempDir, 'local');

    mkdirSync(binDir, { recursive: true });
    setupStubCommands(binDir);
    createLocalArtifacts(localDir);

    const result = runScript(
      'verify_opencode_run.sh',
      {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        VERIFY_BUN_BIN: realBun,
        VERIFY_STUB_OPENCODE_OUTPUT:
          '{"type":"message","message":{"content":[{"type":"text","text":"Maximum Steps Reached\nThe agent hit its configured step limit before producing the required JSON verdict."}]}}',
      },
      [opencodeDir, localDir]
    );

    expect(result.exitCode).toBe(1);

    const summary = JSON.parse(readFileSync(join(opencodeDir, 'result.json'), 'utf-8')) as {
      status: string;
      classification: string;
    };

    expect(summary.status).toBe('error');
    expect(summary.classification).toBe('verdict-missing');
    expect(existsSync(join(opencodeDir, 'opencode-output.jsonl'))).toBe(true);
  });

  test('does not leave placeholder stub artifact files in the repo root', () => {
    for (const filePath of placeholderArtifactPaths) {
      expect(existsSync(filePath)).toBe(false);
    }
  });
});
