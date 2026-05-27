// apps/frontend/src/settings/position.ts
import type { Anchor } from "./useSettingsTrigger";

type Size = { width: number; height: number };

/**
 * DRW-187: default-открытие popover'а в bottom-right углу viewport'а.
 * Stationary default упрощает muscle-memory; manual drag (userPos) overrides.
 * Anchor параметр ignored — оставлен в signature для backward compat сo вызовом.
 */
export function computePopoverPosition(input: {
  anchor: Anchor;
  popoverSize: Size;
  viewport: Size;
  margin: number;
}): { x: number; y: number } {
  const { popoverSize, viewport, margin } = input;
  return {
    x: Math.max(margin, viewport.width - popoverSize.width - margin),
    y: Math.max(margin, viewport.height - popoverSize.height - margin),
  };
}
