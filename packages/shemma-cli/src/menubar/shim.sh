#!/usr/bin/env bash
# <bitbar.title>shemma</bitbar.title>
# <bitbar.version>__VERSION__</bitbar.version>
# <bitbar.author>shemma</bitbar.author>
# <bitbar.desc>Управление shemma-демоном из menu bar.</bitbar.desc>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideLastUpdated>true</swiftbar.hideLastUpdated>
#
# Тонкий shim: вся логика меню — в `shemma menubar` (обновляется вместе с
# бинарём через `shemma update`). Здесь только резолв бинаря + fallback-меню.
set -u

resolve_bin() {
  if [ -n "${SHEMMA_BIN:-}" ] && [ -x "$SHEMMA_BIN" ]; then
    printf '%s' "$SHEMMA_BIN"
    return 0
  fi
  if command -v shemma >/dev/null 2>&1; then
    command -v shemma
    return 0
  fi
  for p in "$HOME/.local/bin/shemma" /opt/homebrew/bin/shemma /usr/local/bin/shemma; do
    if [ -x "$p" ]; then
      printf '%s' "$p"
      return 0
    fi
  done
  return 1
}

if ! BIN="$(resolve_bin)"; then
  echo "⚠️"
  echo "---"
  echo "shemma не найден | color=red"
  echo "Установи бинарь или задай SHEMMA_BIN в env | color=gray"
  echo "Открыть README | href=https://github.com/denizztret/shemma"
  exit 0
fi

exec "$BIN" menubar "${1:-render}" "${@:2}"
