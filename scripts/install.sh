#!/usr/bin/env bash
# install.sh — create a symlink for the didraw binary in $HOME/.local/bin (or a custom prefix).
#
# Usage:
#   ./scripts/install.sh [--prefix <dir>] [<binary-path>]
#
# Arguments:
#   <binary-path>   Path to the didraw binary (defaults to release/didraw-<os>-<arch>
#                   relative to the script's parent directory, or DIDRAW_BIN env var).
#   --prefix <dir>  Install directory (default: $HOME/.local/bin).
#
# Exit codes: 0 success, 1 error.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Defaults
PREFIX="${HOME}/.local/bin"
BINARY=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix=*)
      PREFIX="${1#--prefix=}"
      shift
      ;;
    --prefix)
      if [[ -z "$2" ]]; then
        echo "error: --prefix requires a value" >&2
        exit 1
      fi
      PREFIX="$2"
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

# Resolve binary path
if [[ -z "$BINARY" ]]; then
  BINARY="${DIDRAW_BIN:-}"
fi

if [[ -z "$BINARY" ]]; then
  # Auto-detect: pick a release binary for current platform
  OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64)  ARCH="x64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *)       ARCH="$ARCH" ;;
  esac
  BINARY="${REPO_ROOT}/release/didraw-${OS}-${ARCH}"
fi

# Validate binary
if [[ ! -f "$BINARY" ]]; then
  echo "error: binary not found: $BINARY" >&2
  echo "  Build it first with: ./scripts/build-release.sh <version> stable" >&2
  echo "  Or specify the path: $0 /path/to/didraw" >&2
  exit 1
fi

if [[ ! -x "$BINARY" ]]; then
  echo "error: binary is not executable: $BINARY" >&2
  echo "  Run: chmod +x $BINARY" >&2
  exit 1
fi

# Create install directory if needed
if [[ ! -d "$PREFIX" ]]; then
  mkdir -p "$PREFIX"
  echo "Created directory: $PREFIX"
fi

LINK="${PREFIX}/didraw"

# Remove existing symlink or file
if [[ -L "$LINK" ]]; then
  rm "$LINK"
elif [[ -f "$LINK" ]]; then
  echo "error: $LINK exists and is not a symlink. Remove it manually." >&2
  exit 1
fi

ln -s "$(cd "$(dirname "$BINARY")" && pwd)/$(basename "$BINARY")" "$LINK"
echo "Installed: $LINK -> $(readlink "$LINK")"

# Remind user about PATH if needed
case ":${PATH}:" in
  *":${PREFIX}:"*)
    # already in PATH
    ;;
  *)
    echo ""
    echo "Note: ${PREFIX} is not in your PATH."
    echo "  Add it to your shell config (~/.zshrc, ~/.bashrc, etc.):"
    echo "    export PATH=\"${PREFIX}:\$PATH\""
    ;;
esac
