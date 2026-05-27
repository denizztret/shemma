import { describe, expect, it } from "bun:test";
import { runLayout } from "../src/domain/layout";
import type { TLRecord, TLStoreSnapshot } from "../src/store-types";

// Task #3 (frame-container-direction-layout plan):
// Per-anchor `meta.didrawLayoutParams` override в runLayoutSubgraph.
//
// Spec §4.3 invariants:
//   * Anchor container (frame OR schema-container) MAY carry
//     `meta.didrawLayoutParams: Partial<LayoutParams>` (e.g. `{ spacing: "compact" }`).
//   * `runLayoutSubgraph` reads override per-anchor и применяет ПОВЕРХ board params
//     ТОЛЬКО для subgraph этого anchor. Board defaults остаются для остальных.
//   * `Partial<LayoutParams> = undefined` → anchor inherits board defaults.
//   * Override применим симметрично для frame и schema-container.

describe("runLayoutSubgraph — per-anchor meta.didrawLayoutParams override", () => {
  // -----------------------------------------------------------------------
  // Case 1: frame1 override "compact" → tight spacing; frame2 без override
  // → board "loose" spacing. Расстояние leaves в frame1 строго меньше.
  // -----------------------------------------------------------------------
  it("case 1: per-frame override compact applies to subgraph; sibling frame inherits board loose", async () => {
    const store: TLStoreSnapshot = {
      schema: { schemaVersion: 1, storeVersion: 4, recordVersions: {} },
      store: {
        "document:document": { id: "document:document", typeName: "document" } as TLRecord,
        "page:page": { id: "page:page", typeName: "page" } as TLRecord,

        // frame1 with override { spacing: "compact" }
        "shape:frame1": {
          id: "shape:frame1",
          typeName: "shape",
          type: "frame",
          parentId: "page:page",
          x: 0,
          y: 0,
          props: { w: 600, h: 400, name: "f1", color: "black" },
          meta: { didrawLayoutParams: { spacing: "compact" } },
        } as TLRecord,
        "shape:f1leaf1": {
          id: "shape:f1leaf1",
          typeName: "shape",
          type: "geo",
          parentId: "shape:frame1",
          x: 0,
          y: 0,
          props: { w: 80, h: 40, geo: "rectangle" },
          meta: {},
        } as TLRecord,
        "shape:f1leaf2": {
          id: "shape:f1leaf2",
          typeName: "shape",
          type: "geo",
          parentId: "shape:frame1",
          x: 0,
          y: 0,
          props: { w: 80, h: 40, geo: "rectangle" },
          meta: {},
        } as TLRecord,
        "shape:f1arr": {
          id: "shape:f1arr",
          typeName: "shape",
          type: "arrow",
          parentId: "shape:frame1",
          x: 0,
          y: 0,
          props: {},
          meta: {},
        } as TLRecord,
        "binding:f1a": {
          id: "binding:f1a",
          typeName: "binding",
          fromId: "shape:f1arr",
          toId: "shape:f1leaf1",
          props: { terminal: "start" },
        } as TLRecord,
        "binding:f1b": {
          id: "binding:f1b",
          typeName: "binding",
          fromId: "shape:f1arr",
          toId: "shape:f1leaf2",
          props: { terminal: "end" },
        } as TLRecord,

        // frame2 NO override → inherits board defaults
        "shape:frame2": {
          id: "shape:frame2",
          typeName: "shape",
          type: "frame",
          parentId: "page:page",
          x: 1000,
          y: 0,
          props: { w: 600, h: 400, name: "f2", color: "black" },
          meta: {},
        } as TLRecord,
        "shape:f2leaf1": {
          id: "shape:f2leaf1",
          typeName: "shape",
          type: "geo",
          parentId: "shape:frame2",
          x: 0,
          y: 0,
          props: { w: 80, h: 40, geo: "rectangle" },
          meta: {},
        } as TLRecord,
        "shape:f2leaf2": {
          id: "shape:f2leaf2",
          typeName: "shape",
          type: "geo",
          parentId: "shape:frame2",
          x: 0,
          y: 0,
          props: { w: 80, h: 40, geo: "rectangle" },
          meta: {},
        } as TLRecord,
        "shape:f2arr": {
          id: "shape:f2arr",
          typeName: "shape",
          type: "arrow",
          parentId: "shape:frame2",
          x: 0,
          y: 0,
          props: {},
          meta: {},
        } as TLRecord,
        "binding:f2a": {
          id: "binding:f2a",
          typeName: "binding",
          fromId: "shape:f2arr",
          toId: "shape:f2leaf1",
          props: { terminal: "start" },
        } as TLRecord,
        "binding:f2b": {
          id: "binding:f2b",
          typeName: "binding",
          fromId: "shape:f2arr",
          toId: "shape:f2leaf2",
          props: { terminal: "end" },
        } as TLRecord,
      },
    };

    // Use scope=affected with explicit anchor ids — drives runLayoutSubgraph path
    // (scope='all' goes through buildElkGraph, where per-anchor override is not wired).
    const result = await runLayout(
      store,
      {
        mode: "layered-tb",
        scope: "affected",
        affectedIds: new Set(["shape:frame1", "shape:frame2"]),
        containerScope: "auto",
        spacing: "loose",
      },
      new Map(),
    );

    const u1a = result.batch.updated["shape:f1leaf1"];
    const u1b = result.batch.updated["shape:f1leaf2"];
    const u2a = result.batch.updated["shape:f2leaf1"];
    const u2b = result.batch.updated["shape:f2leaf2"];
    expect(u1a).toBeDefined();
    expect(u1b).toBeDefined();
    expect(u2a).toBeDefined();
    expect(u2b).toBeDefined();

    const p1a = u1a![1] as { x: number; y: number };
    const p1b = u1b![1] as { x: number; y: number };
    const p2a = u2a![1] as { x: number; y: number };
    const p2b = u2b![1] as { x: number; y: number };

    // TB direction → leaves stacked vertically → measure Δy.
    const dyF1 = Math.abs(p1a.y - p1b.y);
    const dyF2 = Math.abs(p2a.y - p2b.y);

    // frame1 (compact) gap must be strictly smaller than frame2 (loose).
    expect(dyF1).toBeLessThan(dyF2);
  });

  // -----------------------------------------------------------------------
  // Case 2: meta.didrawLayoutParams === undefined → anchor inherits board defaults.
  // Same layout as case 1 frame2 alone, with explicit board "compact". Confirms
  // that absence of override yields full board-level spacing.
  // -----------------------------------------------------------------------
  it("case 2: no override → anchor inherits board defaults (compact board → compact subgraph)", async () => {
    const store: TLStoreSnapshot = {
      schema: { schemaVersion: 1, storeVersion: 4, recordVersions: {} },
      store: {
        "document:document": { id: "document:document", typeName: "document" } as TLRecord,
        "page:page": { id: "page:page", typeName: "page" } as TLRecord,
        "shape:plainFrame": {
          id: "shape:plainFrame",
          typeName: "shape",
          type: "frame",
          parentId: "page:page",
          x: 0,
          y: 0,
          props: { w: 600, h: 400, name: "plain", color: "black" },
          meta: {},
        } as TLRecord,
        "shape:plainLeaf1": {
          id: "shape:plainLeaf1",
          typeName: "shape",
          type: "geo",
          parentId: "shape:plainFrame",
          x: 0,
          y: 0,
          props: { w: 80, h: 40, geo: "rectangle" },
          meta: {},
        } as TLRecord,
        "shape:plainLeaf2": {
          id: "shape:plainLeaf2",
          typeName: "shape",
          type: "geo",
          parentId: "shape:plainFrame",
          x: 0,
          y: 0,
          props: { w: 80, h: 40, geo: "rectangle" },
          meta: {},
        } as TLRecord,
        "shape:plainArr": {
          id: "shape:plainArr",
          typeName: "shape",
          type: "arrow",
          parentId: "shape:plainFrame",
          x: 0,
          y: 0,
          props: {},
          meta: {},
        } as TLRecord,
        "binding:plainA": {
          id: "binding:plainA",
          typeName: "binding",
          fromId: "shape:plainArr",
          toId: "shape:plainLeaf1",
          props: { terminal: "start" },
        } as TLRecord,
        "binding:plainB": {
          id: "binding:plainB",
          typeName: "binding",
          fromId: "shape:plainArr",
          toId: "shape:plainLeaf2",
          props: { terminal: "end" },
        } as TLRecord,
      },
    };

    // Board: compact. No override on the frame.
    const compactResult = await runLayout(
      store,
      {
        mode: "layered-tb",
        scope: "affected",
        affectedIds: new Set(["shape:plainFrame"]),
        containerScope: "auto",
        spacing: "compact",
      },
      new Map(),
    );

    // Board: loose. Same frame. Without override the spacing must differ from
    // compact → confirms board defaults reach the anchor through paramsForAnchor.
    const looseResult = await runLayout(
      store,
      {
        mode: "layered-tb",
        scope: "affected",
        affectedIds: new Set(["shape:plainFrame"]),
        containerScope: "auto",
        spacing: "loose",
      },
      new Map(),
    );

    const compactA = compactResult.batch.updated["shape:plainLeaf1"]?.[1] as { x: number; y: number };
    const compactB = compactResult.batch.updated["shape:plainLeaf2"]?.[1] as { x: number; y: number };
    const looseA = looseResult.batch.updated["shape:plainLeaf1"]?.[1] as { x: number; y: number };
    const looseB = looseResult.batch.updated["shape:plainLeaf2"]?.[1] as { x: number; y: number };
    expect(compactA).toBeDefined();
    expect(compactB).toBeDefined();
    expect(looseA).toBeDefined();
    expect(looseB).toBeDefined();

    const dyCompact = Math.abs(compactA.y - compactB.y);
    const dyLoose = Math.abs(looseA.y - looseB.y);

    // No override → board defaults applied → loose > compact.
    expect(dyCompact).toBeLessThan(dyLoose);
  });

  // -----------------------------------------------------------------------
  // Case 3: schema-container с override применяется аналогично frame'у.
  // Спека section 4.3: "anchor container (frame OR schema-container)".
  // -----------------------------------------------------------------------
  it("case 3: schema-container with override applies its own spacing", async () => {
    const buildStore = (
      override: { spacing?: "compact" | "normal" | "loose" } | undefined,
    ): TLStoreSnapshot => ({
      schema: { schemaVersion: 1, storeVersion: 4, recordVersions: {} },
      store: {
        "document:document": { id: "document:document", typeName: "document" } as TLRecord,
        "page:page": { id: "page:page", typeName: "page" } as TLRecord,
        "shape:container": {
          id: "shape:container",
          typeName: "shape",
          type: "schema-container",
          parentId: "page:page",
          x: 0,
          y: 0,
          props: { w: 600, h: 400, direction: "TB" },
          meta: override === undefined ? {} : { didrawLayoutParams: override },
        } as TLRecord,
        "shape:scLeaf1": {
          id: "shape:scLeaf1",
          typeName: "shape",
          type: "geo",
          parentId: "shape:container",
          x: 0,
          y: 0,
          props: { w: 80, h: 40, geo: "rectangle" },
          meta: {},
        } as TLRecord,
        "shape:scLeaf2": {
          id: "shape:scLeaf2",
          typeName: "shape",
          type: "geo",
          parentId: "shape:container",
          x: 0,
          y: 0,
          props: { w: 80, h: 40, geo: "rectangle" },
          meta: {},
        } as TLRecord,
        "shape:scArr": {
          id: "shape:scArr",
          typeName: "shape",
          type: "arrow",
          parentId: "shape:container",
          x: 0,
          y: 0,
          props: {},
          meta: {},
        } as TLRecord,
        "binding:scA": {
          id: "binding:scA",
          typeName: "binding",
          fromId: "shape:scArr",
          toId: "shape:scLeaf1",
          props: { terminal: "start" },
        } as TLRecord,
        "binding:scB": {
          id: "binding:scB",
          typeName: "binding",
          fromId: "shape:scArr",
          toId: "shape:scLeaf2",
          props: { terminal: "end" },
        } as TLRecord,
      },
    });

    // schema-container with override "loose"; board defaults compact.
    const withOverride = await runLayout(
      buildStore({ spacing: "loose" }),
      {
        mode: "layered-tb",
        scope: "affected",
        affectedIds: new Set(["shape:container"]),
        containerScope: "auto",
        spacing: "compact",
      },
      new Map(),
    );

    // Same schema-container WITHOUT override; board defaults still compact.
    const withoutOverride = await runLayout(
      buildStore(undefined),
      {
        mode: "layered-tb",
        scope: "affected",
        affectedIds: new Set(["shape:container"]),
        containerScope: "auto",
        spacing: "compact",
      },
      new Map(),
    );

    const overA = withOverride.batch.updated["shape:scLeaf1"]?.[1] as { x: number; y: number };
    const overB = withOverride.batch.updated["shape:scLeaf2"]?.[1] as { x: number; y: number };
    const noA = withoutOverride.batch.updated["shape:scLeaf1"]?.[1] as { x: number; y: number };
    const noB = withoutOverride.batch.updated["shape:scLeaf2"]?.[1] as { x: number; y: number };
    expect(overA).toBeDefined();
    expect(overB).toBeDefined();
    expect(noA).toBeDefined();
    expect(noB).toBeDefined();

    const dyOver = Math.abs(overA.y - overB.y);
    const dyNo = Math.abs(noA.y - noB.y);

    // Override "loose" beats board "compact" → distance strictly larger.
    expect(dyOver).toBeGreaterThan(dyNo);
  });
});
