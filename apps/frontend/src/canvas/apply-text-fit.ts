// apps/frontend/src/canvas/apply-text-fit.ts
//
// DRW-219: команда «обтянуть текст» для выделения. Для каждого выделенного
// объекта с текстом (geo/note/text) подбирает оптимальную ширину и
// минимальную высоту через pickOptimalWidth, измеряя реальную высоту под
// каждую ширину-кандидат via ShapeUtil.onBeforeCreate (инкапсулирует
// шрифт/размер shape — не зависим от внутренних tldraw-констант).
//
// Новый размер помечается user-owned (meta.didrawSizePinned) — AI-layout его
// не перетирает (pin discipline, DRW-185). Позиция (x/y) не меняется.
// Объекты без текста и нетекстовые типы не трогаются (AC#5).

import type { Editor, TLShape, TLShapeId } from "tldraw";
import { extractPlaintextFromRichText } from "./schema-overlay-sync";
import { pickOptimalWidth } from "./text-fit";

// geo/note несут явный размер + growY-механику. text-shape само-ресайзится
// (autoSize) и в обтяжке не нуждается — не трогаем.
const TEXT_FIT_TYPES: ReadonlySet<string> = new Set(["geo", "note"]);

// Границы поиска ширины. MAX — предел читаемости (не делаем строку-простыню),
// MIN — нижняя граница узкого бокса.
export const TEXT_FIT_MIN_WIDTH = 60;
export const TEXT_FIT_MAX_WIDTH = 400;

// Базовая высота клона при измерении: onBeforeCreate только ДОБАВЛЯет growY к
// текущей h (не уменьшает), поэтому меряем с минимальной h — тогда growY
// отражает полную нужную высоту текста под заданную ширину, а не «текст влез в
// уже большой бокс» (иначе высота никогда не уменьшалась бы).
const MEASURE_BASE_H = 1;

function hasText(shape: TLShape): boolean {
  const rt = (shape.props as { richText?: unknown }).richText;
  const text = extractPlaintextFromRichText(rt);
  return text !== null && text.trim().length > 0;
}

/** effective высота клона shape при ширине w (через onBeforeCreate-measure). */
function makeMeasureH(
  editor: Editor,
  shape: TLShape,
): (w: number) => number {
  const util = editor.getShapeUtil(shape.type);
  return (w: number) => {
    const clone = {
      ...shape,
      props: { ...(shape.props as Record<string, unknown>), w, h: MEASURE_BASE_H, growY: 0 },
    } as TLShape;
    // biome-ignore lint/suspicious/noExplicitAny: tldraw onBeforeCreate signature
    const next = ((util as any).onBeforeCreate?.(clone) as TLShape | undefined) ?? clone;
    const np = next.props as { h?: number; growY?: number };
    const h = typeof np.h === "number" ? np.h : 0;
    const growY = typeof np.growY === "number" ? np.growY : 0;
    return h + growY;
  };
}

/**
 * Подгоняет размеры выделенных текстовых объектов. Возвращает число изменённых.
 */
export function applyTextFitToSelection(
  editor: Editor,
  selectedIds: ReadonlyArray<string>,
): number {
  const targets: TLShape[] = [];
  for (const id of selectedIds) {
    const s = editor.getShape(id as TLShapeId);
    if (!s || !TEXT_FIT_TYPES.has(s.type)) continue;
    if (!hasText(s)) continue;
    targets.push(s);
  }
  if (targets.length === 0) return 0;

  let changed = 0;
  editor.run(() => {
    editor.markHistoryStoppingPoint("fit-text");
    for (const s of targets) {
      const measureH = makeMeasureH(editor, s);
      const { width, height } = pickOptimalWidth(measureH, {
        minWidth: TEXT_FIT_MIN_WIDTH,
        maxWidth: TEXT_FIT_MAX_WIDTH,
      });
      const props = s.props as { w?: number; h?: number; growY?: number };
      const hasGrowY = typeof props.growY === "number";
      const nextProps: Record<string, unknown> = { w: width, h: height };
      // geo/note: высота поглощает growY → плотный бокс без авто-роста.
      if (hasGrowY) nextProps.growY = 0;
      const meta = (s.meta ?? {}) as Record<string, unknown>;
      editor.updateShape({
        id: s.id,
        type: s.type,
        props: nextProps,
        meta: { ...meta, didrawSizePinned: true },
        // biome-ignore lint/suspicious/noExplicitAny: TLShape props union
      } as any);
      changed++;
    }
  });
  return changed;
}
