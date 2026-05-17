// Tests for mermaid-import meta-tagging logic (DRW-053).
//
// Scope:
//   - sourceTargetIds correctly identifies root-frame(s) of an import.
//   - Falls back to all root shapes when no frame is among roots.
//   - meta.mermaidSource is set on sourceTargetIds, NOT on child shapes.
//   - meta.didrawName uniquely assigned per-shape across the import.
//
// We mock createMermaidDiagram через monkey-patching the @tldraw/mermaid module
// доступа в runtime. Editor — минимальный fake без tldraw — только нужный
// surface (createShape/updateShapes mock + getCurrentPageShapes + meta on shapes).

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Fake shape factory ----------------------------------------------------------
type FakeShape = {
  id: string;
  typeName: "shape";
  type: string;
  parentId: string;
  meta: Record<string, unknown>;
  props: { richText?: { type: "doc"; content: unknown[] } };
};

function makeShape(id: string, type: string, parentId: string, label?: string): FakeShape {
  return {
    id: `shape:${id}`,
    typeName: "shape",
    type,
    parentId,
    meta: {},
    props: label
      ? {
          richText: {
            type: "doc",
            content: [{ type: "text", text: label } as unknown as object],
          },
        }
      : {},
  };
}

// Fake editor with just enough surface for importMermaid -----------------------
function makeFakeEditor(pageId: string) {
  let shapes: FakeShape[] = [];
  const editor = {
    getCurrentPageId: () => pageId,
    getCurrentPageShapes: () => shapes.slice(),
    getShape: (id: string) => shapes.find((s) => s.id === id),
    // biome-ignore lint/suspicious/noExplicitAny: fake editor
    updateShapes: (updates: Array<{ id: string; type: string; meta: any }>) => {
      for (const u of updates) {
        const s = shapes.find((x) => x.id === u.id);
        if (s) s.meta = { ...s.meta, ...u.meta };
      }
    },
    // Internal helper for tests (not on real Editor).
    _setShapes: (s: FakeShape[]) => {
      shapes = s.slice();
    },
    _addShapes: (s: FakeShape[]) => {
      shapes = shapes.concat(s);
    },
    _shapes: () => shapes,
  };
  return editor;
}

// renderPlaintextFromRichText mock — returns first text node's content.
// biome-ignore lint/suspicious/noExplicitAny: prosemirror doc shape
function fakeRenderPlaintext(_ed: unknown, doc: any): string {
  return doc?.content?.[0]?.text ?? "";
}

// Mock the tldraw + @tldraw/mermaid modules. We must do this BEFORE importing
// the module under test.
beforeEach(() => {
  // Mock tldraw renderPlaintextFromRichText.
  mock.module("tldraw", () => ({
    renderPlaintextFromRichText: fakeRenderPlaintext,
  }));
});

afterEach(() => {
  mock.restore();
});

// Helper: install a @tldraw/mermaid mock that adds the given shapes on
// createMermaidDiagram() call.
function mockMermaidCreates(addShapes: (editor: any) => void) {
  mock.module("@tldraw/mermaid", () => ({
    createMermaidDiagram: async (editor: any, _source: string) => {
      addShapes(editor);
    },
  }));
}

// --- Tests -------------------------------------------------------------------

describe("importMermaid — meta.mermaidSource", () => {
  test("saves mermaidSource on root frame when one exists", async () => {
    const PAGE = "page:page";
    const editor = makeFakeEditor(PAGE);
    mockMermaidCreates((ed) => {
      ed._addShapes([
        makeShape("frame1", "frame", PAGE),
        makeShape("node1", "geo", "shape:frame1", "Alpha"),
        makeShape("node2", "geo", "shape:frame1", "Beta"),
        makeShape("arrow1", "arrow", "shape:frame1"),
      ]);
    });

    const { importMermaid } = await import("./mermaid-import");
    const source = "graph TD\nA-->B";
    const res = await importMermaid(editor as never, source);

    expect(res.ok).toBe(true);
    expect(res.shapeIds.length).toBe(4);
    expect(res.sourceTargetIds.length).toBe(1);
    expect(res.sourceTargetIds[0]).toBe("shape:frame1" as never);

    const frame = editor._shapes().find((s) => s.id === "shape:frame1");
    const node1 = editor._shapes().find((s) => s.id === "shape:node1");
    expect(frame?.meta.mermaidSource).toBe(source);
    expect(node1?.meta.mermaidSource).toBeUndefined();
    // didrawName is set on every new shape.
    expect(frame?.meta.didrawName).toBeDefined();
    expect(node1?.meta.didrawName).toBe("alpha");
  });

  test("falls back to all root shapes when no frame present", async () => {
    const PAGE = "page:page";
    const editor = makeFakeEditor(PAGE);
    mockMermaidCreates((ed) => {
      ed._addShapes([
        makeShape("n1", "geo", PAGE, "Alpha"),
        makeShape("n2", "geo", PAGE, "Beta"),
        makeShape("a1", "arrow", PAGE),
      ]);
    });

    const { importMermaid } = await import("./mermaid-import");
    const source = "graph LR\nA-->B";
    const res = await importMermaid(editor as never, source);

    expect(res.sourceTargetIds.length).toBe(3);
    for (const s of editor._shapes()) {
      expect(s.meta.mermaidSource).toBe(source);
    }
  });

  test("does NOT tag pre-existing shapes", async () => {
    const PAGE = "page:page";
    const editor = makeFakeEditor(PAGE);
    editor._setShapes([makeShape("existing", "geo", PAGE, "old")]);
    mockMermaidCreates((ed) => {
      ed._addShapes([
        makeShape("new1", "frame", PAGE),
        makeShape("new2", "geo", "shape:new1", "New"),
      ]);
    });

    const { importMermaid } = await import("./mermaid-import");
    await importMermaid(editor as never, "graph TD\nA-->B");

    const existing = editor._shapes().find((s) => s.id === "shape:existing");
    expect(existing?.meta.mermaidSource).toBeUndefined();
  });

  test("dedupes didrawName across duplicate labels", async () => {
    const PAGE = "page:page";
    const editor = makeFakeEditor(PAGE);
    mockMermaidCreates((ed) => {
      ed._addShapes([
        makeShape("a", "geo", PAGE, "Same"),
        makeShape("b", "geo", PAGE, "Same"),
        makeShape("c", "geo", PAGE, "Same"),
      ]);
    });

    const { importMermaid } = await import("./mermaid-import");
    await importMermaid(editor as never, "graph TD\nA-->B");

    const names = editor._shapes().map((s) => s.meta.didrawName);
    expect(new Set(names).size).toBe(3); // unique
    expect(names).toContain("same");
    expect(names).toContain("same-2");
    expect(names).toContain("same-3");
  });

  test("throws when mermaid produces no shapes", async () => {
    const PAGE = "page:page";
    const editor = makeFakeEditor(PAGE);
    mockMermaidCreates(() => {
      // no-op — produce nothing.
    });

    const { importMermaid } = await import("./mermaid-import");
    await expect(importMermaid(editor as never, "")).rejects.toThrow(
      "mermaid produced no shapes",
    );
  });
});
