// apps/frontend/src/theme/theme-store.ts
//
// DRW-217: singleton-store темы. Живёт на module-level (инициализация из
// main.tsx ДО React-рендера — без flash светлой темы), один на все три
// корня приложения (SpacesPage / Gallery / App). React подписывается через
// useSyncExternalStore (см. useThemeMode.ts).

import {
  type ColorMode,
  type ThemeMode,
  loadThemeMode,
  resolveColorMode,
  saveThemeMode,
} from "./theme-mode";

let mode: ThemeMode = "system";
let media: MediaQueryList | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

function systemPrefersDark(): boolean {
  return media?.matches ?? false;
}

/** Выставляет data-shemma-theme на <html> — точка привязки CSS-переменных. */
function applyToDocument(): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.shemmaTheme = resolveColorMode(
    mode,
    systemPrefersDark(),
  );
}

/**
 * Однократная инициализация (main.tsx, до рендера): читает сохранённый режим,
 * красит документ, подписывается на смену OS-темы (для mode=system).
 */
export function initTheme(): void {
  mode = loadThemeMode();
  if (typeof window !== "undefined" && "matchMedia" in window) {
    media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", () => {
      applyToDocument();
      emit();
    });
  }
  applyToDocument();
}

export function getThemeMode(): ThemeMode {
  return mode;
}

/** Фактическая (резолвнутая) схема — для UI-индикации и не-tldraw поверхностей. */
export function getResolvedColorMode(): ColorMode {
  return resolveColorMode(mode, systemPrefersDark());
}

export function setThemeMode(next: ThemeMode): void {
  if (next === mode) return;
  mode = next;
  saveThemeMode(next);
  applyToDocument();
  emit();
}

export function subscribeTheme(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
