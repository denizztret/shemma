// apps/frontend/src/theme/ThemeToggleButton.tsx
//
// DRW-217: board-level переключатель темы в шапке доски (между ⚙ и 💬).
// Цикл light → dark → system; иконка отражает ТЕКУЩИЙ режим. Pure-props
// (mode/onCycle) — wiring через useThemeMode в App.

import type { FC } from "react";
import { tokens } from "../design-tokens";
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
  <div
    style={{
      // Chrome-зона шапки (конвенция DRW-191/206): ⚙ 320 → 🌓 356 → 💬 392.
      position: "absolute",
      top: 4,
      left: 356,
      zIndex: 301,
      pointerEvents: "auto",
      fontFamily: tokens.font.sans,
      fontSize: tokens.font.sm,
    }}
  >
    <button
      type="button"
      aria-label={`Тема: ${MODE_LABEL[mode]}`}
      data-role="theme-toggle"
      title={`Тема: ${MODE_LABEL[mode]} — клик переключает (светлая → тёмная → системная)`}
      onClick={onCycle}
      style={{
        background: tokens.color.bgOverlay,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.sm,
        padding: "4px 8px",
        cursor: "pointer",
        fontSize: tokens.font.sm,
      }}
    >
      {MODE_ICON[mode]}
    </button>
  </div>
);
