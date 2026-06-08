// DRW-217: pure-ядро темы — режим, цикл, резолв, persistence-ключ.
import { describe, expect, test } from "bun:test";
import {
  THEME_STORAGE_KEY,
  type ThemeMode,
  cycleThemeMode,
  normalizeThemeMode,
  resolveColorMode,
  toggleColorMode,
} from "./theme-mode";

describe("theme-mode core", () => {
  test("storage key follows shemma:<feature> convention", () => {
    expect(THEME_STORAGE_KEY).toBe("shemma:theme");
  });

  test("normalizeThemeMode accepts valid modes and defaults to system", () => {
    expect(normalizeThemeMode("light")).toBe("light");
    expect(normalizeThemeMode("dark")).toBe("dark");
    expect(normalizeThemeMode("system")).toBe("system");
    expect(normalizeThemeMode("blue")).toBe("system");
    expect(normalizeThemeMode(null)).toBe("system");
    expect(normalizeThemeMode(undefined)).toBe("system");
  });

  test("cycleThemeMode: light → dark → system → light", () => {
    expect(cycleThemeMode("light")).toBe("dark");
    expect(cycleThemeMode("dark")).toBe("system");
    expect(cycleThemeMode("system")).toBe("light");
  });

  // DRW-230: plain click flips between light/dark based on the currently
  // VISIBLE color, never selecting system.
  test("toggleColorMode flips the visible color to the opposite explicit mode", () => {
    expect(toggleColorMode("light")).toBe("dark");
    expect(toggleColorMode("dark")).toBe("light");
  });

  test("resolveColorMode: explicit modes ignore system preference", () => {
    expect(resolveColorMode("light", true)).toBe("light");
    expect(resolveColorMode("light", false)).toBe("light");
    expect(resolveColorMode("dark", true)).toBe("dark");
    expect(resolveColorMode("dark", false)).toBe("dark");
  });

  test("resolveColorMode: system follows OS preference", () => {
    expect(resolveColorMode("system", true)).toBe("dark");
    expect(resolveColorMode("system", false)).toBe("light");
  });

  test("ThemeMode type round-trips through cycle (exhaustive)", () => {
    const modes: ThemeMode[] = ["light", "dark", "system"];
    const seen = new Set<ThemeMode>();
    let cur: ThemeMode = "light";
    for (let i = 0; i < modes.length; i++) {
      seen.add(cur);
      cur = cycleThemeMode(cur);
    }
    expect(seen.size).toBe(3);
    expect(cur).toBe("light");
  });
});
