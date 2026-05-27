// apps/frontend/src/shapes/schema-container/title-position.test.ts
//
// Pure-helper tests для migrateTitlePosition / normalizeTitlePosition.
// Logic concentrated в pure helpers; tldraw shape-level migration tested через
// схему интеграции (см. SchemaContainerMigrations.ts) — здесь только unit-coverage
// над coercion-логикой.

import { describe, expect, it } from "bun:test";
import {
  isOutsideVariant,
  migrateTitlePosition,
  normalizeTitlePosition,
} from "./title-position";

describe("migrateTitlePosition", () => {
  it("migrates legacy 'inside' → 'inside-center'", () => {
    expect(migrateTitlePosition("inside")).toBe("inside-center");
  });

  it("migrates legacy 'outside' → 'outside-banner' (phase 2)", () => {
    expect(migrateTitlePosition("outside")).toBe("outside-banner");
  });

  it("preserves 'outside-frame' (new variant)", () => {
    expect(migrateTitlePosition("outside-frame")).toBe("outside-frame");
  });

  it("preserves 'outside-banner'", () => {
    expect(migrateTitlePosition("outside-banner")).toBe("outside-banner");
  });

  it("preserves 'inside-center'", () => {
    expect(migrateTitlePosition("inside-center")).toBe("inside-center");
  });

  it("preserves 'inside-left'", () => {
    expect(migrateTitlePosition("inside-left")).toBe("inside-left");
  });

  it("coerces unknown string → 'inside-center'", () => {
    expect(migrateTitlePosition("foobar")).toBe("inside-center");
  });

  it("coerces undefined → 'inside-center'", () => {
    expect(migrateTitlePosition(undefined)).toBe("inside-center");
  });

  it("coerces null → 'inside-center'", () => {
    expect(migrateTitlePosition(null)).toBe("inside-center");
  });

  it("coerces non-string value → 'inside-center'", () => {
    expect(migrateTitlePosition(42)).toBe("inside-center");
    expect(migrateTitlePosition({})).toBe("inside-center");
  });
});

describe("normalizeTitlePosition", () => {
  it("rejects null → 'inside-center'", () => {
    expect(normalizeTitlePosition(null)).toBe("inside-center");
  });

  it("normalizes legacy 'inside' identically to migrate", () => {
    expect(normalizeTitlePosition("inside")).toBe("inside-center");
  });

  it("normalizes legacy 'outside' → 'outside-banner'", () => {
    expect(normalizeTitlePosition("outside")).toBe("outside-banner");
  });

  it("preserves valid new enum values", () => {
    expect(normalizeTitlePosition("outside-frame")).toBe("outside-frame");
    expect(normalizeTitlePosition("outside-banner")).toBe("outside-banner");
    expect(normalizeTitlePosition("inside-center")).toBe("inside-center");
    expect(normalizeTitlePosition("inside-left")).toBe("inside-left");
  });
});

describe("isOutsideVariant", () => {
  it("returns true for outside-frame и outside-banner", () => {
    expect(isOutsideVariant("outside-frame")).toBe(true);
    expect(isOutsideVariant("outside-banner")).toBe(true);
  });

  it("returns false для inside-* вариантов", () => {
    expect(isOutsideVariant("inside-center")).toBe(false);
    expect(isOutsideVariant("inside-left")).toBe(false);
  });
});
