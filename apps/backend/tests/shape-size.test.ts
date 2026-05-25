// Unit tests for shape-size helpers (DRW-168).

import { describe, expect, test } from "bun:test";
import {
  BASE_LEAF_H,
  BASE_LEAF_W,
  effectiveShapeBounds,
  sizeMultiplier,
} from "../src/domain/shape-size";

describe("sizeMultiplier", () => {
  test("s  → 0.85", () => expect(sizeMultiplier("s")).toBe(0.85));
  test("m  → 1.0", () => expect(sizeMultiplier("m")).toBe(1.0));
  test("l  → 1.3", () => expect(sizeMultiplier("l")).toBe(1.3));
  test("xl → 1.6", () => expect(sizeMultiplier("xl")).toBe(1.6));
  test("undefined → 1.0 (default)", () => expect(sizeMultiplier(undefined)).toBe(1.0));
  test("unknown string → 1.0 (default)", () => expect(sizeMultiplier("xxl")).toBe(1.0));
});

describe("effectiveShapeBounds", () => {
  const base = { x: 10, y: 20, w: 220, h: 80 };

  test("m: no change (returns baseBounds as-is, even if smaller than BASE)", () => {
    const r = { props: { size: "m" } };
    const small = { x: 5, y: 5, w: 100, h: 40 };
    const b = effectiveShapeBounds(r, small);
    expect(b.w).toBe(100);
    expect(b.h).toBe(40);
  });

  test("m: no change when w/h already at base", () => {
    const r = { props: { size: "m" } };
    const b = effectiveShapeBounds(r, base);
    expect(b.w).toBe(220);
    expect(b.h).toBe(80);
  });

  test("xl: grows to BASE * 1.6 when base matches default", () => {
    const r = { props: { size: "xl" } };
    const b = effectiveShapeBounds(r, base);
    expect(b.w).toBeCloseTo(BASE_LEAF_W * 1.6, 5);
    expect(b.h).toBeCloseTo(BASE_LEAF_H * 1.6, 5);
  });

  test("l: grows to BASE * 1.3 when base matches default", () => {
    const r = { props: { size: "l" } };
    const b = effectiveShapeBounds(r, base);
    expect(b.w).toBeCloseTo(BASE_LEAF_W * 1.3, 5);
    expect(b.h).toBeCloseTo(BASE_LEAF_H * 1.3, 5);
  });

  test("s: multiplier < 1 → returns baseBounds unchanged (no shrink, no grow)", () => {
    const r = { props: { size: "s" } };
    // mult=0.85 < 1.0 → passthrough; shape is NOT shrunk
    const b = effectiveShapeBounds(r, base);
    expect(b.w).toBe(base.w);
    expect(b.h).toBe(base.h);
  });

  test("xl: already-large user shape is NOT shrunk", () => {
    const r = { props: { size: "xl" } };
    const large = { x: 0, y: 0, w: 500, h: 200 };
    const b = effectiveShapeBounds(r, large);
    // 500 > 220*1.6=352 → stays at 500; 200 > 80*1.6=128 → stays at 200
    expect(b.w).toBe(500);
    expect(b.h).toBe(200);
  });

  test("x/y passthrough unchanged", () => {
    const r = { props: { size: "xl" } };
    const b = effectiveShapeBounds(r, base);
    expect(b.x).toBe(base.x);
    expect(b.y).toBe(base.y);
  });

  test("no props → default multiplier (1.0)", () => {
    const r = {};
    const b = effectiveShapeBounds(r, base);
    expect(b.w).toBe(220);
    expect(b.h).toBe(80);
  });
});
