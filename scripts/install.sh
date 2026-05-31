#!/usr/bin/env bash
# install.sh — install the shemma binary into $HOME/.local/bin (or custom prefix).
#
# Modes:
#
#   1) Local (default):
#      Symlink a pre-built binary from release/shemma-<os>-<arch> (или указанного
#      пути / SHEMMA_BIN env) в $PREFIX/shemma. Если локальный бинарь не найден —
#      автоматически переходит на установку последнего GitHub-релиза (см. ниже).
#
#   2) Remote (--version <X|latest>):
#      Скачать compiled binary из GitHub Release. Для ПУБЛИЧНОГО репозитория
#      работает анонимно (без токена). Для приватного — через gh auth или PAT
#      (env SHEMMA_GITHUB_TOKEN, сохранённый ~/.config/shemma/auth.json, либо
#      интерактивный prompt).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/denizztret/shemma/main/scripts/install.sh | sh
#   ./scripts/install.sh                                  # local pre-built, иначе latest release
#   ./scripts/install.sh [--prefix <dir>] <binary-path>
#   ./scripts/install.sh [--prefix <dir>] --version <ver|latest> [--repo <owner/name>]
#
# Exit codes: 0 success, 1 error.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"
REPO_ROOT=""
if [[ -n "$SCRIPT_DIR" ]]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd || true)"
fi

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

# Read a saved PAT (if any) for private-repo access.
read_saved_token() {
  local f="$HOME/.config/shemma/auth.json"
  if [[ -n "${SHEMMA_GITHUB_TOKEN:-}" ]]; then
    echo "$SHEMMA_GITHUB_TOKEN"
  elif [[ -f "$f" ]] && command -v jq &>/dev/null; then
    jq -r '.github_token // empty' "$f" 2>/dev/null || true
  fi
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

# Resolve the latest release tag. Anonymous for public repos; uses gh/token when available.
resolve_latest() {
  if command -v gh &>/dev/null && gh auth status &>/dev/null; then
    gh release view --repo "$REPO" --json tagName -q .tagName 2>/dev/null && return 0
  fi
  if ! command -v curl &>/dev/null || ! command -v jq &>/dev/null; then
    echo "error: need curl + jq (or authenticated gh) to resolve the latest release" >&2
    exit 1
  fi
  local token args
  token="$(read_saved_token)"
  args=(-fsSL -H "Accept: application/vnd.github+json" -H "User-Agent: shemma-install")
  [[ -n "$token" ]] && args+=(-H "Authorization: Bearer $token")
  curl "${args[@]}" "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | jq -r '.tag_name // empty'
}

# Remote install via GitHub Release. Anonymous-first (public); gh/PAT fallback (private).
remote_install() {
  local platform="$1"
  local link="$PREFIX/shemma"
  ensure_prefix

  # Resolve "latest" (or empty) to a concrete tag.
  if [[ -z "$VERSION" || "$VERSION" == "latest" ]]; then
    echo "Resolving latest release from $REPO..."
    VERSION="$(resolve_latest)"
    if [[ -z "$VERSION" || "$VERSION" == "null" ]]; then
      echo "error: could not resolve the latest release tag for $REPO" >&2
      exit 1
    fi
    echo "Latest release: $VERSION"
  fi

  local asset_name="shemma-$platform"

  # Remove existing entry at link.
  if [[ -L "$link" || -f "$link" ]]; then
    rm -f "$link"
  fi

  # Path A: gh CLI (works for public and private when authenticated).
  if command -v gh &>/dev/null && gh auth status &>/dev/null; then
    echo "Using gh CLI for download (authenticated)"
    gh release download "$VERSION" --repo "$REPO" \
      --pattern "$asset_name" --output "$link"
    chmod +x "$link"
    echo "Installed: $link (gh release download $VERSION $asset_name)"
    remind_path
    return 0
  fi

  # Path B: curl + jq. Anonymous first; token only if needed (private repo).
  if ! command -v curl &>/dev/null; then
    echo "error: curl is required for download" >&2
    exit 1
  fi
  if ! command -v jq &>/dev/null; then
    echo "error: jq is required for download" >&2
    echo "  Install: brew install jq  (macOS) | apt install jq (Debian/Ubuntu)" >&2
    exit 1
  fi

  local token release_json
  token="$(read_saved_token)"
  local rel_url="https://api.github.com/repos/$REPO/releases/tags/$VERSION"

  # Try anonymously first (public repo) unless we already have a token.
  release_json=""
  if [[ -z "$token" ]]; then
    release_json="$(curl -fsSL \
      -H "Accept: application/vnd.github+json" \
      -H "User-Agent: shemma-install" \
      "$rel_url" 2>/dev/null || true)"
  fi

  # Anonymous failed (empty) → likely a private repo: obtain a token.
  if [[ -z "$release_json" ]]; then
    if [[ -z "$token" ]]; then
      echo "Anonymous download failed — repo may be private. A GitHub PAT is required."
      echo "  → Create one: https://github.com/settings/tokens (scope: repo)"
      echo "  → Or install gh CLI: brew install gh && gh auth login"
      # /dev/tty чтобы prompt работал даже когда скрипт pipe'нут (curl|sh).
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
    release_json="$(curl -fsSL \
      -H "Authorization: Bearer $token" \
      -H "Accept: application/vnd.github+json" \
      -H "User-Agent: shemma-install" \
      "$rel_url")" || {
        echo "error: failed to fetch release metadata for $VERSION" >&2
        exit 1
      }
  fi

  local asset_id
  asset_id=$(echo "$release_json" | jq -r ".assets[] | select(.name==\"$asset_name\") | .id")
  if [[ -z "$asset_id" || "$asset_id" == "null" ]]; then
    echo "error: asset $asset_name not found in release $VERSION" >&2
    exit 1
  fi

  echo "Downloading $asset_name (release $VERSION)..."
  local dl_args=(-fsSL -H "Accept: application/octet-stream" -H "User-Agent: shemma-install" -o "$link")
  [[ -n "$token" ]] && dl_args+=(-H "Authorization: Bearer $token")
  curl "${dl_args[@]}" "https://api.github.com/repos/$REPO/releases/assets/$asset_id"
  chmod +x "$link"
  echo "Installed: $link (release $VERSION)"

  # Persist token only if we actually needed one (private repo).
  [[ -n "$token" ]] && save_token "$token"
  remind_path
}

# Local install via existing pre-built binary; falls back to latest release if none.
local_install() {
  # Track whether the user explicitly named a binary (positional arg or SHEMMA_BIN).
  local explicit=""
  if [[ -n "$BINARY" ]]; then
    explicit="1"
  else
    BINARY="${SHEMMA_BIN:-}"
    [[ -n "$BINARY" ]] && explicit="1"
  fi
  if [[ -z "$BINARY" && -n "$REPO_ROOT" ]]; then
    BINARY="${REPO_ROOT}/release/shemma-$(detect_platform)"
  fi

  if [[ -z "$BINARY" || ! -f "$BINARY" ]]; then
    # Explicit path that doesn't exist → hard error (respect user intent).
    if [[ -n "$explicit" ]]; then
      echo "error: binary not found: $BINARY" >&2
      echo "  Build it first with: ./scripts/build-release.sh <version> stable" >&2
      echo "  Or specify the path: $0 /path/to/shemma" >&2
      echo "  Or install from GitHub Release: $0 --version latest" >&2
      exit 1
    fi
    # No binary named → install the latest release (enables `curl ... | sh`).
    echo "No local binary found — installing the latest release from $REPO."
    remote_install "$(detect_platform)"
    return $?
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
