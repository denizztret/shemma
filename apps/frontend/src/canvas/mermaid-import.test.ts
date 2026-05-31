// Tests for mermaid-import meta-tagging logic (DRW-053, DRW-084, DRW-134 Task 2.6, DRW-148).
//
// Scope:
//   - sourceTargetIds correctly identifies root-frame(s) of an import.
//   - Falls back to all root shapes when no frame is among roots.
//   - meta.mermaidSource is set on sourceTargetIds, NOT on child shapes.
//   - meta.didrawId + meta.didrawLabel assigned per-shape (DRW-134 v2 identity).
//   - meta.didrawName mirrors NodeId for backward compat.
//   - DRW-084: subgraph nodes → frame shapes with parentId set on children.
//   - DRW-093: source passes through to createMermaidDiagram unchanged.
//   - DRW-134 Task 2.6: auto-ungroup cosmetic tldraw `group` shapes.
//   - DRW-134 Task 2.6: isCosmeticGroup heuristic.
//   - DRW-148: legacy path tested via importMermaidLegacy directly.
//             importMermaid() throws when backend fails (no silent v1 fallback).
//
// Legacy path tests call `importMermaidLegacy` directly (no v2 HTTP call).
// v2 path tests use mocked fetch.
//
// We mock createMermaidDiagram через monkey-patching the @tldraw/mermaid module
// доступа в runtime. Editor — минимальный fake без tldraw — только нужный
// surface (createShape/updateShapes mock + getCurrentPageShapes + meta on shapes).

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { samePositions } from "./mermaid-import";

// Fake shape factory ----------------------------------------------------------
type FakeShape = {
  id: string;
  typeName: "shape";
  type: string;
  parentId: string;
  meta: Record<string, unknown>;
  props: { richText?: { type: "doc"; content: unknown[] } };
};

function makeShape(
  id: string,
  type: string,
  parentId: string,
  label?: string,
): FakeShape {
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
    updateShapes: (
      updates: Array<{
        id: string;
        type: string;
        parentId?: string;
        meta: any;
      }>,
    ) => {
      for (const u of updates) {
        const s = shapes.find((x) => x.id === u.id);
        if (s) {
          s.meta = { ...s.meta, ...u.meta };
          if (u.parentId !== undefined) s.parentId = u.parentId;
        }
      }
    },
    // DRW-134 Task 2.6: deleteShape support for auto-ungroup.
    deleteShape: (id: unknown) => {
      shapes = shapes.filter((s) => s.id !== id);
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

describe("importMermaidLegacy — meta.mermaidSource", () => {
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

    // DRW-148: test legacy path directly via importMermaidLegacy.
    const { importMermaidLegacy } = await import("./mermaid-import");
    const source = "graph TD\nA-->B";
    const res = await importMermaidLegacy(editor as never, source);

    expect(res.ok).toBe(true);
    expect(res.shapeIds.length).toBe(4);
    expect(res.sourceTargetIds.length).toBe(1);
    expect(res.sourceTargetIds[0]).toBe("shape:frame1" as never);

    const frame = editor._shapes().find((s) => s.id === "shape:frame1");
    const node1 = editor._shapes().find((s) => s.id === "shape:node1");
    expect(frame?.meta.mermaidSource).toBe(source);
    expect(node1?.meta.mermaidSource).toBeUndefined();
    // DRW-134 Task 2.6: didrawId is now a NodeId (<slug>-<6char>), not a plain slug.
    // didrawName mirrors didrawId for backward compat.
    expect(frame?.meta.didrawId).toBeDefined();
    expect(node1?.meta.didrawId).toBeDefined();
    // didrawId starts with label-derived slug.
    expect(String(node1?.meta.didrawId)).toMatch(/^alpha-/);
    // didrawLabel stores original text.
    expect(node1?.meta.didrawLabel).toBe("Alpha");
    // didrawName mirrors didrawId (backward compat).
    expect(node1?.meta.didrawName).toBe(node1?.meta.didrawId);
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

    const { importMermaidLegacy } = await import("./mermaid-import");
    const source = "graph LR\nA-->B";
    const res = await importMermaidLegacy(editor as never, source);

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

    const { importMermaidLegacy } = await import("./mermaid-import");
    await importMermaidLegacy(editor as never, "graph TD\nA-->B");

    const existing = editor._shapes().find((s) => s.id === "shape:existing");
    expect(existing?.meta.mermaidSource).toBeUndefined();
  });

  test("dedupes didrawId across duplicate labels (all NodeIds unique)", async () => {
    const PAGE = "page:page";
    const editor = makeFakeEditor(PAGE);
    mockMermaidCreates((ed) => {
      ed._addShapes([
        makeShape("a", "geo", PAGE, "Same"),
        makeShape("b", "geo", PAGE, "Same"),
        makeShape("c", "geo", PAGE, "Same"),
      ]);
    });

    const { importMermaidLegacy } = await import("./mermaid-import");
    await importMermaidLegacy(editor as never, "graph TD\nA-->B");

    // DRW-134 Task 2.6: didrawId collision prevention via generateNodeId retry × 8.
    // With random RNG, all 3 NodeIds should be unique (collision probability negligible).
    const ids = editor._shapes().map((s) => s.meta.didrawId);
    expect(new Set(ids).size).toBe(3); // unique NodeIds
    // All start with slug derived from "Same".
    for (const id of ids) {
      expect(String(id)).toMatch(/^same-/);
    }
  });

  test("throws when mermaid produces no shapes", async () => {
    const PAGE = "page:page";
    const editor = makeFakeEditor(PAGE);
    mockMermaidCreates(() => {
      // no-op — produce nothing.
    });

    const { importMermaidLegacy } = await import("./mermaid-import");
    await expect(
      importMermaidLegacy(editor as never, ""),
    ).rejects.toThrow("mermaid produced no shapes");
  });
});

// --- DRW-084 hotfix: subgraph → geo+role='boundary' hybrid strategy -----------
//
// Strategy B (hybrid): mapNodeToRenderSpec is removed; subgraph nodes render as
// default geo shapes (library default). importMermaid detects containers by
// heuristic: geo shape with at least one new child (newShape.parentId === s.id).
// Such containers get meta.role = 'boundary'. Children parentId is handled by
// renderBlueprint automatically from blueprint node.parentId.

describe("importMermaidLegacy — DRW-084: subgraph remains geo with meta.role='boundary'", () => {
  // Simulate what @tldraw/mermaid does without mapNodeToRenderSpec hook:
  // subgraph nodes are created as default 'geo' shapes, children get parentId = subgraph geo id.
  // We test that importMermaidLegacy does NOT pass mapNodeToRenderSpec and that
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
        if (mapper)
          throw new Error(
            "mapNodeToRenderSpec hook must NOT be passed in hybrid strategy",
          );

        // Library default: subgraph → geo, children get parentId = subgraph geo id.
        ed._addShapes([
          makeShape("sg1", "geo", PAGE, "Service Layer"),
          makeShape("node1", "geo", "shape:sg1", "API"),
          makeShape("node2", "geo", "shape:sg1", "DB"),
          makeShape("arrow1", "arrow", PAGE),
        ]);
      },
    }));

    // DRW-148: test legacy path directly via importMermaidLegacy.
    const { importMermaidLegacy } = await import("./mermaid-import");
    const source = "graph TD\nsubgraph SL[Service Layer]\n  API-->DB\nend";
    const res = await importMermaidLegacy(editor as never, source);

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

    const { importMermaidLegacy } = await import("./mermaid-import");
    await importMermaidLegacy(editor as never, "graph LR\nA-->B");

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

    const { importMermaidLegacy } = await import("./mermaid-import");
    const res = await importMermaidLegacy(
      editor as never,
      "graph TD\nsubgraph O\nsubgraph I\nLeaf\nend\nend",
    );

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
    const boundsMap: Record<
      string,
      { x: number; y: number; w: number; h: number }
    > = {
      "shape:a": makeBox(0, 0, 100, 50),
      "shape:b": makeBox(200, 100, 80, 60),
    };
    (editor as unknown as Record<string, unknown>).getShapePageBounds = (
      id: string,
    ) => boundsMap[id] ?? undefined;

    const { unionBoundsOf } = await import("./mermaid-import");
    const result = unionBoundsOf(editor as never, [
      "shape:a" as never,
      "shape:b" as never,
    ]);
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
    (editor as unknown as Record<string, unknown>).getShapePageBounds = (
      _id: string,
    ) => undefined;

    const { unionBoundsOf } = await import("./mermaid-import");
    const result = unionBoundsOf(editor as never, ["shape:a" as never]);
    expect(result).toBeNull();
  });

  test("returns null for empty shapeIds array", async () => {
    const PAGE = "page:page";
    const editor = makeFakeEditor(PAGE);
    (editor as unknown as Record<string, unknown>).getShapePageBounds = (
      _id: string,
    ) => undefined;

    const { unionBoundsOf } = await import("./mermaid-import");
    const result = unionBoundsOf(editor as never, []);
    expect(result).toBeNull();
  });

  test("returns single box when only one shape", async () => {
    const PAGE = "page:page";
    const editor = makeFakeEditor(PAGE);
    (editor as unknown as Record<string, unknown>).getShapePageBounds = (
      id: string,
    ) => {
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

describe("samePositions (Stage 1 harvest stability)", () => {
  test("true for identical maps", () => {
    const a = { x: { x: 1, y: 2, w: 3, h: 4 }, y: { x: 5, y: 6, w: 7, h: 8 } };
    const b = { x: { x: 1, y: 2, w: 3, h: 4 }, y: { x: 5, y: 6, w: 7, h: 8 } };
    expect(samePositions(a, b)).toBe(true);
  });
  test("false when a coord differs", () => {
    const a = { x: { x: 1, y: 2, w: 3, h: 4 } };
    const b = { x: { x: 1, y: 2, w: 3, h: 5 } };
    expect(samePositions(a, b)).toBe(false);
  });
  test("false when key sets differ", () => {
    expect(samePositions({ x: { x: 0, y: 0, w: 0, h: 0 } }, {})).toBe(false);
  });
});

// --- DRW-096: isBoundsContained helper ---------------------------------------

describe("isBoundsContained (DRW-096)", () => {
  test("inner fully inside outer → true", async () => {
    const { isBoundsContained } = await import("./mermaid-import");
    expect(
      isBoundsContained(
        { x: 10, y: 10, w: 20, h: 20 },
        { x: 0, y: 0, w: 100, h: 100 },
      ),
    ).toBe(true);
  });

  test("inner overlaps but extends beyond outer → false", async () => {
    const { isBoundsContained } = await import("./mermaid-import");
    expect(
      isBoundsContained(
        { x: 80, y: 0, w: 50, h: 50 },
        { x: 0, y: 0, w: 100, h: 100 },
      ),
    ).toBe(false);
  });

  test("inner completely outside outer → false", async () => {
    const { isBoundsContained } = await import("./mermaid-import");
    expect(
      isBoundsContained(
        { x: 200, y: 200, w: 50, h: 50 },
        { x: 0, y: 0, w: 100, h: 100 },
      ),
    ).toBe(false);
  });

  test("inner touches edge but stays inside → true", async () => {
    const { isBoundsContained } = await import("./mermaid-import");
    expect(
      isBoundsContained(
        { x: 0, y: 0, w: 100, h: 100 },
        { x: 0, y: 0, w: 100, h: 100 },
      ),
    ).toBe(true);
  });
});

// --- DRW-093: source passes through unchanged ---------------------------------

describe("importMermaidLegacy — DRW-093: source passes through unchanged", () => {
  test("source is not modified before reaching createMermaidDiagram", async () => {
    const PAGE = "page:page";
    const editor = makeFakeEditor(PAGE);
    let capturedSource: string | undefined;
    mock.module("@tldraw/mermaid", () => ({
      createMermaidDiagram: async (ed: any, source: string, _opts: any) => {
        capturedSource = source;
        ed._addShapes([makeShape("n1", "geo", "page:page", "A")]);
      },
    }));

    // DRW-148: test legacy path directly via importMermaidLegacy.
    const { importMermaidLegacy } = await import("./mermaid-import");
    const bare = "graph TD\nA-->B";
    await importMermaidLegacy(editor as never, bare);

    expect(capturedSource).toBe(bare);
  });
});

// --- DRW-134 Task 2.6: isCosmeticGroup heuristic ---------------------------------

describe("isCosmeticGroup (DRW-134 Task 2.6)", () => {
  test("group without meta → cosmetic", async () => {
    const { isCosmeticGroup } = await import("./mermaid-import");
    const shape = makeShape("g1", "group", "page:page");
    expect(isCosmeticGroup(shape as never)).toBe(true);
  });

  test("group with meta.role='boundary' → NOT cosmetic (semantic)", async () => {
    const { isCosmeticGroup } = await import("./mermaid-import");
    const shape = makeShape("g1", "group", "page:page");
    shape.meta.role = "boundary";
    expect(isCosmeticGroup(shape as never)).toBe(false);
  });

  test("group with meta.didrawId → NOT cosmetic (v2 identity assigned)", async () => {
    const { isCosmeticGroup } = await import("./mermaid-import");
    const shape = makeShape("g1", "group", "page:page");
    shape.meta.didrawId = "auth-abc123";
    expect(isCosmeticGroup(shape as never)).toBe(false);
  });

  test("group with meta.didrawName → NOT cosmetic (legacy identity assigned)", async () => {
    const { isCosmeticGroup } = await import("./mermaid-import");
    const shape = makeShape("g1", "group", "page:page");
    shape.meta.didrawName = "auth-service";
    expect(isCosmeticGroup(shape as never)).toBe(false);
  });

  test("non-group shape → NOT cosmetic", async () => {
    const { isCosmeticGroup } = await import("./mermaid-import");
    const shape = makeShape("s1", "geo", "page:page");
    expect(isCosmeticGroup(shape as never)).toBe(false);
  });
});

// --- DRW-134 Task 2.6: auto-ungroup cosmetic tldraw group shapes ---------------

describe("importMermaidLegacy — auto-ungroup cosmetic tldraw group (DRW-134 Task 2.6)", () => {
  test("cosmetic group dissolved: children re-parented to frame, group deleted", async () => {
    const PAGE = "page:page";
    const editor = makeFakeEditor(PAGE);

    // createMermaidDiagram creates: frame → cosmetic group → 2 children
    mock.module("@tldraw/mermaid", () => ({
      createMermaidDiagram: async (ed: any, _source: string) => {
        ed._addShapes([
          makeShape("frame1", "frame", PAGE),
          // cosmetic group wrapping — no semantic meta
          makeShape("cg1", "group", "shape:frame1"),
          makeShape("node1", "geo", "shape:cg1", "API"),
          makeShape("node2", "geo", "shape:cg1", "DB"),
        ]);
      },
    }));

    // DRW-148: test legacy path directly via importMermaidLegacy.
    const { importMermaidLegacy } = await import("./mermaid-import");
    const res = await importMermaidLegacy(editor as never, "graph LR\nA-->B");

    expect(res.ok).toBe(true);
    // Cosmetic group (cg1) should be deleted.
    const shapes = editor._shapes();
    expect(shapes.find((s) => s.id === "shape:cg1")).toBeUndefined();
    // Children should be re-parented to the frame (group's parent).
    const node1 = shapes.find((s) => s.id === "shape:node1");
    const node2 = shapes.find((s) => s.id === "shape:node2");
    expect(node1?.parentId).toBe("shape:frame1");
    expect(node2?.parentId).toBe("shape:frame1");
  });

  test("boundary group (meta.role=boundary) is preserved — NOT ungrouped", async () => {
    const PAGE = "page:page";
    const editor = makeFakeEditor(PAGE);

    mock.module("@tldraw/mermaid", () => ({
      createMermaidDiagram: async (ed: any, _source: string) => {
        ed._addShapes([
          makeShape("frame1", "frame", PAGE),
          // semantic group — has role=boundary (subgraph)
          {
            ...makeShape("sg1", "group", "shape:frame1"),
            meta: { role: "boundary" },
          },
          makeShape("node1", "geo", "shape:sg1", "API"),
        ]);
      },
    }));

    const { importMermaidLegacy } = await import("./mermaid-import");
    await importMermaidLegacy(editor as never, "graph LR\nsubgraph SL\nA\nend");

    const shapes = editor._shapes();
    // Semantic group preserved.
    const sg1 = shapes.find((s) => s.id === "shape:sg1");
    expect(sg1).toBeDefined();
    // Child still parented to group.
    const node1 = shapes.find((s) => s.id === "shape:node1");
    expect(node1?.parentId).toBe("shape:sg1");
  });
});

// --- DRW-134 Task 2.6: v2 frame meta assignment (legacy path) ----------------

describe("importMermaidLegacy — v2 frame meta (DRW-134 Task 2.6)", () => {
  test("root frame gets didrawSchemaFrame, didrawProtocol, didrawOverlays", async () => {
    const PAGE = "page:page";
    const editor = makeFakeEditor(PAGE);
    mockMermaidCreates((ed) => {
      ed._addShapes([
        makeShape("frame1", "frame", PAGE),
        makeShape("child1", "geo", "shape:frame1", "API"),
      ]);
    });

    // DRW-148: test legacy path directly via importMermaidLegacy.
    const { importMermaidLegacy } = await import("./mermaid-import");
    await importMermaidLegacy(editor as never, "graph LR\nA-->B");

    const frame = editor._shapes().find((s) => s.id === "shape:frame1");
    expect(frame?.meta.didrawSchemaFrame).toBe(true);
    expect(frame?.meta.didrawProtocol).toBe("v2");
    expect(frame?.meta.schemaProtocolVersion).toBe("1.0");
    expect(frame?.meta.didrawOverlays).toEqual({});
  });

  test("all didrawId values unique within import", async () => {
    const PAGE = "page:page";
    const editor = makeFakeEditor(PAGE);
    mockMermaidCreates((ed) => {
      ed._addShapes([
        makeShape("frame1", "frame", PAGE),
        makeShape("n1", "geo", "shape:frame1", "Alpha"),
        makeShape("n2", "geo", "shape:frame1", "Beta"),
        makeShape("n3", "geo", "shape:frame1", "Gamma"),
      ]);
    });

    const { importMermaidLegacy } = await import("./mermaid-import");
    await importMermaidLegacy(editor as never, "graph LR\nA-->B-->C");

    const shapes = editor._shapes();
    const ids = shapes.map((s) => s.meta.didrawId as string).filter(Boolean);
    expect(ids.length).toBe(4); // frame + 3 nodes
    expect(new Set(ids).size).toBe(4); // all unique
  });
});

// --- DRW-134 Task 2.6: v2 backend path (HTTP call) ---------------------------

describe("importMermaid — v2 backend path (DRW-134 Task 2.6)", () => {
  test("calls POST /api/schema/create and returns frameId + nodeIds on success", async () => {
    const PAGE = "page:page";
    const editor = makeFakeEditor(PAGE);

    // Mock global fetch for v2 path.
    const originalFetch = globalThis.fetch;
    let capturedRequest: { url: string; body: unknown } | undefined;
    globalThis.fetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedRequest = {
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      return new Response(
        JSON.stringify({
          ok: true,
          frameId: "shape:f_test123",
          nodeIds: ["api-aaaaaa", "db-bbbbbb"],
          version: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const { importMermaid } = await import("./mermaid-import");
      const source = "graph LR\napi[API] --> db[Database]";
      const res = await importMermaid(editor as never, source, {
        space: "__test__",
        room: "room1",
      });

      expect(res.ok).toBe(true);
      expect(res.frameId).toBe("shape:f_test123");
      expect(res.nodeIds).toEqual(["api-aaaaaa", "db-bbbbbb"]);
      // v2 path: no local shapes written.
      expect(res.shapeIds).toEqual([]);
      expect(res.sourceTargetIds).toEqual([]);

      // Verify HTTP call was made.
      expect(capturedRequest).toBeDefined();
      expect(capturedRequest?.url).toContain("/api/schema/create");
      expect(capturedRequest?.url).toContain("space=__test__");
      expect(capturedRequest?.url).toContain("room=room1");
      expect(capturedRequest?.body).toMatchObject({ raw: source });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // DRW-148: v2 is the ONLY path — no silent fallback to v1 on backend failure.
  test("throws when backend returns error (no silent v1 fallback)", async () => {
    const PAGE = "page:page";
    const editor = makeFakeEditor(PAGE);

    // Mock fetch to return 503.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "service unavailable" }), {
        status: 503,
      })) as unknown as typeof fetch;

    try {
      const { importMermaid } = await import("./mermaid-import");
      // DRW-148: must throw — no fallback.
      await expect(
        importMermaid(editor as never, "graph LR\nA-->B"),
      ).rejects.toThrow();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// --- DRW-141: inferMermaidLabel — frame name derivation ----------------------

describe("inferMermaidLabel (DRW-141)", () => {
  test("falls back to \"Imported schema\" for bare flowchart with bracketed nodes", async () => {
    const { inferMermaidLabel } = await import("./mermaid-import");
    // Pre-fix this yielded "x[Browser X]" — the leaked raw mermaid identifier.
    expect(
      inferMermaidLabel("graph TD\n  x[Browser X]\n  y[Browser Y]\n  x --> y"),
    ).toBe("Browser X");
  });

  test("returns \"Imported schema\" for graph header with no labelled nodes", async () => {
    const { inferMermaidLabel } = await import("./mermaid-import");
    expect(inferMermaidLabel("graph LR\nA-->B")).toBe("Imported schema");
  });

  test("%% comment wins over node label", async () => {
    const { inferMermaidLabel } = await import("./mermaid-import");
    expect(
      inferMermaidLabel("graph TD\n%% My Diagram\n  x[Node] --> y[Other]"),
    ).toBe("My Diagram");
  });

  test("quoted graph title is used as label", async () => {
    const { inferMermaidLabel } = await import("./mermaid-import");
    expect(inferMermaidLabel('graph LR "Architecture"\nA-->B')).toBe(
      "Architecture",
    );
    expect(inferMermaidLabel('flowchart TB "Pipelines"\nA-->B')).toBe(
      "Pipelines",
    );
  });

  test("subgraph display label is preferred over first node", async () => {
    const { inferMermaidLabel } = await import("./mermaid-import");
    expect(
      inferMermaidLabel(
        "graph TD\nsubgraph backend [Backend Services]\n  api[API] --> db[Database]\nend",
      ),
    ).toBe("Backend Services");
  });

  test("returns first node label when no header metadata present", async () => {
    const { inferMermaidLabel } = await import("./mermaid-import");
    expect(inferMermaidLabel("api[API Gateway]\ndb[(Postgres)]")).toBe(
      "API Gateway",
    );
  });

  test("empty source → fallback", async () => {
    const { inferMermaidLabel } = await import("./mermaid-import");
    expect(inferMermaidLabel("")).toBe("Imported schema");
  });

  test("opts.label override beats inference (v2 backend path)", async () => {
    const PAGE = "page:page";
    const editor = makeFakeEditor(PAGE);

    const originalFetch = globalThis.fetch;
    let captured: { label?: string } = {};
    globalThis.fetch = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      captured = init?.body
        ? (JSON.parse(String(init.body)) as { label?: string })
        : {};
      return new Response(
        JSON.stringify({
          ok: true,
          frameId: "shape:f_x",
          nodeIds: [],
          version: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const { importMermaid } = await import("./mermaid-import");
      await importMermaid(editor as never, "graph TD\n  x[Browser X]", {
        space: "__test__",
        room: "r1",
        label: "Explicit Title",
      });
      expect(captured.label).toBe("Explicit Title");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("v2 backend path receives inferred label, not raw identifier", async () => {
    const PAGE = "page:page";
    const editor = makeFakeEditor(PAGE);

    const originalFetch = globalThis.fetch;
    let captured: { label?: string } = {};
    globalThis.fetch = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      captured = init?.body
        ? (JSON.parse(String(init.body)) as { label?: string })
        : {};
      return new Response(
        JSON.stringify({
          ok: true,
          frameId: "shape:f_x",
          nodeIds: ["browser_x-aaaaaa"],
          version: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const { importMermaid } = await import("./mermaid-import");
      await importMermaid(
        editor as never,
        "graph TD\n  x[Browser X]\n  y[Browser Y]\n  x --> y",
        { space: "__test__", room: "r1" },
      );
      // Pre-fix this was "x[Browser X]" (leaked identifier line).
      expect(captured.label).toBe("Browser X");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("ensureElkLoader — idempotent ELK loader registration", () => {
  test("registers exactly once across multiple calls; returns true", async () => {
    let registerCalls = 0;
    mock.module("mermaid", () => ({
      default: {
        registerLayoutLoaders: (_loaders: unknown) => {
          registerCalls++;
        },
      },
    }));
    mock.module("@mermaid-js/layout-elk", () => ({ default: [{ name: "elk" }] }));

    const { ensureElkLoader, __resetElkLoaderForTest } = await import(
      "./mermaid-import"
    );
    __resetElkLoaderForTest();

    const r1 = await ensureElkLoader();
    const r2 = await ensureElkLoader();
    const r3 = await ensureElkLoader();

    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(r3).toBe(true);
    expect(registerCalls).toBe(1);
  });

  test("returns false (no throw) when registration fails", async () => {
    mock.module("mermaid", () => ({
      default: {
        registerLayoutLoaders: () => {
          throw new Error("loader incompatible");
        },
      },
    }));
    mock.module("@mermaid-js/layout-elk", () => ({ default: [] }));

    const { ensureElkLoader, __resetElkLoaderForTest } = await import(
      "./mermaid-import"
    );
    __resetElkLoaderForTest();

    const r = await ensureElkLoader();
    expect(r).toBe(false);
  });
});

// Хелпер: мок createMermaidDiagram, запоминающий переданные options.
function mockMermaidCapture(): { calls: Array<{ source: string; options: unknown }> } {
  const calls: Array<{ source: string; options: unknown }> = [];
  mock.module("@tldraw/mermaid", () => ({
    createMermaidDiagram: async (
      editor: any,
      source: string,
      options?: unknown,
    ) => {
      calls.push({ source, options });
      // добавить минимальный root frame, чтобы importMermaidLegacy не бросил "no shapes"
      editor._addShapes([makeShape("f1", "frame", editor.getCurrentPageId(), "F")]);
    },
  }));
  return { calls };
}

describe("importMermaidLegacy — layout option passthrough", () => {
  test("dagre (no opts): createMermaidDiagram called WITHOUT mermaidConfig.layout", async () => {
    const cap = mockMermaidCapture();
    const editor = makeFakeEditor("page:page");
    const { importMermaidLegacy } = await import("./mermaid-import");
    await importMermaidLegacy(editor as never, "graph LR\nA-->B");
    expect(cap.calls).toHaveLength(1);
    const opts = cap.calls[0]!.options as { mermaidConfig?: { layout?: string } } | undefined;
    expect(opts?.mermaidConfig?.layout).toBeUndefined();
  });

  test("elk: createMermaidDiagram called WITH mermaidConfig.layout='elk'", async () => {
    const cap = mockMermaidCapture();
    const editor = makeFakeEditor("page:page");
    const { importMermaidLegacy } = await import("./mermaid-import");
    await importMermaidLegacy(editor as never, "graph LR\nA-->B", { layout: "elk" });
    expect(cap.calls).toHaveLength(1);
    const opts = cap.calls[0]!.options as { mermaidConfig?: { layout?: string } };
    expect(opts.mermaidConfig?.layout).toBe("elk");
  });
});

describe("computeImportOriginX", () => {
  const vp = { x: 1000, y: 0, w: 800, h: 600, minX: 1000 } as any;

  test("with page content: maxX + GAP", async () => {
    const { computeImportOriginX, IMPORT_GAP } = await import("./mermaid-import");
    const pageBounds = { x: 0, y: 0, w: 500, h: 300, maxX: 500 } as any;
    expect(computeImportOriginX(pageBounds, vp)).toBe(500 + IMPORT_GAP);
  });

  test("empty page (pageBounds undefined): viewport minX", async () => {
    const { computeImportOriginX } = await import("./mermaid-import");
    expect(computeImportOriginX(undefined, vp)).toBe(1000);
  });
});

describe("repositionToOriginX", () => {
  test("shifts root shapes so union minX == originX", async () => {
    const moved: Array<{ id: string; x: number }> = [];
    const bounds: Record<string, { x: number; y: number; w: number; h: number }> = {
      "shape:root": { x: 50, y: 0, w: 100, h: 80 },
      "shape:child": { x: 60, y: 10, w: 40, h: 20 },
    };
    const shapesById: Record<string, { id: string; type: string; x: number }> = {
      "shape:root": { id: "shape:root", type: "frame", x: 50 },
      "shape:child": { id: "shape:child", type: "geo", x: 10 },
    };
    const editor = {
      getShapePageBounds: (id: string) => bounds[id],
      getShape: (id: string) => shapesById[id],
      updateShapes: (ups: Array<{ id: string; x: number }>) => {
        for (const u of ups) moved.push({ id: u.id, x: u.x });
      },
    };
    const { repositionToOriginX } = await import("./mermaid-import");
    repositionToOriginX(
      editor as never,
      ["shape:root"] as never,
      ["shape:root", "shape:child"] as never,
      1000,
    );
    // union minX = 50, originX = 1000 → dx = 950 → root.x 50→1000
    expect(moved).toEqual([{ id: "shape:root", x: 1000 }]);
  });

  test("no-op when union bounds null (no shapes)", async () => {
    const editor = {
      getShapePageBounds: () => undefined,
      getShape: () => undefined,
      updateShapes: () => {
        throw new Error("should not be called");
      },
    };
    const { repositionToOriginX } = await import("./mermaid-import");
    expect(() =>
      repositionToOriginX(editor as never, [] as never, [] as never, 1000),
    ).not.toThrow();
  });
});

describe("repositionCustomFrameWhenReady", () => {
  test("moves frame once it appears in store", async () => {
    let polls = 0;
    const moved: Array<{ id: string; x: number }> = [];
    const editor = {
      getShape: (_id: string) => {
        polls++;
        return polls >= 2 ? { id: "shape:f", type: "frame", x: 30 } : undefined;
      },
      getShapePageBounds: (_id: string) => ({ x: 30, y: 0, w: 100, h: 50 }),
      updateShape: (u: { id: string; x: number }) => moved.push(u),
    };
    const { repositionCustomFrameWhenReady } = await import("./mermaid-import");
    await repositionCustomFrameWhenReady(editor as never, "shape:f", 500, {
      intervalMs: 1,
      timeoutMs: 100,
    });
    // bounds.x=30, originX=500 → dx=470 → frame.x 30→500
    expect(moved).toEqual([{ id: "shape:f", type: "frame", x: 500 }]);
  });

  test("gives up after timeout without throwing when frame never appears", async () => {
    const editor = {
      getShape: () => undefined,
      getShapePageBounds: () => undefined,
      updateShape: () => {
        throw new Error("should not move");
      },
    };
    const { repositionCustomFrameWhenReady } = await import("./mermaid-import");
    await expect(
      repositionCustomFrameWhenReady(editor as never, "shape:f", 500, {
        intervalMs: 1,
        timeoutMs: 10,
      }),
    ).resolves.toBeUndefined();
  });
});

// --- Stage 1: harvestRecordFromBlueprintNode (pure mapper helper) ------------

describe("harvestRecordFromBlueprintNode (Stage 1)", () => {
  test("keeps mermaid id key + flat coords; returns undefined", async () => {
    const { harvestRecordFromBlueprintNode } = await import("./mermaid-import");
    const out: Record<string, { x: number; y: number; w: number; h: number }> = {};
    // tldraw 5.0.0 mapper input is a WRAPPER: { nodeId, node, diagramKind, kind }
    const input = { nodeId: "api", node: { id: "api", x: 10, y: 20, w: 120, h: 60, kind: "square" }, diagramKind: "flowchart", kind: "square" };
    const ret = harvestRecordFromBlueprintNode(out, input as any);
    expect(ret).toBeUndefined();
    expect(out.api).toEqual({ x: 10, y: 20, w: 120, h: 60 });
  });
});

describe("importMermaidWithEngine — routing", () => {
  function fakeEditorWithBounds(pageId: string) {
    const e = makeFakeEditor(pageId) as any;
    e.getCurrentPageBounds = () => undefined; // пустая страница
    e.getViewportPageBounds = () => ({ x: 0, y: 0, w: 800, h: 600, minX: 0 });
    e.getShapePageBounds = (_id: string) => ({ x: 0, y: 0, w: 100, h: 50 });
    // Stage 1: scratch-page support for harvestMermaidPositions
    e.getPages = () => [{ id: pageId }];
    e.createPage = (_opts: unknown) => { e._scratchPageCreated = true; };
    e.setCurrentPage = (_id: string) => {};
    e.deletePage = (_id: string) => {};
    e.run = (fn: () => void, _opts?: unknown) => { fn(); };
    // After createPage call getPages returns scratch too (simulated by mockMermaidCapture)
    return e;
  }

  // Хелпер: мок createMermaidDiagram для harvest-path (scratch page).
  // Для harvestMermaidPositions: editor.getPages() должен вернуть scratch после createPage.
  function mockMermaidCaptureWithScratch(pageId: string): { calls: Array<{ source: string; options: unknown }> } {
    const calls: Array<{ source: string; options: unknown }> = [];
    mock.module("@tldraw/mermaid", () => ({
      createMermaidDiagram: async (
        editor: any,
        source: string,
        options?: unknown,
      ) => {
        calls.push({ source, options });
        // Harvest path calls createMermaidDiagram on scratch page — no shapes needed for harvest
        // (positions come from blueprintRender.mapNodeToRenderSpec callback).
        // Call the mapper for a fake node so harvestMermaidPositions gets at least one entry.
        const opts = options as any;
        if (opts?.blueprintRender?.mapNodeToRenderSpec) {
          opts.blueprintRender.mapNodeToRenderSpec({
            nodeId: "a",
            node: { id: "a", x: 0, y: 0, w: 100, h: 50, kind: "square" },
          });
        }
      },
    }));
    return { calls };
  }

  test("dagre → harvest via createMermaidDiagram (no layout), then backend fetch, engineUsed='dagre'", async () => {
    const editor = fakeEditorWithBounds("page:page");
    // Track getPages calls to simulate scratch page discovery.
    // Stability-loop may call harvestMermaidPositionsOnce multiple times;
    // each call does 2 getPages invocations (before + after createPage).
    // Odd calls = "before createPage", even calls = "after createPage" (with scratch).
    let pageCallCount = 0;
    editor.getPages = () => {
      pageCallCount++;
      if (pageCallCount % 2 === 1) return [{ id: "page:page" }]; // before createPage
      return [{ id: "page:page" }, { id: "page:scratch" }]; // after createPage
    };

    const cap = mockMermaidCaptureWithScratch("page:page");
    const fetchMock = mock(async () =>
      new Response(JSON.stringify({ ok: true, frameId: "shape:f", nodeIds: [], version: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    (globalThis as any).fetch = fetchMock;

    const { importMermaidWithEngine } = await import("./mermaid-import");
    const res = await importMermaidWithEngine(editor as never, "graph LR\nA-->B", "dagre", {
      space: "s", room: "r",
    });
    // Harvest called createMermaidDiagram with blueprintRender hook (no mermaidConfig.layout).
    // Stability-loop may call it 1-N times depending on warm state; first call sets the engine.
    expect(cap.calls.length).toBeGreaterThanOrEqual(1);
    expect((cap.calls[0]!.options as any)?.mermaidConfig?.layout).toBeUndefined();
    // Then backend was called.
    expect(fetchMock).toHaveBeenCalled();
    expect(res.engineUsed).toBe("dagre");
    expect(res.engineFallback).toBeFalsy();
  });

  test("elk (loader ok) → harvest with layout:elk, then backend fetch, engineUsed='elk'", async () => {
    const editor = fakeEditorWithBounds("page:page");
    // Odd getPages calls = "before createPage", even = "after createPage" (with scratch).
    let pageCallCount = 0;
    editor.getPages = () => {
      pageCallCount++;
      if (pageCallCount % 2 === 1) return [{ id: "page:page" }];
      return [{ id: "page:page" }, { id: "page:scratch" }];
    };

    mock.module("mermaid", () => ({ default: { registerLayoutLoaders: () => {} } }));
    mock.module("@mermaid-js/layout-elk", () => ({ default: [] }));
    const cap = mockMermaidCaptureWithScratch("page:page");
    const fetchMock = mock(async () =>
      new Response(JSON.stringify({ ok: true, frameId: "shape:f", nodeIds: [], version: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    (globalThis as any).fetch = fetchMock;

    const { importMermaidWithEngine, __resetElkLoaderForTest } = await import("./mermaid-import");
    __resetElkLoaderForTest();
    const res = await importMermaidWithEngine(editor as never, "graph LR\nA-->B", "elk", {
      space: "s", room: "r",
    });
    // All harvest calls must use mermaidConfig.layout='elk' (stability-loop reuses same opts).
    expect(cap.calls.length).toBeGreaterThanOrEqual(1);
    expect((cap.calls[0]!.options as any).mermaidConfig?.layout).toBe("elk");
    expect(fetchMock).toHaveBeenCalled();
    expect(res.engineUsed).toBe("elk");
    expect(res.engineFallback).toBe(false);
  });

  test("elk (loader fails) → falls back to dagre harvest (no layout), engineFallback=true", async () => {
    const editor = fakeEditorWithBounds("page:page");
    // Odd getPages calls = "before createPage", even = "after createPage" (with scratch).
    let pageCallCount = 0;
    editor.getPages = () => {
      pageCallCount++;
      if (pageCallCount % 2 === 1) return [{ id: "page:page" }];
      return [{ id: "page:page" }, { id: "page:scratch" }];
    };

    mock.module("mermaid", () => ({
      default: { registerLayoutLoaders: () => { throw new Error("bad"); } },
    }));
    mock.module("@mermaid-js/layout-elk", () => ({ default: [] }));
    const cap = mockMermaidCaptureWithScratch("page:page");
    const fetchMock = mock(async () =>
      new Response(JSON.stringify({ ok: true, frameId: "shape:f", nodeIds: [], version: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    (globalThis as any).fetch = fetchMock;

    const { importMermaidWithEngine, __resetElkLoaderForTest } = await import("./mermaid-import");
    __resetElkLoaderForTest();
    const res = await importMermaidWithEngine(editor as never, "graph LR\nA-->B", "elk", {
      space: "s", room: "r",
    });
    // Dagre fallback: no layout in mermaidConfig.
    expect(cap.calls.length).toBeGreaterThanOrEqual(1);
    expect((cap.calls[0]!.options as any)?.mermaidConfig?.layout).toBeUndefined();
    expect(fetchMock).toHaveBeenCalled();
    expect(res.engineUsed).toBe("dagre");
    expect(res.engineFallback).toBe(true);
  });

  test("custom → backend path, createMermaidDiagram NOT called", async () => {
    const cap = mockMermaidCapture();
    const fetchMock = mock(async () =>
      new Response(JSON.stringify({ ok: true, frameId: "shape:f", nodeIds: [], version: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    (globalThis as any).fetch = fetchMock;
    const editor = fakeEditorWithBounds("page:page");
    const { importMermaidWithEngine } = await import("./mermaid-import");
    const res = await importMermaidWithEngine(editor as never, "graph LR\nA-->B", "custom", {
      space: "s", room: "r",
    });
    expect(cap.calls).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalled();
    expect(res.engineUsed).toBe("custom");
    expect(res.frameId).toBe("shape:f");
  });
});
