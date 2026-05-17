import { describe, expect, test } from "bun:test";
import { ALL_KINDS, isValidConnectionKind, type ConnectionKind } from "../src/connections";

describe("ConnectionKind", () => {
  test("ALL_KINDS contains exactly 4 values", () => {
    expect(ALL_KINDS).toEqual(["sync", "async", "data", "dep"]);
  });

  test.each<ConnectionKind>(["sync", "async", "data", "dep"])(
    "isValidConnectionKind accepts %s",
    (k) => { expect(isValidConnectionKind(k)).toBe(true); },
  );

  test("isValidConnectionKind rejects unknown", () => {
    expect(isValidConnectionKind("notify")).toBe(false);
  });
});
