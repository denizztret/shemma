// apps/frontend/src/settings/position.ts
import type { Anchor } from "./useSettingsTrigger";

type Size = { width: number; height: number };
type Viewport = Size & { top?: number; left?: number };

/**
 * DRW-188: default-открытие popover'а в top-left углу canvas viewport'а.
 * `viewport.top` / `viewport.left` — screen-coord offset до canvas-области
 * (под chrome toolbar'ом tldraw). Берётся из `editor.getViewportScreenBounds()`.
 * Manual drag (userPos) overrides; close+reopen возвращается к top-left default.
 * Anchor parameter ignored — оставлен в signature для backward compat.
 */
export function computePopoverPosition(input: {
  anchor: Anchor;
  popoverSize: Size;
  viewport: Viewport;
  margin: number;
}): { x: number; y: number } {
  const { popoverSize, viewport, margin } = input;
  const left = viewport.left ?? 0;
  const top = viewport.top ?? 0;
  return {
    x: Math.max(margin, left + margin),
    y: Math.max(margin, top + margin),
  };
}
