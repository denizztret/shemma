// apps/frontend/src/settings/position.test.ts
import { describe, expect, test } from "bun:test";
import { computePopoverPosition } from "./position";

const VIEWPORT = { width: 1000, height: 800 };
const POPOVER = { width: 240, height: 220 };

describe("computePopoverPosition (DRW-187 bottom-right default)", () => {
  test("places popover at bottom-right of viewport with margin", () => {
    const pos = computePopoverPosition({
      anchor: { x: 100, y: 100, w: 200, h: 100 },
      popoverSize: POPOVER,
      viewport: VIEWPORT,
      margin: 16,
    });
    expect(pos).toEqual({
      x: VIEWPORT.width - POPOVER.width - 16,
      y: VIEWPORT.height - POPOVER.height - 16,
    });
  });

  test("ignores anchor location (stationary default)", () => {
    const p1 = computePopoverPosition({
      anchor: { x: 0, y: 0 },
      popoverSize: POPOVER,
      viewport: VIEWPORT,
      margin: 16,
    });
    const p2 = computePopoverPosition({
      anchor: { x: 500, y: 500, w: 200, h: 100 },
      popoverSize: POPOVER,
      viewport: VIEWPORT,
      margin: 16,
    });
    expect(p1).toEqual(p2);
  });

  test("clamps to margin when popover larger than viewport", () => {
    const big = { width: 2000, height: 1600 };
    const pos = computePopoverPosition({
      anchor: { x: 0, y: 0 },
      popoverSize: big,
      viewport: VIEWPORT,
      margin: 16,
    });
    expect(pos.x).toBe(16);
    expect(pos.y).toBe(16);
  });

  test("uses custom margin", () => {
    const pos = computePopoverPosition({
      anchor: { x: 0, y: 0 },
      popoverSize: POPOVER,
      viewport: VIEWPORT,
      margin: 32,
    });
    expect(pos).toEqual({
      x: VIEWPORT.width - POPOVER.width - 32,
      y: VIEWPORT.height - POPOVER.height - 32,
    });
  });
});
