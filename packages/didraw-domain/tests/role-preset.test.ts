import { describe, expect, test } from "bun:test";
import { ALL_ROLES, type Role } from "../src/roles";
import { rolePreset } from "../src/role-preset";

describe("rolePreset", () => {
  test.each<Role>([...ALL_ROLES])("every role has a preset (%s)", (r) => {
    const p = rolePreset(r);
    expect(p.kind).toBeDefined();
    expect(typeof p.kind).toBe("string");
  });
  test("service → rounded rect", () => {
    expect(rolePreset("service").kind).toBe("rect");
  });
  test("datastore — distinct fill from service", () => {
    expect(rolePreset("datastore").style.fill).not.toBe(rolePreset("service").style.fill);
  });
  test("network is a container preset (frame-like)", () => {
    expect(rolePreset("network").container).toBe(true);
  });
  test("note has sticky kind", () => {
    expect(rolePreset("note").kind).toBe("sticky");
  });
});
