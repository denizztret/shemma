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

  // DRW-077: wider defaults to prevent label overflow on typical names
  test("service default dimensions are wide enough for labels (220×80)", () => {
    const p = rolePreset("service");
    expect(p.defaultW).toBe(220);
    expect(p.defaultH).toBe(80);
  });
  test("datastore default dimensions are wide enough for labels (220×80)", () => {
    const p = rolePreset("datastore");
    expect(p.defaultW).toBe(220);
    expect(p.defaultH).toBe(80);
  });
  test("external default dimensions are wide enough for labels (220×80)", () => {
    const p = rolePreset("external");
    expect(p.defaultW).toBe(220);
    expect(p.defaultH).toBe(80);
  });
  test("queue keeps compact dimensions (unchanged)", () => {
    const p = rolePreset("queue");
    expect(p.defaultW).toBe(140);
    expect(p.defaultH).toBe(50);
  });
  test("actor keeps compact dimensions (unchanged)", () => {
    const p = rolePreset("actor");
    expect(p.defaultW).toBe(120);
    expect(p.defaultH).toBe(60);
  });
});
