// apps/frontend/src/settings/SettingsTriggerButton.tsx
//
// DRW-206: постоянная видимая кнопка панели настроек (⚙️) в верхней зоне доски,
// перед кнопкой темы 🌓 и Prompts 💬. Открытие/закрытие — общий toggle() из
// useSettingsTrigger (паритет с ⌘⇧P и Option+RightClick).
// Единый chrome-стиль через ChromeButton (приёмка: один вид/размер с соседями).

import type { FC } from "react";
import { ChromeButton } from "../chrome/ChromeButton";

export type SettingsTriggerButtonProps = {
  /** Popover сейчас открыт — кнопка подсвечивается. */
  open: boolean;
  onToggle: () => void;
};

export const SettingsTriggerButton: FC<SettingsTriggerButtonProps> = ({
  open,
  onToggle,
}) => (
  <ChromeButton
    left={320}
    ariaLabel="Настройки"
    title="Настройки доски (⌘⇧P)"
    dataRole="settings-trigger"
    active={open}
    pressed={open}
    onClick={onToggle}
    // stopPropagation: во floating-режиме outside-click-close иначе переоткрыл бы.
    stopPointerDown
  >
    ⚙️
  </ChromeButton>
);
