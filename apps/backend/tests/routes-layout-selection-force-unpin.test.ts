import { describe, expect, test } from "bun:test";
import { runLayout } from "../src/domain/layout";
import { applyStoreChanges, rebuildDidrawIndex } from "../src/store-ops";
import type { TLRecord, TLStoreSnapshot } from "../src/store-types";

function emptySnapshot(): TLStoreSnapshot {
  return {
    schema: { schemaVersion: 1, storeVersion: 4, recordVersions: {} },
    store: {
      "document:document": { id: "document:document", typeName: "document" } as TLRecord,
      "page:page": { id: "page:page", typeName: "page" } as TLRecord,
    },
  };
}

function makeShape(
  id: string,
  x: number,
  y: number,
  name: string,
  extraMeta: Record<string, unknown> = {},
): TLRecord {
  return {
    id,
    typeName: "shape",
    type: "geo",
    x,
    y,
    parentId: "page:page",
    props: { w: 120, h: 60, geo: "rectangle" },
    meta: { didrawName: name, ...extraMeta },
  } as TLRecord;
}

function snapshotWithShapes(records: TLRecord[]): TLStoreSnapshot {
  const s = emptySnapshot();
  for (const r of records) s.store[r.id] = r;
  return s;
}

describe("runLayout forceUnpin", () => {
  test("default — pinned shape keeps position", async () => {
    const fixed = makeShape("shape:fixed", 500, 500, "fixed", {
      pinned: true,
      position: { x: 500, y: 500 },
    });
    const mobile = makeShape("shape:mobile", 10, 10, "mobile");
    const s = snapshotWithShapes([fixed, mobile]);
    const idx = rebuildDidrawIndex(s);
    const r = await runLayout(s, { mode: "layered-lr", scope: "all" }, idx);
    const next = applyStoreChanges(s, r.batch);
    const fixedAfter = next.store["shape:fixed"]!;
    expect(fixedAfter.x).toBe(500);
    expect(fixedAfter.y).toBe(500);
    expect(fixedAfter.meta?.pinned).toBe(true);
  });

  test("forceUnpin=true — pinned shape position overridden once, flag preserved", async () => {
    const fixed = makeShape("shape:fixed", 500, 500, "fixed", {
      pinned: true,
      position: { x: 500, y: 500 },
    });
    const mobile = makeShape("shape:mobile", 10, 10, "mobile");
    const s = snapshotWithShapes([fixed, mobile]);
    const idx = rebuildDidrawIndex(s);
    const r = await runLayout(s, { mode: "layered-lr", scope: "all", forceUnpin: true }, idx);
    const next = applyStoreChanges(s, r.batch);
    const fixedAfter = next.store["shape:fixed"]!;
    expect(fixedAfter.x === 500 && fixedAfter.y === 500).toBe(false);
    expect(fixedAfter.meta?.pinned).toBe(true);
  });
});
