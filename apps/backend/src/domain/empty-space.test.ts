import { describe, expect, test } from "bun:test";
import { findEmptySlot, computeExpansion } from "./empty-space";

describe("findEmptySlot", () => {
  test("empty parent returns a center-biased slot", () => {
    const slot = findEmptySlot(
      { w: 400, h: 300 },
      [],
      { w: 100, h: 50 },
      10,
    );
    expect(slot).toBeDefined();
    // The center-biased pick should be roughly in the middle.
    expect(slot!.x).toBeGreaterThan(100);
    expect(slot!.x).toBeLessThan(200);
    expect(slot!.y).toBeGreaterThan(100);
    expect(slot!.y).toBeLessThan(150);
  });

  test("avoids occupied region with padding", () => {
    const occ = { x: 50, y: 50, w: 200, h: 100 };
    const slot = findEmptySlot(
      { w: 400, h: 300 },
      [occ],
      { w: 100, h: 50 },
      10,
    );
    expect(slot).toBeDefined();
    const overlap =
      slot!.x + 100 + 10 > occ.x &&
      occ.x + occ.w + 10 > slot!.x &&
      slot!.y + 50 + 10 > occ.y &&
      occ.y + occ.h + 10 > slot!.y;
    expect(overlap).toBe(false);
  });

  test("returns null when no space fits", () => {
    const slot = findEmptySlot(
      { w: 100, h: 100 },
      [{ x: 0, y: 0, w: 100, h: 100 }],
      { w: 100, h: 100 },
      10,
    );
    expect(slot).toBeNull();
  });

  test("size larger than parent → null", () => {
    const slot = findEmptySlot(
      { w: 100, h: 100 },
      [],
      { w: 200, h: 100 },
      10,
    );
    expect(slot).toBeNull();
  });

  test("multiple occupants, finds gap", () => {
    // Parent 400x300; two occupants on left and right; gap in middle
    const slot = findEmptySlot(
      { w: 400, h: 300 },
      [
        { x: 0, y: 100, w: 100, h: 60 },
        { x: 300, y: 100, w: 100, h: 60 },
      ],
      { w: 80, h: 40 },
      10,
    );
    expect(slot).toBeDefined();
    expect(slot!.x).toBeGreaterThanOrEqual(110);
    expect(slot!.x + 80 + 10).toBeLessThanOrEqual(300);
  });
});

describe("computeExpansion", () => {
  test("LR direction expands width to the right", () => {
    const e = computeExpansion(
      { w: 400, h: 300 },
      { w: 120, h: 60 },
      20,
      "LR",
    );
    expect(e.dw).toBeGreaterThan(0);
    expect(e.dh).toBe(0);
    expect(e.position.x).toBeGreaterThanOrEqual(400);
    expect(e.position.x + 120 + 20).toBeLessThanOrEqual(400 + e.dw);
  });

  test("TB direction expands height to the bottom", () => {
    const e = computeExpansion(
      { w: 400, h: 300 },
      { w: 120, h: 60 },
      20,
      "TB",
    );
    expect(e.dh).toBeGreaterThan(0);
    expect(e.dw).toBe(0);
    expect(e.position.y).toBeGreaterThanOrEqual(300);
    expect(e.position.y + 60 + 20).toBeLessThanOrEqual(300 + e.dh);
  });

  test("expansion delta accommodates size + 2*padding", () => {
    const e = computeExpansion(
      { w: 400, h: 300 },
      { w: 100, h: 60 },
      20,
      "LR",
    );
    expect(e.dw).toBe(100 + 2 * 20);
  });
});
