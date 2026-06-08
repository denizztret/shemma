import { describe, expect, test } from "bun:test";
import {
  computeRespreadLevel,
  levelMinK,
  type RespreadNode,
} from "./respread";

// Two boxes stacked vertically (100×100 each): a at top, b 300px below.
function stack(): RespreadNode[] {
  return [
    { id: "a", x: 0, y: 0, w: 100, h: 100, pinned: false },
    { id: "b", x: 0, y: 300, w: 100, h: 100, pinned: false },
  ];
}

function get(rows: ReadonlyArray<RespreadResultLike>, id: string): RespreadResultLike {
  const r = rows.find((n) => n.id === id);
  if (!r) throw new Error(`row ${id} not found`);
  return r;
}
type RespreadResultLike = { id: string; x: number; y: number };

describe("computeRespreadLevel", () => {
  test("spread (k>1) increases the gap; centre-distance scales by exactly k", () => {
    const r = computeRespreadLevel(stack(), 2, "min");
    const a = get(r, "a");
    const b = get(r, "b");
    // centre distance: orig 300 → 600
    expect(b.y + 50 - (a.y + 50)).toBeCloseTo(600, 6);
  });

  test("compress (k<1) decreases the gap", () => {
    const r = computeRespreadLevel(stack(), 0.5, "min");
    const a = get(r, "a");
    const b = get(r, "b");
    expect(b.y + 50 - (a.y + 50)).toBeCloseTo(150, 6);
  });

  test("min anchor keeps the content top-left fixed (drift-free)", () => {
    for (const k of [0.5, 1.5, 2]) {
      const r = computeRespreadLevel(stack(), k, "min");
      const a = get(r, "a");
      // 'a' is the top-left box → its top-left stays at the original (0,0)
      expect(a.x).toBeCloseTo(0, 6);
      expect(a.y).toBeCloseTo(0, 6);
    }
  });

  test("center anchor keeps the bbox centre fixed (symmetric spread)", () => {
    const before = stack();
    const r = computeRespreadLevel(before, 2, "center");
    const a = get(r, "a");
    const b = get(r, "b");
    // bbox centre y was (0+400)/2 = 200; must stay 200
    const newCentreY = (Math.min(a.y, b.y) + Math.max(a.y + 100, b.y + 100)) / 2;
    expect(newCentreY).toBeCloseTo(200, 6);
  });

  test("preserves structure: relative order is unchanged under spread and compress", () => {
    const nodes: RespreadNode[] = [
      { id: "a", x: 0, y: 0, w: 100, h: 60, pinned: false },
      { id: "b", x: 200, y: 0, w: 100, h: 60, pinned: false },
      { id: "c", x: 0, y: 200, w: 100, h: 60, pinned: false },
    ];
    for (const k of [0.5, 1.8]) {
      const r = computeRespreadLevel(nodes, k, "min");
      const a = get(r, "a");
      const b = get(r, "b");
      const c = get(r, "c");
      expect(a.x).toBeLessThan(b.x); // a left of b
      expect(a.y).toBeLessThan(c.y); // a above c
      expect(a.y).toBeCloseTo(b.y, 6); // same row
      expect(a.x).toBeCloseTo(c.x, 6); // same column
    }
  });

  test("pinned nodes are never moved and never returned", () => {
    const nodes: RespreadNode[] = [
      { id: "a", x: 0, y: 0, w: 100, h: 100, pinned: false },
      { id: "p", x: 0, y: 300, w: 100, h: 100, pinned: true },
    ];
    const r = computeRespreadLevel(nodes, 2, "min");
    expect(r.find((n) => n.id === "p")).toBeUndefined();
    // only 'a' moves; as the sole movable node it is its own bbox → stays put
    expect(get(r, "a").x).toBeCloseTo(0, 6);
    expect(get(r, "a").y).toBeCloseTo(0, 6);
  });
});

describe("levelMinK (min-gap guard)", () => {
  test("returns the exact floor where the binding pair hits minGap", () => {
    // two 100-wide boxes, centres 200 apart → at k, gap = 200k − 100.
    // gap = minGap(20) ⇒ 200k − 100 = 20 ⇒ k = 0.6
    const nodes: RespreadNode[] = [
      { id: "a", x: 0, y: 0, w: 100, h: 100, pinned: false },
      { id: "b", x: 200, y: 0, w: 100, h: 100, pinned: false },
    ];
    expect(levelMinK(nodes, 20)).toBeCloseTo(0.6, 6);
    // and at that k the gap is exactly minGap
    const r = computeRespreadLevel(nodes, 0.6, "min");
    const a = get(r, "a");
    const b = get(r, "b");
    expect(b.x - (a.x + 100)).toBeCloseTo(20, 6);
  });

  test("pairs already tighter than minGap only block compression (capped at 1, never force expansion)", () => {
    // centres 110 apart, 100-wide boxes → current gap 10 < minGap 20.
    const nodes: RespreadNode[] = [
      { id: "a", x: 0, y: 0, w: 100, h: 100, pinned: false },
      { id: "b", x: 110, y: 0, w: 100, h: 100, pinned: false },
    ];
    expect(levelMinK(nodes, 20)).toBe(1);
  });

  test("no constraint when boxes are far apart on one axis", () => {
    const nodes: RespreadNode[] = [
      { id: "a", x: 0, y: 0, w: 100, h: 100, pinned: false },
      { id: "b", x: 1000, y: 0, w: 100, h: 100, pinned: false },
    ];
    // floor well below 1 → compression allowed down to where the gap = minGap
    expect(levelMinK(nodes, 20)).toBeLessThan(0.2);
  });

  test("pinned nodes are ignored by the guard", () => {
    const nodes: RespreadNode[] = [
      { id: "a", x: 0, y: 0, w: 100, h: 100, pinned: true },
      { id: "p", x: 110, y: 0, w: 100, h: 100, pinned: true },
    ];
    expect(levelMinK(nodes, 20)).toBe(0);
  });
});
