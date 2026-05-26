/**
 * Tests for schema frame duplication + delete — DRW-134 Task 3.1.
 *
 * Покрытие:
 *   - Single-node frame: duplicate → new frameId, nodeIdMap 1 entry, original untouched.
 *   - 5-node frame с edges: duplicate → все IDs remapped, RAW edges refs new IDs.
 *   - Frame с overlays: overlay keys remapped под новые NodeIds (AC-5).
 *   - Position: новый frame at oldX + oldW + 40.
 *   - buildDeleteSchemaFrameBatch: frame + children removed.
 */

import { describe, test, expect } from "bun:test";
import { duplicateSchemaFrame, buildDeleteSchemaFrameBatch, findFrameChildren } from "./duplicate";
import type { TLRecord, StoreChangeBatch } from "../../store-types";
import type { RoomState } from "../../types";

// ---- Helpers ----

function makeStore(records: TLRecord[]): Record<string, TLRecord> {
  const store: Record<string, TLRecord> = {};
  for (const r of records) {
    store[r.id] = r;
  }
  return store;
}

function makeRoom(store: Record<string, TLRecord | undefined>): RoomState {
  return {
    store: { store: store as Record<string, TLRecord>, schema: {} },
    version: 1,
    dirty: false,
    meta: { didrawProtocol: "v2" },
    didrawIndex: new Map(),
    prompts: [],
    opLog: [],
    aiActivity: null,
  } as unknown as RoomState;
}

function makeFrame(id: string, x = 100, y = 80, w = 640, h = 480, raw = ""): TLRecord {
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
    props: { name: "Test Frame", w, h },
    meta: {
      didrawSchemaFrame: true,
      didrawProtocol: "v2",
      schemaProtocolVersion: "1.0",
      mermaidSource: raw,
      didrawOverlays: {},
    },
  } as TLRecord;
}

function makeChild(id: string, parentId: string, nodeId: string, label: string): TLRecord {
  return {
    id,
    typeName: "shape",
    type: "geo",
    x: 10,
    y: 20,
    parentId,
    index: "a1",
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: { w: 220, h: 80, geo: "rectangle" },
    meta: {
      didrawId: nodeId,
      didrawName: nodeId,
      didrawLabel: label,
      didrawSchemaParent: parentId,
    },
  } as TLRecord;
}

// ---- Tests ----

describe("findFrameChildren", () => {
  test("returns direct children only (no frame itself)", () => {
    const frame = makeFrame("shape:frame1");
    const child1 = makeChild("shape:c1", "shape:frame1", "api-aaaaaa", "API");
    const child2 = makeChild("shape:c2", "shape:frame1", "db-bbbbbb", "DB");
    const other = makeChild("shape:c3", "page:page", "other-cccccc", "Other");
    const store = makeStore([frame, child1, child2, other]);
    const children = findFrameChildren(store, "shape:frame1");
    const ids = children.map((c) => c.id).sort();
    expect(ids).toEqual(["shape:c1", "shape:c2"]);
  });

  test("returns empty array for frame with no children", () => {
    const frame = makeFrame("shape:frame1");
    const store = makeStore([frame]);
    const children = findFrameChildren(store, "shape:frame1");
    expect(children).toHaveLength(0);
  });

  test("returns nested children (indirect ancestry)", () => {
    const frame = makeFrame("shape:frame1");
    const child1 = makeChild("shape:c1", "shape:frame1", "api-aaaaaa", "API");
    // nested child (child of child1)
    const nested = { ...makeChild("shape:c2", "shape:c1", "nested-bbbbbb", "Nested") };
    const store = makeStore([frame, child1, nested]);
    const children = findFrameChildren(store, "shape:frame1");
    expect(children).toHaveLength(2);
  });
});

describe("duplicateSchemaFrame", () => {
  test("single-node frame: duplicate produces valid result", () => {
    const raw = "graph LR\n  api-aaaaaa[API]";
    const frame = makeFrame("shape:frame1", 100, 80, 640, 480, raw);
    const child = makeChild("shape:c1", "shape:frame1", "api-aaaaaa", "API");
    const store = makeStore([frame, child]);
    const room = makeRoom(store);

    const result = duplicateSchemaFrame({
      room,
      oldFrame: frame,
      newLabel: "API v2",
      suffixLen: 6,
    });

    // newFrameId — новый, отличный от оригинала
    expect(result.newFrameId).not.toBe("shape:frame1");
    expect(result.newFrameId).toMatch(/^shape:f_/);

    // nodeIdMap имеет 1 запись
    const mapEntries = Object.entries(result.nodeIdMap);
    expect(mapEntries).toHaveLength(1);
    const [[oldId, newId]] = mapEntries;
    expect(oldId).toBe("api-aaaaaa");
    expect(newId).not.toBe("api-aaaaaa");
    expect(newId).toMatch(/^api-[0-9a-z]{6}$/);

    // batch.added содержит новый frame + новый child
    expect(Object.keys(result.batch.added)).toHaveLength(2);

    // Новый frame имеет правильный label
    const newFrame = result.batch.added[result.newFrameId];
    expect(newFrame).toBeDefined();
    expect((newFrame!.props as { name?: string }).name).toBe("API v2");

    // RAW в новом frame содержит новый ID вместо старого
    const newFrameMeta = (newFrame!.meta ?? {}) as Record<string, unknown>;
    expect(typeof newFrameMeta.mermaidSource).toBe("string");
    expect((newFrameMeta.mermaidSource as string)).toContain(newId);
    expect((newFrameMeta.mermaidSource as string)).not.toContain("api-aaaaaa");

    // Original frame НЕ в batch.updated или batch.removed
    expect(result.batch.updated["shape:frame1"]).toBeUndefined();
    expect(result.batch.removed["shape:frame1"]).toBeUndefined();
  });

  test("5-node frame with edges: all IDs remapped in RAW", () => {
    const raw = [
      "graph LR",
      "  user-aaaaaa[User]",
      "  auth-bbbbbb[Auth]",
      "  api-cccccc[API]",
      "  db-dddddd[(DB)]",
      "  cache-eeeeee[(Cache)]",
      "  user-aaaaaa --> auth-bbbbbb",
      "  auth-bbbbbb --> api-cccccc",
      "  api-cccccc --> db-dddddd",
      "  api-cccccc --> cache-eeeeee",
    ].join("\n");

    const frame = makeFrame("shape:frame1", 100, 80, 640, 480, raw);
    const children = [
      makeChild("shape:c1", "shape:frame1", "user-aaaaaa", "User"),
      makeChild("shape:c2", "shape:frame1", "auth-bbbbbb", "Auth"),
      makeChild("shape:c3", "shape:frame1", "api-cccccc", "API"),
      makeChild("shape:c4", "shape:frame1", "db-dddddd", "DB"),
      makeChild("shape:c5", "shape:frame1", "cache-eeeeee", "Cache"),
    ];
    const store = makeStore([frame, ...children]);
    const room = makeRoom(store);

    const result = duplicateSchemaFrame({
      room,
      oldFrame: frame,
      newLabel: "Copy",
      suffixLen: 6,
    });

    // 5 entries in nodeIdMap
    const mapEntries = Object.entries(result.nodeIdMap);
    expect(mapEntries).toHaveLength(5);

    // Все старые ID не присутствуют в новом RAW
    const newFrameMeta = (result.batch.added[result.newFrameId]?.meta ?? {}) as Record<string, unknown>;
    const newRaw = newFrameMeta.mermaidSource as string;
    expect(newRaw).not.toContain("user-aaaaaa");
    expect(newRaw).not.toContain("auth-bbbbbb");
    expect(newRaw).not.toContain("api-cccccc");
    expect(newRaw).not.toContain("db-dddddd");
    expect(newRaw).not.toContain("cache-eeeeee");

    // Все новые ID присутствуют в RAW
    for (const [, newId] of mapEntries) {
      expect(newRaw).toContain(newId);
    }

    // batch.added: 1 frame + 5 children = 6
    expect(Object.keys(result.batch.added)).toHaveLength(6);

    // Original frame не тронут
    expect(result.batch.updated["shape:frame1"]).toBeUndefined();
    expect(result.batch.removed["shape:frame1"]).toBeUndefined();
  });

  test("frame with overlays: overlay keys remapped to new NodeIds (AC-5)", () => {
    const raw = "graph LR\n  api-aaaaaa[API]\n  db-bbbbbb[(DB)]";
    const frame = makeFrame("shape:frame1", 100, 80, 640, 480, raw);
    (frame.meta as Record<string, unknown>).didrawOverlays = {
      "api-aaaaaa": { position: { x: 200, y: 100 }, color: "red" },
      "db-bbbbbb": { pinned: true, styleOwnedBy: "user" },
    };

    const children = [
      makeChild("shape:c1", "shape:frame1", "api-aaaaaa", "API"),
      makeChild("shape:c2", "shape:frame1", "db-bbbbbb", "DB"),
    ];
    const store = makeStore([frame, ...children]);
    const room = makeRoom(store);

    const result = duplicateSchemaFrame({
      room,
      oldFrame: frame,
      newLabel: "Copy",
      suffixLen: 6,
    });

    const newFrameMeta = (result.batch.added[result.newFrameId]?.meta ?? {}) as Record<string, unknown>;
    const newOverlays = newFrameMeta.didrawOverlays as Record<string, unknown>;

    // Старые ключи не должны быть в новых overlays
    expect(newOverlays["api-aaaaaa"]).toBeUndefined();
    expect(newOverlays["db-bbbbbb"]).toBeUndefined();

    // Новые ключи (из nodeIdMap) должны присутствовать
    const newApiId = result.nodeIdMap["api-aaaaaa"];
    const newDbId = result.nodeIdMap["db-bbbbbb"];
    expect(newApiId).toBeDefined();
    expect(newDbId).toBeDefined();

    expect(newOverlays[newApiId]).toMatchObject({ position: { x: 200, y: 100 }, color: "red" });
    expect(newOverlays[newDbId]).toMatchObject({ pinned: true, styleOwnedBy: "user" });
  });

  test("position: new frame at oldX + oldW + 40, same Y", () => {
    const frame = makeFrame("shape:frame1", 100, 200, 500, 400, "graph LR\n  a-aaaaaa[A]");
    const child = makeChild("shape:c1", "shape:frame1", "a-aaaaaa", "A");
    const store = makeStore([frame, child]);
    const room = makeRoom(store);

    const result = duplicateSchemaFrame({
      room,
      oldFrame: frame,
      newLabel: "Copy",
      suffixLen: 6,
    });

    const newFrame = result.batch.added[result.newFrameId];
    expect(newFrame).toBeDefined();
    // x = 100 + 500 + 40 = 640
    expect(newFrame!.x).toBe(640);
    // y = 200 (same as original)
    expect(newFrame!.y).toBe(200);
  });

  test("frame without children: nodeIdMap is empty, batch has only new frame", () => {
    const raw = "graph LR";
    const frame = makeFrame("shape:frame1", 0, 0, 640, 480, raw);
    const store = makeStore([frame]);
    const room = makeRoom(store);

    const result = duplicateSchemaFrame({
      room,
      oldFrame: frame,
      newLabel: "Empty copy",
      suffixLen: 6,
    });

    expect(Object.keys(result.nodeIdMap)).toHaveLength(0);
    // batch.added: только новый frame
    expect(Object.keys(result.batch.added)).toHaveLength(1);
    expect(result.batch.added[result.newFrameId]).toBeDefined();
  });

  test("new child shapes have updated meta.didrawId and meta.didrawSchemaParent", () => {
    const raw = "graph LR\n  api-aaaaaa[API]";
    const frame = makeFrame("shape:frame1", 0, 0, 640, 480, raw);
    const child = makeChild("shape:c1", "shape:frame1", "api-aaaaaa", "API");
    const store = makeStore([frame, child]);
    const room = makeRoom(store);

    const result = duplicateSchemaFrame({
      room,
      oldFrame: frame,
      newLabel: "Copy",
      suffixLen: 6,
    });

    // Найдём новый child в batch.added (все кроме нового frame)
    const addedIds = Object.keys(result.batch.added).filter((id) => id !== result.newFrameId);
    expect(addedIds).toHaveLength(1);
    const newChild = result.batch.added[addedIds[0]!];
    expect(newChild).toBeDefined();

    const childMeta = (newChild!.meta ?? {}) as Record<string, unknown>;
    expect(childMeta.didrawId).toBe(result.nodeIdMap["api-aaaaaa"]);
    expect(childMeta.didrawSchemaParent).toBe(result.newFrameId);
    // parentId тоже должен указывать на новый frame
    expect(newChild!.parentId).toBe(result.newFrameId);
  });
});

// ---- DRW-140: arrows + bindings clone ----

function makeArrow(id: string, parentId: string, startShape: string, endShape: string): TLRecord {
  return {
    id,
    typeName: "shape",
    type: "arrow",
    x: 0,
    y: 0,
    parentId,
    index: "a2",
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: {
      start: { x: 0, y: 0, boundShapeId: startShape, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: true },
      end: { x: 0, y: 0, boundShapeId: endShape, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: true },
      color: "black",
      size: "m",
      kind: "elbow",
      elbowMidPoint: 0.5,
    },
    meta: {},
  } as TLRecord;
}

function makeBinding(id: string, arrowId: string, targetShape: string, terminal: "start" | "end"): TLRecord {
  return {
    id,
    typeName: "binding",
    type: "arrow",
    fromId: arrowId,
    toId: targetShape,
    props: { terminal, isPrecise: true, isExact: false, normalizedAnchor: { x: 0.5, y: 0.5 }, snap: "none" },
    meta: {},
  } as unknown as TLRecord;
}

describe("DRW-140 — duplicate arrows + bindings (visual stretch)", () => {
  test("arrow props.start/end.boundShapeId remapped to cloned shape ids", () => {
    const raw = "graph LR\n  a-aaaaaa --> b-bbbbbb";
    const frame = makeFrame("shape:frame1", 0, 0, 640, 480, raw);
    const childA = makeChild("shape:nodeA", "shape:frame1", "a-aaaaaa", "A");
    const childB = makeChild("shape:nodeB", "shape:frame1", "b-bbbbbb", "B");
    const arrow = makeArrow("shape:arr1", "shape:frame1", "shape:nodeA", "shape:nodeB");
    const store = makeStore([frame, childA, childB, arrow]);
    const room = makeRoom(store);

    const result = duplicateSchemaFrame({
      room,
      oldFrame: frame,
      newLabel: "Copy",
      suffixLen: 6,
    });

    // Find cloned arrow in batch
    const clonedArrow = Object.values(result.batch.added).find(
      (r) => r && r.type === "arrow",
    );
    expect(clonedArrow).toBeDefined();
    // biome-ignore lint/suspicious/noExplicitAny: arrow props are untyped in tldraw
    const props = (clonedArrow as any).props as Record<string, unknown>;
    const start = props.start as Record<string, unknown>;
    const end = props.end as Record<string, unknown>;
    // Must NOT reference original shape ids
    expect(start.boundShapeId).not.toBe("shape:nodeA");
    expect(end.boundShapeId).not.toBe("shape:nodeB");
    // Must reference some new shape id from the batch
    expect(typeof start.boundShapeId).toBe("string");
    expect(Object.keys(result.batch.added)).toContain(start.boundShapeId as string);
    expect(Object.keys(result.batch.added)).toContain(end.boundShapeId as string);
  });

  test("bindings cloned with both endpoints remapped", () => {
    const raw = "graph LR\n  a-aaaaaa --> b-bbbbbb";
    const frame = makeFrame("shape:frame1", 0, 0, 640, 480, raw);
    const childA = makeChild("shape:nodeA", "shape:frame1", "a-aaaaaa", "A");
    const childB = makeChild("shape:nodeB", "shape:frame1", "b-bbbbbb", "B");
    const arrow = makeArrow("shape:arr1", "shape:frame1", "shape:nodeA", "shape:nodeB");
    const bindStart = makeBinding("binding:bs1", "shape:arr1", "shape:nodeA", "start");
    const bindEnd = makeBinding("binding:be1", "shape:arr1", "shape:nodeB", "end");
    const store = makeStore([frame, childA, childB, arrow, bindStart, bindEnd]);
    const room = makeRoom(store);

    const result = duplicateSchemaFrame({
      room,
      oldFrame: frame,
      newLabel: "Copy",
      suffixLen: 6,
    });

    const clonedBindings = Object.values(result.batch.added).filter(
      (r) => r && r.typeName === "binding",
    );
    expect(clonedBindings).toHaveLength(2);
    for (const b of clonedBindings) {
      expect(b!.id).toMatch(/^binding:/);
      expect(b!.id).not.toBe("binding:bs1");
      expect(b!.id).not.toBe("binding:be1");
      // biome-ignore lint/suspicious/noExplicitAny: binding shape is untyped
      const fromId = (b as any).fromId;
      // biome-ignore lint/suspicious/noExplicitAny: binding shape is untyped
      const toId = (b as any).toId;
      expect(fromId).not.toBe("shape:arr1");
      expect(toId).not.toBe("shape:nodeA");
      expect(toId).not.toBe("shape:nodeB");
      // Both endpoints must be in the cloned batch
      expect(Object.keys(result.batch.added)).toContain(fromId);
      expect(Object.keys(result.batch.added)).toContain(toId);
    }
  });

  test("binding referencing shape OUTSIDE frame is skipped (no dangle)", () => {
    const raw = "graph LR\n  a-aaaaaa[A]";
    const frame = makeFrame("shape:frame1", 0, 0, 640, 480, raw);
    const childA = makeChild("shape:nodeA", "shape:frame1", "a-aaaaaa", "A");
    const outsideShape = makeChild("shape:outside", "page:page", "outside-zzzzzz", "Outside");
    // Arrow inside frame; one endpoint points OUTSIDE the frame.
    const arrow = makeArrow("shape:arr1", "shape:frame1", "shape:nodeA", "shape:outside");
    const bindStart = makeBinding("binding:bs1", "shape:arr1", "shape:nodeA", "start");
    const bindEnd = makeBinding("binding:be1", "shape:arr1", "shape:outside", "end");
    const store = makeStore([frame, childA, outsideShape, arrow, bindStart, bindEnd]);
    const room = makeRoom(store);

    const result = duplicateSchemaFrame({
      room,
      oldFrame: frame,
      newLabel: "Copy",
      suffixLen: 6,
    });

    // Only the binding with both endpoints inside the frame gets cloned.
    // bindStart (arrow → nodeA) — both cloned → cloned.
    // bindEnd (arrow → outside) — outside isn't in shapeIdMap → skipped to avoid
    // a dangling binding between the replica arrow and the original outside shape.
    const clonedBindings = Object.values(result.batch.added).filter(
      (r) => r && r.typeName === "binding",
    );
    expect(clonedBindings).toHaveLength(1);
    // biome-ignore lint/suspicious/noExplicitAny: binding shape is untyped
    const survivor = clonedBindings[0] as any;
    // Cloned binding must NOT reference any original shape id.
    expect(survivor.fromId).not.toBe("shape:arr1");
    expect(survivor.toId).not.toBe("shape:nodeA");
    expect(survivor.toId).not.toBe("shape:outside");
  });

  test("arrows without boundShapeId (free-hand) clone untouched", () => {
    const raw = "graph LR";
    const frame = makeFrame("shape:frame1", 0, 0, 640, 480, raw);
    // Free-hand arrow — no boundShapeId
    const freeArrow: TLRecord = {
      id: "shape:freearr",
      typeName: "shape",
      type: "arrow",
      x: 0,
      y: 0,
      parentId: "shape:frame1",
      index: "a2",
      isLocked: false,
      opacity: 1,
      rotation: 0,
      props: {
        start: { x: 10, y: 10 },
        end: { x: 100, y: 100 },
        color: "black",
        size: "m",
        kind: "elbow",
        elbowMidPoint: 0.5,
      },
      meta: {},
    } as TLRecord;
    const store = makeStore([frame, freeArrow]);
    const room = makeRoom(store);

    const result = duplicateSchemaFrame({
      room,
      oldFrame: frame,
      newLabel: "Copy",
      suffixLen: 6,
    });

    const clonedArrow = Object.values(result.batch.added).find(
      (r) => r && r.type === "arrow",
    );
    expect(clonedArrow).toBeDefined();
    // biome-ignore lint/suspicious/noExplicitAny: arrow props are untyped
    const props = (clonedArrow as any).props as Record<string, unknown>;
    const start = props.start as Record<string, unknown>;
    expect(start.x).toBe(10);
    expect(start.y).toBe(10);
    // No boundShapeId to remap — preserved as-is
    expect(start.boundShapeId).toBeUndefined();
  });
});

describe("buildDeleteSchemaFrameBatch", () => {
  test("deletes frame and all its children", () => {
    const frame = makeFrame("shape:frame1");
    const child1 = makeChild("shape:c1", "shape:frame1", "api-aaaaaa", "API");
    const child2 = makeChild("shape:c2", "shape:frame1", "db-bbbbbb", "DB");
    const other = makeChild("shape:c3", "page:page", "other-cccccc", "Other");
    const store = makeStore([frame, child1, child2, other]);
    const room = makeRoom(store);

    const batch = buildDeleteSchemaFrameBatch({ room, frame });

    // frame + 2 children в removed
    expect(Object.keys(batch.removed).sort()).toEqual(
      ["shape:c1", "shape:c2", "shape:frame1"].sort(),
    );
    // shape:c3 не должен быть удалён (не child frame)
    expect(batch.removed["shape:c3"]).toBeUndefined();
    // added и updated пустые
    expect(Object.keys(batch.added)).toHaveLength(0);
    expect(Object.keys(batch.updated)).toHaveLength(0);
  });

  test("deletes frame with no children", () => {
    const frame = makeFrame("shape:frame1");
    const store = makeStore([frame]);
    const room = makeRoom(store);

    const batch = buildDeleteSchemaFrameBatch({ room, frame });

    expect(Object.keys(batch.removed)).toEqual(["shape:frame1"]);
  });

  test("deletes nested children recursively", () => {
    const frame = makeFrame("shape:frame1");
    const child = makeChild("shape:c1", "shape:frame1", "api-aaaaaa", "API");
    const nested = { ...makeChild("shape:c2", "shape:c1", "nested-bbbbbb", "Nested") };
    const store = makeStore([frame, child, nested]);
    const room = makeRoom(store);

    const batch = buildDeleteSchemaFrameBatch({ room, frame });

    expect(Object.keys(batch.removed).sort()).toEqual(
      ["shape:c1", "shape:c2", "shape:frame1"].sort(),
    );
  });
});
