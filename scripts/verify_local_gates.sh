#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ARTIFACT_DIR="${1:-${VERIFY_LOCAL_ARTIFACT_DIR:-}}"
if [ -z "$ARTIFACT_DIR" ]; then
  ARTIFACT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mind-local-gates.XXXXXX")"
fi

mkdir -p "$ARTIFACT_DIR/commands" "$ARTIFACT_DIR/untracked"

BUN_BIN="${VERIFY_BUN_BIN:-bun}"
GATE_BUN_BIN="${VERIFY_GATE_BUN_BIN:-bun}"
GIT_BIN="${VERIFY_GIT_BIN:-git}"
COMMAND_RECORDS="$ARTIFACT_DIR/commands.tsv"
ARTIFACT_ERRORS="$ARTIFACT_DIR/artifact-errors.txt"

: > "$COMMAND_RECORDS"
: > "$ARTIFACT_ERRORS"

BASELINE_REF="HEAD"
if ! "$GIT_BIN" -C "$REPO_ROOT" rev-parse --verify HEAD >/dev/null 2>&1; then
  BASELINE_REF="4b825dc642cb6eb9a060e54bf8d69288fbee4904"
fi

run_gate() {
  local name="$1"
  shift

  local stdout_path="$ARTIFACT_DIR/commands/${name}.stdout.txt"
  local stderr_path="$ARTIFACT_DIR/commands/${name}.stderr.txt"
  local exit_code=0
  local status="pass"

  "$@" >"$stdout_path" 2>"$stderr_path"
  exit_code=$?
  if [ "$exit_code" -ne 0 ]; then
    status="fail"
  fi

  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$name" \
    "$status" \
    "$exit_code" \
    "$stdout_path" \
    "$stderr_path" >> "$COMMAND_RECORDS"
}

capture_artifact() {
  local name="$1"
  local expected_diff_exit="$2"
  shift 2

  local output_path="$ARTIFACT_DIR/$name"
  local error_path="$ARTIFACT_DIR/${name}.stderr.txt"
  local exit_code=0

  "$@" >"$output_path" 2>"$error_path"
  exit_code=$?

  if [ "$exit_code" -ne 0 ] && [ "$exit_code" -ne "$expected_diff_exit" ]; then
    printf '%s\t%s\n' "$name" "$exit_code" >> "$ARTIFACT_ERRORS"
  fi
}

capture_artifact "worktree_status.txt" 0 \
  "$GIT_BIN" -C "$REPO_ROOT" status --short --branch --untracked-files=all
capture_artifact "worktree_diff_stat.txt" 0 \
  "$GIT_BIN" -C "$REPO_ROOT" diff --stat "$BASELINE_REF" --
capture_artifact "worktree_diff_numstat.txt" 0 \
  "$GIT_BIN" -C "$REPO_ROOT" diff --numstat "$BASELINE_REF" --
capture_artifact "worktree.patch" 0 \
  "$GIT_BIN" -C "$REPO_ROOT" diff --binary --no-ext-diff "$BASELINE_REF" --
capture_artifact "untracked_files.txt" 0 \
  "$GIT_BIN" -C "$REPO_ROOT" ls-files --others --exclude-standard

if [ -s "$ARTIFACT_DIR/untracked_files.txt" ]; then
  while IFS= read -r relative_path; do
    [ -z "$relative_path" ] && continue
    safe_name="${relative_path//\//__}"
    safe_name="${safe_name// /_}"
    capture_artifact "untracked/${safe_name}.patch" 1 \
      "$GIT_BIN" -C "$REPO_ROOT" diff --no-index --binary /dev/null "$relative_path"
  done < "$ARTIFACT_DIR/untracked_files.txt"
fi

run_gate "git-diff-check" "$GIT_BIN" -C "$REPO_ROOT" diff --check
run_gate "format-check" "$GATE_BUN_BIN" run format:check
run_gate "lint" "$GATE_BUN_BIN" run lint
run_gate "typecheck" "$GATE_BUN_BIN" run typecheck
run_gate "tests" "$GATE_BUN_BIN" test test/ web/test

"$BUN_BIN" -e '
  const fs = require("node:fs");

  const [recordsPath, resultPath, artifactErrorsPath, artifactDir] = process.argv.slice(1);
  const rows = fs
    .readFileSync(recordsPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(line => {
      const [name, status, exitCode, stdoutPath, stderrPath] = line.split("\t");
      return {
        name,
        status,
        exit_code: Number(exitCode),
        stdout_path: stdoutPath,
        stderr_path: stderrPath,
      };
    });

  const failedGates = rows.filter(row => row.status === "fail").map(row => row.name);
  const artifactErrors = fs.existsSync(artifactErrorsPath)
    ? fs
        .readFileSync(artifactErrorsPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(line => {
          const [name, exitCode] = line.split("\t");
          return { name, exit_code: Number(exitCode) };
        })
    : [];

  const result = {
    stage: "local-gates",
    status: failedGates.length === 0 ? "pass" : "fail",
    classification: failedGates.length === 0 ? "all-hard-gates-passed" : "hard-gate-failure",
    failed_gates: failedGates,
    commands: rows,
    artifact_errors: artifactErrors,
    artifacts: {
      worktree_status: `${artifactDir}/worktree_status.txt`,
      worktree_diff_stat: `${artifactDir}/worktree_diff_stat.txt`,
      worktree_diff_numstat: `${artifactDir}/worktree_diff_numstat.txt`,
      worktree_patch: `${artifactDir}/worktree.patch`,
      untracked_files: `${artifactDir}/untracked_files.txt`,
      untracked_dir: `${artifactDir}/untracked`,
    },
  };

  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
' "$COMMAND_RECORDS" "$ARTIFACT_DIR/result.json" "$ARTIFACT_ERRORS" "$ARTIFACT_DIR"

if "$BUN_BIN" -e '
  const fs = require("node:fs");
  const [resultPath] = process.argv.slice(1);
  const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  process.exit(result.status === "pass" ? 0 : 1);
' "$ARTIFACT_DIR/result.json"; then
  printf 'local gates: PASS (%s)\n' "$ARTIFACT_DIR/result.json"
  exit 0
fi

printf 'local gates: FAIL (%s)\n' "$ARTIFACT_DIR/result.json" >&2
exit 1
