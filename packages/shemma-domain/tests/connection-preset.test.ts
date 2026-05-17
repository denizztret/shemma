import { describe, expect, test } from "bun:test";
import { ALL_KINDS, type ConnectionKind } from "../src/connections";
import { connectionPreset } from "../src/connection-preset";

describe("connectionPreset", () => {
  test.each<ConnectionKind>([...ALL_KINDS])("every kind has a preset (%s)", (k) => {
    expect(connectionPreset(k).dashed).toBeDefined();
  });
  test("sync — solid, default label 'calls'", () => {
    const p = connectionPreset("sync");
    expect(p.dashed).toBe(false);
    expect(p.defaultLabel).toBe("calls");
  });
  test("async — dashed, default label 'publishes'", () => {
    const p = connectionPreset("async");
    expect(p.dashed).toBe(true);
    expect(p.defaultLabel).toBe("publishes");
  });
  test("dep — no default label", () => {
    expect(connectionPreset("dep").defaultLabel).toBeUndefined();
  });
});
