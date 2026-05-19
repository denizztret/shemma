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

// --- DRW-084 hotfix: subgraph → geo+role='boundary' hybrid strategy -----------
//
// Strategy B (hybrid): mapNodeToRenderSpec is removed; subgraph nodes render as
// default geo shapes (library default). importMermaid detects containers by
// heuristic: geo shape with at least one new child (newShape.parentId === s.id).
// Such containers get meta.role = 'boundary'. Children parentId is handled by
// renderBlueprint automatically from blueprint node.parentId.

describe("importMermaid — DRW-084: subgraph remains geo with meta.role='boundary'", () => {
  // Simulate what @tldraw/mermaid does without mapNodeToRenderSpec hook:
  // subgraph nodes are created as default 'geo' shapes, children get parentId = subgraph geo id.
  // We test that importMermaid does NOT pass mapNodeToRenderSpec and that
  // after import the subgraph shape has type "geo" + meta.role="boundary",
  // and children have the correct parentId.
  test("subgraph remains geo with meta.role='boundary'", async () => {
    const PAGE = "page:page";
    const editor = makeFakeEditor(PAGE);

    // Mock createMermaidDiagram — library creates subgraph as default geo (no hook).
    mock.module("@tldraw/mermaid", () => ({
      createMermaidDiagram: async (ed: any, _source: string, opts: any) => {
        // Verify that mapNodeToRenderSpec hook is NOT passed (no frame override).
        const mapper = opts?.blueprintRender?.mapNodeToRenderSpec;
        if (mapper) throw new Error("mapNodeToRenderSpec hook must NOT be passed in hybrid strategy");

        // Library default: subgraph → geo, children get parentId = subgraph geo id.
        ed._addShapes([
          makeShape("sg1", "geo", PAGE, "Service Layer"),
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

    // Subgraph shape must be geo (not frame).
    const sg1 = editor._shapes().find((s) => s.id === "shape:sg1");
    expect(sg1?.type).toBe("geo");

    // Children must have parentId = subgraph geo id.
    const node1 = editor._shapes().find((s) => s.id === "shape:node1");
    const node2 = editor._shapes().find((s) => s.id === "shape:node2");
    expect(node1?.parentId).toBe("shape:sg1");
    expect(node2?.parentId).toBe("shape:sg1");

    // Subgraph geo container must have meta.role = "boundary".
    expect(sg1?.meta.role).toBe("boundary");

    // Leaf nodes must NOT have role.
    expect(node1?.meta.role).toBeUndefined();
    expect(node2?.meta.role).toBeUndefined();
  });

  test("non-subgraph shapes do NOT get role='boundary'", async () => {
    const PAGE = "page:page";
    const editor = makeFakeEditor(PAGE);

    mock.module("@tldraw/mermaid", () => ({
      createMermaidDiagram: async (ed: any, _source: string, _opts: any) => {
        // Flat diagram — no parent-child relationships, all at page level.
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

  test("nested subgraph: both inner and outer geo containers get role='boundary'", async () => {
    const PAGE = "page:page";
    const editor = makeFakeEditor(PAGE);

    mock.module("@tldraw/mermaid", () => ({
      createMermaidDiagram: async (ed: any, _source: string, _opts: any) => {
        // Nested: outer subgraph at page level, inner at outer level, leaf inside inner.
        ed._addShapes([
          makeShape("outer", "geo", PAGE, "Outer"),
          makeShape("inner", "geo", "shape:outer", "Inner"),
          makeShape("leaf", "geo", "shape:inner", "Leaf"),
        ]);
      },
    }));

    const { importMermaid } = await import("./mermaid-import");
    const res = await importMermaid(editor as never, "graph TD\nsubgraph O\nsubgraph I\nLeaf\nend\nend");

    expect(res.ok).toBe(true);
    const outer = editor._shapes().find((s) => s.id === "shape:outer");
    const inner = editor._shapes().find((s) => s.id === "shape:inner");
    const leaf = editor._shapes().find((s) => s.id === "shape:leaf");

    // Both containers must be geo + role=boundary.
    expect(outer?.type).toBe("geo");
    expect(inner?.type).toBe("geo");
    expect(outer?.meta.role).toBe("boundary");
    expect(inner?.meta.role).toBe("boundary");

    // Leaf has no children → no role.
    expect(leaf?.meta.role).toBeUndefined();

    expect(inner?.parentId).toBe("shape:outer");
  });
});

// --- DRW-086: unionBoundsOf helper -------------------------------------------

describe("unionBoundsOf (DRW-086)", () => {
  // Mock Box class for union calculation
  function makeBox(x: number, y: number, w: number, h: number) {
    return { x, y, w, h };
  }

  test("returns union box for multiple shapes with bounds", async () => {
    const PAGE = "page:page";
    const editor = makeFakeEditor(PAGE);
    // Augment fake editor with getShapePageBounds
    const boundsMap: Record<string, { x: number; y: number; w: number; h: number }> = {
      "shape:a": makeBox(0, 0, 100, 50),
      "shape:b": makeBox(200, 100, 80, 60),
    };
    (editor as unknown as Record<string, unknown>).getShapePageBounds = (id: string) => boundsMap[id] ?? undefined;

    const { unionBoundsOf } = await import("./mermaid-import");
    const result = unionBoundsOf(editor as never, ["shape:a" as never, "shape:b" as never]);
    // Union of (0,0,100,50) and (200,100,80,60) should produce (0,0,280,160)
    expect(result).not.toBeNull();
    expect(result!.x).toBe(0);
    expect(result!.y).toBe(0);
    expect(result!.w).toBe(280);
    expect(result!.h).toBe(160);
  });

  test("returns null when no shapes have bounds", async () => {
    const PAGE = "page:page";
    const editor = makeFakeEditor(PAGE);
    (editor as unknown as Record<string, unknown>).getShapePageBounds = (_id: string) => undefined;

    const { unionBoundsOf } = await import("./mermaid-import");
    const result = unionBoundsOf(editor as never, ["shape:a" as never]);
    expect(result).toBeNull();
  });

  test("returns null for empty shapeIds array", async () => {
    const PAGE = "page:page";
    const editor = makeFakeEditor(PAGE);
    (editor as unknown as Record<string, unknown>).getShapePageBounds = (_id: string) => undefined;

    const { unionBoundsOf } = await import("./mermaid-import");
    const result = unionBoundsOf(editor as never, []);
    expect(result).toBeNull();
  });

  test("returns single box when only one shape", async () => {
    const PAGE = "page:page";
    const editor = makeFakeEditor(PAGE);
    (editor as unknown as Record<string, unknown>).getShapePageBounds = (id: string) => {
      if (id === "shape:solo") return makeBox(10, 20, 50, 30);
      return undefined;
    };

    const { unionBoundsOf } = await import("./mermaid-import");
    const result = unionBoundsOf(editor as never, ["shape:solo" as never]);
    expect(result).not.toBeNull();
    expect(result!.x).toBe(10);
    expect(result!.y).toBe(20);
    expect(result!.w).toBe(50);
    expect(result!.h).toBe(30);
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
