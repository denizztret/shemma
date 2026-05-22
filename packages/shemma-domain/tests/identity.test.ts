import { describe, expect, test } from "bun:test";
import {
  slugify,
  nodeIdRegex,
  generateNodeId,
  generateSuffix,
  isValidNodeId,
  DEFAULT_SUFFIX_LENGTH,
  SUFFIX_LENGTH_MIN,
  SUFFIX_LENGTH_MAX,
} from "../src/identity";

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

describe("slugify (DRW-134 Task 1.1)", () => {
  test("happy path: 'Auth Service' → 'auth-service'", () => {
    expect(slugify("Auth Service")).toBe("auth-service");
  });

  test("happy path: 'Postgres DB' → 'postgres-db'", () => {
    expect(slugify("Postgres DB")).toBe("postgres-db");
  });

  test("cyrillic stripped: 'Postgres БД' → 'postgres'", () => {
    expect(slugify("Postgres БД")).toBe("postgres");
  });

  test("cyrillic-only → empty → fallback 'shape': 'БД' → 'shape'", () => {
    expect(slugify("БД")).toBe("shape");
  });

  test("emoji stripped: '📊 Dashboard' → 'dashboard'", () => {
    expect(slugify("📊 Dashboard")).toBe("dashboard");
  });

  test("empty string → fallback 'shape'", () => {
    expect(slugify("")).toBe("shape");
  });

  test("max len 40: 'a'.repeat(50) → length === 40", () => {
    const result = slugify("a".repeat(50));
    expect(result.length).toBe(40);
  });

  test("trims leading/trailing dashes", () => {
    expect(slugify("  API  ")).toBe("api");
  });

  test("collapses multiple dashes: 'foo---bar' → 'foo-bar'", () => {
    expect(slugify("foo---bar")).toBe("foo-bar");
  });

  test("special chars removed: 'user@domain.com' → 'user-domain-com'", () => {
    expect(slugify("user@domain.com")).toBe("user-domain-com");
  });
});

// ---------------------------------------------------------------------------
// nodeIdRegex
// ---------------------------------------------------------------------------

describe("nodeIdRegex (DRW-134 Task 1.1)", () => {
  test("accepts valid named id: 'api-x9k2lm' (suffixLen=6)", () => {
    expect(nodeIdRegex(6).test("api-x9k2lm")).toBe(true);
  });

  test("rejects too-short suffix (5 chars): 'api-x9k2l'", () => {
    expect(nodeIdRegex(6).test("api-x9k2l")).toBe(false);
  });

  test("accepts multi-word slug: 'auth-service-7q3w1z'", () => {
    expect(nodeIdRegex(6).test("auth-service-7q3w1z")).toBe(true);
  });

  test("accepts anonymous form: 'e-h4n8tp'", () => {
    expect(nodeIdRegex(6).test("e-h4n8tp")).toBe(true);
  });

  test("rejects uppercase slug: 'API-x9k2lm'", () => {
    expect(nodeIdRegex(6).test("API-x9k2lm")).toBe(false);
  });

  test("rejects uppercase suffix: 'api-X9K2LM'", () => {
    expect(nodeIdRegex(6).test("api-X9K2LM")).toBe(false);
  });

  test("suffixLen=3: accepts 'a-x9k'", () => {
    expect(nodeIdRegex(3).test("a-x9k")).toBe(true);
  });

  test("suffixLen=3: rejects too-long suffix 'a-x9k2lm'", () => {
    expect(nodeIdRegex(3).test("a-x9k2lm")).toBe(false);
  });

  test("rejects garbage 'foo' (no suffix)", () => {
    expect(nodeIdRegex(6).test("foo")).toBe(false);
  });

  test("rejects trailing dash 'foo-'", () => {
    expect(nodeIdRegex(6).test("foo-")).toBe(false);
  });

  test("rejects 5-char suffix 'foo-12345'", () => {
    expect(nodeIdRegex(6).test("foo-12345")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// generateNodeId
// ---------------------------------------------------------------------------

describe("generateNodeId (DRW-134 Task 1.1)", () => {
  test("named form: slug='api' → matches ^api-[0-9a-z]{6}$", () => {
    const id = generateNodeId({ slug: "api", existingIds: new Set(), rng: () => 0.5 });
    expect(/^api-[0-9a-z]{6}$/.test(id)).toBe(true);
  });

  test("anonymous form: slug='' → matches ^e-[0-9a-z]{6}$", () => {
    const id = generateNodeId({ slug: "", existingIds: new Set() });
    expect(/^e-[0-9a-z]{6}$/.test(id)).toBe(true);
  });

  test("slug='shape' (fallback from cyrillic) → matches ^shape-[0-9a-z]{6}$", () => {
    const id = generateNodeId({ slug: "shape", existingIds: new Set(), rng: () => 0.5 });
    expect(/^shape-[0-9a-z]{6}$/.test(id)).toBe(true);
  });

  test("configurable length: suffixLen=4 → matches ^api-[0-9a-z]{4}$", () => {
    const id = generateNodeId({ slug: "api", suffixLen: 4, existingIds: new Set(), rng: () => 0.5 });
    expect(/^api-[0-9a-z]{4}$/.test(id)).toBe(true);
  });

  test("retry scenario: first 7 attempts collide, 8th succeeds", () => {
    // Sequence: первые 7 вызовов rng дают суффикс 'aaaaaa', 8-й — 'bbbbbb'
    const COLLIDING_SUFFIX = "aaaaaa"; // rng=()=>0 даёт '0' * 6 = '000000'... но используем mock
    const existingIds = new Set<string>();
    let callCount = 0;
    // Создаём детерминированную последовательность
    // rng вызывается suffixLen раз за попытку
    const rngSequence = (): (() => number) => {
      // первые 7 × 6 = 42 вызовов → 0 (символ '0')
      // следующие 6 вызовов → 0.5 (символ 'i')
      return () => {
        callCount++;
        return callCount <= 42 ? 0 : 0.5;
      };
    };
    const rng = rngSequence();
    const COLLIDING_ID = "api-000000";
    existingIds.add(COLLIDING_ID);

    const id = generateNodeId({ slug: "api", existingIds, rng });
    expect(id).not.toBe(COLLIDING_ID);
    expect(/^api-[0-9a-z]{6}$/.test(id)).toBe(true);
  });

  test("all 8 attempts collide → throws 'nodeId-collision'", () => {
    // rng возвращает 0 → suffix всегда '000000'
    const existingIds = new Set(["api-000000"]);
    expect(() =>
      generateNodeId({ slug: "api", existingIds, rng: () => 0 }),
    ).toThrow("nodeId-collision");
  });
});

// ---------------------------------------------------------------------------
// isValidNodeId
// ---------------------------------------------------------------------------

describe("isValidNodeId (DRW-134 Task 1.1)", () => {
  test("accepts well-formed id with default suffixLen", () => {
    expect(isValidNodeId("api-x9k2lm")).toBe(true);
  });

  test("rejects 5-char suffix", () => {
    expect(isValidNodeId("api-x9k2l")).toBe(false);
  });

  test("accepts anonymous form", () => {
    expect(isValidNodeId("e-h4n8tp")).toBe(true);
  });

  test("rejects uppercase", () => {
    expect(isValidNodeId("api-X9K2LM")).toBe(false);
  });

  test("rejects no-suffix garbage 'foo'", () => {
    expect(isValidNodeId("foo")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Collision frequency sanity (statistical)
// ---------------------------------------------------------------------------

describe("collision sanity — 10k IDs at suffixLen=6 (DRW-134 Task 1.1)", () => {
  test("10k generated IDs are unique", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const id = generateNodeId({ slug: "api", existingIds: ids });
      ids.add(id);
    }
    expect(ids.size).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// Constants sanity
// ---------------------------------------------------------------------------

describe("constants (DRW-134 Task 1.1)", () => {
  test("DEFAULT_SUFFIX_LENGTH === 6", () => {
    expect(DEFAULT_SUFFIX_LENGTH).toBe(6);
  });

  test("SUFFIX_LENGTH_MIN === 3", () => {
    expect(SUFFIX_LENGTH_MIN).toBe(3);
  });

  test("SUFFIX_LENGTH_MAX === 12", () => {
    expect(SUFFIX_LENGTH_MAX).toBe(12);
  });
});
