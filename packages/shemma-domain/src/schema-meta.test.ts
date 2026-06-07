import { describe, expect, test } from "bun:test";
import { ALL_SCHEMA_ACTION_KINDS, SCHEMA_PROTOCOL_VERSION } from "./index";

describe("schema meta constants (DRW-134 Task 1.3)", () => {
  test("SCHEMA_PROTOCOL_VERSION === '1.0' для 0.23.0", () => {
    expect(SCHEMA_PROTOCOL_VERSION).toBe("1.0");
  });

  test("ALL_SCHEMA_ACTION_KINDS contains все 9 kinds", () => {
    expect(ALL_SCHEMA_ACTION_KINDS).toHaveLength(9);
    expect(ALL_SCHEMA_ACTION_KINDS).toContain("schema-define");
    expect(ALL_SCHEMA_ACTION_KINDS).toContain("schema-connect");
    expect(ALL_SCHEMA_ACTION_KINDS).toContain("schema-rename");
    expect(ALL_SCHEMA_ACTION_KINDS).toContain("schema-set-role");
    expect(ALL_SCHEMA_ACTION_KINDS).toContain("schema-group");
    expect(ALL_SCHEMA_ACTION_KINDS).toContain("schema-disconnect");
    expect(ALL_SCHEMA_ACTION_KINDS).toContain("schema-delete-node");
    expect(ALL_SCHEMA_ACTION_KINDS).toContain("schema-set-overlay");
    expect(ALL_SCHEMA_ACTION_KINDS).toContain("schema-set-edge-overlay");
  });
});
