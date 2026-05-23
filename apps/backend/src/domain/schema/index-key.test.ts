/**
 * DRW-141 — index-key helper tests.
 */
import { describe, expect, test } from "bun:test";
import { assignBatchIndices } from "./index-key";
import type { StoreChangeBatch, TLRecord } from "../../store-types";

function shape(id: string, parentId: string): TLRecord {
  return {
    id,
    typeName: "shape",
    type: "geo",
    parentId,
    x: 0,
    y: 0,
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: {},
    meta: {},
    index: "a1",
  } as TLRecord;
}

describe("assignBatchIndices", () => {
  test("empty batch — no-op", () => {
    const batch: StoreChangeBatch = { added: {}, updated: {}, removed: {} };
    assignBatchIndices(batch, {});
    expect(Object.keys(batch.added)).toHaveLength(0);
  });

  test("single child — gets a000 (no existing siblings)", () => {
    const batch: StoreChangeBatch = {
      added: { "shape:a": shape("shape:a", "shape:frame") },
      updated: {},
      removed: {},
    };
    assignBatchIndices(batch, {});
    expect((batch.added["shape:a"] as { index: string }).index).toBe("a000z");
  });

  test("multiple children — get a000, a001, a002 ... in insertion order", () => {
    const batch: StoreChangeBatch = {
      added: {
        "shape:a": shape("shape:a", "shape:frame"),
        "shape:b": shape("shape:b", "shape:frame"),
        "shape:c": shape("shape:c", "shape:frame"),
      },
      updated: {},
      removed: {},
    };
    assignBatchIndices(batch, {});
    expect((batch.added["shape:a"] as { index: string }).index).toBe("a000z");
    expect((batch.added["shape:b"] as { index: string }).index).toBe("a001z");
    expect((batch.added["shape:c"] as { index: string }).index).toBe("a002z");
  });

  test("indices are unique within parent (no `a1 >= a1` collision)", () => {
    const batch: StoreChangeBatch = {
      added: {
        "shape:1": shape("shape:1", "shape:frame"),
        "shape:2": shape("shape:2", "shape:frame"),
        "shape:3": shape("shape:3", "shape:frame"),
        "shape:4": shape("shape:4", "shape:frame"),
        "shape:5": shape("shape:5", "shape:frame"),
      },
      updated: {},
      removed: {},
    };
    assignBatchIndices(batch, {});
    const indices = Object.values(batch.added).map((r) => (r as { index: string }).index);
    expect(new Set(indices).size).toBe(5);
  });

  test("siblings in different parents get independent ranges", () => {
    const batch: StoreChangeBatch = {
      added: {
        "shape:a1": shape("shape:a1", "shape:frameA"),
        "shape:a2": shape("shape:a2", "shape:frameA"),
        "shape:b1": shape("shape:b1", "shape:frameB"),
      },
      updated: {},
      removed: {},
    };
    assignBatchIndices(batch, {});
    expect((batch.added["shape:a1"] as { index: string }).index).toBe("a000z");
    expect((batch.added["shape:a2"] as { index: string }).index).toBe("a001z");
    expect((batch.added["shape:b1"] as { index: string }).index).toBe("a000z");
  });

  test("appends after existing siblings — finds max prior index + 1", () => {
    const priorStore: Record<string, TLRecord | undefined> = {
      "shape:existing1": { ...shape("shape:existing1", "shape:frame"), index: "a005z" } as TLRecord,
      "shape:existing2": { ...shape("shape:existing2", "shape:frame"), index: "a00fz" } as TLRecord,
    };
    const batch: StoreChangeBatch = {
      added: { "shape:new": shape("shape:new", "shape:frame") },
      updated: {},
      removed: {},
    };
    assignBatchIndices(batch, priorStore);
    // a00f = 15 in base36; next is 16 = "g" in base36 → "a00gz" (with z suffix).
    expect((batch.added["shape:new"] as { index: string }).index).toBe("a00gz");
  });

  test("ignores prior siblings in OTHER parents when finding max", () => {
    const priorStore: Record<string, TLRecord | undefined> = {
      "shape:other": { ...shape("shape:other", "shape:otherFrame"), index: "a0zz" } as TLRecord,
    };
    const batch: StoreChangeBatch = {
      added: { "shape:new": shape("shape:new", "shape:frame") },
      updated: {},
      removed: {},
    };
    assignBatchIndices(batch, priorStore);
    // No prior siblings in shape:frame — start at a000z, not after a0zz.
    expect((batch.added["shape:new"] as { index: string }).index).toBe("a000z");
  });

  test("non-shape records are skipped (bindings)", () => {
    const batch: StoreChangeBatch = {
      added: {
        "binding:b1": {
          id: "binding:b1",
          typeName: "binding",
          type: "arrow",
          fromId: "shape:x",
          toId: "shape:y",
          props: {},
          meta: {},
        } as unknown as TLRecord,
        "shape:s1": shape("shape:s1", "shape:frame"),
      },
      updated: {},
      removed: {},
    };
    assignBatchIndices(batch, {});
    expect((batch.added["shape:s1"] as { index: string }).index).toBe("a000z");
    // binding records have no .index field — leave them alone
    expect((batch.added["binding:b1"] as Record<string, unknown>).index).toBeUndefined();
  });

  test("ignores tldraw native long fractional indices (a4q9xb6V etc.) in priorStore — does not overflow", () => {
    // Real-world scenario: room contains shapes with tldraw native fractional indices
    // (e.g. from tldraw editor.duplicateShapes). Regex must NOT parse them as huge numbers.
    const priorStore: Record<string, TLRecord | undefined> = {
      "shape:native1": { ...shape("shape:native1", "shape:frame"), index: "a4q9xb6V" } as TLRecord,
      "shape:native2": { ...shape("shape:native2", "shape:frame"), index: "a12H3CjQV" } as TLRecord,
      "shape:native3": { ...shape("shape:native3", "shape:frame"), index: "a1KppmMO" } as TLRecord,
    };
    const batch: StoreChangeBatch = {
      added: {
        "shape:new1": shape("shape:new1", "shape:frame"),
        "shape:new2": shape("shape:new2", "shape:frame"),
      },
      updated: {},
      removed: {},
    };
    // Must NOT throw "too many siblings" — native long indices should be ignored
    expect(() => assignBatchIndices(batch, priorStore)).not.toThrow();
    // New shapes start from a000 (long native indices are unrecognized, maxOrdinal stays 0)
    expect((batch.added["shape:new1"] as { index: string }).index).toBe("a000z");
    expect((batch.added["shape:new2"] as { index: string }).index).toBe("a001z");
  });

  test("lexicographic order matches numeric order (sortable)", () => {
    const batch: StoreChangeBatch = {
      added: {},
      updated: {},
      removed: {},
    };
    // Add 50 siblings — verify their assigned indices sort lexicographically
    // in the same order they were added (i.e. fixed-width padding works).
    for (let i = 0; i < 50; i++) {
      batch.added[`shape:n${i}`] = shape(`shape:n${i}`, "shape:frame");
    }
    assignBatchIndices(batch, {});
    const pairs = Array.from({ length: 50 }, (_, i) => ({
      i,
      idx: (batch.added[`shape:n${i}`] as { index: string }).index,
    }));
    const sorted = [...pairs].sort((a, b) => (a.idx < b.idx ? -1 : a.idx > b.idx ? 1 : 0));
    expect(sorted.map((p) => p.i)).toEqual(pairs.map((p) => p.i));
  });
});
