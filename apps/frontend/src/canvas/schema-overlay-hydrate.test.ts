/**
 * DRW-135: Tests for schema-overlay-hydrate.
 *
 * Pure unit tests — real tldraw Editor не используется. Build mock-shapes и
 * проверяем pure helpers + applyOverlaysToShapes на минимальном Editor-mock.
 *
 * Coverage:
 *   - collectOverlayApplications: schema-frames только, skip empty/invalid overlays
 *   - findChildByNodeId: match по parent + didrawId
 *   - computeShapeUpdateFromOverlay: position diff, color diff, meta fields, no-op
 *   - applyOverlaysToShapes: end-to-end (sync calls updateShapes)
 */

import { describe, expect, it, mock } from "bun:test";
import type { Editor, TLShape } from "tldraw";
import {
  applyOverlaysToShapes,
  collectOverlayApplications,
  computeShapeUpdateFromOverlay,
  findChildByNodeId,
} from "./schema-overlay-hydrate";

function makeShape(overrides: Record<string, unknown> = {}): TLShape {
  return {
    id: "shape:test",
    typeName: "shape",
    type: "geo",
    parentId: "page:page",
    index: "a1",
    x: 100,
    y: 200,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {},
    props: { color: "blue", richText: undefined },
    ...overrides,
  } as unknown as TLShape;
}

describe("collectOverlayApplications", () => {
  it("returns empty for empty shapes", () => {
    expect(collectOverlayApplications([])).toEqual([]);
  });

  it("skips non-frame shapes", () => {
    const shape = makeShape({
      type: "geo",
      meta: {
        didrawSchemaFrame: true,
        didrawOverlays: { n1: { color: "red" } },
      },
    });
    expect(collectOverlayApplications([shape])).toEqual([]);
  });

  it("skips frames без didrawSchemaFrame discriminator", () => {
    const frame = makeShape({
      type: "frame",
      meta: { didrawOverlays: { n1: { color: "red" } } },
    });
    expect(collectOverlayApplications([frame])).toEqual([]);
  });

  it("skips frames с пустым/missing didrawOverlays", () => {
    const frame1 = makeShape({
      id: "shape:f1",
      type: "frame",
      meta: { didrawSchemaFrame: true },
    });
    const frame2 = makeShape({
      id: "shape:f2",
      type: "frame",
      meta: { didrawSchemaFrame: true, didrawOverlays: {} },
    });
    expect(collectOverlayApplications([frame1, frame2])).toEqual([]);
  });

  it("возвращает entries для каждого overlay в каждом schema-frame", () => {
    const frame1 = makeShape({
      id: "shape:f1",
      type: "frame",
      meta: {
        didrawSchemaFrame: true,
        didrawOverlays: {
          n1: { position: { x: 10, y: 20 } },
          n2: { color: "red" },
        },
      },
    });
    const frame2 = makeShape({
      id: "shape:f2",
      type: "frame",
      meta: {
        didrawSchemaFrame: true,
        didrawOverlays: { n3: { pinned: true } },
      },
    });
    const result = collectOverlayApplications([frame1, frame2]);
    expect(result).toHaveLength(3);
    expect(result).toContainEqual({
      frameId: "shape:f1",
      nodeId: "n1",
      overlay: { position: { x: 10, y: 20 } },
    });
    expect(result).toContainEqual({
      frameId: "shape:f1",
      nodeId: "n2",
      overlay: { color: "red" },
    });
    expect(result).toContainEqual({
      frameId: "shape:f2",
      nodeId: "n3",
      overlay: { pinned: true },
    });
  });
});

describe("findChildByNodeId", () => {
  it("matches на didrawSchemaParent + didrawId", () => {
    const child = makeShape({
      id: "shape:c1",
      meta: { didrawSchemaParent: "shape:f1", didrawId: "n1" },
    });
    const other = makeShape({
      id: "shape:c2",
      meta: { didrawSchemaParent: "shape:f1", didrawId: "n2" },
    });
    expect(findChildByNodeId([child, other], "shape:f1", "n1")).toBe(child);
  });

  it("returns undefined если nodeId не совпадает", () => {
    const child = makeShape({
      id: "shape:c1",
      meta: { didrawSchemaParent: "shape:f1", didrawId: "n1" },
    });
    expect(findChildByNodeId([child], "shape:f1", "missing")).toBeUndefined();
  });

  it("returns undefined если parent не совпадает", () => {
    const child = makeShape({
      id: "shape:c1",
      meta: { didrawSchemaParent: "shape:other", didrawId: "n1" },
    });
    expect(findChildByNodeId([child], "shape:f1", "n1")).toBeUndefined();
  });
});

describe("computeShapeUpdateFromOverlay", () => {
  it("returns null если overlay пустой", () => {
    const shape = makeShape();
    expect(computeShapeUpdateFromOverlay(shape, {})).toBeNull();
  });

  it("returns null если overlay.position совпадает с current", () => {
    const shape = makeShape({ x: 100, y: 200 });
    expect(
      computeShapeUpdateFromOverlay(shape, { position: { x: 100, y: 200 } }),
    ).toBeNull();
  });

  it("returns x/y update при overlay.position diff", () => {
    const shape = makeShape({ x: 100, y: 200 });
    const update = computeShapeUpdateFromOverlay(shape, {
      position: { x: 500, y: 600 },
    });
    expect(update).toEqual({
      id: shape.id,
      type: shape.type,
      x: 500,
      y: 600,
    });
  });

  it("returns props.geo + opacity update при overlay diff (DRW-215)", () => {
    const shape = makeShape({ props: { geo: "rectangle" }, opacity: 1 });
    const update = computeShapeUpdateFromOverlay(shape, {
      geo: "ellipse",
      opacity: 0.5,
    });
    expect(update).toEqual({
      id: shape.id,
      type: shape.type,
      opacity: 0.5,
      props: { geo: "ellipse" },
    });
  });

  it("returns null если geo/opacity совпадают (DRW-215)", () => {
    const shape = makeShape({ props: { geo: "ellipse" }, opacity: 0.5 });
    expect(
      computeShapeUpdateFromOverlay(shape, { geo: "ellipse", opacity: 0.5 }),
    ).toBeNull();
  });

  it("returns props.color update при overlay.color diff", () => {
    const shape = makeShape({ props: { color: "blue" } });
    const update = computeShapeUpdateFromOverlay(shape, { color: "red" });
    expect(update).toEqual({
      id: shape.id,
      type: shape.type,
      props: { color: "red" },
    });
  });

  it("coerces a raw hex overlay.color to the nearest palette name (DRW-231)", () => {
    const shape = makeShape({ props: { color: "blue" } });
    const update = computeShapeUpdateFromOverlay(shape, { color: "#6A1B9A" });
    expect(update).toEqual({
      id: shape.id,
      type: shape.type,
      props: { color: "violet" },
    });
  });

  it("skip's color update если совпадает", () => {
    const shape = makeShape({ props: { color: "red" } });
    expect(computeShapeUpdateFromOverlay(shape, { color: "red" })).toBeNull();
  });

  it("merges meta.role + styleOwnedBy + pinned в один update", () => {
    const shape = makeShape({
      meta: { didrawId: "n1", role: "actor", existing: "keep" },
    });
    const update = computeShapeUpdateFromOverlay(shape, {
      role: "service",
      styleOwnedBy: "user",
      pinned: true,
    });
    expect(update).toEqual({
      id: shape.id,
      type: shape.type,
      meta: {
        didrawId: "n1",
        existing: "keep",
        role: "service",
        styleOwnedBy: "user",
        pinned: true,
      },
    });
  });

  it("combines position + color + meta в single update", () => {
    const shape = makeShape({
      x: 0,
      y: 0,
      props: { color: "blue" },
      meta: { didrawId: "n1" },
    });
    const update = computeShapeUpdateFromOverlay(shape, {
      position: { x: 10, y: 20 },
      color: "red",
      role: "datastore",
      styleOwnedBy: "user",
    });
    expect(update).toMatchObject({
      x: 10,
      y: 20,
      props: { color: "red" },
      meta: { didrawId: "n1", role: "datastore", styleOwnedBy: "user" },
    });
  });
});

describe("applyOverlaysToShapes", () => {
  function makeEditor(shapes: TLShape[]): {
    editor: Editor;
    updateCalls: unknown[][];
  } {
    const updateCalls: unknown[][] = [];
    const editor = {
      getCurrentPageShapes: () => shapes,
      updateShapes: mock((updates: unknown[]) => {
        updateCalls.push(updates);
      }),
    } as unknown as Editor;
    return { editor, updateCalls };
  }

  it("returns 0 если нет schema-frames", () => {
    const { editor, updateCalls } = makeEditor([]);
    expect(applyOverlaysToShapes(editor)).toBe(0);
    expect(updateCalls).toHaveLength(0);
  });

  it("returns 0 если overlays нет no-op'нутся (no diff)", () => {
    const frame = makeShape({
      id: "shape:f1",
      type: "frame",
      meta: {
        didrawSchemaFrame: true,
        didrawOverlays: { n1: { position: { x: 50, y: 60 } } },
      },
    });
    const child = makeShape({
      id: "shape:c1",
      x: 50,
      y: 60,
      meta: { didrawSchemaParent: "shape:f1", didrawId: "n1" },
    });
    const { editor, updateCalls } = makeEditor([frame, child]);
    expect(applyOverlaysToShapes(editor)).toBe(0);
    expect(updateCalls).toHaveLength(0);
  });

  it("applies overlay position diff к ребёнку", () => {
    const frame = makeShape({
      id: "shape:f1",
      type: "frame",
      meta: {
        didrawSchemaFrame: true,
        didrawOverlays: {
          n1: { position: { x: 999, y: 888 }, styleOwnedBy: "user" },
        },
      },
    });
    const child = makeShape({
      id: "shape:c1",
      x: 50,
      y: 60,
      meta: { didrawSchemaParent: "shape:f1", didrawId: "n1" },
    });
    const { editor, updateCalls } = makeEditor([frame, child]);
    expect(applyOverlaysToShapes(editor)).toBe(1);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toEqual([
      {
        id: child.id,
        type: child.type,
        x: 999,
        y: 888,
        meta: {
          didrawSchemaParent: "shape:f1",
          didrawId: "n1",
          styleOwnedBy: "user",
        },
      },
    ]);
  });

  it("skips overlay для отсутствующих children (orphan)", () => {
    const frame = makeShape({
      id: "shape:f1",
      type: "frame",
      meta: {
        didrawSchemaFrame: true,
        didrawOverlays: { ghost: { position: { x: 1, y: 2 } } },
      },
    });
    const { editor, updateCalls } = makeEditor([frame]);
    expect(applyOverlaysToShapes(editor)).toBe(0);
    expect(updateCalls).toHaveLength(0);
  });

  it("обрабатывает multiple frames + multiple overlays в одном updateShapes call", () => {
    const frame1 = makeShape({
      id: "shape:f1",
      type: "frame",
      meta: {
        didrawSchemaFrame: true,
        didrawOverlays: {
          n1: { position: { x: 10, y: 20 } },
          n2: { color: "red" },
        },
      },
    });
    const frame2 = makeShape({
      id: "shape:f2",
      type: "frame",
      meta: {
        didrawSchemaFrame: true,
        didrawOverlays: { n3: { pinned: true } },
      },
    });
    const c1 = makeShape({
      id: "shape:c1",
      x: 0,
      y: 0,
      meta: { didrawSchemaParent: "shape:f1", didrawId: "n1" },
    });
    const c2 = makeShape({
      id: "shape:c2",
      props: { color: "blue" },
      meta: { didrawSchemaParent: "shape:f1", didrawId: "n2" },
    });
    const c3 = makeShape({
      id: "shape:c3",
      meta: { didrawSchemaParent: "shape:f2", didrawId: "n3" },
    });
    const { editor, updateCalls } = makeEditor([frame1, frame2, c1, c2, c3]);
    expect(applyOverlaysToShapes(editor)).toBe(3);
    expect(updateCalls).toHaveLength(1);
    expect((updateCalls[0] as unknown[]).length).toBe(3);
  });
});
