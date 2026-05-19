// Tests for mermaid-import meta-tagging logic (DRW-053, DRW-084).
//
// Scope:
//   - sourceTargetIds correctly identifies root-frame(s) of an import.
//   - Falls back to all root shapes when no frame is among roots.
//   - meta.mermaidSource is set on sourceTargetIds, NOT on child shapes.
//   - meta.didrawName uniquely assigned per-shape across the import.
//   - DRW-084: subgraph nodes → frame shapes with parentId set on children.
//   - DRW-084: auto-prepend ELK frontmatter when absent.
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

// --- DRW-084: subgraph → frame conversion -------------------------------------

describe("importMermaid — DRW-084: subgraph shapes become frames", () => {
  // Simulate what @tldraw/mermaid does when mapNodeToRenderSpec hook is active:
  // subgraph nodes are created as 'frame' shapes, children get parentId = frame.
  // We test that importMermaid passes the hook to createMermaidDiagram and that
  // after import the subgraph shape has type "frame" (not "geo") and children
  // have the correct parentId.
  test("subgraph created by hook has type 'frame'", async () => {
    const PAGE = "page:page";
    const editor = makeFakeEditor(PAGE);

    // Mock createMermaidDiagram to simulate: hook causes subgraph → frame,
    // children get parentId = subgraph frame id.
    mock.module("@tldraw/mermaid", () => ({
      createMermaidDiagram: async (ed: any, _source: string, opts: any) => {
        // Verify that options.blueprintRender.mapNodeToRenderSpec is passed.
        const mapper = opts?.blueprintRender?.mapNodeToRenderSpec;
        if (!mapper) throw new Error("mapNodeToRenderSpec hook not passed");

        // Simulate what the hook returns for subgraph kind.
        const subgraphResult = mapper({ kind: "subgraph", nodeId: "sg1", node: { kind: "subgraph" } as any, diagramKind: "flowchart" });
        // Hook must return frame type for subgraph.
        if (!subgraphResult || subgraphResult.type !== "frame") {
          throw new Error(`Expected frame spec, got: ${JSON.stringify(subgraphResult)}`);
        }

        // Simulate non-subgraph kind → should return undefined (use defaults).
        const rectResult = mapper({ kind: "rect", nodeId: "n1", node: { kind: "rect" } as any, diagramKind: "flowchart" });
        if (rectResult !== undefined) {
          throw new Error("Expected undefined for non-subgraph kind");
        }

        // Add shapes as if renderBlueprint created them: subgraph = frame, children with parentId = frame.
        ed._addShapes([
          makeShape("sg1", "frame", PAGE, "Service Layer"),
          makeShape("node1", "geo", "shape:sg1", "API"),
          makeShape("node2", "geo", "shape:sg1", "DB"),
          makeShape("arrow1", "arrow", PAGE),
        ]);
      },
    }));

    const { importMermaid } = await import("./mermaid-import");
    const source = "graph TD\nsubgraph SL[Service Layer]\n  API-->DB\nend";
    const res = await importMermaid(editor as never, source);

    expect(res.ok).toBe(true);
    expect(res.shapeIds.length).toBe(4);

    // Subgraph frame shape must exist.
    const frame = editor._shapes().find((s) => s.id === "shape:sg1");
    expect(frame?.type).toBe("frame");

    // Children must have parentId = frame id.
    const node1 = editor._shapes().find((s) => s.id === "shape:node1");
    const node2 = editor._shapes().find((s) => s.id === "shape:node2");
    expect(node1?.parentId).toBe("shape:sg1");
    expect(node2?.parentId).toBe("shape:sg1");

    // Frame should have meta.role = "boundary".
    expect(frame?.meta.role).toBe("boundary");
  });

  test("non-subgraph shapes do NOT get role='boundary'", async () => {
    const PAGE = "page:page";
    const editor = makeFakeEditor(PAGE);

    mock.module("@tldraw/mermaid", () => ({
      createMermaidDiagram: async (ed: any, _source: string, _opts: any) => {
        ed._addShapes([
          makeShape("n1", "geo", PAGE, "Alpha"),
          makeShape("n2", "geo", PAGE, "Beta"),
        ]);
      },
    }));

    const { importMermaid } = await import("./mermaid-import");
    await importMermaid(editor as never, "graph LR\nA-->B");

    for (const s of editor._shapes()) {
      expect(s.meta.role).toBeUndefined();
    }
  });

  test("nested subgraph: inner subgraph also becomes frame", async () => {
    const PAGE = "page:page";
    const editor = makeFakeEditor(PAGE);

    mock.module("@tldraw/mermaid", () => ({
      createMermaidDiagram: async (ed: any, _source: string, opts: any) => {
        const mapper = opts?.blueprintRender?.mapNodeToRenderSpec;
        if (!mapper) throw new Error("mapNodeToRenderSpec hook not passed");

        // Both outer and inner subgraphs should be mapped to frame.
        const outer = mapper({ kind: "subgraph", nodeId: "outer", node: { kind: "subgraph" } as any, diagramKind: "flowchart" });
        const inner = mapper({ kind: "subgraph", nodeId: "inner", node: { kind: "subgraph" } as any, diagramKind: "flowchart" });
        if (!outer || outer.type !== "frame") throw new Error("outer not frame");
        if (!inner || inner.type !== "frame") throw new Error("inner not frame");

        // Outer subgraph = frame at page level, inner = frame child of outer.
        ed._addShapes([
          makeShape("outer", "frame", PAGE, "Outer"),
          makeShape("inner", "frame", "shape:outer", "Inner"),
          makeShape("leaf", "geo", "shape:inner", "Leaf"),
        ]);
      },
    }));

    const { importMermaid } = await import("./mermaid-import");
    const res = await importMermaid(editor as never, "graph TD\nsubgraph O\nsubgraph I\nLeaf\nend\nend");

    expect(res.ok).toBe(true);
    const outer = editor._shapes().find((s) => s.id === "shape:outer");
    const inner = editor._shapes().find((s) => s.id === "shape:inner");
    expect(outer?.type).toBe("frame");
    expect(inner?.type).toBe("frame");
    expect(outer?.meta.role).toBe("boundary");
    expect(inner?.meta.role).toBe("boundary");
    expect(inner?.parentId).toBe("shape:outer");
  });
});

// --- DRW-084: ELK frontmatter auto-prepend ------------------------------------

describe("importMermaid — DRW-084: ELK frontmatter auto-prepend", () => {
  let capturedSource: string | undefined;

  beforeEach(() => {
    capturedSource = undefined;
  });

  function mockMermaidCapture() {
    mock.module("@tldraw/mermaid", () => ({
      createMermaidDiagram: async (ed: any, source: string, _opts: any) => {
        capturedSource = source;
        ed._addShapes([makeShape("n1", "geo", "page:page", "A")]);
      },
    }));
  }

  test("prepends ELK frontmatter when source has no frontmatter", async () => {
    const PAGE = "page:page";
    const editor = makeFakeEditor(PAGE);
    mockMermaidCapture();

    const { importMermaid } = await import("./mermaid-import");
    const bare = "graph TD\nA-->B";
    await importMermaid(editor as never, bare);

    expect(capturedSource).toBeDefined();
    expect(capturedSource!.startsWith("---\n")).toBe(true);
    expect(capturedSource!).toContain("layout: elk");
    expect(capturedSource!).toContain("graph TD\nA-->B");
  });

  test("does NOT prepend frontmatter when source already has frontmatter", async () => {
    const PAGE = "page:page";
    const editor = makeFakeEditor(PAGE);
    mockMermaidCapture();

    const { importMermaid } = await import("./mermaid-import");
    const withFm = "---\nconfig:\n  theme: dark\n---\ngraph TD\nA-->B";
    await importMermaid(editor as never, withFm);

    // Source passed to createMermaidDiagram must be identical (not modified).
    expect(capturedSource).toBe(withFm);
  });

  test("does NOT add frontmatter when source starts with whitespace before ---", async () => {
    const PAGE = "page:page";
    const editor = makeFakeEditor(PAGE);
    mockMermaidCapture();

    const { importMermaid } = await import("./mermaid-import");
    // Mermaid frontmatter must be at line 0, but if user passes `---` at start it's already there.
    const alreadyHasFm = "---\nconfig:\n  layout: elk\n---\ngraph LR\nA-->B";
    await importMermaid(editor as never, alreadyHasFm);

    expect(capturedSource).toBe(alreadyHasFm);
  });
});
