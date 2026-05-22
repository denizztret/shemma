// apps/backend/src/domain/schema/identity.test.ts
// Unit-тесты для backend identity wrapper (DRW-134 Task 1.2).

import { describe, expect, test } from "bun:test";
import { nodeIdRegex } from "@shemma/domain";
import { generateNodeIdServer, nodeIdFromLabel } from "./identity";

describe("generateNodeIdServer (DRW-134 Task 1.2)", () => {
  test("возвращает валидный NodeId для slug 'api'", () => {
    const id = generateNodeIdServer({ slug: "api", existingIds: new Set() });
    expect(nodeIdRegex(6).test(id)).toBe(true);
    expect(id.startsWith("api-")).toBe(true);
  });

  test("1000 последовательных вызовов дают уникальные ID (collision sanity)", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const id = generateNodeIdServer({ slug: "svc", existingIds: ids });
      expect(ids.has(id)).toBe(false);
      ids.add(id);
    }
    expect(ids.size).toBe(1000);
  });

  test("empty slug возвращает anonymous form 'e-<6char>'", () => {
    const id = generateNodeIdServer({ slug: "", existingIds: new Set() });
    expect(id.startsWith("e-")).toBe(true);
    expect(nodeIdRegex(6).test(id)).toBe(true);
  });
});

describe("nodeIdFromLabel (DRW-134 Task 1.2)", () => {
  test("'Auth Service' → starts with 'auth-service-'", () => {
    const id = nodeIdFromLabel("Auth Service", new Set());
    expect(id.startsWith("auth-service-")).toBe(true);
    expect(nodeIdRegex(6).test(id)).toBe(true);
  });

  test("empty label → anonymous form 'e-<6char>'", () => {
    const id = nodeIdFromLabel("", new Set());
    expect(id.startsWith("e-")).toBe(true);
    expect(nodeIdRegex(6).test(id)).toBe(true);
  });
});
