// apps/backend/src/domain/schema/view.test.ts
// Unit tests для buildCanvasView — pure function без HTTP. DRW-134 Task 2.1.

import { describe, expect, it } from "bun:test";
import type { RoomState } from "../../types";
import type { TLRecord, TLStoreSnapshot } from "../../store-types";
import { buildCanvasView } from "./view";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeStore(shapes: TLRecord[]): TLStoreSnapshot {
  const store: Record<string, TLRecord> = {
    "document:document": { id: "document:document", typeName: "document" },
    "page:page": { id: "page:page", typeName: "page" },
  };
  for (const s of shapes) store[s.id] = s;
  return {
    schema: {
      schemaVersion: 2,
      storeVersion: 1,
      recordVersions: {},
    },
    store,
  };
}

function makeRoom(shapes: TLRecord[]): RoomState {
  return {
    store: makeStore(shapes),
    opLog: [],
    prompts: [],
    version: 1,
    dirty: false,
    lastTouched: Date.now(),
    didrawIndex: new Map(),
  };
}

/** Создаёт schema-frame shape. */
function schemaFrame(opts: {
  id: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  name?: string;
  mermaidSource?: string;
  didrawOverlays?: Record<string, unknown>;
}): TLRecord {
  return {
    id: opts.id,
    typeName: "shape",
    type: "frame",
    parentId: "page:page",
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    props: {
      name: opts.name ?? "",
      w: opts.w ?? 400,
      h: opts.h ?? 300,
    },
    meta: {
      didrawSchemaFrame: true,
      didrawProtocol: "v2",
      schemaProtocolVersion: "1.0",
      mermaidSource: opts.mermaidSource ?? "",
      didrawOverlays: opts.didrawOverlays ?? {},
    },
  };
}

/** Создаёт child shape внутри frame'а. */
function frameChild(opts: {
  id: string;
  frameId: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  label?: string;
  didrawId?: string;
}): TLRecord {
  return {
    id: opts.id,
    typeName: "shape",
    type: "geo",
    parentId: opts.frameId,
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    props: {
      w: opts.w ?? 100,
      h: opts.h ?? 50,
      richText: opts.label
        ? {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: opts.label }] }],
          }
        : undefined,
    },
    meta: opts.didrawId ? { didrawId: opts.didrawId, didrawLabel: opts.label ?? "" } : {},
  };
}

/** Создаёт free shape (parent = page). */
function freeShape(opts: {
  id: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  type?: string;
  label?: string;
}): TLRecord {
  return {
    id: opts.id,
    typeName: "shape",
    type: opts.type ?? "geo",
    parentId: "page:page",
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    props: {
      w: opts.w ?? 100,
      h: opts.h ?? 50,
      richText: opts.label
        ? {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: opts.label }] }],
          }
        : undefined,
    },
    meta: {},
  };
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("buildCanvasView (DRW-134 Task 2.1)", () => {
  it("empty room → { schemaVersion:'v2', frames:[], free:[] }", () => {
    const result = buildCanvasView(makeRoom([]));
    expect(result.schemaVersion).toBe("v2");
    expect(result.frames).toEqual([]);
    expect(result.free).toEqual([]);
  });

  it("room с одним schema-frame → frame в frames[], children не в free[]", () => {
    const frame = schemaFrame({ id: "shape:frame1", name: "Auth flow", mermaidSource: "graph LR\n  a --> b" });
    const child1 = frameChild({ id: "shape:c1", frameId: "shape:frame1", didrawId: "a-x9k2lm" });
    const child2 = frameChild({ id: "shape:c2", frameId: "shape:frame1", didrawId: "b-k3m7pq" });

    const result = buildCanvasView(makeRoom([frame, child1, child2]));

    expect(result.frames).toHaveLength(1);
    expect(result.free).toHaveLength(0);

    const f = result.frames[0];
    expect(f.id).toBe("shape:frame1");
    expect(f.label).toBe("Auth flow");
    expect(f.raw).toBe("graph LR\n  a --> b");
  });

  it("frame без children → bbox = frame's own bounds", () => {
    const frame = schemaFrame({ id: "shape:frame1", x: 10, y: 20, w: 500, h: 200 });

    const result = buildCanvasView(makeRoom([frame]));

    expect(result.frames[0].bbox).toEqual({ x: 10, y: 20, w: 500, h: 200 });
  });

  it("frame с children → bbox = union of children bounds", () => {
    const frame = schemaFrame({ id: "shape:frame1", x: 0, y: 0, w: 1000, h: 1000 });
    // child1 at (10,20) size 100x50 → right=110, bottom=70
    const child1 = frameChild({ id: "shape:c1", frameId: "shape:frame1", x: 10, y: 20, w: 100, h: 50 });
    // child2 at (200,100) size 80x40 → right=280, bottom=140
    const child2 = frameChild({ id: "shape:c2", frameId: "shape:frame1", x: 200, y: 100, w: 80, h: 40 });

    const result = buildCanvasView(makeRoom([frame, child1, child2]));

    // union: x=10, y=20, w=280-10=270, h=140-20=120
    expect(result.frames[0].bbox).toEqual({ x: 10, y: 20, w: 270, h: 120 });
  });

  it("frame meta.mermaidSource + meta.didrawOverlays preserved verbatim", () => {
    const overlays = { "api-x9k2lm": { position: { x: 380, y: 200 }, color: "red" } };
    const frame = schemaFrame({
      id: "shape:frame1",
      mermaidSource: "graph LR\n  api-x9k2lm --> db-c8h2vx",
      didrawOverlays: overlays,
    });

    const result = buildCanvasView(makeRoom([frame]));

    expect(result.frames[0].raw).toBe("graph LR\n  api-x9k2lm --> db-c8h2vx");
    expect(result.frames[0].overlays).toEqual(overlays);
  });

  it("free shape (parent=page) → 1 entry в free[]", () => {
    const shape = freeShape({ id: "shape:note1", type: "note", x: 100, y: 50, w: 120, h: 60, label: "TODO check" });

    const result = buildCanvasView(makeRoom([shape]));

    expect(result.free).toHaveLength(1);
    expect(result.frames).toHaveLength(0);

    const fe = result.free[0];
    expect(fe.id).toBe("shape:note1");
    expect(fe.type).toBe("note");
    expect(fe.label).toBe("TODO check");
    expect(fe.bbox).toEqual({ x: 100, y: 50, w: 120, h: 60 });
  });

  it("free shape без label → entry без поля label", () => {
    const shape = freeShape({ id: "shape:free1" });

    const result = buildCanvasView(makeRoom([shape]));

    expect(result.free[0].label).toBeUndefined();
  });

  it("bbox integer-rounded (дробные coords)", () => {
    const frame = schemaFrame({ id: "shape:frame1" });
    const child = {
      id: "shape:c1",
      typeName: "shape",
      type: "geo",
      parentId: "shape:frame1",
      x: 10.4,
      y: 20.7,
      props: { w: 100.6, h: 50.3 },
      meta: {},
    } as TLRecord;

    const result = buildCanvasView(makeRoom([frame, child]));

    const bbox = result.frames[0].bbox;
    expect(Number.isInteger(bbox.x)).toBe(true);
    expect(Number.isInteger(bbox.y)).toBe(true);
    expect(Number.isInteger(bbox.w)).toBe(true);
    expect(Number.isInteger(bbox.h)).toBe(true);
  });

  it("shape внутри group внутри frame → НЕ в free[]", () => {
    const frame = schemaFrame({ id: "shape:frame1" });
    // intermediate group inside frame
    const group: TLRecord = {
      id: "shape:group1",
      typeName: "shape",
      type: "group",
      parentId: "shape:frame1",
      x: 0,
      y: 0,
      props: {},
      meta: {},
    };
    // nested child inside group
    const nestedChild: TLRecord = {
      id: "shape:nested1",
      typeName: "shape",
      type: "geo",
      parentId: "shape:group1",
      x: 5,
      y: 5,
      props: { w: 80, h: 40 },
      meta: {},
    };

    const result = buildCanvasView(makeRoom([frame, group, nestedChild]));

    expect(result.free).toHaveLength(0);
    expect(result.frames).toHaveLength(1);
  });

  it("два schema-frames и один free shape → оба frame в frames[], free shape в free[]", () => {
    const frame1 = schemaFrame({ id: "shape:frame1", name: "Schema A" });
    const frame2 = schemaFrame({ id: "shape:frame2", name: "Schema B" });
    const free = freeShape({ id: "shape:free1", label: "note" });

    const result = buildCanvasView(makeRoom([frame1, frame2, free]));

    expect(result.frames).toHaveLength(2);
    expect(result.free).toHaveLength(1);
    expect(result.frames.map((f) => f.id)).toContain("shape:frame1");
    expect(result.frames.map((f) => f.id)).toContain("shape:frame2");
  });

  it("frame без props.name → label из meta.didrawLabel", () => {
    const frame: TLRecord = {
      id: "shape:frame1",
      typeName: "shape",
      type: "frame",
      parentId: "page:page",
      x: 0,
      y: 0,
      props: { name: "", w: 400, h: 300 },
      meta: {
        didrawSchemaFrame: true,
        didrawProtocol: "v2",
        schemaProtocolVersion: "1.0",
        mermaidSource: "",
        didrawOverlays: {},
        didrawLabel: "Fallback label",
      },
    };

    const result = buildCanvasView(makeRoom([frame]));
    expect(result.frames[0].label).toBe("Fallback label");
  });

  it("page не является page:page (multi-page) → free shape корректно определяется", () => {
    // Симулируем room с другим page id
    const store: Record<string, TLRecord> = {
      "document:document": { id: "document:document", typeName: "document" },
      "page:custom-page-id": { id: "page:custom-page-id", typeName: "page" },
    };
    const freeShape: TLRecord = {
      id: "shape:free1",
      typeName: "shape",
      type: "geo",
      parentId: "page:custom-page-id",
      x: 0,
      y: 0,
      props: { w: 100, h: 50 },
      meta: {},
    };
    store["shape:free1"] = freeShape;

    const room: RoomState = {
      store: {
        schema: { schemaVersion: 2, storeVersion: 1, recordVersions: {} },
        store,
      },
      opLog: [],
      prompts: [],
      version: 1,
      dirty: false,
      lastTouched: Date.now(),
      didrawIndex: new Map(),
    };

    const result = buildCanvasView(room);
    expect(result.free).toHaveLength(1);
    expect(result.free[0].id).toBe("shape:free1");
  });
});
