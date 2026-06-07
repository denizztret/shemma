import { describe, expect, test } from "bun:test";
import {
  applyStyleDefaultsResolution,
  validateStyleDefaults,
} from "./style-defaults";

// DRW-207: arrowKind в board style defaults. Unset = статус-кво
// (ручные стрелки arc, AI-стрелки elbow) — без нативного фолбэка.
describe("StyleDefaults.arrowKind", () => {
  test("validateStyleDefaults accepts arc and elbow", () => {
    expect(() => validateStyleDefaults({ arrowKind: "arc" })).not.toThrow();
    expect(() => validateStyleDefaults({ arrowKind: "elbow" })).not.toThrow();
  });

  test("validateStyleDefaults rejects invalid arrowKind", () => {
    expect(() =>
      validateStyleDefaults({
        arrowKind: "curvy" as unknown as "arc",
      }),
    ).toThrow(/arrowKind/);
  });

  test("resolution carries arrowKind from the nearest defined layer", () => {
    const resolved = applyStyleDefaultsResolution([
      {},
      { arrowKind: "elbow" },
    ]);
    expect(resolved.arrowKind).toBe("elbow");
  });

  test("resolution: first defined layer wins", () => {
    const resolved = applyStyleDefaultsResolution([
      { arrowKind: "arc" },
      { arrowKind: "elbow" },
    ]);
    expect(resolved.arrowKind).toBe("arc");
  });

  test("resolution leaves arrowKind undefined when no layer defines it (no native fallback)", () => {
    const resolved = applyStyleDefaultsResolution([
      { dash: "solid" },
      { size: "l" },
    ]);
    expect(resolved.arrowKind).toBeUndefined();
    // существующие ключи по-прежнему добиваются нативными дефолтами
    expect(resolved.dash).toBe("solid");
    expect(resolved.font).toBe("draw");
  });
});
