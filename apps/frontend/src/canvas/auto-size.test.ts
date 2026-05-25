import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Editor } from "tldraw";
import { triggerAutoSize } from "./auto-size";

type MockShape = { id: string; type: string; props: Record<string, unknown> };
type Update = { id: string; type: string; props: Record<string, unknown> };

interface MockOpts {
  shapes: MockShape[];
  // Per-type onBeforeCreate stub. Returning undefined = no change.
  onBeforeCreate?: Record<string, (s: MockShape) => MockShape | undefined>;
}

function makeMockEditor(opts: MockOpts): {
  editor: Editor;
  updates: Update[];
  measured: Array<{ id: string; type: string }>;
} {
  const updates: Update[] = [];
  const measured: Array<{ id: string; type: string }> = [];
  const editor = {
    getCurrentPageShapes: () => opts.shapes,
    run: (fn: () => void) => fn(),
    updateShape: (u: Update) => {
      updates.push(u);
    },
    getShapeUtil: (type: string) => ({
      onBeforeCreate: (s: MockShape) => {
        measured.push({ id: s.id, type: s.type });
        return opts.onBeforeCreate?.[type]?.(s);
      },
    }),
  } as unknown as Editor;
  return { editor, updates, measured };
}

describe("triggerAutoSize", () => {
  test("no-op when no shapes on page", () => {
    const { editor, updates, measured } = makeMockEditor({ shapes: [] });
    triggerAutoSize(editor);
    expect(updates).toEqual([]);
    expect(measured).toEqual([]);
  });

  test("calls onBeforeCreate for geo and applies growY when returned", () => {
    const { editor, updates, measured } = makeMockEditor({
      shapes: [{ id: "shape:a", type: "geo", props: { w: 220, h: 80, growY: 0 } }],
      onBeforeCreate: {
        geo: (s) => ({ ...s, props: { ...s.props, growY: 130 } }),
      },
    });
    triggerAutoSize(editor);
    expect(measured).toEqual([{ id: "shape:a", type: "geo" }]);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.props.growY).toBe(130);
  });

  test("skips updateShape when onBeforeCreate returns undefined (no change)", () => {
    const { editor, updates, measured } = makeMockEditor({
      shapes: [{ id: "shape:a", type: "geo", props: { w: 220, h: 80, growY: 0 } }],
      onBeforeCreate: { geo: () => undefined },
    });
    triggerAutoSize(editor);
    expect(measured).toHaveLength(1);
    expect(updates).toEqual([]);
  });

  test("re-measures note shapes", () => {
    const { editor, updates, measured } = makeMockEditor({
      shapes: [{ id: "shape:b", type: "note", props: { growY: 0 } }],
      onBeforeCreate: {
        note: (s) => ({ ...s, props: { ...s.props, growY: 40 } }),
      },
    });
    triggerAutoSize(editor);
    expect(measured).toEqual([{ id: "shape:b", type: "note" }]);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.props.growY).toBe(40);
  });

  test("re-measures text shapes", () => {
    const { editor, updates, measured } = makeMockEditor({
      shapes: [{ id: "shape:c", type: "text", props: { autoSize: true, w: 8 } }],
      onBeforeCreate: {
        text: (s) => ({ ...s, props: { ...s.props, w: 320 } }),
      },
    });
    triggerAutoSize(editor);
    expect(measured).toEqual([{ id: "shape:c", type: "text" }]);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.props.w).toBe(320);
  });

  test("ignores non-autosize types (group, frame, arrow, custom)", () => {
    const { editor, updates, measured } = makeMockEditor({
      shapes: [
        { id: "shape:d", type: "group", props: {} },
        { id: "shape:e", type: "frame", props: {} },
        { id: "shape:f", type: "schema-container", props: {} },
        { id: "shape:g", type: "arrow", props: {} },
      ],
    });
    triggerAutoSize(editor);
    expect(updates).toEqual([]);
    expect(measured).toEqual([]);
  });

  test("filters by ids set when provided", () => {
    const { editor, updates, measured } = makeMockEditor({
      shapes: [
        { id: "shape:a", type: "geo", props: {} },
        { id: "shape:b", type: "note", props: {} },
        { id: "shape:c", type: "text", props: {} },
      ],
      onBeforeCreate: {
        geo: (s) => ({ ...s, props: { ...s.props, growY: 1 } }),
        note: (s) => ({ ...s, props: { ...s.props, growY: 1 } }),
        text: (s) => ({ ...s, props: { ...s.props, w: 1 } }),
      },
    });
    triggerAutoSize(editor, new Set(["shape:b"]));
    expect(measured).toEqual([{ id: "shape:b", type: "note" }]);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.id).toBe("shape:b");
  });

  test("mixed shapes: only autosize-capable types are measured", () => {
    const { editor, updates, measured } = makeMockEditor({
      shapes: [
        { id: "shape:a", type: "geo", props: {} },
        { id: "shape:b", type: "note", props: {} },
        { id: "shape:c", type: "text", props: {} },
        { id: "shape:d", type: "group", props: {} },
        { id: "shape:e", type: "arrow", props: {} },
      ],
      onBeforeCreate: {
        geo: (s) => ({ ...s, props: { ...s.props, growY: 1 } }),
        note: (s) => ({ ...s, props: { ...s.props, growY: 1 } }),
        text: (s) => ({ ...s, props: { ...s.props, w: 1 } }),
      },
    });
    triggerAutoSize(editor);
    expect(measured.map((m) => m.type).sort()).toEqual(["geo", "note", "text"]);
    expect(updates).toHaveLength(3);
  });

  test("empty ids set yields no measurements", () => {
    const { editor, updates, measured } = makeMockEditor({
      shapes: [{ id: "shape:a", type: "geo", props: {} }],
    });
    triggerAutoSize(editor, new Set());
    expect(updates).toEqual([]);
    expect(measured).toEqual([]);
  });
});

// DRW-174: POST /measured-bounds for shapes inside a v2 schema-frame.

describe("triggerAutoSize — DRW-174 measured-bounds POST", () => {
  // biome-ignore lint/suspicious/noExplicitAny: capturing fetch calls
  let fetchCalls: Array<{ url: string; body: any }>;
  let originalFetch: typeof fetch | undefined;

  beforeEach(() => {
    fetchCalls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      fetchCalls.push({ url, body });
      return new Response(
        JSON.stringify({ ok: true, applied: 0, skipped: 0 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
  });

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  type ShapeWithParent = {
    id: string;
    type: string;
    props: Record<string, unknown>;
    parentId?: string;
    meta?: Record<string, unknown>;
  };

  function makeEditorWithParents(opts: {
    shapes: ShapeWithParent[];
    onBeforeCreate?: Record<string, (s: ShapeWithParent) => ShapeWithParent>;
  }): Editor {
    return {
      getCurrentPageShapes: () => opts.shapes,
      run: (fn: () => void) => fn(),
      updateShape: () => {},
      getShapeUtil: (type: string) => ({
        onBeforeCreate: (s: ShapeWithParent) =>
          opts.onBeforeCreate?.[type]?.(s) ?? s,
      }),
    } as unknown as Editor;
  }

  test("shape inside schema-frame → POST measured-bounds with effective h (h+growY)", async () => {
    const editor = makeEditorWithParents({
      shapes: [
        {
          id: "shape:frame1",
          type: "frame",
          props: {},
          meta: { didrawSchemaFrame: true },
        },
        {
          id: "shape:a",
          type: "geo",
          parentId: "shape:frame1",
          props: { w: 220, h: 80, growY: 0 },
        },
      ],
      onBeforeCreate: {
        geo: (s) => ({ ...s, props: { ...s.props, growY: 50 } }),
      },
    });
    triggerAutoSize(editor);
    // Allow microtask queue for fire-and-forget POST.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toContain(
      "/api/schema/shape%3Aframe1/measured-bounds",
    );
    expect(fetchCalls[0]!.body.bounds["shape:a"]).toEqual({ h: 130 });
  });

  test("shape without schema-frame ancestor → no POST", async () => {
    const editor = makeEditorWithParents({
      shapes: [
        { id: "shape:a", type: "geo", props: { w: 220, h: 80, growY: 0 } },
      ],
      onBeforeCreate: {
        geo: (s) => ({ ...s, props: { ...s.props, growY: 50 } }),
      },
    });
    triggerAutoSize(editor);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchCalls).toHaveLength(0);
  });

  test("shape inside plain (non-schema) frame → no POST", async () => {
    const editor = makeEditorWithParents({
      shapes: [
        {
          id: "shape:frame1",
          type: "frame",
          props: {},
          meta: {} /* no didrawSchemaFrame */,
        },
        {
          id: "shape:a",
          type: "geo",
          parentId: "shape:frame1",
          props: { w: 220, h: 80, growY: 0 },
        },
      ],
      onBeforeCreate: {
        geo: (s) => ({ ...s, props: { ...s.props, growY: 50 } }),
      },
    });
    triggerAutoSize(editor);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchCalls).toHaveLength(0);
  });

  test("nested: shape → schema-container → schema-frame → POST grouped by frame", async () => {
    const editor = makeEditorWithParents({
      shapes: [
        {
          id: "shape:frame1",
          type: "frame",
          props: {},
          meta: { didrawSchemaFrame: true },
        },
        {
          id: "shape:container1",
          type: "schema-container",
          parentId: "shape:frame1",
          props: {},
        },
        {
          id: "shape:a",
          type: "geo",
          parentId: "shape:container1",
          props: { w: 220, h: 80, growY: 0 },
        },
        {
          id: "shape:b",
          type: "geo",
          parentId: "shape:container1",
          props: { w: 220, h: 80, growY: 0 },
        },
      ],
      onBeforeCreate: {
        geo: (s) => ({ ...s, props: { ...s.props, growY: 30 } }),
      },
    });
    triggerAutoSize(editor);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.body.bounds["shape:a"]).toEqual({ h: 110 });
    expect(fetchCalls[0]!.body.bounds["shape:b"]).toEqual({ h: 110 });
  });

  test("no effective bounds change → no POST", async () => {
    const editor = makeEditorWithParents({
      shapes: [
        {
          id: "shape:frame1",
          type: "frame",
          props: {},
          meta: { didrawSchemaFrame: true },
        },
        {
          id: "shape:a",
          type: "geo",
          parentId: "shape:frame1",
          props: { w: 220, h: 80, growY: 0 },
        },
      ],
      onBeforeCreate: {
        // identity — onBeforeCreate returns same shape.
        geo: (s) => s,
      },
    });
    triggerAutoSize(editor);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchCalls).toHaveLength(0);
  });
});
