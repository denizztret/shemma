// apps/frontend/src/settings/position.test.ts
import { describe, expect, test } from "bun:test";
import { computePopoverPosition } from "./position";

const VIEWPORT = { width: 1000, height: 800 };
const POPOVER = { width: 240, height: 220 };

describe("computePopoverPosition (DRW-188 top-left default under chrome)", () => {
  test("places popover at top-left of viewport with margin (no chrome offset)", () => {
    const pos = computePopoverPosition({
      anchor: { x: 100, y: 100, w: 200, h: 100 },
      popoverSize: POPOVER,
      viewport: VIEWPORT,
      margin: 16,
    });
    expect(pos).toEqual({ x: 16, y: 16 });
  });

  test("offsets by viewport.top/.left (canvas chrome offset)", () => {
    const pos = computePopoverPosition({
      anchor: { x: 0, y: 0 },
      popoverSize: POPOVER,
      viewport: { ...VIEWPORT, top: 56, left: 0 },
      margin: 16,
    });
    expect(pos).toEqual({ x: 16, y: 56 + 16 });
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

  test("uses custom margin", () => {
    const pos = computePopoverPosition({
      anchor: { x: 0, y: 0 },
      popoverSize: POPOVER,
      viewport: { ...VIEWPORT, top: 50 },
      margin: 32,
    });
    expect(pos).toEqual({ x: 32, y: 50 + 32 });
  });
});
