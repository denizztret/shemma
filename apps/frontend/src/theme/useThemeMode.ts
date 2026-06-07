// apps/frontend/src/theme/useThemeMode.ts
//
// DRW-217: React-обвязка theme-store (useSyncExternalStore).

import { useCallback, useSyncExternalStore } from "react";
import { type ColorMode, type ThemeMode, cycleThemeMode } from "./theme-mode";
import {
  getResolvedColorMode,
  getThemeMode,
  setThemeMode,
  subscribeTheme,
} from "./theme-store";

export function useThemeMode(): {
  mode: ThemeMode;
  colorMode: ColorMode;
  setMode: (next: ThemeMode) => void;
  cycle: () => void;
} {
  const mode = useSyncExternalStore(subscribeTheme, getThemeMode);
  const colorMode = useSyncExternalStore(subscribeTheme, getResolvedColorMode);
  const cycle = useCallback(() => {
    setThemeMode(cycleThemeMode(getThemeMode()));
  }, []);
  return { mode, colorMode, setMode: setThemeMode, cycle };
}
