#!/usr/bin/env bash
set -euo pipefail

REPO="${MIND_INSTALL_REPO:-GabrielMartinMoran/mind}"
REF="${MIND_INSTALL_REF:-latest}"
INSTALL_DIR="${MIND_INSTALL_DIR:-$HOME/.local/share/mind}"
BIN_DIR="${MIND_BIN_DIR:-$HOME/.local/bin}"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1"
    exit 1
  fi
}

ensure_bun() {
  if command -v bun >/dev/null 2>&1; then
    return
  fi

  echo "bun is not installed. Installing bun..."
  curl -fsSL https://bun.sh/install | bash

  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"

  if ! command -v bun >/dev/null 2>&1; then
    echo "bun installation failed. Install manually: https://bun.sh"
    exit 1
  fi
}

resolve_ref() {
  if [ "$REF" != "latest" ]; then
    echo "$REF"
    return
  fi

  local latest_json
  if ! latest_json="$(curl -fsSL -H "Accept: application/vnd.github+json" -H "User-Agent: mind-installer" \
    "https://api.github.com/repos/${REPO}/releases/latest")"; then
    echo "Could not fetch latest release for ${REPO}."
    echo "If no releases exist yet, set MIND_INSTALL_REF=<tag-or-branch> and retry."
    exit 1
  fi

  local tag
  tag="$(printf '%s' "$latest_json" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  if [ -z "$tag" ]; then
    echo "Could not determine latest release tag for ${REPO}" >&2
    exit 1
  fi
  echo "$tag"
}

install_mind() {
  local tag="$1"
  local tarball_url="https://api.github.com/repos/${REPO}/tarball/${tag}"

  echo "Installing mind ${tag} from ${REPO}..."
  echo "Install dir: ${INSTALL_DIR}"
  echo "Bin dir:     ${BIN_DIR}"

  mkdir -p "$TMP_DIR/src"
  curl -fsSL -H "Accept: application/vnd.github+json" -H "User-Agent: mind-installer" \
    "$tarball_url" -o "$TMP_DIR/mind.tar.gz"

  tar -xzf "$TMP_DIR/mind.tar.gz" -C "$TMP_DIR/src" --strip-components=1

  mkdir -p "$(dirname "$INSTALL_DIR")"
  if [ -d "$INSTALL_DIR/data" ]; then
    mv "$INSTALL_DIR/data" "$TMP_DIR/data-backup"
  fi

  rm -rf "$INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  cp -R "$TMP_DIR/src"/. "$INSTALL_DIR"/

  if [ -d "$TMP_DIR/data-backup" ]; then
    mv "$TMP_DIR/data-backup" "$INSTALL_DIR/data"
  fi

  (cd "$INSTALL_DIR" && bun install --production --ignore-scripts)

  # Copy .env.example to .env if .env doesn't exist
  if [ ! -f "$INSTALL_DIR/.env" ] && [ -f "$INSTALL_DIR/.env.example" ]; then
    echo "Creating .env from .env.example..."
    cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  fi

  mkdir -p "$BIN_DIR"
  cat > "$BIN_DIR/mind" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required to run mind. Install from https://bun.sh"
  exit 1
fi
exec bun run "$INSTALL_DIR/src/mind.ts" "\$@"
EOF
  chmod +x "$BIN_DIR/mind"

  echo
  echo "✅ mind installed successfully"
  echo "Try: $BIN_DIR/mind help"
  echo "Refresh detected agent integrations with: $BIN_DIR/mind setup refresh"

  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      echo
      echo "Add mind to your PATH:"
      echo "  export PATH=\"$BIN_DIR:\$PATH\""
      ;;
  esac
}

main() {
  require_cmd curl
  require_cmd tar
  ensure_bun

  local tag
  tag="$(resolve_ref)"
  install_mind "$tag"
}

main "$@"
