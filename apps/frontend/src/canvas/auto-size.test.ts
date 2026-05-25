import { describe, expect, test } from "bun:test";
import type { Editor } from "tldraw";
import { triggerAutoSize } from "./auto-size";

type MockShape = { id: string; type: string; props: Record<string, unknown> };
type Update = { id: string; type: string; props: Record<string, unknown> };

function makeMockEditor(shapes: MockShape[]): { editor: Editor; updates: Update[] } {
  const updates: Update[] = [];
  const editor = {
    getCurrentPageShapes: () => shapes,
    run: (fn: () => void) => fn(),
    updateShape: (u: Update) => {
      updates.push(u);
    },
  } as unknown as Editor;
  return { editor, updates };
}

describe("triggerAutoSize", () => {
  test("no-op when no shapes on page", () => {
    const { editor, updates } = makeMockEditor([]);
    triggerAutoSize(editor);
    expect(updates).toEqual([]);
  });

  test("triggers updateShape for geo with original props", () => {
    const props = { w: 100, h: 50, growY: 0 };
    const { editor, updates } = makeMockEditor([
      { id: "shape:a", type: "geo", props },
    ]);
    triggerAutoSize(editor);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({ id: "shape:a", type: "geo", props });
  });

  test("triggers updateShape for note", () => {
    const { editor, updates } = makeMockEditor([
      { id: "shape:b", type: "note", props: { growY: 0 } },
    ]);
    triggerAutoSize(editor);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.type).toBe("note");
    expect(updates[0]!.id).toBe("shape:b");
  });

  test("triggers updateShape for text", () => {
    const { editor, updates } = makeMockEditor([
      { id: "shape:c", type: "text", props: { autoSize: true } },
    ]);
    triggerAutoSize(editor);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.type).toBe("text");
  });

  test("ignores non-autosize types (group, frame, arrow, custom)", () => {
    const { editor, updates } = makeMockEditor([
      { id: "shape:d", type: "group", props: {} },
      { id: "shape:e", type: "frame", props: {} },
      { id: "shape:f", type: "schema-container", props: {} },
      { id: "shape:g", type: "arrow", props: {} },
    ]);
    triggerAutoSize(editor);
    expect(updates).toEqual([]);
  });

  test("filters by ids set when provided", () => {
    const { editor, updates } = makeMockEditor([
      { id: "shape:a", type: "geo", props: {} },
      { id: "shape:b", type: "note", props: {} },
      { id: "shape:c", type: "text", props: {} },
    ]);
    triggerAutoSize(editor, new Set(["shape:b"]));
    expect(updates).toHaveLength(1);
    expect(updates[0]!.id).toBe("shape:b");
  });

  test("ids filter excludes shapes not in the set even if type matches", () => {
    const { editor, updates } = makeMockEditor([
      { id: "shape:a", type: "geo", props: {} },
      { id: "shape:b", type: "geo", props: {} },
    ]);
    triggerAutoSize(editor, new Set(["shape:a"]));
    expect(updates).toHaveLength(1);
    expect(updates[0]!.id).toBe("shape:a");
  });

  test("mixed shapes: only autosize-capable types are triggered", () => {
    const { editor, updates } = makeMockEditor([
      { id: "shape:a", type: "geo", props: {} },
      { id: "shape:b", type: "note", props: {} },
      { id: "shape:c", type: "text", props: {} },
      { id: "shape:d", type: "group", props: {} },
      { id: "shape:e", type: "arrow", props: {} },
    ]);
    triggerAutoSize(editor);
    expect(updates).toHaveLength(3);
    expect(updates.map((u) => u.type).sort()).toEqual(["geo", "note", "text"]);
  });

  test("empty ids set yields no updates even when shapes exist", () => {
    const { editor, updates } = makeMockEditor([
      { id: "shape:a", type: "geo", props: {} },
    ]);
    triggerAutoSize(editor, new Set());
    expect(updates).toEqual([]);
  });
});
