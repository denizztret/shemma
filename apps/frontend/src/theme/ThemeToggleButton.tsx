// apps/frontend/src/theme/ThemeToggleButton.tsx
//
// DRW-217: board-level переключатель темы в шапке доски (между ⚙️ и 💬).
// Цикл light → dark → system; иконка отражает ТЕКУЩИЙ режим. Pure-props
// (mode/onCycle) — wiring через useThemeMode в App.
// Единый chrome-стиль через ChromeButton (один вид/размер с соседями).

import type { FC } from "react";
import { ChromeButton } from "../chrome/ChromeButton";
import type { ThemeMode } from "./theme-mode";

export type ThemeToggleButtonProps = {
  mode: ThemeMode;
  onCycle: () => void;
};

const MODE_ICON: Record<ThemeMode, string> = {
  light: "☀️",
  dark: "🌙",
  system: "🌓",
};

const MODE_LABEL: Record<ThemeMode, string> = {
  light: "светлая",
  dark: "тёмная",
  system: "системная",
};

export const ThemeToggleButton: FC<ThemeToggleButtonProps> = ({
  mode,
  onCycle,
}) => (
  <ChromeButton
    left={356}
    ariaLabel={`Тема: ${MODE_LABEL[mode]}`}
    title={`Тема: ${MODE_LABEL[mode]} — клик переключает (светлая → тёмная → системная)`}
    dataRole="theme-toggle"
    onClick={onCycle}
  >
    {MODE_ICON[mode]}
  </ChromeButton>
);
