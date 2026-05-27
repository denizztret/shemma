// apps/frontend/src/settings/position.ts
import type { Anchor } from "./useSettingsTrigger";

type Size = { width: number; height: number };

export function computePopoverPosition(input: {
  anchor: Anchor;
  popoverSize: Size;
  viewport: Size;
  margin: number;
}): { x: number; y: number } {
  const { anchor, popoverSize, viewport, margin } = input;
  const isPoint = anchor.w === undefined || anchor.h === undefined;

  let x: number;
  let y: number;

  if (isPoint) {
    x = anchor.x + 12;
    y = anchor.y + 12;
  } else {
    x = anchor.x;
    const below = anchor.y + (anchor.h ?? 0) + 8;
    if (below + popoverSize.height <= viewport.height - margin) {
      y = below;
    } else {
      y = anchor.y - popoverSize.height - 8;
    }
  }

  const maxX = viewport.width - popoverSize.width - margin;
  const maxY = viewport.height - popoverSize.height - margin;
  x = Math.max(margin, Math.min(x, maxX));
  y = Math.max(margin, Math.min(y, maxY));

  return { x, y };
}
