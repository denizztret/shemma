import { describe, expect, test } from "bun:test";
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
