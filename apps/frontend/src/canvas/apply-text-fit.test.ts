import { describe, expect, test } from "bun:test";
import { shouldManualFit } from "./apply-text-fit";

describe("DRW-232 shouldManualFit — предикат ручной обтяжки + force", () => {
  test("geo с текстом, не закреплён → обтягиваем", () => {
    expect(
      shouldManualFit({
        type: "geo",
        hasText: true,
        sizePinned: false,
        force: false,
      }),
    ).toBe(true);
  });

  test("note с текстом → обтягиваем", () => {
    expect(
      shouldManualFit({
        type: "note",
        hasText: true,
        sizePinned: false,
        force: false,
      }),
    ).toBe(true);
  });

  test("обычный режим уважает size-pin (вручную заданный размер не ломаем)", () => {
    expect(
      shouldManualFit({
        type: "geo",
        hasText: true,
        sizePinned: true,
        force: false,
      }),
    ).toBe(false);
  });

  test("force-режим обтягивает и size-pinned", () => {
    expect(
      shouldManualFit({
        type: "geo",
        hasText: true,
        sizePinned: true,
        force: true,
      }),
    ).toBe(true);
  });

  test("пустой текст → не обтягиваем", () => {
    expect(
      shouldManualFit({
        type: "geo",
        hasText: false,
        sizePinned: false,
        force: false,
      }),
    ).toBe(false);
    // даже force не обтягивает пустой узел
    expect(
      shouldManualFit({
        type: "geo",
        hasText: false,
        sizePinned: true,
        force: true,
      }),
    ).toBe(false);
  });

  test("нетекстовые/контейнерные типы не обтягиваются (контейнер/фрейм/стрелка/text)", () => {
    for (const type of [
      "frame",
      "schema-container",
      "arrow",
      "text",
      "line",
      "draw",
    ]) {
      expect(
        shouldManualFit({
          type,
          hasText: true,
          sizePinned: false,
          force: false,
        }),
      ).toBe(false);
      expect(
        shouldManualFit({
          type,
          hasText: true,
          sizePinned: false,
          force: true,
        }),
      ).toBe(false);
    }
  });
});
