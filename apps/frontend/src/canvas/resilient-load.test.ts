import { describe, expect, it } from "bun:test";
import {
  createTLStore,
  defaultBindingUtils,
  defaultShapeUtils,
  type TLRecord,
} from "tldraw";
import { partitionValidRecords } from "./resilient-load";

function freshStore() {
  return createTLStore({
    shapeUtils: defaultShapeUtils,
    bindingUtils: defaultBindingUtils,
  });
}

describe("partitionValidRecords (real tldraw store, DRW-231)", () => {
  it("keeps every record when all are valid", () => {
    const store = freshStore();
    const records = {
      "page:a": {
        id: "page:a",
        typeName: "page",
        name: "A",
        index: "a1",
        meta: {},
      },
      "page:b": {
        id: "page:b",
        typeName: "page",
        name: "B",
        index: "a2",
        meta: {},
      },
    } as unknown as Record<string, TLRecord>;
    const { valid, dropped } = partitionValidRecords(store, records, () => {});
    expect(dropped).toBe(0);
    expect(Object.keys(valid).sort()).toEqual(["page:a", "page:b"]);
  });

  it("drops the record that fails strict validation, keeps the rest", () => {
    const store = freshStore();
    const warnings: string[] = [];
    const records = {
      "page:good": {
        id: "page:good",
        typeName: "page",
        name: "Good",
        index: "a1",
        meta: {},
      },
      "page:bad": {
        id: "page:bad",
        typeName: "page",
        // invalid: page name must be a string — mirrors a corrupt record that
        // would otherwise abort the whole loadSnapshot and blank the board.
        name: 123 as unknown as string,
        index: "a2",
        meta: {},
      },
    } as unknown as Record<string, TLRecord>;
    const { valid, dropped } = partitionValidRecords(store, records, (m) =>
      warnings.push(m),
    );
    expect(dropped).toBe(1);
    expect(valid["page:good"]).toBeDefined();
    expect(valid["page:bad"]).toBeUndefined();
    expect(warnings.some((w) => w.includes("page:bad"))).toBe(true);
  });

  it("handles an empty record map", () => {
    const store = freshStore();
    expect(partitionValidRecords(store, {}, () => {})).toEqual({
      valid: {},
      dropped: 0,
    });
  });
});
