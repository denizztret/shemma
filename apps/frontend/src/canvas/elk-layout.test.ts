import { describe, expect, it } from "bun:test";
import type { Editor, TLShape, TLShapeId } from "tldraw";
import {
  growWrappersForShapes,
  isFlipEligible,
  resolveContainerDir,
  segmentIntersectsRect,
} from "./elk-layout";

// Minimal shape-like factory: isFlipEligible only reads props.direction and the
// meta direction/inherited markers.
const container = (
  props: { direction?: string },
  meta: { didrawDirection?: string; didrawDirectionInherited?: boolean } = {},
): TLShape =>
  ({ type: "schema-container", props, meta }) as unknown as TLShape;

describe("isFlipEligible", () => {
  it("inherit placeholder (marker set) IS flippable — engine optimises sense", () => {
    expect(
      isFlipEligible(
        container({ direction: "TB" }, { didrawDirectionInherited: true }),
        false,
      ),
    ).toBe(true);
  });

  it('"custom" (auto/inherit) IS flippable', () => {
    expect(isFlipEligible(container({ direction: "custom" }), false)).toBe(true);
  });

  it("explicit cardinal direction is NOT flippable — user sense honoured", () => {
    expect(isFlipEligible(container({ direction: "LR" }), false)).toBe(false);
    expect(isFlipEligible(container({ direction: "RL" }), false)).toBe(false);
    expect(isFlipEligible(container({ direction: "TB" }), false)).toBe(false);
    expect(isFlipEligible(container({ direction: "BT" }), false)).toBe(false);
  });

  it("inherited marker wins over a structural props.direction default", () => {
    expect(
      isFlipEligible(
        container({ direction: "LR" }, { didrawDirectionInherited: true }),
        false,
      ),
    ).toBe(true);
  });

  it("explicit direction via meta fallback (no props) is NOT flippable", () => {
    expect(isFlipEligible(container({}, { didrawDirection: "LR" }), false)).toBe(
      false,
    );
  });

  it("forceDirections (⌘⌥⇧L clean-slate) re-enables flipping for explicit too", () => {
    expect(isFlipEligible(container({ direction: "LR" }), true)).toBe(true);
  });
});

describe("segmentIntersectsRect", () => {
  const rect = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

  it("detects a segment passing through the box", () => {
    expect(
      segmentIntersectsRect({ x: -50, y: 50 }, { x: 150, y: 50 }, rect, 0),
    ).toBe(true);
  });

  it("detects a segment ending inside the box", () => {
    expect(
      segmentIntersectsRect({ x: -50, y: 50 }, { x: 50, y: 50 }, rect, 0),
    ).toBe(true);
  });

  it("misses a segment clearly outside", () => {
    expect(
      segmentIntersectsRect({ x: -50, y: 200 }, { x: 150, y: 200 }, rect, 0),
    ).toBe(false);
  });

  it("negative pad ignores a segment that only grazes the edge", () => {
    // runs exactly along the top edge (y=0); a -3 inset shrinks the box so the
    // grazing line no longer counts as biting in.
    expect(
      segmentIntersectsRect({ x: -50, y: 0 }, { x: 150, y: 0 }, rect, -3),
    ).toBe(false);
    // 2px inside the edge still counts as a real clip under the same inset.
    expect(
      segmentIntersectsRect({ x: -50, y: 5 }, { x: 150, y: 5 }, rect, -3),
    ).toBe(true);
  });

  it("positive pad flags a near-touch just outside the box", () => {
    expect(
      segmentIntersectsRect({ x: -50, y: -4 }, { x: 150, y: -4 }, rect, 6),
    ).toBe(true);
  });
});

describe("resolveContainerDir (inheritMode)", () => {
  const inherit = container({ direction: "custom" }, { didrawDirectionInherited: true });
  const explicit = container({ direction: "RL" });
  const kids = new Set(["a", "b"]);
  const flowEdges = [{ from: "a", to: "b" }]; // internal flow between own kids
  const noEdges: Array<{ from: string; to: string }> = [];

  it('"perp" forces an inherit container perpendicular to the frame', () => {
    expect(resolveContainerDir(inherit, kids, "LR", flowEdges, false, "perp")).toBe("TB");
    expect(resolveContainerDir(inherit, kids, "TB", flowEdges, false, "perp")).toBe("LR");
  });

  it('"auto" uses the internal-flow rule (flow→along, bundle→perp)', () => {
    expect(resolveContainerDir(inherit, kids, "LR", flowEdges, false, "auto")).toBe("LR");
    expect(resolveContainerDir(inherit, kids, "LR", noEdges, false, "auto")).toBe("TB");
  });

  it("explicit direction wins over every inheritMode (unless forceDirections)", () => {
    expect(resolveContainerDir(explicit, kids, "LR", flowEdges, false, "perp")).toBe("RL");
    // forceDirections re-infers — the explicit "RL" is ignored, mode applies.
    expect(resolveContainerDir(explicit, kids, "LR", flowEdges, true, "perp")).toBe("TB");
  });
});

// === DRW-232: growWrappersForShapes (auto-envelope grow-only) ===
//
// Fake editor over a flat shape map. Covers только то, что нужно хелперу:
// getShape, getCurrentPageShapes (для childrenOf), updateShape (props/meta merge).
type FakeShape = {
  id: string;
  type: string;
  x: number;
  y: number;
  props: { w?: number; h?: number; growY?: number };
  meta?: Record<string, unknown>;
  parentId: string;
};

function fakeEditor(shapes: FakeShape[]): {
  editor: Editor;
  propsOf: (id: string) => { w?: number; h?: number; growY?: number };
} {
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const editor = {
    getShape: (id: TLShapeId) => byId.get(id as unknown as string),
    getCurrentPageShapes: () => [...byId.values()],
    updateShape: (partial: {
      id: string;
      props?: Record<string, unknown>;
      meta?: Record<string, unknown>;
    }) => {
      const s = byId.get(partial.id);
      if (!s) return;
      if (partial.props) s.props = { ...s.props, ...partial.props };
      if (partial.meta) s.meta = { ...(s.meta ?? {}), ...partial.meta };
    },
  } as unknown as Editor;
  const propsOf = (id: string) => {
    const s = byId.get(id);
    if (!s) throw new Error(`fakeEditor: no shape ${id}`);
    return s.props;
  };
  return { editor, propsOf };
}

describe("DRW-232 growWrappersForShapes — auto-envelope grow-only", () => {
  const frame = (over: Partial<FakeShape> = {}): FakeShape => ({
    id: "shape:f",
    type: "frame",
    x: 0,
    y: 0,
    props: { w: 100, h: 100 },
    parentId: "page:p",
    ...over,
  });
  const containerC = (over: Partial<FakeShape> = {}): FakeShape => ({
    id: "shape:c",
    type: "schema-container",
    x: 10,
    y: 10,
    props: { w: 50, h: 50 },
    parentId: "shape:f",
    ...over,
  });

  it("grows container AND frame inner→outer to contain an oversized nested node", () => {
    const { editor, propsOf } = fakeEditor([
      frame(),
      containerC(),
      {
        id: "shape:g",
        type: "geo",
        x: 5,
        y: 5,
        props: { w: 200, h: 30 },
        parentId: "shape:c",
      },
    ]);
    const grew = growWrappersForShapes(editor, ["shape:g"]);
    expect(grew).toBe(true);
    // container: content right 5+200=205, bottom 5+30=35; pad 16.
    expect(propsOf("shape:c")).toMatchObject({ w: 221, h: 51 });
    // frame sees the GROWN container (10+221=231, 10+51=61); pad 56.
    expect(propsOf("shape:f")).toMatchObject({ w: 287, h: 117 });
  });

  it("is idempotent: a node that already fits writes nothing (loop-safe)", () => {
    const { editor, propsOf } = fakeEditor([
      frame({ props: { w: 300, h: 300 } }),
      containerC({ props: { w: 200, h: 200 } }),
      {
        id: "shape:g",
        type: "geo",
        x: 5,
        y: 5,
        props: { w: 20, h: 20 },
        parentId: "shape:c",
      },
    ]);
    const grew = growWrappersForShapes(editor, ["shape:g"]);
    expect(grew).toBe(false);
    expect(propsOf("shape:c")).toMatchObject({ w: 200, h: 200 });
    expect(propsOf("shape:f")).toMatchObject({ w: 300, h: 300 });
  });

  it("never shrinks a wrapper (grow-only) when a child is smaller than slack", () => {
    const { editor, propsOf } = fakeEditor([
      frame({ props: { w: 500, h: 500 } }),
      {
        id: "shape:g",
        type: "geo",
        x: 5,
        y: 5,
        props: { w: 20, h: 20 },
        parentId: "shape:f",
      },
    ]);
    growWrappersForShapes(editor, ["shape:g"]);
    expect(propsOf("shape:f")).toMatchObject({ w: 500, h: 500 });
  });

  it("respects a user-pinned wrapper size (AC #7) — grows container, leaves frame", () => {
    const { editor, propsOf } = fakeEditor([
      frame({
        props: { w: 100, h: 100 },
        meta: { didrawSizePinned: true, didrawSizeOrigin: "user" },
      }),
      containerC(),
      {
        id: "shape:g",
        type: "geo",
        x: 5,
        y: 5,
        props: { w: 200, h: 30 },
        parentId: "shape:c",
      },
    ]);
    growWrappersForShapes(editor, ["shape:g"]);
    // container still grows (not pinned)…
    expect(propsOf("shape:c")).toMatchObject({ w: 221, h: 51 });
    // …but the user-pinned frame is left exactly as the user sized it.
    expect(propsOf("shape:f")).toMatchObject({ w: 100, h: 100 });
  });

  it("accounts for growY in a child's effective height", () => {
    const { editor, propsOf } = fakeEditor([
      frame({ props: { w: 100, h: 100 } }),
      {
        id: "shape:g",
        type: "note",
        x: 0,
        y: 0,
        props: { w: 40, h: 20, growY: 60 },
        parentId: "shape:f",
      },
    ]);
    growWrappersForShapes(editor, ["shape:g"]);
    // effective height = 20 + 60 = 80; bottom 0+80=80; pad 56 → 136.
    expect(propsOf("shape:f")).toMatchObject({ w: 100, h: 136 });
  });

  it("returns false when the trigger shape has no wrapper ancestor", () => {
    const { editor } = fakeEditor([
      {
        id: "shape:g",
        type: "geo",
        x: 0,
        y: 0,
        props: { w: 40, h: 20 },
        parentId: "page:p",
      },
    ]);
    expect(growWrappersForShapes(editor, ["shape:g"])).toBe(false);
  });
});
