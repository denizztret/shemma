import { describe, expect, it } from "bun:test";
import type { Editor, TLShape, TLShapeId } from "tldraw";
import { resolveLayoutScope } from "./layout-scope";

// Minimal fake: enough for getShape / getCurrentPageShapes walks.
function fakeEditor(shapes: Array<Partial<TLShape> & { id: string }>): Editor {
  const byId = new Map(shapes.map((s) => [s.id, s as TLShape]));
  return {
    getShape: (id: TLShapeId) => byId.get(id as string),
    getCurrentPageShapes: () => [...byId.values()],
    getViewportPageBounds: () => ({ center: { x: 0, y: 0 } }),
    getShapePageBounds: () => undefined,
  } as unknown as Editor;
}

const frame = { id: "shape:f1", type: "frame", parentId: "page:1", meta: {} };
const container = (id: string, parentId: string) => ({
  id,
  type: "schema-container",
  parentId,
  props: {},
  meta: {},
});
const geo = (id: string, parentId: string) => ({
  id,
  type: "geo",
  parentId,
  meta: {},
});

describe("resolveLayoutScope", () => {
  it("exactly one selected schema-container → container scope (DRW-233)", () => {
    const ed = fakeEditor([frame, container("shape:c1", "shape:f1")]);
    expect(resolveLayoutScope(ed, ["shape:c1" as TLShapeId])).toEqual({
      kind: "container",
      containerId: "shape:c1",
    });
  });

  it("a selected leaf inside a frame → frame scope", () => {
    const ed = fakeEditor([frame, geo("shape:g1", "shape:f1")]);
    expect(resolveLayoutScope(ed, ["shape:g1" as TLShapeId])).toEqual({
      kind: "frame",
      frameId: "shape:f1",
    });
  });

  it("multi-selection that includes a container → frame scope (not container)", () => {
    const ed = fakeEditor([
      frame,
      container("shape:c1", "shape:f1"),
      geo("shape:g1", "shape:f1"),
    ]);
    expect(
      resolveLayoutScope(ed, ["shape:c1", "shape:g1"] as TLShapeId[]),
    ).toEqual({ kind: "frame", frameId: "shape:f1" });
  });

  it("≥2 page-level nodes without a frame → loose scope", () => {
    const ed = fakeEditor([
      geo("shape:g1", "page:1"),
      geo("shape:g2", "page:1"),
    ]);
    expect(
      resolveLayoutScope(ed, ["shape:g1", "shape:g2"] as TLShapeId[]),
    ).toEqual({ kind: "loose", ids: ["shape:g1", "shape:g2"] });
  });

  it("page-level single container → container scope (frameless container)", () => {
    const ed = fakeEditor([container("shape:c1", "page:1")]);
    expect(resolveLayoutScope(ed, ["shape:c1" as TLShapeId])).toEqual({
      kind: "container",
      containerId: "shape:c1",
    });
  });

  it("nested container: selected one whose parent is a container → ITS scope", () => {
    const ed = fakeEditor([
      frame,
      container("shape:c1", "shape:f1"),
      container("shape:c2", "shape:c1"),
    ]);
    expect(resolveLayoutScope(ed, ["shape:c2" as TLShapeId])).toEqual({
      kind: "container",
      containerId: "shape:c2",
    });
  });

  it("empty selection + единственный фрейм → fallback frame scope", () => {
    const ed = fakeEditor([frame]);
    expect(resolveLayoutScope(ed, [])).toEqual({
      kind: "frame",
      frameId: "shape:f1",
    });
  });

  it("nothing layoutable → none with a reason", () => {
    const ed = fakeEditor([]);
    const r = resolveLayoutScope(ed, []);
    expect(r.kind).toBe("none");
  });
});
