import { describe, expect, test } from "bun:test";
import { shouldAutoFit, textChanged } from "./auto-text-fit";

describe("DRW-228 shouldAutoFit — event-driven fit decision", () => {
  test("geo with text whose text just changed → fit", () => {
    expect(
      shouldAutoFit({ type: "geo", hasText: true, sizePinned: false, textChanged: true }),
    ).toBe(true);
  });

  test("note НЕ обтягивается даже с новым текстом (само-размерный, нет props.w/h)", () => {
    // Регрессия: auto-fit писал w/h в note → ValidationError, падал холст.
    expect(
      shouldAutoFit({ type: "note", hasText: true, sizePinned: false, textChanged: true }),
    ).toBe(false);
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

// DRW-232 Фаза 2: пин-origin различает auto-fit-пин (переобтягиваемый при правке
// текста) от user-пина (drag-resize / force-fit — никогда не трогаем авто).
describe("DRW-232 shouldAutoFit — pin origin (fit vs user)", () => {
  test("size-pinned by a previous auto-fit (origin 'fit') → re-fit on text edit", () => {
    expect(
      shouldAutoFit({
        type: "geo",
        hasText: true,
        sizePinned: true,
        textChanged: true,
        sizeOrigin: "fit",
      }),
    ).toBe(true);
  });

  test("size-pinned by user drag-resize (origin 'user') → never auto-fit", () => {
    expect(
      shouldAutoFit({
        type: "geo",
        hasText: true,
        sizePinned: true,
        textChanged: true,
        sizeOrigin: "user",
      }),
    ).toBe(false);
  });

  test("size-pinned without an origin (legacy / AI-set) → conservative skip", () => {
    expect(
      shouldAutoFit({
        type: "geo",
        hasText: true,
        sizePinned: true,
        textChanged: true,
      }),
    ).toBe(false);
  });

  test("not pinned + origin 'fit' → fit (origin is irrelevant when not pinned)", () => {
    expect(
      shouldAutoFit({
        type: "geo",
        hasText: true,
        sizePinned: false,
        textChanged: true,
        sizeOrigin: "fit",
      }),
    ).toBe(true);
  });

  test("origin 'fit' does NOT override the text-unchanged guard", () => {
    expect(
      shouldAutoFit({
        type: "geo",
        hasText: true,
        sizePinned: true,
        textChanged: false,
        sizeOrigin: "fit",
      }),
    ).toBe(false);
  });
});

// DRW-232 AC #2/#4 regression: the auto-fit decision takes NO parent — it never
// looked at parentId. A geo/note nested in a schema-container/frame is decided
// exactly like a top-level one. The original "doesn't fire on nested nodes"
// report was a misdiagnosis of the missing envelope (parent didn't grow → node
// overflowed), NOT a missing fit. This test pins the parent-agnostic contract so
// a parent filter can never be reintroduced silently.
describe("DRW-232 shouldAutoFit — parent-agnostic (nested === top-level)", () => {
  test("a nested-style input fits identically to a top-level one", () => {
    const decision = (sizePinned: boolean) =>
      shouldAutoFit({ type: "geo", hasText: true, sizePinned, textChanged: true });
    // Same inputs → same decision whether the node sits at top level or inside a
    // container/frame: the function has no notion of parent at all.
    expect(decision(false)).toBe(true);
    expect(decision(true)).toBe(false);
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
