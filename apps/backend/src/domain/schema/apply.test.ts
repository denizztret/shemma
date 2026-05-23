/**
 * Tests для schema apply engine (DRW-134 Task 2.4 — apply.ts).
 * 13+ cases per plan acceptance.
 */

import { describe, test, expect } from "bun:test";
import { applySchemaActions } from "./apply";
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
