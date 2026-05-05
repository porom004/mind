#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUN_BIN="${VERIFY_BUN_BIN:-bun}"

ARTIFACT_ROOT="${1:-${VERIFY_ARTIFACT_DIR:-}}"
if [ -z "$ARTIFACT_ROOT" ]; then
  ARTIFACT_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/mind-full-verify.XXXXXX")"
fi

mkdir -p "$ARTIFACT_ROOT"

LOCAL_DIR="$ARTIFACT_ROOT/local"
OPENCODE_DIR="$ARTIFACT_ROOT/opencode"
DOCKER_DIR="$ARTIFACT_ROOT/docker"

local_exit=0
opencode_exit=0

"$SCRIPT_DIR/verify_local_gates.sh" "$LOCAL_DIR"
local_exit=$?

"$SCRIPT_DIR/verify_opencode_run.sh" "$OPENCODE_DIR" "$LOCAL_DIR"
opencode_exit=$?

"$SCRIPT_DIR/verify_docker.sh" "$DOCKER_DIR"

"$BUN_BIN" -e '
  const fs = require("node:fs");

  const [summaryPath, artifactRoot, localPath, opencodePath, dockerPath] = process.argv.slice(1);

  function readStage(stageName, filePath) {
    if (!fs.existsSync(filePath)) {
      return {
        stage: stageName,
        status: "error",
        classification: "stage-result-missing",
        result_path: filePath,
      };
    }

    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      ...parsed,
      result_path: filePath,
    };
  }

  const local = readStage("local-gates", localPath);
  const opencode = readStage("opencode", opencodePath);
  const docker = readStage("docker", dockerPath);

  const hardFailure = local.status !== "pass" || opencode.status !== "pass";
  const summary = {
    status: hardFailure ? "fail" : "pass",
    classification: hardFailure ? "hard-gates-failed" : "hard-gates-passed",
    artifact_root: artifactRoot,
    stages: {
      local_gates: local,
      opencode,
      docker,
    },
  };

  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
' "$ARTIFACT_ROOT/summary.json" "$ARTIFACT_ROOT" "$LOCAL_DIR/result.json" "$OPENCODE_DIR/result.json" "$DOCKER_DIR/result.json"

printf 'verification summary: %s\n' "$ARTIFACT_ROOT/summary.json"

if "$BUN_BIN" -e '
  const fs = require("node:fs");
  const [summaryPath] = process.argv.slice(1);
  const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  process.exit(summary.status === "pass" ? 0 : 1);
' "$ARTIFACT_ROOT/summary.json"; then
  printf 'run_full_test: PASS\n'
  exit 0
fi

printf 'run_full_test: FAIL\n' >&2
exit 1
