// apps/frontend/src/chrome/ChromeButton.tsx
//
// DRW-206/217 (приёмка): единый стиль кнопок верхней chrome-зоны доски
// (⚙ настройки, 🌓 тема, 💬 prompts). Один размер, один вид — чтобы кнопки
// не разъезжались по стилю/высоте. Иконочные кнопки квадратные; кнопка с
// доп. контентом (Prompts со счётчиком) тянется по ширине, сохраняя высоту.

import type { CSSProperties, FC, ReactNode } from "react";
import { tokens } from "../design-tokens";

// Шаг раскладки кнопок в шапке (left): ⚙ 320 → 🌓 356 → 💬 392.
export const CHROME_BUTTON_STEP = 36;
const CHROME_BUTTON_SIZE = 28;

/** Единый стиль chrome-кнопки — переиспользуется компонентами, которым нужен
 *  собственный wrapper (PromptDrawer: кнопка и drawer делят одну позицию). */
export function chromeButtonStyle(active?: boolean): CSSProperties {
  return {
    boxSizing: "border-box",
    height: CHROME_BUTTON_SIZE,
    minWidth: CHROME_BUTTON_SIZE,
    padding: "0 7px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    background: active ? tokens.color.hoverOverlay : tokens.color.bgOverlay,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.md,
    color: tokens.color.text,
    fontSize: 15,
    lineHeight: 1,
    cursor: "pointer",
  };
}

export type ChromeButtonProps = {
  /** Абсолютная X-позиция в chrome-зоне (top фиксирован). */
  left: number;
  children: ReactNode;
  onClick: () => void;
  ariaLabel: string;
  title?: string;
  /** Активное состояние (панель открыта) — лёгкая подсветка фона. */
  active?: boolean;
  /** aria-pressed для toggle-кнопок. */
  pressed?: boolean;
  dataRole?: string;
  /** pointerdown stopPropagation — нужен кнопкам поверх popover (settings). */
  stopPointerDown?: boolean;
};

export const ChromeButton: FC<ChromeButtonProps> = ({
  left,
  children,
  onClick,
  ariaLabel,
  title,
  active,
  pressed,
  dataRole,
  stopPointerDown,
}) => {
  const wrapperStyle: CSSProperties = {
    position: "absolute",
    top: 4,
    left,
    zIndex: 301,
    pointerEvents: "auto",
    fontFamily: tokens.font.sans,
  };
  return (
    <div
      style={wrapperStyle}
      onPointerDown={
        stopPointerDown ? (e) => e.stopPropagation() : undefined
      }
    >
      <button
        type="button"
        aria-label={ariaLabel}
        aria-pressed={pressed}
        data-role={dataRole}
        title={title}
        onClick={onClick}
        style={chromeButtonStyle(active)}
      >
        {children}
      </button>
    </div>
  );
};
