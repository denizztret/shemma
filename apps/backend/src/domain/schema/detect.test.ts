// apps/backend/src/domain/schema/detect.test.ts
// Unit-тесты для room-level v1/v2 protocol detection (DRW-134 Task 1.4).

import { describe, test, expect } from "bun:test";
import type { RoomState } from "../../types";
import { isV2Room, roomSuffixLength } from "./detect";

// ─── isV2Room ────────────────────────────────────────────────────────────────

describe("isV2Room (DRW-134 Task 1.4)", () => {
  test("undefined → false", () => {
    expect(isV2Room(undefined)).toBe(false);
  });

  test("null → false", () => {
    expect(isV2Room(null)).toBe(false);
  });

  test("meta: undefined → false", () => {
    expect(isV2Room({ meta: undefined } as never)).toBe(false);
  });

  test("meta без didrawProtocol (только miroExports) → false", () => {
    expect(isV2Room({ meta: { miroExports: {} } } as never)).toBe(false);
  });

  test("meta.didrawProtocol === 'v2' → true", () => {
    expect(isV2Room({ meta: { didrawProtocol: "v2" } } as never)).toBe(true);
  });
});

// ─── roomSuffixLength ────────────────────────────────────────────────────────

describe("roomSuffixLength (DRW-134 Task 1.4)", () => {
  test("undefined → DEFAULT_SUFFIX_LENGTH (6)", () => {
    expect(roomSuffixLength(undefined)).toBe(6);
  });

  test("null → DEFAULT_SUFFIX_LENGTH (6)", () => {
    expect(roomSuffixLength(null)).toBe(6);
  });

  test("meta без didrawIdSuffixLength → DEFAULT_SUFFIX_LENGTH (6)", () => {
    expect(roomSuffixLength({ meta: {} } as never)).toBe(6);
  });

  test("didrawIdSuffixLength: 8 → 8 (in-range)", () => {
    expect(
      roomSuffixLength({ meta: { didrawIdSuffixLength: 8 } } as never),
    ).toBe(8);
  });

  test("didrawIdSuffixLength: 2 → 3 (clamp to MIN)", () => {
    expect(
      roomSuffixLength({ meta: { didrawIdSuffixLength: 2 } } as never),
    ).toBe(3);
  });

  test("didrawIdSuffixLength: 99 → 12 (clamp to MAX)", () => {
    expect(
      roomSuffixLength({ meta: { didrawIdSuffixLength: 99 } } as never),
    ).toBe(12);
  });

  test("didrawIdSuffixLength: 6.5 (non-integer) → DEFAULT_SUFFIX_LENGTH (6)", () => {
    expect(
      roomSuffixLength({ meta: { didrawIdSuffixLength: 6.5 as never } } as never),
    ).toBe(6);
  });

  test("didrawIdSuffixLength: 3 → 3 (MIN boundary)", () => {
    expect(
      roomSuffixLength({ meta: { didrawIdSuffixLength: 3 } } as never),
    ).toBe(3);
  });

  test("didrawIdSuffixLength: 12 → 12 (MAX boundary)", () => {
    expect(
      roomSuffixLength({ meta: { didrawIdSuffixLength: 12 } } as never),
    ).toBe(12);
  });
});
