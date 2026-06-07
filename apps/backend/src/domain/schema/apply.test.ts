/**
 * Tests для schema apply engine (DRW-134 Task 2.4 — apply.ts).
 * 13+ cases per plan acceptance.
 */

import { describe, test, expect } from "bun:test";
import { applySchemaActions, estimateEffectiveHeight } from "./apply";
import type { ApplyResult } from "./apply";
import type { RoomState } from "../../types";
import type { TLRecord } from "../../store-types";
import type { SchemaAction } from "@shemma/domain";

// ---- Test helpers ----

/** Builds a minimal RoomState for testing. */
function makeRoom(extraStore: Record<string, TLRecord> = {}): RoomState {
  return {
    store: {
      schema: { schemaVersion: 1, storeVersion: 1, recordVersions: {} },
      store: {
        "page:page": {
          id: "page:page",
          typeName: "page",
        } as TLRecord,
        ...extraStore,
      },
    },
    opLog: [],
    prompts: [],
    version: 1,
    dirty: false,
    lastTouched: Date.now(),
    didrawIndex: new Map(),
  };
}

/** Builds a minimal schema-frame TLRecord. */
function makeFrame(
  frameId: string,
  mermaidSource: string,
  overlays: Record<string, unknown> = {},
  extraMeta: Record<string, unknown> = {},
): TLRecord {
  return {
    id: frameId,
    typeName: "shape",
    type: "frame",
    x: 0,
    y: 0,
    parentId: "page:page",
    index: "a1",
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: { w: 640, h: 480, name: "Test Frame" },
    meta: {
      didrawSchemaFrame: true,
      didrawProtocol: "v2",
      schemaProtocolVersion: "1.0",
      mermaidSource,
      didrawOverlays: overlays,
      ...extraMeta,
    },
  } as TLRecord;
}

/** Builds a minimal child shape representing a schema node. */
function makeChildShape(
  shapeId: string,
  nodeId: string,
  label: string,
  frameId: string,
): TLRecord {
  return {
    id: shapeId,
    typeName: "shape",
    type: "geo",
    x: 0,
    y: 0,
    parentId: frameId,
    index: "a1",
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: {
      w: 220,
      h: 80,
      geo: "rectangle",
      color: "blue",
      richText: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: label }] }],
      },
    },
    meta: {
      didrawId: nodeId,
      didrawLabel: label,
      didrawSchemaParent: frameId,
    },
  } as TLRecord;
}

const SUFFIX_LEN = 6;

// ---- Tests ----

describe("applySchemaActions (DRW-134 Task 2.4)", () => {
  // ---------- Happy path ----------

  test("Empty frame + schema-define → 1 added node, RAW contains declaration", () => {
    const frame = makeFrame("shape:frame1", "");
    const room = makeRoom({ "shape:frame1": frame });

    const actions: SchemaAction[] = [
      {
        kind: "schema-define",
        nodeId: "api-aaaaaa",
        role: "service",
        label: "API",
      },
    ];

    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.addedNodeIds).toHaveLength(1);
    expect(result.addedNodeIds[0]).toBe("api-aaaaaa");
    expect(result.newRaw).toContain("api-aaaaaa");
    expect(Object.keys(result.batch.added)).toHaveLength(1);
    expect(result.destructiveScore).toBe(0);
    expect(result.orphanedOverlays).toBe(0);
  });

  test("schema-define without nodeId → backend generates valid nodeId", () => {
    const frame = makeFrame("shape:frame1", "");
    const room = makeRoom({ "shape:frame1": frame });

    const actions: SchemaAction[] = [
      { kind: "schema-define", role: "service", label: "API Gateway" },
    ];

    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.addedNodeIds).toHaveLength(1);
    const generatedId = result.addedNodeIds[0]!;
    // Should be like "api-gateway-xxxxxx"
    expect(generatedId).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-z]{6}$/);
    expect(result.newRaw).toContain(generatedId);
  });

  test("Batch of 5 valid actions → all applied atomically", () => {
    const frame = makeFrame("shape:frame1", "");
    const room = makeRoom({ "shape:frame1": frame });

    const actions: SchemaAction[] = [
      { kind: "schema-define", nodeId: "api-aaaaaa", role: "service", label: "API" },
      { kind: "schema-define", nodeId: "db-bbbbbb", role: "datastore", label: "Database" },
      { kind: "schema-define", nodeId: "cache-cccccc", role: "service", label: "Cache" },
      { kind: "schema-connect", from: "api-aaaaaa", to: "db-bbbbbb", connectionKind: "sync" },
      { kind: "schema-connect", from: "api-aaaaaa", to: "cache-cccccc", connectionKind: "dep" },
    ];

    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.addedNodeIds).toHaveLength(3);
    expect(result.newRaw).toContain("api-aaaaaa");
    expect(result.newRaw).toContain("db-bbbbbb");
    expect(result.newRaw).toContain("cache-cccccc");
    // 3 geo shapes + 2 arrows + 4 bindings = 9 added records
    expect(Object.keys(result.batch.added).length).toBeGreaterThanOrEqual(3);
  });

  test("schema-connect to a node nested inside a schema-container materializes the arrow", () => {
    // Repro for the silent edge-drop bug: an endpoint that lives inside a
    // subgraph (tldraw parent = schema-container, not the frame) must still
    // resolve to its shape so the arrow + bindings get created.
    const raw = [
      "graph LR",
      "  outer-bbbbbb[Outer]",
      "  subgraph c1 [Container]",
      "    inner-aaaaaa[Inner]",
      "  end",
    ].join("\n");
    const frame = makeFrame("shape:frame1", raw);

    // Container is a direct child of the frame.
    const container = {
      id: "shape:cont1",
      typeName: "shape",
      type: "schema-container",
      x: 0,
      y: 0,
      parentId: "shape:frame1",
      index: "a1",
      isLocked: false,
      opacity: 1,
      rotation: 0,
      props: { w: 300, h: 200 },
      meta: {},
    } as TLRecord;
    // Inner node is parented to the CONTAINER, not the frame.
    const inner = makeChildShape("shape:inner1", "inner-aaaaaa", "Inner", "shape:cont1");
    // Outer node is a direct frame child.
    const outer = makeChildShape("shape:outer1", "outer-bbbbbb", "Outer", "shape:frame1");

    const room = makeRoom({
      "shape:frame1": frame,
      "shape:cont1": container,
      "shape:inner1": inner,
      "shape:outer1": outer,
    });

    const actions: SchemaAction[] = [
      { kind: "schema-connect", from: "inner-aaaaaa", to: "outer-bbbbbb", connectionKind: "sync" },
    ];

    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // biome-ignore lint/suspicious/noExplicitAny: TLRecord union — test introspection
    const added = Object.values(result.batch.added) as any[];
    const arrowShapes = added.filter((r) => r.typeName === "shape" && r.type === "arrow");
    const bindings = added.filter((r) => r.typeName === "binding" && r.type === "arrow");

    expect(arrowShapes).toHaveLength(1);
    expect(bindings).toHaveLength(2);
    // Both endpoints must be bound — including the container-nested one.
    expect(bindings.some((b) => b.toId === "shape:inner1")).toBe(true);
    expect(bindings.some((b) => b.toId === "shape:outer1")).toBe(true);
  });

  test("schema-connect creates elbow arrows (parity with imported schema arrows)", () => {
    // DRW-205 AC#6: incremental arrows must match the imported ones
    // (compile.ts emits kind:"elbow"); arc arrows look alien on a schema.
    const frame = makeFrame("shape:frame1", "");
    const room = makeRoom({ "shape:frame1": frame });

    const actions: SchemaAction[] = [
      { kind: "schema-define", nodeId: "api-aaaaaa", role: "service", label: "API" },
      { kind: "schema-define", nodeId: "db-bbbbbb", role: "datastore", label: "Database" },
      { kind: "schema-connect", from: "api-aaaaaa", to: "db-bbbbbb", connectionKind: "sync" },
    ];

    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // biome-ignore lint/suspicious/noExplicitAny: TLRecord union — test introspection
    const added = Object.values(result.batch.added) as any[];
    const arrowShapes = added.filter((r) => r.typeName === "shape" && r.type === "arrow");
    expect(arrowShapes).toHaveLength(1);
    expect(arrowShapes[0].props.kind).toBe("elbow");
  });

  // ---------- Container-aware resolver edge-cases (DRW-205, этап 5) ----------

  test("schema-connect resolves a node nested TWO container levels deep", () => {
    const raw = [
      "graph LR",
      "  outer-bbbbbb[Outer]",
      "  deep-aaaaaa[Deep]",
    ].join("\n");
    const frame = makeFrame("shape:frame1", raw);

    const mkContainer = (id: string, parentId: string): TLRecord =>
      ({
        id,
        typeName: "shape",
        type: "schema-container",
        x: 0,
        y: 0,
        parentId,
        index: "a1",
        isLocked: false,
        opacity: 1,
        rotation: 0,
        props: { w: 300, h: 200 },
        meta: {},
      }) as TLRecord;
    const c1 = mkContainer("shape:c1", "shape:frame1");
    const c2 = mkContainer("shape:c2", "shape:c1");
    const deep = makeChildShape("shape:deep1", "deep-aaaaaa", "Deep", "shape:c2");
    const outer = makeChildShape("shape:outer1", "outer-bbbbbb", "Outer", "shape:frame1");

    const room = makeRoom({
      "shape:frame1": frame,
      "shape:c1": c1,
      "shape:c2": c2,
      "shape:deep1": deep,
      "shape:outer1": outer,
    });

    const actions: SchemaAction[] = [
      { kind: "schema-connect", from: "deep-aaaaaa", to: "outer-bbbbbb", connectionKind: "sync" },
    ];
    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // biome-ignore lint/suspicious/noExplicitAny: TLRecord union — test introspection
    const added = Object.values(result.batch.added) as any[];
    const bindings = added.filter((r) => r.typeName === "binding" && r.type === "arrow");
    expect(bindings).toHaveLength(2);
    expect(bindings.some((b) => b.toId === "shape:deep1")).toBe(true);
    expect(bindings.some((b) => b.toId === "shape:outer1")).toBe(true);
  });

  test("schema-connect to a node from ANOTHER frame is rejected, not silently dropped", () => {
    const frame1 = makeFrame("shape:frame1", "graph LR\n  here-aaaaaa[Here]");
    const frame2 = makeFrame("shape:frame2", "graph LR\n  there-bbbbbb[There]");
    const here = makeChildShape("shape:here1", "here-aaaaaa", "Here", "shape:frame1");
    const there = makeChildShape("shape:there1", "there-bbbbbb", "There", "shape:frame2");
    const room = makeRoom({
      "shape:frame1": frame1,
      "shape:frame2": frame2,
      "shape:here1": here,
      "shape:there1": there,
    });

    const actions: SchemaAction[] = [
      { kind: "schema-connect", from: "here-aaaaaa", to: "there-bbbbbb", connectionKind: "sync" },
    ];
    const result = applySchemaActions({ room, frame: frame1, actions, suffixLen: SUFFIX_LEN });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.code === "unknown-node")).toBe(true);
  });

  test("schema-disconnect removes the arrow + bindings of a container-nested endpoint", () => {
    const raw = [
      "graph LR",
      "  outer-bbbbbb[Outer]",
      "  subgraph c1 [Container]",
      "    inner-aaaaaa[Inner]",
      "  end",
      "  inner-aaaaaa --> outer-bbbbbb",
    ].join("\n");
    const frame = makeFrame("shape:frame1", raw);
    const container = {
      id: "shape:cont1",
      typeName: "shape",
      type: "schema-container",
      x: 0,
      y: 0,
      parentId: "shape:frame1",
      index: "a1",
      isLocked: false,
      opacity: 1,
      rotation: 0,
      props: { w: 300, h: 200 },
      meta: {},
    } as TLRecord;
    const inner = makeChildShape("shape:inner1", "inner-aaaaaa", "Inner", "shape:cont1");
    const outer = makeChildShape("shape:outer1", "outer-bbbbbb", "Outer", "shape:frame1");
    const arrow = {
      id: "shape:arrow1",
      typeName: "shape",
      type: "arrow",
      x: 0,
      y: 0,
      parentId: "shape:frame1",
      index: "a1",
      isLocked: false,
      opacity: 1,
      rotation: 0,
      props: {},
      meta: {},
    } as TLRecord;
    const mkBinding = (id: string, terminal: "start" | "end", toId: string): TLRecord =>
      ({
        id,
        typeName: "binding",
        type: "arrow",
        fromId: "shape:arrow1",
        toId,
        props: { terminal },
        meta: {},
      }) as TLRecord;
    const room = makeRoom({
      "shape:frame1": frame,
      "shape:cont1": container,
      "shape:inner1": inner,
      "shape:outer1": outer,
      "shape:arrow1": arrow,
      "binding:b1": mkBinding("binding:b1", "start", "shape:inner1"),
      "binding:b2": mkBinding("binding:b2", "end", "shape:outer1"),
    });

    const actions: SchemaAction[] = [
      { kind: "schema-disconnect", from: "inner-aaaaaa", to: "outer-bbbbbb" },
    ];
    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.batch.removed["shape:arrow1"]).toBeDefined();
    expect(result.batch.removed["binding:b1"]).toBeDefined();
    expect(result.batch.removed["binding:b2"]).toBeDefined();
  });

  // ---------- Smart-insert placement (DRW-178 wiring) ----------

  test("schema-define places the new node in free space, not overlapping existing children", () => {
    const raw = "graph LR\n  existing-aaaaaa[Existing]";
    const frame = { ...makeFrame("shape:frame1", raw), props: { w: 600, h: 300, name: "T" } } as TLRecord;
    const existing = {
      ...makeChildShape("shape:ex1", "existing-aaaaaa", "Existing", "shape:frame1"),
      x: 20,
      y: 20,
    } as TLRecord;
    const room = makeRoom({ "shape:frame1": frame, "shape:ex1": existing });

    const actions: SchemaAction[] = [
      { kind: "schema-define", nodeId: "new-bbbbbb", role: "service", label: "New" },
    ];
    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // biome-ignore lint/suspicious/noExplicitAny: TLRecord union — test introspection
    const newShape = Object.values(result.batch.added).find(
      (r) => (r as any).typeName === "shape" && (r as any).meta?.didrawId === "new-bbbbbb",
    ) as any;
    expect(newShape).toBeDefined();
    const nx = newShape.x as number;
    const ny = newShape.y as number;
    const nw = newShape.props.w as number;
    const nh = newShape.props.h as number;
    // Must NOT overlap the existing node at (20,20,220,80).
    const overlaps = nx < 20 + 220 && 20 < nx + nw && ny < 20 + 80 && 20 < ny + nh;
    expect(overlaps).toBe(false);
  });

  test("schema-define grows the frame when no free slot fits", () => {
    const raw = "graph TB\n  existing-aaaaaa[Existing]";
    const frame = { ...makeFrame("shape:frame1", raw), props: { w: 260, h: 120, name: "T" } } as TLRecord;
    const existing = {
      ...makeChildShape("shape:ex1", "existing-aaaaaa", "Existing", "shape:frame1"),
      x: 20,
      y: 20,
    } as TLRecord;
    const room = makeRoom({ "shape:frame1": frame, "shape:ex1": existing });

    const actions: SchemaAction[] = [
      { kind: "schema-define", nodeId: "new-bbbbbb", role: "service", label: "New" },
    ];
    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const frameUpd = result.batch.updated["shape:frame1"];
    expect(frameUpd).toBeDefined();
    // biome-ignore lint/suspicious/noExplicitAny: TLRecord union — test introspection
    const grown = frameUpd![1] as any;
    const grewW = (grown.props.w as number) > 260;
    const grewH = (grown.props.h as number) > 120;
    expect(grewW || grewH).toBe(true);
  });

  // ---------- Smart-insert: text-growth aware sizing (DRW-205) ----------

  test("estimateEffectiveHeight: wrapping labels get extra height, short labels keep base", () => {
    // Calibrated against live tldraw renders (S2/S3 verification rooms):
    // "Alert Queue" in a 140-wide queue box rendered 91.4px tall (h50+growY41.4).
    expect(estimateEffectiveHeight("Alert Queue", 140, 50)).toBeGreaterThanOrEqual(92);
    // 4-line label rendered 150.8px tall in a 220-wide box.
    expect(
      estimateEffectiveHeight("Observability & Distributed Tracing Platform", 220, 80),
    ).toBeGreaterThanOrEqual(151);
    // 3-line label in a queue box rendered ~133px tall (S6-BT live repro).
    expect(estimateEffectiveHeight("Dead Letter Queue", 140, 50)).toBeGreaterThanOrEqual(133);
    // Single-line labels must not inflate — placement density stays unchanged.
    expect(estimateEffectiveHeight("Ingress", 220, 80)).toBe(80);
    expect(estimateEffectiveHeight("Metrics", 220, 80)).toBe(80);
  });

  test("smart-insert avoids occupants grown by text (growY) — S2 overlap repro", () => {
    // Existing child declares h=80 but tldraw grew it by growY=300 to fit text.
    // The band below its NOMINAL bottom is free, but its EFFECTIVE bottom
    // reaches y=404 — placing there overlaps the rendered shape.
    const raw = "graph TB\n  existing-aaaaaa[Existing]";
    const frame = { ...makeFrame("shape:frame1", raw), props: { w: 640, h: 480, name: "T" } } as TLRecord;
    const existing = {
      ...makeChildShape("shape:ex1", "existing-aaaaaa", "Existing", "shape:frame1"),
      x: 24,
      y: 24,
    } as TLRecord;
    // biome-ignore lint/suspicious/noExplicitAny: TLRecord union — test setup
    (existing as any).props = { ...(existing as any).props, w: 572, growY: 300 };
    const room = makeRoom({ "shape:frame1": frame, "shape:ex1": existing });

    const actions: SchemaAction[] = [
      { kind: "schema-define", nodeId: "new-bbbbbb", role: "service", label: "New" },
    ];
    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // biome-ignore lint/suspicious/noExplicitAny: TLRecord union — test introspection
    const added = Object.values(result.batch.added) as any[];
    const newShape = added.find((r) => r.typeName === "shape" && r.meta?.didrawId === "new-bbbbbb");
    expect(newShape).toBeDefined();
    const nx = newShape.x as number;
    const ny = newShape.y as number;
    const nw = newShape.props.w as number;
    const nh = newShape.props.h as number;
    // Effective occupant rect: (24,24,572,80+300).
    const ix = Math.min(nx + nw, 24 + 572) - Math.max(nx, 24);
    const iy = Math.min(ny + nh, 24 + 380) - Math.max(ny, 24);
    expect(ix <= 0 || iy <= 0).toBe(true);
  });

  test("smart-insert reserves wrap height for the new node's own label — grows frame instead of squeezing", () => {
    // Empty frame 640x146: a nominal queue box (140x50) fits (24+50+24=98),
    // but "Alert Queue" wraps to 2 lines and renders ~91px tall — the
    // estimated box must NOT fit, forcing frame expansion.
    const frame = { ...makeFrame("shape:frame1", ""), props: { w: 640, h: 146, name: "T" } } as TLRecord;
    const room = makeRoom({ "shape:frame1": frame });

    const actions: SchemaAction[] = [
      { kind: "schema-define", nodeId: "alerts-bbbbbb", role: "queue", label: "Alert Queue" },
    ];
    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const frameUpd = result.batch.updated["shape:frame1"];
    expect(frameUpd).toBeDefined();
    if (!frameUpd) return;
    // biome-ignore lint/suspicious/noExplicitAny: TLRecord union — test introspection
    const grown = frameUpd[1] as any;
    expect((grown.props.h as number) > 146 || (grown.props.w as number) > 640).toBe(true);
  });

  test("smart-insert places a connected node near its linked neighbor, not at frame center", () => {
    // Wide frame, single existing node at the far RIGHT. A new node connected
    // to it must land near that neighbor — not in the geometric center.
    const raw = "graph LR\n  right-aaaaaa[Right]";
    const frame = { ...makeFrame("shape:frame1", raw), props: { w: 1600, h: 400, name: "T" } } as TLRecord;
    const right = {
      ...makeChildShape("shape:r1", "right-aaaaaa", "Right", "shape:frame1"),
      x: 1340,
      y: 160,
    } as TLRecord;
    const room = makeRoom({ "shape:frame1": frame, "shape:r1": right });

    const actions: SchemaAction[] = [
      { kind: "schema-define", nodeId: "new-bbbbbb", role: "service", label: "New" },
      { kind: "schema-connect", from: "right-aaaaaa", to: "new-bbbbbb", connectionKind: "sync" },
    ];
    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // biome-ignore lint/suspicious/noExplicitAny: TLRecord union — test introspection
    const added = Object.values(result.batch.added) as any[];
    const newShape = added.find((r) => r.typeName === "shape" && r.meta?.didrawId === "new-bbbbbb");
    expect(newShape).toBeDefined();
    // Slot center must be pulled towards the neighbor at x≈1450 — the
    // unbiased center pick lands at x≈804 (measured).
    expect((newShape.x as number) + (newShape.props.w as number) / 2).toBeGreaterThan(1000);
  });

  // ---------- set-overlay repaints existing shapes (DRW-205 acceptance gap) ----------

  test("schema-set-overlay color repaints the existing shape", () => {
    const raw = "graph LR\n  node-aaaaaa[Node]";
    const frame = makeFrame("shape:frame1", raw);
    const node = makeChildShape("shape:n1", "node-aaaaaa", "Node", "shape:frame1");
    const room = makeRoom({ "shape:frame1": frame, "shape:n1": node });

    const actions: SchemaAction[] = [
      { kind: "schema-set-overlay", nodeId: "node-aaaaaa", overlay: { color: "orange" } },
    ];
    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const upd = result.batch.updated["shape:n1"];
    expect(upd).toBeDefined();
    if (!upd) return;
    // biome-ignore lint/suspicious/noExplicitAny: TLRecord union — test introspection
    expect((upd[1] as any).props.color).toBe("orange");
    // Overlay map records the color too.
    expect(result.newOverlays["node-aaaaaa"]?.color).toBe("orange");
  });

  test("explicit schema-set-overlay color overrides user-owned style (targeted intent)", () => {
    // Ownership protects against INCIDENTAL overwrites (presets, re-imports).
    // An explicit set-overlay targeting this node IS the user's intent
    // expressed through the agent — it must repaint. NB: the frontend stamps
    // styleOwnedBy:"user" even on position-only drags, so blocking here would
    // make recolor impossible for any node the user has ever moved.
    const raw = "graph LR\n  node-aaaaaa[Node]";
    const frame = makeFrame("shape:frame1", raw);
    const node = makeChildShape("shape:n1", "node-aaaaaa", "Node", "shape:frame1");
    // biome-ignore lint/suspicious/noExplicitAny: TLRecord union — test setup
    (node as any).meta = { ...(node as any).meta, styleOwnedBy: "user" };
    const room = makeRoom({ "shape:frame1": frame, "shape:n1": node });

    const actions: SchemaAction[] = [
      { kind: "schema-set-overlay", nodeId: "node-aaaaaa", overlay: { color: "orange" } },
    ];
    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const upd = result.batch.updated["shape:n1"];
    expect(upd).toBeDefined();
    if (!upd) return;
    // biome-ignore lint/suspicious/noExplicitAny: TLRecord union — test introspection
    expect((upd[1] as any).props.color).toBe("orange");
  });

  test("schema-set-overlay fill restyles the existing shape", () => {
    const raw = "graph LR\n  node-aaaaaa[Node]";
    const frame = makeFrame("shape:frame1", raw);
    const node = makeChildShape("shape:n1", "node-aaaaaa", "Node", "shape:frame1");
    const room = makeRoom({ "shape:frame1": frame, "shape:n1": node });

    const actions: SchemaAction[] = [
      { kind: "schema-set-overlay", nodeId: "node-aaaaaa", overlay: { fill: "solid" } },
    ];
    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const upd = result.batch.updated["shape:n1"];
    expect(upd).toBeDefined();
    if (!upd) return;
    // biome-ignore lint/suspicious/noExplicitAny: TLRecord union — test introspection
    expect((upd[1] as any).props.fill).toBe("solid");
    expect(result.newOverlays["node-aaaaaa"]?.fill).toBe("solid");
  });

  test("schema-set-overlay applies the full style block (dash/size/font/labelColor)", () => {
    const raw = "graph LR\n  node-aaaaaa[Node]";
    const frame = makeFrame("shape:frame1", raw);
    const node = makeChildShape("shape:n1", "node-aaaaaa", "Node", "shape:frame1");
    const room = makeRoom({ "shape:frame1": frame, "shape:n1": node });

    const actions: SchemaAction[] = [
      {
        kind: "schema-set-overlay",
        nodeId: "node-aaaaaa",
        overlay: { dash: "solid", size: "l", font: "mono", labelColor: "red" },
      },
    ];
    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const upd = result.batch.updated["shape:n1"];
    expect(upd).toBeDefined();
    if (!upd) return;
    // biome-ignore lint/suspicious/noExplicitAny: TLRecord union — test introspection
    const props = (upd[1] as any).props;
    expect(props.dash).toBe("solid");
    expect(props.size).toBe("l");
    expect(props.font).toBe("mono");
    expect(props.labelColor).toBe("red");
    // Untouched style fields keep their values.
    expect(props.color).toBe("blue");
  });

  test("schema-define + schema-set-overlay in one batch colors the new shape", () => {
    const frame = makeFrame("shape:frame1", "");
    const room = makeRoom({ "shape:frame1": frame });

    const actions: SchemaAction[] = [
      { kind: "schema-define", nodeId: "new-bbbbbb", role: "service", label: "New" },
      { kind: "schema-set-overlay", nodeId: "new-bbbbbb", overlay: { color: "violet" } },
    ];
    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // biome-ignore lint/suspicious/noExplicitAny: TLRecord union — test introspection
    const added = Object.values(result.batch.added) as any[];
    const newShape = added.find((r) => r.typeName === "shape" && r.meta?.didrawId === "new-bbbbbb");
    expect(newShape).toBeDefined();
    expect(newShape.props.color).toBe("violet");
  });

  // ---------- Frame-fit to grown content (DRW-205 AC#3, S8 repro) ----------

  test("schema-rename to a long wrapping label grows the frame instead of clipping the node", () => {
    // Node near the bottom edge: rename makes it wrap to many lines — the
    // rendered shape would escape the frame and get clipped. The frame must
    // grow (down/right only); the node itself must NOT move.
    const raw = "graph TB\n  top-aaaaaa[Top Service]\n  bottom-bbbbbb[Bottom]";
    const frame = { ...makeFrame("shape:frame1", raw), props: { w: 260, h: 372, name: "T" } } as TLRecord;
    const top = {
      ...makeChildShape("shape:t1", "top-aaaaaa", "Top Service", "shape:frame1"),
      x: 20,
      y: 72,
    } as TLRecord;
    const bottom = {
      ...makeChildShape("shape:b1", "bottom-bbbbbb", "Bottom", "shape:frame1"),
      x: 20,
      y: 272,
    } as TLRecord;
    const room = makeRoom({ "shape:frame1": frame, "shape:t1": top, "shape:b1": bottom });

    const actions: SchemaAction[] = [
      {
        kind: "schema-rename",
        nodeId: "bottom-bbbbbb",
        label: "Bottom Aggregation Service With A Very Long Descriptive Multi Word Name",
      },
    ];
    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Frame must grow to cover the estimated rendered height of the renamed node.
    const frameUpd = result.batch.updated["shape:frame1"];
    expect(frameUpd).toBeDefined();
    if (!frameUpd) return;
    // biome-ignore lint/suspicious/noExplicitAny: TLRecord union — test introspection
    const grown = frameUpd[1] as any;
    expect(grown.props.h as number).toBeGreaterThan(372);
    // The renamed node must not be repositioned.
    const bottomUpd = result.batch.updated["shape:b1"];
    expect(bottomUpd).toBeDefined();
    if (!bottomUpd) return;
    // biome-ignore lint/suspicious/noExplicitAny: TLRecord union — test introspection
    const renamedShape = bottomUpd[1] as any;
    expect(renamedShape.x).toBe(20);
    expect(renamedShape.y).toBe(272);
  });

  test("frame-fit covers persisted growY of existing children", () => {
    // A child already grown by tldraw (growY persisted) sticks out of the
    // frame; ANY schema patch should fit the frame around it — grow-only.
    const raw = "graph TB\n  big-aaaaaa[Big]";
    const frame = { ...makeFrame("shape:frame1", raw), props: { w: 600, h: 200, name: "T" } } as TLRecord;
    const big = {
      ...makeChildShape("shape:big1", "big-aaaaaa", "Big", "shape:frame1"),
      x: 20,
      y: 100,
    } as TLRecord;
    // biome-ignore lint/suspicious/noExplicitAny: TLRecord union — test setup
    (big as any).props = { ...(big as any).props, growY: 120 }; // bottom = 100+80+120 = 300 > 200
    const room = makeRoom({ "shape:frame1": frame, "shape:big1": big });

    const actions: SchemaAction[] = [
      { kind: "schema-define", nodeId: "new-cccccc", role: "service", label: "New" },
    ];
    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const frameUpd = result.batch.updated["shape:frame1"];
    expect(frameUpd).toBeDefined();
    if (!frameUpd) return;
    // biome-ignore lint/suspicious/noExplicitAny: TLRecord union — test introspection
    const grown = frameUpd[1] as any;
    expect(grown.props.h as number).toBeGreaterThanOrEqual(300 + 24);
    // Existing child not moved.
    expect(result.batch.updated["shape:big1"]).toBeUndefined();
  });

  // ---------- Validation errors ----------

  test("schema-connect with unknown from node → errors: [{code: 'unknown-node'}]", () => {
    const frame = makeFrame("shape:frame1", "");
    const room = makeRoom({ "shape:frame1": frame });

    const actions: SchemaAction[] = [
      {
        kind: "schema-connect",
        from: "nonexistent-aaaaaa",
        to: "also-bbbbbb",
      },
    ];

    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.code).toBe("unknown-node");
    expect(result.errors[0]!.message).toContain("nonexistent-aaaaaa");
  });

  test("schema-define duplicate nodeId → duplicate-node error", () => {
    const existingRaw = "graph LR\n  api-aaaaaa[API]";
    const frame = makeFrame("shape:frame1", existingRaw);
    const room = makeRoom({ "shape:frame1": frame });

    const actions: SchemaAction[] = [
      { kind: "schema-define", nodeId: "api-aaaaaa", role: "service", label: "API" },
    ];

    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.code).toBe("duplicate-node");
  });

  test("schema-define with invalid nodeId format → invalid-id error", () => {
    const frame = makeFrame("shape:frame1", "");
    const room = makeRoom({ "shape:frame1": frame });

    const actions: SchemaAction[] = [
      { kind: "schema-define", nodeId: "INVALID_ID_UPPERCASE", role: "service" },
    ];

    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.errors[0]!.code).toBe("invalid-id");
  });

  test("schema-define with invalid role → invalid-role error", () => {
    const frame = makeFrame("shape:frame1", "");
    const room = makeRoom({ "shape:frame1": frame });

    const actions: SchemaAction[] = [
      {
        kind: "schema-define",
        nodeId: "api-aaaaaa",
        role: "not-a-real-role" as import("@shemma/domain").Role,
      },
    ];

    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.errors[0]!.code).toBe("invalid-role");
  });

  test("Batch of 3 actions where 2nd is invalid → {ok:false}, no partial application", () => {
    const frame = makeFrame("shape:frame1", "");
    const room = makeRoom({ "shape:frame1": frame });

    const originalRaw = "";

    const actions: SchemaAction[] = [
      { kind: "schema-define", nodeId: "api-aaaaaa", role: "service", label: "API" },
      // Invalid: connecting to non-existent node
      { kind: "schema-connect", from: "api-aaaaaa", to: "nonexistent-zzzzzz" },
      { kind: "schema-define", nodeId: "db-bbbbbb", role: "datastore", label: "DB" },
    ];

    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    // Errors collected (atomicity — all-or-nothing).
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some(e => e.code === "unknown-node")).toBe(true);
  });

  // ---------- Rename / role change ----------

  test("schema-rename → diff.renamed has 1 entry, batch.updated has 1 entry, RAW reflects new label", () => {
    const raw = "graph LR\n  api-aaaaaa[API]";
    const childShape = makeChildShape("shape:child1", "api-aaaaaa", "API", "shape:frame1");
    const frame = makeFrame("shape:frame1", raw);
    const room = makeRoom({
      "shape:frame1": frame,
      "shape:child1": childShape,
    });

    const actions: SchemaAction[] = [
      { kind: "schema-rename", nodeId: "api-aaaaaa", label: "API Gateway" },
    ];

    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // RAW should contain new label.
    expect(result.newRaw).toContain("API Gateway");
    // NodeId preserved.
    expect(result.newRaw).toContain("api-aaaaaa");
    // Shape updated in batch.
    expect(result.batch.updated["shape:child1"]).toBeDefined();
    // No adds or removes.
    expect(result.addedNodeIds).toHaveLength(0);
    expect(result.removedNodeIds).toHaveLength(0);
  });

  test("schema-set-role → diff.roleChanged, batch.updated has shape with new style", () => {
    const raw = "graph LR\n  api-aaaaaa[API]";
    const childShape = makeChildShape("shape:child1", "api-aaaaaa", "API", "shape:frame1");
    const frame = makeFrame("shape:frame1", raw);
    const room = makeRoom({
      "shape:frame1": frame,
      "shape:child1": childShape,
    });

    const actions: SchemaAction[] = [
      { kind: "schema-set-role", nodeId: "api-aaaaaa", role: "datastore" },
    ];

    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.batch.updated["shape:child1"]).toBeDefined();
    const [, newShape] = result.batch.updated["shape:child1"]!;
    // Datastore role has green color.
    expect((newShape.props as Record<string, unknown>).color).toBe("green");
  });

  // ---------- Delete / disconnect ----------

  test("schema-delete-node for node with overlay → orphanedOverlays === 1, overlay entry preserved", () => {
    const raw = "graph LR\n  api-aaaaaa[API]\n  db-bbbbbb[(DB)]";
    const childApi = makeChildShape("shape:child1", "api-aaaaaa", "API", "shape:frame1");
    const childDb = makeChildShape("shape:child2", "db-bbbbbb", "DB", "shape:frame1");
    const frame = makeFrame(
      "shape:frame1",
      raw,
      { "api-aaaaaa": { position: { x: 100, y: 200 } } }, // overlay for api
    );
    const room = makeRoom({
      "shape:frame1": frame,
      "shape:child1": childApi,
      "shape:child2": childDb,
    });

    const actions: SchemaAction[] = [
      { kind: "schema-delete-node", nodeId: "api-aaaaaa" },
    ];

    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.orphanedOverlays).toBe(1);
    // Per spec §Overlay model orphan policy: keep dead.
    expect(result.newOverlays["api-aaaaaa"]).toBeDefined();
    expect(result.removedNodeIds).toContain("api-aaaaaa");
    expect(result.batch.removed["shape:child1"]).toBeDefined();
  });

  test("schema-disconnect → edgesRemoved + arrow removed from batch", () => {
    const raw = "graph LR\n  api-aaaaaa[API]\n  db-bbbbbb[(DB)]\n  api-aaaaaa --> db-bbbbbb";
    const childApi = makeChildShape("shape:child1", "api-aaaaaa", "API", "shape:frame1");
    const childDb = makeChildShape("shape:child2", "db-bbbbbb", "DB", "shape:frame1");
    // Arrow shape between them.
    const arrowShape: TLRecord = {
      id: "shape:arrow1",
      typeName: "shape",
      type: "arrow",
      parentId: "shape:frame1",
      index: "a1",
      x: 0,
      y: 0,
      props: {},
      meta: { connectionKind: "sync" },
    } as TLRecord;
    // Bindings for the arrow.
    const bindingStart: TLRecord = {
      id: "binding:start1",
      typeName: "binding",
      type: "arrow",
      fromId: "shape:arrow1",
      toId: "shape:child1",
      props: { terminal: "start" },
      meta: {},
    } as TLRecord;
    const bindingEnd: TLRecord = {
      id: "binding:end1",
      typeName: "binding",
      type: "arrow",
      fromId: "shape:arrow1",
      toId: "shape:child2",
      props: { terminal: "end" },
      meta: {},
    } as TLRecord;
    const frame = makeFrame("shape:frame1", raw);
    const room = makeRoom({
      "shape:frame1": frame,
      "shape:child1": childApi,
      "shape:child2": childDb,
      "shape:arrow1": arrowShape,
      "binding:start1": bindingStart,
      "binding:end1": bindingEnd,
    });

    const actions: SchemaAction[] = [
      { kind: "schema-disconnect", from: "api-aaaaaa", to: "db-bbbbbb" },
    ];

    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Arrow and its bindings should be removed.
    expect(result.batch.removed["shape:arrow1"]).toBeDefined();
    expect(result.batch.removed["binding:start1"]).toBeDefined();
    expect(result.batch.removed["binding:end1"]).toBeDefined();
    expect(result.newRaw).not.toContain("-->");
  });

  // ---------- Destructive score ----------

  test("Destructive score: delete 6 of 10 nodes → destructiveScore === 0.6", () => {
    // Build a schema with 10 nodes.
    const nodeIds = Array.from({ length: 10 }, (_, i) =>
      `node-${i.toString().padStart(2, "0")}aaaa`,
    );
    const rawLines = ["graph LR", ...nodeIds.map((id) => `  ${id}[Node ${id}]`)];
    const raw = rawLines.join("\n");

    const frame = makeFrame("shape:frame1", raw);
    const room = makeRoom({ "shape:frame1": frame });

    const deleteActions: SchemaAction[] = nodeIds.slice(0, 6).map((nodeId) => ({
      kind: "schema-delete-node" as const,
      nodeId,
    }));

    const result = applySchemaActions({
      room,
      frame,
      actions: deleteActions,
      suffixLen: SUFFIX_LEN,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.destructiveScore).toBeCloseTo(0.6, 5);
    expect(result.removedNodeIds).toHaveLength(6);
  });

  // ---------- Caller-provided nodeId ----------

  test("schema-define with caller-provided nodeId → ID preserved (no regeneration)", () => {
    const frame = makeFrame("shape:frame1", "");
    const room = makeRoom({ "shape:frame1": frame });

    const actions: SchemaAction[] = [
      { kind: "schema-define", nodeId: "custom-abc123", role: "service" },
    ];

    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.addedNodeIds).toContain("custom-abc123");
    expect(result.newRaw).toContain("custom-abc123");
  });

  // ---------- schema-set-overlay ----------

  test("schema-set-overlay → overlay merged into newOverlays without affecting RAW", () => {
    const raw = "graph LR\n  api-aaaaaa[API]";
    const childShape = makeChildShape("shape:child1", "api-aaaaaa", "API", "shape:frame1");
    const frame = makeFrame("shape:frame1", raw);
    const room = makeRoom({ "shape:frame1": frame, "shape:child1": childShape });

    const actions: SchemaAction[] = [
      {
        kind: "schema-set-overlay",
        nodeId: "api-aaaaaa",
        overlay: { position: { x: 150, y: 250 }, color: "red", styleOwnedBy: "user" },
      },
    ];

    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.newOverlays["api-aaaaaa"]).toBeDefined();
    expect(result.newOverlays["api-aaaaaa"]!.position?.x).toBe(150);
    expect(result.newOverlays["api-aaaaaa"]!.color).toBe("red");
    expect(result.newOverlays["api-aaaaaa"]!.styleOwnedBy).toBe("user");
    // RAW unchanged.
    expect(result.newRaw).toBe(raw);
    // No adds/removes.
    expect(result.addedNodeIds).toHaveLength(0);
    expect(result.removedNodeIds).toHaveLength(0);
  });

  // ---------- Overlay preservation for existing nodes ----------

  test("Overlay preserved for existing node across patch", () => {
    const raw = "graph LR\n  api-aaaaaa[API]";
    const childShape = makeChildShape("shape:child1", "api-aaaaaa", "API", "shape:frame1");
    const frame = makeFrame(
      "shape:frame1",
      raw,
      { "api-aaaaaa": { position: { x: 300, y: 150 }, color: "violet" } },
    );
    const room = makeRoom({ "shape:frame1": frame, "shape:child1": childShape });

    // Add a new node — api-aaaaaa should keep its overlay.
    const actions: SchemaAction[] = [
      { kind: "schema-define", nodeId: "db-bbbbbb", role: "datastore", label: "DB" },
    ];

    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Overlay for api-aaaaaa preserved.
    expect(result.newOverlays["api-aaaaaa"]).toBeDefined();
    expect(result.newOverlays["api-aaaaaa"]!.position?.x).toBe(300);
    expect(result.newOverlays["api-aaaaaa"]!.color).toBe("violet");
  });

  // ---------- In-batch reference handling ----------

  test("Batch [define X, delete X] → success, end-state has 0 X", () => {
    const frame = makeFrame("shape:frame1", "");
    const room = makeRoom({ "shape:frame1": frame });

    const actions: SchemaAction[] = [
      { kind: "schema-define", nodeId: "node-aaaaaa", role: "service", label: "Temp" },
      { kind: "schema-delete-node", nodeId: "node-aaaaaa" },
    ];

    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Net result: node was added then deleted → not in RAW (net-zero diff from empty).
    expect(result.newRaw).not.toContain("node-aaaaaa");
    // Both addedNodeIds and removedNodeIds are empty since the diff is against
    // the original empty state (define+delete is a no-op net diff).
    expect(result.addedNodeIds).toHaveLength(0);
    expect(result.removedNodeIds).toHaveLength(0);
    // No shapes in store change batch.
    expect(Object.keys(result.batch.added)).toHaveLength(0);
    expect(Object.keys(result.batch.removed)).toHaveLength(0);
  });

  test("Batch [define X, define Y, disconnect X→Y added-in-batch] → success, no connection", () => {
    const frame = makeFrame("shape:frame1", "");
    const room = makeRoom({ "shape:frame1": frame });

    const actions: SchemaAction[] = [
      { kind: "schema-define", nodeId: "svc-aaaaaa", role: "service", label: "SVC" },
      { kind: "schema-define", nodeId: "db-bbbbbb", role: "datastore", label: "DB" },
      { kind: "schema-connect", from: "svc-aaaaaa", to: "db-bbbbbb" },
      { kind: "schema-disconnect", from: "svc-aaaaaa", to: "db-bbbbbb" },
    ];

    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Connection was added then removed → no --> in RAW.
    expect(result.newRaw).not.toContain("-->");
    // Both nodes still present.
    expect(result.newRaw).toContain("svc-aaaaaa");
    expect(result.newRaw).toContain("db-bbbbbb");
  });

  // ---------- Collect all errors (atomicity) ----------

  test("Multiple invalid actions → all errors collected (not bail on first)", () => {
    const frame = makeFrame("shape:frame1", "");
    const room = makeRoom({ "shape:frame1": frame });

    const actions: SchemaAction[] = [
      // Unknown node ref
      { kind: "schema-connect", from: "nonexistent-aaaaaa", to: "also-nonex-bbbbbb" },
      // Invalid role
      { kind: "schema-define", nodeId: "api-cccccc", role: "bogus" as import("@shemma/domain").Role },
    ];

    const result = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    // Should collect multiple errors.
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});
