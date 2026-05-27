import { describe, expect, it } from "bun:test";
import { runLayout } from "../src/domain/layout";
import type { TLRecord, TLStoreSnapshot } from "../src/store-types";

// Task #2 (frame-container-direction-layout plan):
// Backend frame direction support.
//
// Spec §4.1 invariants:
//   * native tldraw `frame` shape MAY carry `meta.didrawDirection`
//     (TB/BT/LR/RL/custom);
//   * `readContainerDirection` must honour it (same mapping as schema-container);
//   * `isCustomDirection` must return true for frame with didrawDirection='custom';
//   * `inferContainerDirections` (DRW-178) must NOT touch frames — meta on
//     frame is user-set only, never auto-inferred.

describe("frame meta.didrawDirection — backend layout support", () => {
  it("case 1: frame с meta.didrawDirection='LR' → ELK layouts children горизонтально", async () => {
    const store: TLStoreSnapshot = {
      schema: { schemaVersion: 1, storeVersion: 4, recordVersions: {} },
      store: {
        "document:document": { id: "document:document", typeName: "document" } as TLRecord,
        "page:page": { id: "page:page", typeName: "page" } as TLRecord,
        "shape:frameLR": {
          id: "shape:frameLR",
          typeName: "shape",
          type: "frame",
          parentId: "page:page",
          x: 0,
          y: 0,
          props: { w: 600, h: 400, name: "frame LR", color: "black" },
          meta: { didrawDirection: "LR" },
        } as TLRecord,
        "shape:leaf1": {
          id: "shape:leaf1",
          typeName: "shape",
          type: "geo",
          parentId: "shape:frameLR",
          x: 10,
          y: 10,
          props: { w: 80, h: 40, geo: "rectangle" },
          meta: {},
        } as TLRecord,
        "shape:leaf2": {
          id: "shape:leaf2",
          typeName: "shape",
          type: "geo",
          parentId: "shape:frameLR",
          x: 10,
          y: 100,
          props: { w: 80, h: 40, geo: "rectangle" },
          meta: {},
        } as TLRecord,
        // Arrow leaf1 → leaf2 so ELK has an edge and arranges them along
        // the requested direction instead of stacking at origin.
        "shape:arr": {
          id: "shape:arr",
          typeName: "shape",
          type: "arrow",
          parentId: "shape:frameLR",
          x: 0,
          y: 0,
          props: {},
          meta: {},
        } as TLRecord,
        "binding:1": {
          id: "binding:1",
          typeName: "binding",
          fromId: "shape:arr",
          toId: "shape:leaf1",
          props: { terminal: "start" },
        } as TLRecord,
        "binding:2": {
          id: "binding:2",
          typeName: "binding",
          fromId: "shape:arr",
          toId: "shape:leaf2",
          props: { terminal: "end" },
        } as TLRecord,
      },
    };

    const result = await runLayout(
      store,
      {
        mode: "layered-tb",
        scope: "affected",
        affectedIds: new Set(["shape:frameLR"]),
        containerScope: "self",
      },
      new Map(),
    );

    // After LR layout, leaf1 and leaf2 should be spaced horizontally
    // (significant Δx). Without frame-direction support, the request would
    // fall back to the outer mode (TB) and produce vertical stacking.
    const u1 = result.batch.updated["shape:leaf1"];
    const u2 = result.batch.updated["shape:leaf2"];
    expect(u1).toBeDefined();
    expect(u2).toBeDefined();
    const newLeaf1 = u1![1] as { x: number; y: number };
    const newLeaf2 = u2![1] as { x: number; y: number };
    const dx = Math.abs(newLeaf1.x - newLeaf2.x);
    expect(dx).toBeGreaterThan(40);
  });

  it("case 2: frame с meta.didrawDirection='custom' → children positions preserved", async () => {
    const store: TLStoreSnapshot = {
      schema: { schemaVersion: 1, storeVersion: 4, recordVersions: {} },
      store: {
        "document:document": { id: "document:document", typeName: "document" } as TLRecord,
        "page:page": { id: "page:page", typeName: "page" } as TLRecord,
        "shape:frameCustom": {
          id: "shape:frameCustom",
          typeName: "shape",
          type: "frame",
          parentId: "page:page",
          x: 0,
          y: 0,
          props: { w: 600, h: 400, name: "frame custom", color: "black" },
          meta: { didrawDirection: "custom" },
        } as TLRecord,
        "shape:leafA": {
          id: "shape:leafA",
          typeName: "shape",
          type: "geo",
          parentId: "shape:frameCustom",
          x: 47,
          y: 83,
          props: { w: 80, h: 40, geo: "rectangle" },
          meta: {},
        } as TLRecord,
        "shape:leafB": {
          id: "shape:leafB",
          typeName: "shape",
          type: "geo",
          parentId: "shape:frameCustom",
          x: 210,
          y: 250,
          props: { w: 80, h: 40, geo: "rectangle" },
          meta: {},
        } as TLRecord,
      },
    };

    const result = await runLayout(
      store,
      {
        mode: "layered-tb",
        scope: "affected",
        affectedIds: new Set(["shape:frameCustom"]),
        containerScope: "self",
      },
      new Map(),
    );

    // Custom direction → Pass A skips this container; child positions
    // must not appear in batch.updated (or if present, must match originals).
    const uA = result.batch.updated["shape:leafA"];
    const uB = result.batch.updated["shape:leafB"];
    if (uA) {
      const newA = uA[1] as { x: number; y: number };
      expect(newA.x).toBe(47);
      expect(newA.y).toBe(83);
    }
    if (uB) {
      const newB = uB[1] as { x: number; y: number };
      expect(newB.x).toBe(210);
      expect(newB.y).toBe(250);
    }
  });

  it("case 3: frame НЕ участвует в DRW-178 auto-direction inference", async () => {
    // Setup: frame with 2 leaves connected by an arrow + an external shape on
    // page connected to one leaf. inferContainerDirections would normally
    // assign meta.didrawDirection based on external edges; for frame we expect
    // NO write.
    const store: TLStoreSnapshot = {
      schema: { schemaVersion: 1, storeVersion: 4, recordVersions: {} },
      store: {
        "document:document": { id: "document:document", typeName: "document" } as TLRecord,
        "page:page": { id: "page:page", typeName: "page" } as TLRecord,
        "shape:frameNoDir": {
          id: "shape:frameNoDir",
          typeName: "shape",
          type: "frame",
          parentId: "page:page",
          x: 200,
          y: 0,
          props: { w: 600, h: 400, name: "frame no dir", color: "black" },
          // No meta.didrawDirection — eligible for inference IF frame qualified.
          meta: {},
        } as TLRecord,
        "shape:inner1": {
          id: "shape:inner1",
          typeName: "shape",
          type: "geo",
          parentId: "shape:frameNoDir",
          x: 20,
          y: 30,
          props: { w: 80, h: 40, geo: "rectangle" },
          meta: {},
        } as TLRecord,
        "shape:inner2": {
          id: "shape:inner2",
          typeName: "shape",
          type: "geo",
          parentId: "shape:frameNoDir",
          x: 200,
          y: 30,
          props: { w: 80, h: 40, geo: "rectangle" },
          meta: {},
        } as TLRecord,
        "shape:external": {
          id: "shape:external",
          typeName: "shape",
          type: "geo",
          parentId: "page:page",
          x: 0,
          y: 50,
          props: { w: 80, h: 40, geo: "rectangle" },
          meta: {},
        } as TLRecord,
        // Arrow: external → inner1 (creates an external edge into the frame).
        "shape:arrExternal": {
          id: "shape:arrExternal",
          typeName: "shape",
          type: "arrow",
          parentId: "page:page",
          x: 0,
          y: 0,
          props: {},
          meta: {},
        } as TLRecord,
        "binding:e1": {
          id: "binding:e1",
          typeName: "binding",
          fromId: "shape:arrExternal",
          toId: "shape:external",
          props: { terminal: "start" },
        } as TLRecord,
        "binding:e2": {
          id: "binding:e2",
          typeName: "binding",
          fromId: "shape:arrExternal",
          toId: "shape:inner1",
          props: { terminal: "end" },
        } as TLRecord,
      },
    };

    const result = await runLayout(
      store,
      {
        mode: "layered-tb",
        scope: "all",
      },
      new Map(),
      { autoDirectionEnabled: true },
    );

    // The frame must NOT receive an inferred direction.
    const frameUpdate = result.batch.updated["shape:frameNoDir"];
    if (frameUpdate) {
      const newFrame = frameUpdate[1] as { meta?: Record<string, unknown> };
      expect(newFrame.meta?.didrawDirection).toBeUndefined();
    }
  });
});
