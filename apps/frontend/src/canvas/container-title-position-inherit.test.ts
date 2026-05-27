// apps/frontend/src/canvas/container-title-position-inherit.test.ts
//
// DRW-186 frame-scope — pure-helper тест applyFrameTitlePositionInheritance.
// Full side-effect wiring проверяется live; здесь — coercion + scope logic.

import { describe, expect, it } from "bun:test";
import type { TLShape } from "tldraw";
import { applyFrameTitlePositionInheritance } from "./container-title-position-inherit";

type ParentLookup = Parameters<typeof applyFrameTitlePositionInheritance>[1];

function makeShape(overrides: Partial<TLShape> & { type: string }): TLShape {
  return {
    id: "shape:c1",
    type: overrides.type,
    parentId: overrides.parentId,
    props: overrides.props ?? { titlePosition: "inside-center" },
  } as unknown as TLShape;
}

function makeLookup(map: Record<string, { type?: string; meta?: Record<string, unknown> }>): ParentLookup {
  return (id) => map[id];
}

describe("applyFrameTitlePositionInheritance", () => {
  it("non-schema-container shape — pass-through", () => {
    const shape = makeShape({ type: "geo", parentId: "shape:f1" });
    const out = applyFrameTitlePositionInheritance(
      shape,
      makeLookup({
        "shape:f1": { type: "frame", meta: { didrawContainerTitlePosition: "outside-banner" } },
      }),
    );
    expect(out).toBe(shape);
  });

  it("schema-container без parentId — pass-through", () => {
    const shape = makeShape({ type: "schema-container" });
    const out = applyFrameTitlePositionInheritance(shape, makeLookup({}));
    expect(out).toBe(shape);
  });

  it("parent не Frame — pass-through", () => {
    const shape = makeShape({ type: "schema-container", parentId: "shape:p1" });
    const out = applyFrameTitlePositionInheritance(
      shape,
      makeLookup({ "shape:p1": { type: "schema-container", meta: { didrawContainerTitlePosition: "inside-left" } } }),
    );
    expect(out).toBe(shape);
  });

  it("parent — Frame без meta — pass-through", () => {
    const shape = makeShape({ type: "schema-container", parentId: "shape:f1" });
    const out = applyFrameTitlePositionInheritance(
      shape,
      makeLookup({ "shape:f1": { type: "frame", meta: {} } }),
    );
    expect(out).toBe(shape);
  });

  it("parent — Frame с meta — инжектирует titlePosition", () => {
    const shape = makeShape({
      type: "schema-container",
      parentId: "shape:f1",
      props: { titlePosition: "inside-center", color: "blue" } as unknown as TLShape["props"],
    });
    const out = applyFrameTitlePositionInheritance(
      shape,
      makeLookup({
        "shape:f1": { type: "frame", meta: { didrawContainerTitlePosition: "outside-banner" } },
      }),
    );
    expect((out.props as { titlePosition?: string }).titlePosition).toBe("outside-banner");
    // Other props сохраняются.
    expect((out.props as { color?: string }).color).toBe("blue");
  });

  it("parent — Frame с legacy 'outside' meta — мигрируется в outside-banner", () => {
    const shape = makeShape({
      type: "schema-container",
      parentId: "shape:f1",
      props: { titlePosition: "inside-center" } as unknown as TLShape["props"],
    });
    const out = applyFrameTitlePositionInheritance(
      shape,
      makeLookup({
        "shape:f1": { type: "frame", meta: { didrawContainerTitlePosition: "outside" } },
      }),
    );
    expect((out.props as { titlePosition?: string }).titlePosition).toBe("outside-banner");
  });

  it("уже совпадающий titlePosition — pass-through (no churn)", () => {
    const shape = makeShape({
      type: "schema-container",
      parentId: "shape:f1",
      props: { titlePosition: "outside-banner" } as unknown as TLShape["props"],
    });
    const out = applyFrameTitlePositionInheritance(
      shape,
      makeLookup({
        "shape:f1": { type: "frame", meta: { didrawContainerTitlePosition: "outside-banner" } },
      }),
    );
    expect(out).toBe(shape);
  });
});
