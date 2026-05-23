/**
 * DRW-134 Task 3.2 — role-picker pure logic tests.
 *
 * No DOM / JSDOM / tldraw — pure unit tests.
 * Decision: no .test.tsx JSDOM infra exists; pure-logic path per plan pre-flight.
 */
import { describe, expect, test } from "bun:test";
import {
  classifySelection,
  buildRolePatches,
  buildKindPatches,
  applyPickerChoice,
  makeRolePickerHandler,
  type SelectionInfo,
} from "./role-picker.ts";

// ---------------------------------------------------------------------------
// classifySelection
// ---------------------------------------------------------------------------

describe("classifySelection", () => {
  const noArrows = (_id: string) => false;
  const allArrows = (_id: string) => true;
  const isArrow = (id: string) => id.startsWith("arrow:");

  test("empty selection → mode=none, no ids", () => {
    const result = classifySelection([], noArrows);
    expect(result.hasSelection).toBe(false);
    expect(result.mode).toBe("none");
    expect(result.shapeIds).toHaveLength(0);
    expect(result.arrowIds).toHaveLength(0);
  });

  test("all non-arrow shapes → mode=role", () => {
    const result = classifySelection(["shape:a", "shape:b"], noArrows);
    expect(result.hasSelection).toBe(true);
    expect(result.mode).toBe("role");
    expect(result.shapeIds).toEqual(["shape:a", "shape:b"]);
    expect(result.arrowIds).toHaveLength(0);
  });

  test("all arrows → mode=connectionKind", () => {
    const result = classifySelection(["shape:x", "shape:y"], allArrows);
    expect(result.mode).toBe("connectionKind");
    expect(result.arrowIds).toEqual(["shape:x", "shape:y"]);
    expect(result.shapeIds).toHaveLength(0);
  });

  test("mixed arrows + shapes → mode=mixed", () => {
    const result = classifySelection(["shape:geo", "arrow:a", "arrow:b"], isArrow);
    expect(result.mode).toBe("mixed");
    expect(result.shapeIds).toEqual(["shape:geo"]);
    expect(result.arrowIds).toEqual(["arrow:a", "arrow:b"]);
  });

  test("single non-arrow → mode=role", () => {
    const result = classifySelection(["shape:solo"], noArrows);
    expect(result.mode).toBe("role");
    expect(result.shapeIds).toEqual(["shape:solo"]);
  });
});

// ---------------------------------------------------------------------------
// buildRolePatches
// ---------------------------------------------------------------------------

describe("buildRolePatches", () => {
  test("maps each id to a role meta patch", () => {
    const patches = buildRolePatches(["shape:a", "shape:b"], "service");
    expect(patches).toHaveLength(2);
    expect(patches[0]).toEqual({ id: "shape:a", meta: { didrawRole: "service" } });
    expect(patches[1]).toEqual({ id: "shape:b", meta: { didrawRole: "service" } });
  });

  test("empty ids → empty patches", () => {
    expect(buildRolePatches([], "actor")).toHaveLength(0);
  });

  test("actor role patch", () => {
    const [patch] = buildRolePatches(["shape:x"], "actor");
    expect(patch.meta.didrawRole).toBe("actor");
  });

  test("datastore role patch", () => {
    const [patch] = buildRolePatches(["shape:x"], "datastore");
    expect(patch.meta.didrawRole).toBe("datastore");
  });
});

// ---------------------------------------------------------------------------
// buildKindPatches
// ---------------------------------------------------------------------------

describe("buildKindPatches", () => {
  test("maps each arrow id to a connectionKind meta patch", () => {
    const patches = buildKindPatches(["shape:arr1"], "async");
    expect(patches).toHaveLength(1);
    expect(patches[0]).toEqual({ id: "shape:arr1", meta: { didrawConnectionKind: "async" } });
  });

  test("dep kind patch", () => {
    const [patch] = buildKindPatches(["shape:d"], "dep");
    expect(patch.meta.didrawConnectionKind).toBe("dep");
  });

  test("empty ids → empty patches", () => {
    expect(buildKindPatches([], "sync")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// applyPickerChoice
// ---------------------------------------------------------------------------

describe("applyPickerChoice", () => {
  const info: SelectionInfo = {
    hasSelection: true,
    mode: "mixed",
    shapeIds: ["shape:a", "shape:b"],
    arrowIds: ["shape:arr"],
  };

  test("type=role → patches shapeIds only", () => {
    const patches = applyPickerChoice(info, { type: "role", value: "queue" });
    expect(patches).toHaveLength(2);
    expect(patches.every((p) => p.meta.didrawRole === "queue")).toBe(true);
  });

  test("type=kind → patches arrowIds only", () => {
    const patches = applyPickerChoice(info, { type: "kind", value: "data" });
    expect(patches).toHaveLength(1);
    expect(patches[0].meta.didrawConnectionKind).toBe("data");
    expect(patches[0].id).toBe("shape:arr");
  });

  test("role-only info with role choice", () => {
    const roleInfo: SelectionInfo = {
      hasSelection: true,
      mode: "role",
      shapeIds: ["shape:x"],
      arrowIds: [],
    };
    const patches = applyPickerChoice(roleInfo, { type: "role", value: "note" });
    expect(patches).toHaveLength(1);
    expect(patches[0].meta.didrawRole).toBe("note");
  });
});

// ---------------------------------------------------------------------------
// makeRolePickerHandler
// ---------------------------------------------------------------------------

function fakeKey(opts: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}): { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; preventDefault: () => void } {
  return {
    key: opts.key,
    metaKey: opts.metaKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    preventDefault: () => {},
  };
}

const hasSelectionInfo: SelectionInfo = {
  hasSelection: true,
  mode: "role",
  shapeIds: ["shape:a"],
  arrowIds: [],
};

const emptyInfo: SelectionInfo = {
  hasSelection: false,
  mode: "none",
  shapeIds: [],
  arrowIds: [],
};

describe("makeRolePickerHandler", () => {
  test("fires onOpen on Cmd+Shift+K (Mac) with selection", () => {
    let opened = false;
    const handler = makeRolePickerHandler(
      () => hasSelectionInfo,
      () => { opened = true; },
    );
    // biome-ignore lint/suspicious/noExplicitAny: substituting KeyboardEvent in Bun test env
    handler(fakeKey({ key: "K", metaKey: true, shiftKey: true }) as any);
    expect(opened).toBe(true);
  });

  test("fires onOpen on Ctrl+Shift+K (Win/Linux) with selection", () => {
    let opened = false;
    const handler = makeRolePickerHandler(
      () => hasSelectionInfo,
      () => { opened = true; },
    );
    // biome-ignore lint/suspicious/noExplicitAny: substituting KeyboardEvent in Bun test env
    handler(fakeKey({ key: "k", ctrlKey: true, shiftKey: true }) as any);
    expect(opened).toBe(true);
  });

  test("calls onEmpty when selection is empty", () => {
    let emptyCalled = false;
    let opened = false;
    const handler = makeRolePickerHandler(
      () => emptyInfo,
      () => { opened = true; },
      () => { emptyCalled = true; },
    );
    // biome-ignore lint/suspicious/noExplicitAny: substituting KeyboardEvent in Bun test env
    handler(fakeKey({ key: "K", metaKey: true, shiftKey: true }) as any);
    expect(opened).toBe(false);
    expect(emptyCalled).toBe(true);
  });

  test("does NOT fire on Cmd+K (no shift)", () => {
    let opened = false;
    const handler = makeRolePickerHandler(
      () => hasSelectionInfo,
      () => { opened = true; },
    );
    // biome-ignore lint/suspicious/noExplicitAny: substituting KeyboardEvent in Bun test env
    handler(fakeKey({ key: "K", metaKey: true, shiftKey: false }) as any);
    expect(opened).toBe(false);
  });

  test("does NOT fire on Cmd+Shift+E (different key)", () => {
    let opened = false;
    const handler = makeRolePickerHandler(
      () => hasSelectionInfo,
      () => { opened = true; },
    );
    // biome-ignore lint/suspicious/noExplicitAny: substituting KeyboardEvent in Bun test env
    handler(fakeKey({ key: "E", metaKey: true, shiftKey: true }) as any);
    expect(opened).toBe(false);
  });

  test("does NOT fire without modifier key", () => {
    let opened = false;
    const handler = makeRolePickerHandler(
      () => hasSelectionInfo,
      () => { opened = true; },
    );
    // biome-ignore lint/suspicious/noExplicitAny: substituting KeyboardEvent in Bun test env
    handler(fakeKey({ key: "K", shiftKey: true }) as any);
    expect(opened).toBe(false);
  });

  test("no onEmpty provided — empty selection → onOpen not called, no crash", () => {
    let opened = false;
    const handler = makeRolePickerHandler(
      () => emptyInfo,
      () => { opened = true; },
      // no onEmpty
    );
    // biome-ignore lint/suspicious/noExplicitAny: substituting KeyboardEvent in Bun test env
    expect(() => handler(fakeKey({ key: "K", metaKey: true, shiftKey: true }) as any)).not.toThrow();
    expect(opened).toBe(false);
  });
});
