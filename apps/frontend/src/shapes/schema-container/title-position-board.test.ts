// apps/frontend/src/shapes/schema-container/title-position-board.test.ts
//
// DRW-186 Task 5 — smoke-тест чистого read'а board-default `titlePosition` из
// `editor.getDocumentSettings().meta`. Полноценные интеграционные сценарии (sync
// меню BoardPanel ↔ meta) тестируются в Task 8/9; здесь покрываем coercion-логику
// + базовое чтение meta-ключа.
//
// Frame-scope extension (DRW-186 v2): `resolveTitlePositionForNew(editor, parentId)`
// добавляет inheritance из parent Frame.meta поверх board-default fallback'а.

import { describe, expect, it } from "bun:test";
import {
  resolveBoardTitlePosition,
  resolveTitlePositionForNew,
} from "./title-position-board";

type BoardEditor = Parameters<typeof resolveBoardTitlePosition>[0];

function fakeEditor(meta: Record<string, unknown>): BoardEditor {
  return {
    getDocumentSettings: () => ({ meta }),
  } as unknown as BoardEditor;
}

describe("resolveBoardTitlePosition", () => {
  it("returns inside-center when meta empty", () => {
    expect(resolveBoardTitlePosition(fakeEditor({}))).toBe("inside-center");
  });

  it("reads outside-banner from meta.containerTitlePosition", () => {
    expect(
      resolveBoardTitlePosition(
        fakeEditor({ containerTitlePosition: "outside-banner" }),
      ),
    ).toBe("outside-banner");
  });

  it("migrates legacy 'outside' meta → 'outside-banner'", () => {
    expect(
      resolveBoardTitlePosition(
        fakeEditor({ containerTitlePosition: "outside" }),
      ),
    ).toBe("outside-banner");
  });

  it("coerces unknown value to inside-center", () => {
    expect(
      resolveBoardTitlePosition(fakeEditor({ containerTitlePosition: "garbage" })),
    ).toBe("inside-center");
  });
});

// ---------------------------------------------------------------------------
// Frame-scope inheritance (DRW-186 v2)
// ---------------------------------------------------------------------------

type ShapeRecord = {
  id: string;
  type: string;
  meta?: Record<string, unknown>;
};

type FrameAwareEditor = Parameters<typeof resolveTitlePositionForNew>[0];

function fakeFrameAwareEditor(args: {
  docMeta?: Record<string, unknown>;
  shapes?: Record<string, ShapeRecord>;
}): FrameAwareEditor {
  const docMeta = args.docMeta ?? {};
  const shapes = args.shapes ?? {};
  return {
    getDocumentSettings: () => ({ meta: docMeta }),
    getShape: (id: string) => shapes[id],
  } as unknown as FrameAwareEditor;
}

describe("resolveTitlePositionForNew", () => {
  it("без parentId возвращает board-default", () => {
    const ed = fakeFrameAwareEditor({
      docMeta: { containerTitlePosition: "outside-banner" },
    });
    expect(resolveTitlePositionForNew(ed)).toBe("outside-banner");
  });

  it("parent — Frame с meta → берёт frame meta поверх board-default", () => {
    const ed = fakeFrameAwareEditor({
      docMeta: { containerTitlePosition: "outside-banner" },
      shapes: {
        "shape:f1": {
          id: "shape:f1",
          type: "frame",
          meta: { didrawContainerTitlePosition: "inside-left" },
        },
      },
    });
    expect(resolveTitlePositionForNew(ed, "shape:f1" as never)).toBe("inside-left");
  });

  it("parent — Frame БЕЗ meta → fallback к board-default", () => {
    const ed = fakeFrameAwareEditor({
      docMeta: { containerTitlePosition: "outside-banner" },
      shapes: { "shape:f1": { id: "shape:f1", type: "frame", meta: {} } },
    });
    expect(resolveTitlePositionForNew(ed, "shape:f1" as never)).toBe("outside-banner");
  });

  it("parent не Frame (другой shape) → fallback к board-default", () => {
    const ed = fakeFrameAwareEditor({
      docMeta: { containerTitlePosition: "outside-banner" },
      shapes: {
        "shape:c1": {
          id: "shape:c1",
          type: "schema-container",
          meta: { didrawContainerTitlePosition: "inside-left" },
        },
      },
    });
    // SchemaContainer не наследует scope — только Frame.
    expect(resolveTitlePositionForNew(ed, "shape:c1" as never)).toBe("outside-banner");
  });

  it("parent не найден → fallback к board-default", () => {
    const ed = fakeFrameAwareEditor({
      docMeta: { containerTitlePosition: "inside-left" },
      shapes: {},
    });
    expect(resolveTitlePositionForNew(ed, "shape:missing" as never)).toBe("inside-left");
  });

  it("frame meta содержит legacy 'outside' → мигрируется в outside-banner", () => {
    const ed = fakeFrameAwareEditor({
      docMeta: {},
      shapes: {
        "shape:f1": {
          id: "shape:f1",
          type: "frame",
          meta: { didrawContainerTitlePosition: "outside" },
        },
      },
    });
    expect(resolveTitlePositionForNew(ed, "shape:f1" as never)).toBe("outside-banner");
  });

  it("frame meta non-string (junk) → fallback к board-default", () => {
    const ed = fakeFrameAwareEditor({
      docMeta: { containerTitlePosition: "inside-left" },
      shapes: {
        "shape:f1": {
          id: "shape:f1",
          type: "frame",
          meta: { didrawContainerTitlePosition: 42 },
        },
      },
    });
    expect(resolveTitlePositionForNew(ed, "shape:f1" as never)).toBe("inside-left");
  });
});
