/**
 * DRW-245 — единый источник spacing-чисел для Ф2 global-align пасса.
 *
 * Эталон — фронтовый ⌘⇧L (`apps/frontend/src/canvas/elk-layout.ts`): там пасс
 * получает `rowGap = round(nodeNode * CONTAINER_SPACING_FRACTION)` и
 * `compGap = comp`, где `nodeNode`/`comp` — числа таблицы `SPREAD` (НЕ
 * `SPACING_PRESETS` из `layout-modes.ts`, у которой другие значения). Чтобы
 * backend-адаптер давал пиксель-в-пиксель тот же результат, что фронт (AC#1,
 * порог |Δ|<1px), оба берут rowGap/compGap отсюда.
 *
 * Значения скопированы из фронтового `SPREAD` (поля nodeNode/comp) — при
 * расхождении синхронизировать обе стороны на эту таблицу.
 */

import type { Spacing } from "./layout-modes";

/** Доля board-spacing для внутренних зазоров строк колонки (фронт: 0.62). */
export const CONTAINER_SPACING_FRACTION = 0.62;

/**
 * Зеркало фронтового `SPREAD` — только поля, нужные Ф2-пассу:
 *  - `nodeNode` — cross-axis зазор соседей (основа rowGap);
 *  - `comp`     — зазор между компонентами (compGap при re-pack).
 */
export const GLOBAL_ALIGN_SPREAD: Record<
  Spacing,
  { nodeNode: number; comp: number }
> = {
  compact: { nodeNode: 34, comp: 60 },
  normal: { nodeNode: 92, comp: 130 },
  loose: { nodeNode: 160, comp: 240 },
};

export interface GlobalAlignGaps {
  /** мин. вертикальный зазор строк в колонке (round(nodeNode * fraction)) */
  rowGap: number;
  /** зазор между компонентами по cross-оси (re-pack) */
  compGap: number;
}

/**
 * rowGap/compGap для заданного spacing — единая формула фронта и backend.
 * Эквивалент строк elk-layout.ts:1572-1573.
 */
export function globalAlignGaps(spacing: Spacing): GlobalAlignGaps {
  const sp = GLOBAL_ALIGN_SPREAD[spacing];
  return {
    rowGap: Math.round(sp.nodeNode * CONTAINER_SPACING_FRACTION),
    compGap: sp.comp,
  };
}
