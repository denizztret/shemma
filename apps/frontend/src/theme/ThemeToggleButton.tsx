// apps/frontend/src/theme/ThemeToggleButton.tsx
//
// DRW-217 / DRW-230: board-level переключатель темы в шапке доски (между ⚙️ и
// 💬). Обычный клик переключает ТОЛЬКО светлая⇄тёмная (никогда не системная);
// Opt-клик выбирает системную. Пока зажат Opt — иконка показывает 🌓 (preview)
// и клик в этот момент включит системную. Pure-props (mode/colorMode/altHeld/
// onSelect) — wiring через ThemeToggleButtonContainer.
// Единый chrome-стиль через ChromeButton (один вид/размер с соседями).

import type { FC } from "react";
import { ChromeButton } from "../chrome/ChromeButton";
import { type ColorMode, type ThemeMode, toggleColorMode } from "./theme-mode";

export type ThemeToggleButtonProps = {
  mode: ThemeMode;
  /** Текущая ВИДИМАЯ цветовая схема (резолв system → light/dark). */
  colorMode: ColorMode;
  /** Зажат ли Opt/Alt — кнопка показывает 🌓 и клик выбирает системную. */
  altHeld: boolean;
  /** Применить режим темы. Плоский клик → light/dark; Opt-клик → system. */
  onSelect: (mode: ThemeMode) => void;
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
  colorMode,
  altHeld,
  onSelect,
}) => {
  const icon = altHeld ? MODE_ICON.system : MODE_ICON[mode];
  const title = altHeld
    ? "Opt-клик: системная тема"
    : `Тема: ${MODE_LABEL[mode]} — клик: светлая ⇄ тёмная, Opt-клик: системная`;
  return (
    <ChromeButton
      left={356}
      ariaLabel={`Тема: ${MODE_LABEL[mode]}`}
      title={title}
      dataRole="theme-toggle"
      onClick={() => onSelect(altHeld ? "system" : toggleColorMode(colorMode))}
    >
      {icon}
    </ChromeButton>
  );
};
