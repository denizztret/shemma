import { describe, expect, test } from "bun:test";
import type { NodeId, OverlayEntry } from "@shemma/domain";
import {
  GC_KEEP_GENERATIONS,
  GC_MIN_ORPHANS,
  gcOverlays,
} from "./overlay-gc";

function overlays(
  entries: Record<string, OverlayEntry>,
): Record<NodeId, OverlayEntry> {
  return entries as Record<NodeId, OverlayEntry>;
}

function mkOrphans(
  count: number,
  deadGen: number | undefined,
): Record<NodeId, OverlayEntry> {
  const out: Record<string, OverlayEntry> = {};
  for (let i = 0; i < count; i++) {
    out[`dead-${i}`] = deadGen === undefined ? { color: "red" } : { color: "red", deadGen };
  }
  return out as Record<NodeId, OverlayEntry>;
}

describe("gcOverlays", () => {
  test("increments generation each pass", () => {
    const r = gcOverlays(overlays({}), new Set<NodeId>(), 5);
    expect(r.gen).toBe(6);
  });

  test("live entries keep their data and lose any deadGen", () => {
    const ov = overlays({
      a: { color: "blue", deadGen: 3 },
      b: { position: { x: 1, y: 2 } },
    });
    const r = gcOverlays(ov, new Set<NodeId>(["a", "b"] as NodeId[]), 10);
    expect(r.overlays.a).toEqual({ color: "blue" });
    expect(r.overlays.b).toEqual({ position: { x: 1, y: 2 } });
    expect(r.collected).toBe(0);
  });

  test("fresh orphan gets deadGen = current gen", () => {
    const ov = overlays({ x: { color: "red" } });
    const r = gcOverlays(ov, new Set<NodeId>(), 7);
    expect(r.overlays.x?.deadGen).toBe(8);
    expect(r.collected).toBe(0);
  });

  test("orphan below threshold is NEVER collected (keep-dead)", () => {
    // few orphans, very old — but count < GC_MIN_ORPHANS
    const ov = mkOrphans(3, 1);
    const r = gcOverlays(ov, new Set<NodeId>(), 1000);
    expect(Object.keys(r.overlays)).toHaveLength(3);
    expect(r.collected).toBe(0);
  });

  test("recent orphan above threshold is kept (re-add window)", () => {
    // many orphans but young (gen - deadGen < KEEP)
    const prevGen = 100;
    const ov = mkOrphans(GC_MIN_ORPHANS + 10, prevGen); // deadGen == prevGen
    const live = new Set<NodeId>(["live-1"] as NodeId[]);
    const r = gcOverlays({ ...ov, "live-1": { color: "green" } }, live, prevGen);
    // gen = 101, age = 101 - 100 = 1 < KEEP → kept
    expect(r.collected).toBe(0);
    expect(Object.keys(r.overlays).length).toBe(GC_MIN_ORPHANS + 10 + 1);
  });

  test("old orphans above threshold ARE collected", () => {
    const ov = mkOrphans(GC_MIN_ORPHANS + 10, 1); // deadGen = 1 (very old)
    const live = new Set<NodeId>(["live-1"] as NodeId[]);
    const prevGen = 500;
    const r = gcOverlays({ ...ov, "live-1": { color: "green" } }, live, prevGen);
    // gen = 501, age = 500 >= KEEP, orphans (60) > 2*1 && >= MIN → collected
    expect(r.collected).toBe(GC_MIN_ORPHANS + 10);
    // only the live entry survives
    expect(Object.keys(r.overlays)).toEqual(["live-1"]);
  });

  test("re-added node (now live) is NOT collected even when old", () => {
    const ov = mkOrphans(GC_MIN_ORPHANS + 10, 1);
    // re-add one of the dead nodes → it becomes live
    const revived = "dead-0" as NodeId;
    const live = new Set<NodeId>([revived]);
    const r = gcOverlays(ov, live, 500);
    expect(r.overlays[revived]).toBeDefined();
    expect(r.overlays[revived]?.deadGen).toBeUndefined();
  });

  test("collection threshold scales with live node count", () => {
    // 60 orphans, 40 live → 60 > 2*40=80 is FALSE → not collected despite age
    const ov = mkOrphans(60, 1);
    const live = new Set<NodeId>(
      Array.from({ length: 40 }, (_, i) => `live-${i}` as NodeId),
    );
    const r = gcOverlays(ov, live, 500);
    expect(r.collected).toBe(0);
    expect(Object.keys(r.overlays)).toHaveLength(60);
  });

  test("GC_KEEP_GENERATIONS is a positive integer", () => {
    expect(GC_KEEP_GENERATIONS).toBeGreaterThan(0);
    expect(Number.isInteger(GC_KEEP_GENERATIONS)).toBe(true);
  });
});
