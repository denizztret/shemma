import { describe, expect, it } from "bun:test";
import { resolvePageBounds, computeCentroid, type RawShape } from "./coords";

function shape(id: string, x: number, y: number, w: number, h: number, parentId?: string): RawShape {
  return { id, typeName: "shape", x, y, parentId, props: { w, h } };
}

describe("resolvePageBounds — top-level shape", () => {
  it("shape with parentId='page:page' returns absolute coords as stored", () => {
    const store = {
      "shape:a": shape("shape:a", 100, 200, 50, 80, "page:page"),
    };
    const r = resolvePageBounds("shape:a", store);
    expect(r).toEqual({ x: 100, y: 200, w: 50, h: 80 });
  });

  it("shape without parentId returns coords as stored", () => {
    const store = {
      "shape:b": shape("shape:b", 10, 20, 5, 6),
    };
    expect(resolvePageBounds("shape:b", store)).toEqual({ x: 10, y: 20, w: 5, h: 6 });
  });
});

describe("resolvePageBounds — frame children (parent-relative)", () => {
  it("single nesting: child x/y are relative to parent frame", () => {
    const store = {
      "shape:frame": shape("shape:frame", 100, 100, 200, 200, "page:page"),
      "shape:child": shape("shape:child", 10, 10, 30, 30, "shape:frame"),
    };
    const r = resolvePageBounds("shape:child", store);
    expect(r).toEqual({ x: 110, y: 110, w: 30, h: 30 });
  });

  it("deep nesting: walks parent chain bottom-up", () => {
    const store = {
      "shape:outer": shape("shape:outer", 100, 100, 500, 500, "page:page"),
      "shape:mid": shape("shape:mid", 20, 20, 200, 200, "shape:outer"),
      "shape:leaf": shape("shape:leaf", 5, 5, 50, 50, "shape:mid"),
    };
    expect(resolvePageBounds("shape:leaf", store)).toEqual({ x: 125, y: 125, w: 50, h: 50 });
  });

  it("missing shape returns null", () => {
    expect(resolvePageBounds("shape:missing", {})).toBeNull();
  });

  it("broken parent chain (parent not in store) stops walking, returns partial sum", () => {
    const store = {
      "shape:orphan": shape("shape:orphan", 50, 60, 10, 10, "shape:gone"),
    };
    expect(resolvePageBounds("shape:orphan", store)).toEqual({ x: 50, y: 60, w: 10, h: 10 });
  });
});

describe("computeCentroid", () => {
  it("single shape: centroid = center of shape", () => {
    const bounds = [{ x: 100, y: 100, w: 50, h: 80 }];
    expect(computeCentroid(bounds)).toEqual({ x: 125, y: 140 });
  });

  it("two shapes: centroid = center of bbox enclosing both", () => {
    const bounds = [
      { x: 100, y: 100, w: 50, h: 50 },
      { x: 200, y: 200, w: 50, h: 50 },
    ];
    expect(computeCentroid(bounds)).toEqual({ x: 175, y: 175 });
  });

  it("empty array returns (0, 0)", () => {
    expect(computeCentroid([])).toEqual({ x: 0, y: 0 });
  });
});
