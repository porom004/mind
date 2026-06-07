#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ARTIFACT_DIR="${1:-${VERIFY_OPENCODE_ARTIFACT_DIR:-}}"
LOCAL_ARTIFACT_DIR="${2:-${VERIFY_LOCAL_ARTIFACT_DIR:-}}"

if [ -z "$ARTIFACT_DIR" ]; then
  ARTIFACT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mind-opencode-review.XXXXXX")"
fi

if [ -z "$LOCAL_ARTIFACT_DIR" ]; then
  printf 'verify_opencode_run.sh requires a local artifact directory\n' >&2
  exit 1
fi

mkdir -p "$ARTIFACT_DIR"

BUN_BIN="${VERIFY_BUN_BIN:-bun}"
OPENCODE_BIN="${VERIFY_OPENCODE_BIN:-opencode}"
STDOUT_PATH="$ARTIFACT_DIR/opencode-output.jsonl"
STDERR_PATH="$ARTIFACT_DIR/opencode-error.txt"
ATTACHMENTS_PATH="$ARTIFACT_DIR/attachments.txt"

: > "$ATTACHMENTS_PATH"

add_attachment() {
  local path="$1"
  if [ -f "$path" ]; then
    printf '%s\n' "$path" >> "$ATTACHMENTS_PATH"
  fi
}

add_attachment "$LOCAL_ARTIFACT_DIR/result.json"
add_attachment "$LOCAL_ARTIFACT_DIR/worktree_status.txt"
add_attachment "$LOCAL_ARTIFACT_DIR/worktree_diff_stat.txt"
add_attachment "$LOCAL_ARTIFACT_DIR/worktree_diff_numstat.txt"
add_attachment "$LOCAL_ARTIFACT_DIR/worktree.patch"
add_attachment "$LOCAL_ARTIFACT_DIR/untracked_files.txt"

if [ -d "$LOCAL_ARTIFACT_DIR/commands" ]; then
  while IFS= read -r file_path; do
    add_attachment "$file_path"
  done < <(find "$LOCAL_ARTIFACT_DIR/commands" -type f | sort)
fi

if [ -d "$LOCAL_ARTIFACT_DIR/untracked" ]; then
  while IFS= read -r file_path; do
    add_attachment "$file_path"
  done < <(find "$LOCAL_ARTIFACT_DIR/untracked" -type f | sort)
fi

PROMPT=$(cat <<'EOF'
Review only the attached machine-generated verification artifacts.
Do not assume access to the repository, the network, or any tools.

Classify strictly:
- verdict=pass when every hard gate passed and the artifacts do not show a blocking issue.
- verdict=fail when any hard gate failed or the current worktree still shows a blocking issue.
- verdict=error when the artifacts are missing, contradictory, or insufficient.

Hard gates: git diff --check, format:check, lint, typecheck, bun test test/ web/test, and this constrained review stage.
Docker is advisory only in v1.

Do not output status prose, markdown, or explanations outside the JSON object.
If you are uncertain, return verdict="error" in the required JSON shape.

Return exactly one JSON object and nothing else:
{"verdict":"pass|fail|error","summary":"<=200 chars","failures":[{"id":"kebab-case","severity":"hard|advisory","reason":"<=200 chars","artifact":"basename"}],"warnings":[{"id":"kebab-case","reason":"<=200 chars","artifact":"basename"}]}
EOF
)

export OPENCODE_CONFIG_CONTENT
OPENCODE_CONFIG_CONTENT=$(cat <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "*": "deny"
  },
  "agent": {
    "verification-harness": {
      "description": "Evaluates attached verification artifacts and returns strict JSON verdicts without tools.",
      "mode": "primary",
      "temperature": 0,
      "permission": {
        "*": "deny"
      },
      "prompt": "Read only the attached machine-generated artifacts. Never claim repo exploration or tool use. Never emit prose outside the final JSON object. If uncertain, still return the required JSON shape with verdict error."
    }
  }
}
JSON
)

export OPENCODE_DISABLE_AUTOCOMPACT=1
export OPENCODE_DISABLE_CLAUDE_CODE=1
export OPENCODE_DISABLE_DEFAULT_PLUGINS=1
export OPENCODE_DISABLE_MODELS_FETCH=1
export OPENCODE_CLIENT=verification-harness

opencode_args=(run --format json --agent verification-harness)
if [ -n "${VERIFY_OPENCODE_MODEL:-}" ]; then
  opencode_args+=(--model "$VERIFY_OPENCODE_MODEL")
fi

while IFS= read -r attachment; do
  [ -z "$attachment" ] && continue
  opencode_args+=(--file "$attachment")
done < "$ATTACHMENTS_PATH"

opencode_exit=0
"$OPENCODE_BIN" "${opencode_args[@]}" >"$STDOUT_PATH" 2>"$STDERR_PATH" <<<"$PROMPT"
opencode_exit=$?

"$BUN_BIN" -e '
  const fs = require("node:fs");
  const path = require("node:path");

  const [stdoutPath, stderrPath, attachmentsPath, resultPath, opencodeExitRaw] = process.argv.slice(1);
  const opencodeExit = Number(opencodeExitRaw);
  const output = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, "utf8") : "";
  const parseableLines = [];
  const collectedStrings = [];

  function collectStrings(value) {
    if (typeof value === "string") {
      collectedStrings.push(value);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        collectStrings(item);
      }
      return;
    }

    if (value && typeof value === "object") {
      for (const child of Object.values(value)) {
        collectStrings(child);
      }
    }
  }

  function parseVerdictCandidate(text) {
    const candidates = [];
    const trimmed = text.trim();

    if (!trimmed) {
      return null;
    }

    candidates.push(trimmed);

    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
    }

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        if (
          parsed &&
          typeof parsed === "object" &&
          (parsed.verdict === "pass" || parsed.verdict === "fail" || parsed.verdict === "error")
        ) {
          return parsed;
        }
      } catch {
        // Ignore candidate parse failures and keep scanning.
      }
    }

    return null;
  }

  for (const line of output.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    try {
      const parsedLine = JSON.parse(line);
      parseableLines.push(parsedLine);
      collectStrings(parsedLine);
    } catch {
      collectedStrings.push(line);
    }
  }

  let verdict = null;
  for (const text of [...collectedStrings].reverse()) {
    verdict = parseVerdictCandidate(text);
    if (verdict) {
      break;
    }
  }

  if (!verdict) {
    verdict = parseVerdictCandidate(collectedStrings.join("\n"));
  }

  let status = "pass";
  let classification = "verified-pass";

  if (opencodeExit !== 0) {
    status = "error";
    classification = "opencode-nonzero-exit";
  } else if (!verdict) {
    status = "error";
    classification = "verdict-missing";
  } else if (verdict.verdict === "fail") {
    status = "fail";
    classification = "model-verdict-fail";
  } else if (verdict.verdict === "error") {
    status = "error";
    classification = "model-verdict-error";
  }

  const result = {
    stage: "opencode",
    status,
    classification,
    exit_code: opencodeExit,
    verdict,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    attachments: fs.existsSync(attachmentsPath)
      ? fs.readFileSync(attachmentsPath, "utf8").split("\n").filter(Boolean)
      : [],
    parsed_event_count: parseableLines.length,
    output_excerpt: output.trim().slice(0, 4000),
    stderr_excerpt: fs.existsSync(stderrPath)
      ? fs.readFileSync(stderrPath, "utf8").trim().slice(0, 2000)
      : "",
  };

  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
' "$STDOUT_PATH" "$STDERR_PATH" "$ATTACHMENTS_PATH" "$ARTIFACT_DIR/result.json" "$opencode_exit"

if "$BUN_BIN" -e '
  const fs = require("node:fs");
  const [resultPath] = process.argv.slice(1);
  const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  process.exit(result.status === "pass" ? 0 : 1);
' "$ARTIFACT_DIR/result.json"; then
  printf 'opencode review: PASS (%s)\n' "$ARTIFACT_DIR/result.json"
  exit 0
fi

printf 'opencode review: FAIL (%s)\n' "$ARTIFACT_DIR/result.json" >&2
exit 1
