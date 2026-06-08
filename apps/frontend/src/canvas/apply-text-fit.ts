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
import { collectDescendantIds } from "../shapes/style-apply";
import { reflowAfterFit } from "./elk-layout";
import { extractPlaintextFromRichText } from "./schema-overlay-sync";
import { pickOptimalWidth } from "./text-fit";

// geo/note несут явный размер + growY-механику. text-shape само-ресайзится
// (autoSize) и в обтяжке не нуждается — не трогаем.
export const TEXT_FIT_TYPES: ReadonlySet<string> = new Set(["geo", "note"]);

// Границы поиска ширины. MAX — предел читаемости (не делаем строку-простыню),
// MIN — нижняя граница узкого бокса.
export const TEXT_FIT_MIN_WIDTH = 60;
export const TEXT_FIT_MAX_WIDTH = 400;

// Базовая высота клона при измерении: onBeforeCreate только ДОБАВЛЯет growY к
// текущей h (не уменьшает), поэтому меряем с минимальной h — тогда growY
// отражает полную нужную высоту текста под заданную ширину, а не «текст влез в
// уже большой бокс» (иначе высота никогда не уменьшалась бы).
const MEASURE_BASE_H = 1;

/** Объект несёт непустой текст (geo/note richText). */
export function shapeHasText(shape: TLShape): boolean {
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
 * Подгоняет размер ОДНОГО объекта с текстом (geo/note) под оптимальную ширину.
 * Возвращает true, если объект был обтянут. Нетекстовые типы и объекты без
 * текста пропускаются (false). Размер помечается user-owned
 * (meta.didrawSizePinned) — AI-layout его не перетирает.
 *
 * Чистого undo-grouping не делает: вызывающая сторона оборачивает в
 * editor.run() + markHistoryStoppingPoint(), если нужна отдельная undo-точка
 * (DRW-228: переиспользуется и командой ⌘⇧F, и авто-обтяжкой по событию).
 */
export function applyTextFitToShape(editor: Editor, shape: TLShape): boolean {
  if (!TEXT_FIT_TYPES.has(shape.type)) return false;
  if (!shapeHasText(shape)) return false;

  const measureH = makeMeasureH(editor, shape);
  const { width, height } = pickOptimalWidth(measureH, {
    minWidth: TEXT_FIT_MIN_WIDTH,
    maxWidth: TEXT_FIT_MAX_WIDTH,
  });
  const props = shape.props as { w?: number; h?: number; growY?: number };
  const hasGrowY = typeof props.growY === "number";
  const nextProps: Record<string, unknown> = { w: width, h: height };
  // geo/note: высота поглощает growY → плотный бокс без авто-роста.
  if (hasGrowY) nextProps.growY = 0;
  const meta = (shape.meta ?? {}) as Record<string, unknown>;
  editor.updateShape({
    id: shape.id,
    type: shape.type,
    props: nextProps,
    meta: { ...meta, didrawSizePinned: true },
    // biome-ignore lint/suspicious/noExplicitAny: TLShape props union
  } as any);
  return true;
}

/**
 * DRW-232: чистый предикат «обтягивать ли этот объект вручную». geo/note с
 * непустым текстом обтягиваются; size-pinned (вручную заданный размер) — только
 * в force-режиме (⌘⌥⇧F / Opt-click), иначе уважаем пин (не ломаем форму).
 */
export function shouldManualFit(input: {
  type: string;
  hasText: boolean;
  sizePinned: boolean;
  force: boolean;
}): boolean {
  if (!TEXT_FIT_TYPES.has(input.type)) return false;
  if (!input.hasText) return false;
  if (input.sizePinned && !input.force) return false;
  return true;
}

/**
 * DRW-232: обтянуть текст рекурсивно по выделению/контейнеру/фрейму и привести
 * обёртки в порядок — точечный push наезжающих соседей вдоль направления +
 * envelope-рост/сжатие родителей по всей цепочке предков (reflowAfterFit). Вся
 * операция — одна undo-точка. Возвращает число переобтянутых объектов.
 *
 * Цели обтяжки — текстовые geo/note среди ПОТОМКОВ выделения (collectDescendantIds:
 * кнопка на контейнере/фрейме берёт вложенные узлы, в т.ч. во вложенных контейнерах;
 * мульти-выделение — и сами узлы, и детей). `force` (⌘⌥⇧F / Opt-click) — обтягивать
 * и size-pinned узлы тоже; обычный режим уважает вручную заданный размер.
 *
 * reflow по обёрткам ВСЕГО выделения выполняется ВСЕГДА, даже если ни один узел не
 * переобтянут (все уже size-pinned, в т.ч. после авто-обтяжки DRW-228, которая не
 * делает push/envelope): иначе наезд оставался бы, а кнопка была бы no-op. Размеры
 * читаются из props (синхронно — effectiveSizeFromProps), поэтому push и envelope
 * работают в одном run / одной undo-точке.
 */
export function fitTextWithReflow(
  editor: Editor,
  rootIds: ReadonlyArray<string>,
  opts?: { force?: boolean },
): number {
  const force = opts?.force === true;
  const scope = [...collectDescendantIds(editor, [...rootIds])];
  if (scope.length === 0) return 0;
  const targets: TLShape[] = [];
  for (const id of scope) {
    const s = editor.getShape(id as TLShapeId);
    if (!s) continue;
    const sizePinned =
      (s.meta as Record<string, unknown> | undefined)?.didrawSizePinned ===
      true;
    if (shouldManualFit({ type: s.type, hasText: shapeHasText(s), sizePinned, force }))
      targets.push(s);
  }
  let changed = 0;
  editor.run(() => {
    editor.markHistoryStoppingPoint("fit-text");
    for (const s of targets) {
      if (applyTextFitToShape(editor, s)) changed++;
    }
    reflowAfterFit(editor, scope);
  });
  return changed;
}
