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

/** Цикл кнопки 🌓: light → dark → system → light. (Legacy — DRW-230 заменил
 *  поведение кнопки на toggleColorMode; оставлено как переиспользуемый хелпер.) */
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

/**
 * DRW-230: обычный клик по кнопке темы — переключение ТОЛЬКО светлая⇄тёмная.
 * Берём ВИДИМУЮ сейчас цветовую схему (`resolveColorMode`) и возвращаем
 * противоположный явный режим — так клик из системного режима тоже флипает то,
 * что пользователь видит, и никогда не «застревает» в системной. Системный
 * режим выбирается отдельно (Opt-Click), не этим переключателем.
 */
export function toggleColorMode(current: ColorMode): ThemeMode {
  return current === "dark" ? "light" : "dark";
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
