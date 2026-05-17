#!/usr/bin/env bash
# install.sh — install the shemma binary into $HOME/.local/bin (or custom prefix).
#
# Two modes:
#
#   1) Local mode (default):
#      Symlink a pre-built binary from release/shemma-<os>-<arch> (или указанного
#      пути / SHEMMA_BIN env) в $PREFIX/shemma.
#
#   2) Remote mode (--version <X> или --from-release <X>):
#      Скачать compiled binary из GitHub Release version X (private repo
#      supported через PAT). Dual flow:
#        Path A: gh release download   — если gh установлен и авторизован
#        Path B: curl + jq + PAT       — fallback (env SHEMMA_GITHUB_TOKEN или
#                                        interactive prompt). Сохраняет PAT в
#                                        ~/.config/shemma/auth.json (chmod 600)
#                                        для последующих `shemma update`.
#
# Usage:
#   ./scripts/install.sh [--prefix <dir>] [<binary-path>]
#   ./scripts/install.sh [--prefix <dir>] --version <ver> [--repo <owner/name>]
#
# Exit codes: 0 success, 1 error.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Defaults
PREFIX="${HOME}/.local/bin"
BINARY=""
VERSION=""
REPO="${SHEMMA_GITHUB_REPO:-denizztret/shemma}"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix=*)
      PREFIX="${1#--prefix=}"
      shift
      ;;
    --prefix)
      if [[ -z "${2:-}" ]]; then
        echo "error: --prefix requires a value" >&2
        exit 1
      fi
      PREFIX="$2"
      shift 2
      ;;
    --version=*|--from-release=*)
      VERSION="${1#*=}"
      shift
      ;;
    --version|--from-release)
      if [[ -z "${2:-}" ]]; then
        echo "error: $1 requires a value" >&2
        exit 1
      fi
      VERSION="$2"
      shift 2
      ;;
    --repo=*)
      REPO="${1#--repo=}"
      shift
      ;;
    --repo)
      if [[ -z "${2:-}" ]]; then
        echo "error: --repo requires a value" >&2
        exit 1
      fi
      REPO="$2"
      shift 2
      ;;
    -*)
      echo "error: unknown flag: $1" >&2
      exit 1
      ;;
    *)
      BINARY="$1"
      shift
      ;;
  esac
done

# Detect platform
detect_platform() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$arch" in
    x86_64)  arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
  esac
  echo "${os}-${arch}"
}

# Persist token for future `shemma update` invocations.
save_token() {
  local token="$1"
  local dir="$HOME/.config/shemma"
  mkdir -p "$dir"
  chmod 700 "$dir"
  printf '{"github_token":"%s"}\n' "$token" > "$dir/auth.json"
  chmod 600 "$dir/auth.json"
  echo "Saved PAT → $dir/auth.json (chmod 600)"
}

# Ensure install dir exists.
ensure_prefix() {
  if [[ ! -d "$PREFIX" ]]; then
    mkdir -p "$PREFIX"
    echo "Created directory: $PREFIX"
  fi
}

# Reminds user about PATH if needed.
remind_path() {
  case ":${PATH}:" in
    *":${PREFIX}:"*) ;;
    *)
      echo ""
      echo "Note: ${PREFIX} is not in your PATH."
      echo "  Add it to your shell config (~/.zshrc, ~/.bashrc, etc.):"
      echo "    export PATH=\"${PREFIX}:\$PATH\""
      ;;
  esac
}

# Remote install via GitHub Release (Path A: gh, Path B: curl+PAT).
remote_install() {
  local platform="$1"
  local link="$PREFIX/shemma"
  local asset_name="shemma-$platform"
  ensure_prefix

  # Remove existing entry at link.
  if [[ -L "$link" ]]; then
    rm "$link"
  elif [[ -f "$link" ]]; then
    rm "$link"
  fi

  # Path A: gh
  if command -v gh &>/dev/null && gh auth status &>/dev/null; then
    echo "Using gh CLI for download (authenticated)"
    gh release download "$VERSION" --repo "$REPO" \
      --pattern "$asset_name" --output "$link"
    chmod +x "$link"
    echo "Installed: $link (gh release download $VERSION $asset_name)"
    remind_path
    return 0
  fi

  # Path B: curl + jq + PAT
  if ! command -v curl &>/dev/null; then
    echo "error: curl is required for Path B install" >&2
    exit 1
  fi
  if ! command -v jq &>/dev/null; then
    echo "error: jq is required for Path B install" >&2
    echo "  Install: brew install jq  (macOS) | apt install jq (Debian/Ubuntu)" >&2
    exit 1
  fi

  local token="${SHEMMA_GITHUB_TOKEN:-}"
  if [[ -z "$token" ]]; then
    echo "GitHub PAT required for private repo download."
    echo "  → Create one: https://github.com/settings/tokens (scope: repo)"
    echo "  → Or install gh CLI: brew install gh && gh auth login"
    # /dev/tty чтобы prompt работал даже когда скрипт pipe'нут (curl|bash).
    if [[ -t 0 ]]; then
      read -rsp "PAT: " token
      echo ""
    elif [[ -c /dev/tty ]] && (: < /dev/tty) 2>/dev/null; then
      read -rsp "PAT: " token < /dev/tty
      echo ""
    else
      echo "error: no TTY available for interactive PAT prompt" >&2
      echo "  hint: set SHEMMA_GITHUB_TOKEN env var" >&2
      exit 1
    fi
  fi
  if [[ -z "$token" ]]; then
    echo "error: empty PAT" >&2
    exit 1
  fi

  echo "Resolving asset $asset_name in release $VERSION (repo $REPO)..."
  local release_json asset_id
  release_json=$(curl -fsSL \
    -H "Authorization: Bearer $token" \
    -H "Accept: application/vnd.github+json" \
    -H "User-Agent: shemma-install" \
    "https://api.github.com/repos/$REPO/releases/tags/$VERSION") || {
      echo "error: failed to fetch release metadata" >&2
      exit 1
    }
  asset_id=$(echo "$release_json" | jq -r ".assets[] | select(.name==\"$asset_name\") | .id")
  if [[ -z "$asset_id" || "$asset_id" == "null" ]]; then
    echo "error: asset $asset_name not found in release $VERSION" >&2
    exit 1
  fi

  echo "Downloading asset id=$asset_id..."
  curl -fsSL \
    -H "Authorization: Bearer $token" \
    -H "Accept: application/octet-stream" \
    -H "User-Agent: shemma-install" \
    -o "$link" \
    "https://api.github.com/repos/$REPO/releases/assets/$asset_id"
  chmod +x "$link"
  echo "Installed: $link (curl from release $VERSION)"

  save_token "$token"
  remind_path
}

# Local install via existing pre-built binary (legacy default).
local_install() {
  # Resolve binary path
  if [[ -z "$BINARY" ]]; then
    BINARY="${SHEMMA_BIN:-}"
  fi
  if [[ -z "$BINARY" ]]; then
    BINARY="${REPO_ROOT}/release/shemma-$(detect_platform)"
  fi

  if [[ ! -f "$BINARY" ]]; then
    echo "error: binary not found: $BINARY" >&2
    echo "  Build it first with: ./scripts/build-release.sh <version> stable" >&2
    echo "  Or specify the path: $0 /path/to/shemma" >&2
    echo "  Or install from GitHub Release: $0 --version <X>" >&2
    exit 1
  fi
  if [[ ! -x "$BINARY" ]]; then
    echo "error: binary is not executable: $BINARY" >&2
    echo "  Run: chmod +x $BINARY" >&2
    exit 1
  fi

  ensure_prefix
  local link="$PREFIX/shemma"
  if [[ -L "$link" ]]; then
    rm "$link"
  elif [[ -f "$link" ]]; then
    echo "error: $link exists and is not a symlink. Remove it manually." >&2
    exit 1
  fi
  ln -s "$(cd "$(dirname "$BINARY")" && pwd)/$(basename "$BINARY")" "$link"
  echo "Installed: $link -> $(readlink "$link")"
  remind_path
}

if [[ -n "$VERSION" ]]; then
  remote_install "$(detect_platform)"
else
  local_install
fi
