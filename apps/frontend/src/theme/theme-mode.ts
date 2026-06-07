// apps/frontend/src/theme/theme-mode.ts
//
// DRW-217: ядро темы. SSOT режима — localStorage `shemma:theme`
// (per-browser, работает и на страницах без tldraw editor: Gallery/Spaces).
// Резолв system → matchMedia; применение — data-shemma-theme на <html>
// (наши CSS-переменные) + colorScheme в tldraw (canvas/UI).
//
// AC#9: preference НЕ пишется в canvas state / room store.

export type ThemeMode = "light" | "dark" | "system";
export type ColorMode = "light" | "dark";

export const THEME_STORAGE_KEY = "shemma:theme";

const VALID_MODES: ReadonlySet<ThemeMode> = new Set([
  "light",
  "dark",
  "system",
]);

/** Незнакомое/отсутствующее значение → "system" (следуем OS по умолчанию). */
export function normalizeThemeMode(raw: unknown): ThemeMode {
  return typeof raw === "string" && VALID_MODES.has(raw as ThemeMode)
    ? (raw as ThemeMode)
    : "system";
}

/** Цикл кнопки 🌓: light → dark → system → light. */
export function cycleThemeMode(mode: ThemeMode): ThemeMode {
  switch (mode) {
    case "light":
      return "dark";
    case "dark":
      return "system";
    case "system":
      return "light";
  }
}

/** Резолв режима в фактическую цветовую схему. */
export function resolveColorMode(
  mode: ThemeMode,
  systemPrefersDark: boolean,
): ColorMode {
  if (mode === "system") return systemPrefersDark ? "dark" : "light";
  return mode;
}

export function loadThemeMode(): ThemeMode {
  if (typeof localStorage === "undefined") return "system";
  try {
    return normalizeThemeMode(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function saveThemeMode(mode: ThemeMode): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // private mode / quota — некритично, тема просто не переживёт reload.
  }
}
