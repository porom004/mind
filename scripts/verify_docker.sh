#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ARTIFACT_DIR="${1:-${VERIFY_DOCKER_ARTIFACT_DIR:-}}"
if [ -z "$ARTIFACT_DIR" ]; then
  ARTIFACT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mind-docker-check.XXXXXX")"
fi

mkdir -p "$ARTIFACT_DIR"

BUN_BIN="${VERIFY_BUN_BIN:-bun}"
DOCKER_BIN="${VERIFY_DOCKER_BIN:-docker}"
DOCKER_SCRIPT="${VERIFY_DOCKER_SCRIPT:-$SCRIPT_DIR/test-docker-curl-installer.sh}"
STDOUT_PATH="$ARTIFACT_DIR/docker-output.txt"
STDERR_PATH="$ARTIFACT_DIR/docker-error.txt"

status="warn"
classification="docker-unavailable"
message="Docker was not available; advisory stage skipped."

if [ "${VERIFY_DOCKER_ENABLED:-1}" = "0" ]; then
  status="skip"
  classification="docker-disabled"
  message="Docker advisory stage disabled by VERIFY_DOCKER_ENABLED=0."
elif ! command -v "$DOCKER_BIN" >/dev/null 2>&1; then
  status="warn"
  classification="docker-unavailable"
  message="Docker CLI was not found; advisory stage skipped."
elif [ ! -f "$DOCKER_SCRIPT" ]; then
  status="warn"
  classification="docker-script-missing"
  message="Docker advisory script was missing."
elif "$DOCKER_SCRIPT" >"$STDOUT_PATH" 2>"$STDERR_PATH"; then
  status="pass"
  classification="installer-smoke-passed"
  message="Docker installer smoke passed."
else
  status="warn"
  classification="installer-smoke-failed"
  message="Docker installer smoke failed, but Docker remains advisory in v1."
fi

"$BUN_BIN" -e '
  const fs = require("node:fs");

  const [resultPath, stdoutPath, stderrPath, status, classification, message] = process.argv.slice(1);
  const result = {
    stage: "docker",
    status,
    classification,
    message,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
  };

  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
' "$ARTIFACT_DIR/result.json" "$STDOUT_PATH" "$STDERR_PATH" "$status" "$classification" "$message"

printf 'docker advisory: %s (%s)\n' "$status" "$ARTIFACT_DIR/result.json"
exit 0
