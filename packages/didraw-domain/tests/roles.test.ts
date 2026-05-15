import { describe, expect, test } from "bun:test";
import { isContainerRole, type Role } from "../src/roles";

describe("Role", () => {
  test("isContainerRole — network and boundary are containers", () => {
    expect(isContainerRole("network")).toBe(true);
    expect(isContainerRole("boundary")).toBe(true);
  });

  test.each<Role>(["actor", "service", "datastore", "queue", "external", "note"])(
    "isContainerRole — %s is leaf",
    (r) => { expect(isContainerRole(r)).toBe(false); },
  );

  test("isContainerRole — unknown string is false", () => {
    expect(isContainerRole("frobnicator" as Role)).toBe(false);
  });
});
