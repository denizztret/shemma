import { describe, expect, test } from "bun:test";
import type { TLRecord, TLStoreSnapshot } from "../store-types";
import { placeNewFreeShapes } from "./place-free";

function geo(
  id: string,
  x: number,
  y: number,
  w = 220,
  h = 80,
  parentId = "page:page",
): TLRecord {
  return {
    id,
    typeName: "shape",
    type: "geo",
    x,
    y,
    parentId,
    index: "a1",
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: { w, h, growY: 0 },
    meta: {},
  } as TLRecord;
}

function note(id: string, x: number, y: number): TLRecord {
  return {
    id,
    typeName: "shape",
    type: "note",
    x,
    y,
    parentId: "page:page",
    index: "a1",
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: { growY: 0 },
    meta: {},
  } as TLRecord;
}

function frame(id: string, x: number, y: number, w = 400, h = 300): TLRecord {
  return {
    id,
    typeName: "shape",
    type: "frame",
    x,
    y,
    parentId: "page:page",
    index: "a1",
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: { w, h },
    meta: {},
  } as TLRecord;
}

function arrow(id: string): TLRecord {
  return {
    id,
    typeName: "shape",
    type: "arrow",
    x: 0,
    y: 0,
    parentId: "page:page",
    index: "a1",
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: { start: { x: 0, y: 0 }, end: { x: 0, y: 0 } },
    meta: {},
  } as TLRecord;
}

function storeOf(...recs: TLRecord[]): TLStoreSnapshot {
  const store: Record<string, TLRecord> = {};
  for (const r of recs) store[r.id] = r;
  return { store } as unknown as TLStoreSnapshot;
}

type Box = { x: number; y: number; w: number; h: number };

function boxOf(r: TLRecord): Box {
  const rec = r as {
    x: number;
    y: number;
    type?: string;
    props?: Record<string, unknown>;
  };
  const p = rec.props ?? {};
  const w = rec.type === "note" ? 200 : (p.w as number);
  const h =
    rec.type === "note"
      ? 200
      : (p.h as number) + ((p.growY as number | undefined) ?? 0);
  return { x: rec.x, y: rec.y, w, h };
}

function overlaps(a: Box, b: Box): boolean {
  return !(
    a.x + a.w <= b.x ||
    b.x + b.w <= a.x ||
    a.y + a.h <= b.y ||
    b.y + b.h <= a.y
  );
}

function add(...recs: TLRecord[]): Record<string, TLRecord> {
  const m: Record<string, TLRecord> = {};
  for (const r of recs) m[r.id] = r;
  return m;
}

describe("DRW-223 placeNewFreeShapes — page-level smart-insert for free shapes", () => {
  test("first shape into an empty page → placed at (0,0)", () => {
    const n1 = geo("shape:n1", 0, 0);
    placeNewFreeShapes(storeOf(), add(n1));
    expect((n1 as { x: number }).x).toBe(0);
    expect((n1 as { y: number }).y).toBe(0);
  });

  test("new shape does NOT stack on an existing shape at (0,0)", () => {
    const existing = geo("shape:old", 0, 0);
    const nw = geo("shape:new", 0, 0);
    placeNewFreeShapes(storeOf(existing), add(nw));
    expect(overlaps(boxOf(nw), boxOf(existing))).toBe(false);
  });

  test("two new shapes in one batch don't overlap each other", () => {
    const a = geo("shape:a", 0, 0);
    const b = geo("shape:b", 0, 0);
    placeNewFreeShapes(storeOf(), add(a, b));
    expect(overlaps(boxOf(a), boxOf(b))).toBe(false);
  });

  test("new shape avoids an existing schema-frame (v2 room occupant)", () => {
    const existingFrame = frame("shape:f1", 0, 0, 600, 400);
    const nw = geo("shape:new", 0, 0);
    placeNewFreeShapes(storeOf(existingFrame), add(nw));
    expect(overlaps(boxOf(nw), boxOf(existingFrame))).toBe(false);
  });

  test("notes are placed too (don't stack at origin)", () => {
    const existing = note("shape:on", 0, 0);
    const nn = note("shape:nn", 0, 0);
    placeNewFreeShapes(storeOf(existing), add(nn));
    expect(overlaps(boxOf(nn), boxOf(existing))).toBe(false);
  });

  test("arrows are left untouched (no bbox / bound geometry)", () => {
    const arr = arrow("shape:arr");
    placeNewFreeShapes(storeOf(geo("shape:old", 0, 0)), add(arr));
    expect((arr as { x: number }).x).toBe(0);
    expect((arr as { y: number }).y).toBe(0);
  });

  test("five separate single-shape inserts never pile (regression for the bug)", () => {
    // Simulate the agent pattern: 5 sequential single-define POSTs. Each call
    // sees the prior shapes already in the store.
    const store = storeOf();
    const placed: TLRecord[] = [];
    for (let i = 0; i < 5; i++) {
      const rec = geo(`shape:s${i}`, 0, 0);
      placeNewFreeShapes(store, add(rec));
      placed.push(rec);
      (store as { store: Record<string, TLRecord> }).store[rec.id] = rec;
    }
    // No two of the five overlap.
    for (const [i, pi] of placed.entries()) {
      for (const pj of placed.slice(i + 1)) {
        expect(overlaps(boxOf(pi), boxOf(pj))).toBe(false);
      }
    }
  });
});
