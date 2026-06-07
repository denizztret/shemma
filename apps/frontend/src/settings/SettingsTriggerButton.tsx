// apps/frontend/src/settings/SettingsTriggerButton.tsx
//
// DRW-206: постоянная видимая кнопка панели настроек (⚙) в верхней зоне доски,
// перед кнопкой Prompts (💬). Открытие/закрытие — общий toggle() из
// useSettingsTrigger (паритет с ⌘⇧P и Option+RightClick: board-панель без
// выделения, selection/node-панель при выделении).

import type { FC } from "react";
import { tokens } from "../design-tokens";

export type SettingsTriggerButtonProps = {
  /** Popover сейчас открыт — кнопка подсвечивается. */
  open: boolean;
  onToggle: () => void;
};

export const SettingsTriggerButton: FC<SettingsTriggerButtonProps> = ({
  open,
  onToggle,
}) => (
  <div
    style={{
      // Та же chrome-зона, что и кнопка Prompts (DRW-191): сразу после
      // tldraw menu zone. Prompts сдвинут на left:356 — ⚙ стоит перед 💬.
      position: "absolute",
      top: 4,
      left: 320,
      zIndex: 301,
      pointerEvents: "auto",
      fontFamily: tokens.font.sans,
      fontSize: tokens.font.sm,
    }}
    // Unpinned-режим: window-pointerdown закрывает popover по клику вне него.
    // Без stopPropagation клик по ⚙ закрыл бы (window) и тут же переоткрыл
    // (onClick toggle) — кнопка «закрыть» не работала бы во floating-режиме.
    onPointerDown={(e) => e.stopPropagation()}
  >
    <button
      type="button"
      aria-label="Настройки"
      aria-pressed={open}
      data-role="settings-trigger"
      title="Настройки доски (⌘⇧P)"
      onClick={onToggle}
      style={{
        background: open ? tokens.color.hoverOverlay : tokens.color.bgOverlay,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.sm,
        padding: "4px 8px",
        cursor: "pointer",
        fontSize: tokens.font.sm,
      }}
    >
      ⚙
    </button>
  </div>
);
