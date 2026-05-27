// apps/frontend/src/settings/useSettingsTrigger.test.ts
import { describe, expect, it, test } from "bun:test";
import { resolveTarget, SETTINGS_POPOVER_DEFAULT_PINNED, type ResolveInput, type Target } from "./useSettingsTrigger";

function shape(id: string, type: string, didrawId?: string) {
  return { id, type, meta: didrawId ? { didrawId } : {} };
}

describe("resolveTarget", () => {
  test("no hit + no selection → board target with pointer anchor", () => {
    const result = resolveTarget({
      hit: null,
      selectedIds: [],
      pointerScreen: { x: 100, y: 200 },
      bbox: () => null,
    } satisfies ResolveInput);
    expect(result).toEqual({ kind: "board", anchor: { x: 100, y: 200 } });
  });

  test("hit in multi-selection → selection target with bbox of selection", () => {
    const result = resolveTarget({
      hit: shape("s:a", "geo", "node-a"),
      selectedIds: ["s:a", "s:b"],
      pointerScreen: { x: 0, y: 0 },
      bbox: (ids) => (ids.length === 2 ? { x: 10, y: 10, w: 100, h: 50 } : null),
    });
    expect(result).toEqual({
      kind: "selection",
      anchor: { x: 10, y: 10, w: 100, h: 50 },
    });
  });

  test("hit on schema-container → selection target of size 1 (single Frame)", () => {
    const result = resolveTarget({
      hit: shape("s:c1", "schema-container"),
      selectedIds: [],
      pointerScreen: { x: 0, y: 0 },
      bbox: () => ({ x: 0, y: 0, w: 200, h: 100 }),
    });
    expect(result).toEqual({
      kind: "selection",
      anchor: { x: 0, y: 0, w: 200, h: 100 },
    });
  });

  test("hit on shape with meta.didrawId → node target", () => {
    const result = resolveTarget({
      hit: shape("s:n1", "geo", "node-1"),
      selectedIds: [],
      pointerScreen: { x: 0, y: 0 },
      bbox: () => ({ x: 5, y: 5, w: 80, h: 40 }),
    });
    expect(result).toEqual({
      kind: "node",
      subjectId: "s:n1",
      anchor: { x: 5, y: 5, w: 80, h: 40 },
    });
  });

  test("hit on default shape without meta.didrawId → null (no popover)", () => {
    const result = resolveTarget({
      hit: shape("s:x", "geo"),
      selectedIds: [],
      pointerScreen: { x: 0, y: 0 },
      bbox: () => null,
    });
    expect(result).toBeNull();
  });

  test("hit outside non-empty selection → opens by hit, not by selection (Note 3)", () => {
    const result = resolveTarget({
      hit: shape("s:other", "geo", "node-other"),
      selectedIds: ["s:a", "s:b"],
      pointerScreen: { x: 0, y: 0 },
      bbox: (ids) => (ids[0] === "s:other" ? { x: 1, y: 2, w: 3, h: 4 } : null),
    });
    expect(result).toEqual({
      kind: "node",
      subjectId: "s:other",
      anchor: { x: 1, y: 2, w: 3, h: 4 },
    });
  });
});

describe("useSettingsTrigger — DRW-185 default-pinned mode", () => {
  it("exports SETTINGS_POPOVER_DEFAULT_PINNED constant", () => {
    expect(typeof SETTINGS_POPOVER_DEFAULT_PINNED).toBe("boolean");
  });

  it("default popover state is pinned (true)", () => {
    expect(SETTINGS_POPOVER_DEFAULT_PINNED).toBe(true);
  });
});
