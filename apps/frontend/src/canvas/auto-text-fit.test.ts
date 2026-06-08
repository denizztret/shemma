import { describe, expect, test } from "bun:test";
import { shouldAutoFit, textChanged } from "./auto-text-fit";

describe("DRW-228 shouldAutoFit — event-driven fit decision", () => {
  test("geo with text whose text just changed → fit", () => {
    expect(
      shouldAutoFit({ type: "geo", hasText: true, sizePinned: false, textChanged: true }),
    ).toBe(true);
  });

  test("note with new text → fit", () => {
    expect(
      shouldAutoFit({ type: "note", hasText: true, sizePinned: false, textChanged: true }),
    ).toBe(true);
  });

  test("text unchanged (e.g. a move/resize) → no fit (don't re-fit on every change)", () => {
    expect(
      shouldAutoFit({ type: "geo", hasText: true, sizePinned: false, textChanged: false }),
    ).toBe(false);
  });

  test("size-pinned shape → no fit (user owns the size — DRW-219/185)", () => {
    expect(
      shouldAutoFit({ type: "geo", hasText: true, sizePinned: true, textChanged: true }),
    ).toBe(false);
  });

  test("empty text → no fit (nothing to size to)", () => {
    expect(
      shouldAutoFit({ type: "geo", hasText: false, sizePinned: false, textChanged: true }),
    ).toBe(false);
  });

  test("non-fittable type (arrow/frame/text) → no fit", () => {
    for (const type of ["arrow", "frame", "text", "draw", "line"]) {
      expect(
        shouldAutoFit({ type, hasText: true, sizePinned: false, textChanged: true }),
      ).toBe(false);
    }
  });
});

describe("DRW-228 textChanged — plaintext comparison (null-safe)", () => {
  test("different text → true", () => {
    expect(textChanged("api", "api gateway")).toBe(true);
  });

  test("same text → false (move/resize/style change)", () => {
    expect(textChanged("api", "api")).toBe(false);
  });

  test("null → text (new shape gains text) → true", () => {
    expect(textChanged(null, "db")).toBe(true);
  });

  test("text → null (text removed) → true", () => {
    expect(textChanged("db", null)).toBe(true);
  });

  test("null → null (non-text shape) → false", () => {
    expect(textChanged(null, null)).toBe(false);
  });

  test("empty string === null for comparison (no spurious fit)", () => {
    expect(textChanged(null, "")).toBe(false);
    expect(textChanged("", null)).toBe(false);
  });
});
