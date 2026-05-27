import { describe, expect, it } from "bun:test";
import { runLayout } from "../src/domain/layout";
import type { TLRecord, TLStoreSnapshot } from "../src/store-types";

// Task #0 (frame-container-direction-layout plan):
// Diagnostic baseline. Repro fixture for the "parent frame collapses when
// Tidy ⌘⇧L re-layouts a single container inside it" bug.
//
// Hypothesis from spec/plan: with containerScope='self' the backend
// runLayoutSubgraph already early-returns BEFORE Pass B (line ~877 in
// layout.ts), so the parent frame should NOT appear in batch.updated.
// If this test PASSES → bug is purely a frontend issue (tidy-layout.ts:41
// not threading scope), task #5 collapses to a regression suite.
// If it FAILS → there is a backend leak in Pass A/C writeback; task #5
// becomes a real backend fix.

describe("DRW: scope:'self' invariant — frame size preservation", () => {
  it("repro: scope:'self' + ids=[container inside frame] → batch must NOT contain frame props.w/h update", async () => {
    // Setup: outer tldraw frame containing a schema-container with 2 leaves.
    const store: TLStoreSnapshot = {
      schema: { schemaVersion: 1, storeVersion: 4, recordVersions: {} },
      store: {
        "document:document": {
          id: "document:document",
          typeName: "document",
        } as TLRecord,
        "page:page": { id: "page:page", typeName: "page" } as TLRecord,
        "shape:frameA": {
          id: "shape:frameA",
          typeName: "shape",
          type: "frame",
          parentId: "page:page",
          x: 0,
          y: 0,
          props: { w: 600, h: 400, name: "frame A", color: "black" },
          meta: {},
        } as TLRecord,
        "shape:container1": {
          id: "shape:container1",
          typeName: "shape",
          type: "schema-container",
          parentId: "shape:frameA",
          x: 20,
          y: 60,
          props: { w: 200, h: 200, direction: "TB" },
          meta: {},
        } as TLRecord,
        "shape:leaf1": {
          id: "shape:leaf1",
          typeName: "shape",
          type: "geo",
          parentId: "shape:container1",
          x: 10,
          y: 10,
          props: { w: 80, h: 40, geo: "rectangle" },
          meta: {},
        } as TLRecord,
        "shape:leaf2": {
          id: "shape:leaf2",
          typeName: "shape",
          type: "geo",
          parentId: "shape:container1",
          x: 100,
          y: 10,
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
        affectedIds: new Set(["shape:container1"]),
        containerScope: "self",
      },
      new Map(),
    );

    // ASSERTION: outer frame size MUST NOT be in batch.updated.
    // batch.updated is Record<id, [oldRec, newRec]> — undefined means
    // the frame was not touched by this layout pass (desired).
    const frameUpdate = result.batch.updated["shape:frameA"];
    expect(frameUpdate).toBeUndefined();
  });
});
