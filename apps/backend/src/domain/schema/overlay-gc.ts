// apps/backend/src/domain/schema/overlay-gc.ts
//
// DRW-216: GC orphan-overlay'ев. didrawOverlays держит записи удалённых узлов
// «навсегда» (keep-dead — чтобы re-add того же nodeId вернул пользовательский
// вид). На долгоживущих AI-редактируемых досках это растит файл комнаты.
//
// Политика: age-based generation GC. Каждый apply-проход фрейма = поколение
// (didrawOverlayGen++). Orphan помечается поколением смерти (deadGen); при
// воскрешении узла метка снимается (re-add окно сохраняется). Сборка
// случается ТОЛЬКО при превышении порога (много мусора относительно живых
// узлов) и только для orphan'ов, переживших GC_KEEP_GENERATIONS поколений —
// недавние удаления остаются восстановимыми.

import type { NodeId, OverlayEntry } from "@shemma/domain";

/** Orphan переживает столько apply-проходов после смерти, прежде чем стать
 *  кандидатом на сборку — окно для «недавнего re-add». */
export const GC_KEEP_GENERATIONS = 20;

/** GC не запускается, пока orphan'ов не станет больше этого множителя от
 *  числа живых узлов (пропорционально размеру схемы). */
export const GC_TRIGGER_FACTOR = 2;

/** Нижний порог: маленькие доски не трогаем вовсе (keep-dead как раньше). */
export const GC_MIN_ORPHANS = 50;

export type GcResult = {
  overlays: Record<NodeId, OverlayEntry>;
  /** Новое поколение фрейма (записать в frame.meta.didrawOverlayGen). */
  gen: number;
  /** Сколько orphan-записей удалено в этом проходе. */
  collected: number;
};

/**
 * Чистый GC-проход над overlay-словарём.
 *
 * @param overlays  текущие didrawOverlays (после всех правок батча)
 * @param liveIds   NodeId узлов, существующих ПОСЛЕ apply
 * @param prevGen   frame.meta.didrawOverlayGen ?? 0
 */
export function gcOverlays(
  overlays: Record<NodeId, OverlayEntry>,
  liveIds: ReadonlySet<NodeId>,
  prevGen: number,
): GcResult {
  const gen = prevGen + 1;
  const out: Record<NodeId, OverlayEntry> = {};
  let orphanCount = 0;

  // Pass 1: разметка. Живые теряют deadGen (воскрешение сбрасывает возраст);
  // свежие orphan'ы получают deadGen = текущее поколение.
  for (const key in overlays) {
    const nid = key as NodeId;
    const entry = overlays[nid];
    if (!entry) continue;
    if (liveIds.has(nid)) {
      if (entry.deadGen !== undefined) {
        const { deadGen: _drop, ...rest } = entry;
        out[nid] = rest;
      } else {
        out[nid] = entry;
      }
      continue;
    }
    orphanCount++;
    out[nid] = entry.deadGen === undefined ? { ...entry, deadGen: gen } : entry;
  }

  // Pass 2: сборка — только при превышении порога и только старые orphan'ы.
  let collected = 0;
  const threshold = GC_TRIGGER_FACTOR * liveIds.size;
  if (orphanCount >= GC_MIN_ORPHANS && orphanCount > threshold) {
    for (const key in out) {
      const nid = key as NodeId;
      if (liveIds.has(nid)) continue;
      const dg = out[nid]?.deadGen;
      if (dg !== undefined && gen - dg >= GC_KEEP_GENERATIONS) {
        delete out[nid];
        collected++;
      }
    }
  }

  return { overlays: out, gen, collected };
}
