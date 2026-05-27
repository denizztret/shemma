// apps/frontend/src/settings/position.test.ts
import { describe, expect, test } from "bun:test";
import { computePopoverPosition } from "./position";

const VIEWPORT = { width: 1000, height: 800 };
const POPOVER = { width: 240, height: 220 };

describe("computePopoverPosition", () => {
  test("places under bbox with 8px offset by default", () => {
    const pos = computePopoverPosition({
      anchor: { x: 100, y: 100, w: 200, h: 100 },
      popoverSize: POPOVER,
      viewport: VIEWPORT,
      margin: 16,
    });
    expect(pos).toEqual({ x: 100, y: 100 + 100 + 8 });
  });

  test("flips above bbox when not enough vertical space below", () => {
    const pos = computePopoverPosition({
      anchor: { x: 100, y: 600, w: 200, h: 100 },
      popoverSize: POPOVER,
      viewport: VIEWPORT,
      margin: 16,
    });
    expect(pos.y).toBe(600 - 220 - 8);
  });

  test("clamps to right edge with margin", () => {
    const pos = computePopoverPosition({
      anchor: { x: 900, y: 100 },
      popoverSize: POPOVER,
      viewport: VIEWPORT,
      margin: 16,
    });
    expect(pos.x).toBeLessThanOrEqual(VIEWPORT.width - POPOVER.width - 16);
  });

  test("clamps to left edge with margin", () => {
    const pos = computePopoverPosition({
      anchor: { x: -50, y: 100 },
      popoverSize: POPOVER,
      viewport: VIEWPORT,
      margin: 16,
    });
    expect(pos.x).toBe(16);
  });

  test("board target — anchor at pointer with +12/+12 offset", () => {
    const pos = computePopoverPosition({
      anchor: { x: 200, y: 300 },
      popoverSize: POPOVER,
      viewport: VIEWPORT,
      margin: 16,
    });
    expect(pos).toEqual({ x: 200 + 12, y: 300 + 12 });
  });
});
