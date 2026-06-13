// apps/backend/src/domain/global-align-adapter.ts
//
// DRW-245 — чистый адаптер входа Ф2 global-align для backend-пайплайна.
//
// Зеркало фронтовой сборки `runGlobalAlignPass` (apps/frontend/src/canvas/
// elk-layout.ts:1531-1583): из store + ELK-позиций строит `GlobalAlignPassArgs`,
// которые скармливаются переносённому в @shemma/domain чистому пассу.
//
// Здесь НЕТ прогона ELK и НЕТ вызова runLayout — только трансформация данных.
// Врезка в runLayout — задача T3.
//
// Главный риск (спека §3.3): координатное пространство. Backend scope='all' даёт
// ABSOLUTE координаты (collectPositions аккумулирует offset родителей), а
// runGlobalAlignPass ждёт PARENT-RELATIVE flat: дети контейнера — отн. контейнера,
// top-level — отн. фрейма. Нормализация abs↔rel вынесена в отдельные чистые
// функции и покрыта юнит-тестами (round-trip идемпотентность + вложенность).

import {
  type GlobalAlignPassArgs,
  type Spacing,
  globalAlignGaps,
  partitionComponents,
  rankComponents,
} from "@shemma/domain";
import type { TLStoreSnapshot } from "../store-types";
import {
  type Positions,
  type ShapeRec,
  collectArrows,
  collectShapes,
  isContainerShape,
  isPinned,
  isSizePinned,
  readContainerDirection,
  resolveArrowEndpoints,
} from "./layout";

// --------------------------------------------------------------------------
// ELK-direction → cardinal
// --------------------------------------------------------------------------

export type Cardinal = "TB" | "BT" | "LR" | "RL";

// Обратное отображение к MERMAID_DIR_TO_ELK в layout.ts (TB→DOWN, BT→UP,
// LR→RIGHT, RL→LEFT). readContainerDirection возвращает ELK-токены, GA-пасс
// рассуждает в cardinal.
const ELK_DIR_TO_CARDINAL: Record<string, Cardinal> = {
  DOWN: "TB",
  UP: "BT",
  RIGHT: "LR",
  LEFT: "RL",
};

/** Нормализует ELK-токен направления контейнера в cardinal; undefined для custom/none. */
export function elkDirToCardinal(
  elkDir: string | undefined,
): Cardinal | undefined {
  if (elkDir === undefined) return undefined;
  return ELK_DIR_TO_CARDINAL[elkDir];
}

/** Resolved cardinal-направление контейнера (или undefined для custom/inherit). */
export function resolveContainerCardinal(
  container: ShapeRec,
): Cardinal | undefined {
  return elkDirToCardinal(readContainerDirection(container));
}

// --------------------------------------------------------------------------
// store-индекс: parent-связи для нормализации координат
// --------------------------------------------------------------------------

interface StoreIndex {
  /** все layout-кандидаты (без arrow) по id */
  shapeById: Map<string, ShapeRec>;
  /**
   * контейнеры-колонки/passive по id — это compound-shape'ы ВНУТРИ scope
   * (schema-container / boundary-geo), но НЕ сам scope-фрейм. Фрейм — root
   * пространства (origin top-level), он не колонка и не passive.
   */
  containers: Map<string, ShapeRec>;
  /** прямые дети контейнера: containerId → childIds (только layout-кандидаты) */
  childrenOf: Map<string, string[]>;
}

/**
 * Индекс store для адаптера. `frameId` исключается из набора контейнеров: он —
 * scope-root (origin top-level), не колонка. Его прямые дети считаются top-level.
 */
function buildStoreIndex(store: TLStoreSnapshot, frameId?: string): StoreIndex {
  const shapes = collectShapes(store);
  const shapeById = new Map<string, ShapeRec>();
  const containers = new Map<string, ShapeRec>();
  for (const s of shapes) {
    shapeById.set(s.id, s);
    if (s.id !== frameId && isContainerShape(s)) containers.set(s.id, s);
  }
  const childrenOf = new Map<string, string[]>();
  for (const s of shapes) {
    const pid = s.parentId;
    if (pid && containers.has(pid)) {
      const bucket = childrenOf.get(pid);
      if (bucket) bucket.push(s.id);
      else childrenOf.set(pid, [s.id]);
    }
  }
  return { shapeById, containers, childrenOf };
}

// --------------------------------------------------------------------------
// нормализация координат abs ↔ frame-relative
// --------------------------------------------------------------------------

/**
 * ABSOLUTE → parent-relative flat (как ждёт runGlobalAlignPass):
 *  - ребёнок контейнера → координаты относительно контейнера (child.abs − container.abs);
 *  - top-level (контейнер / loose под фреймом или на странице) → относительно
 *    фрейма (top.abs − frame.abs).
 *
 * `frameId === undefined` (frameless / page-root) → top-level остаются абсолютными
 * (frame-origin = 0,0), что согласуется с фронтовым frameless-anchored путём.
 *
 * Размеры (w/h) переносятся без изменений. Чистая: возвращает НОВЫЙ объект,
 * входной не мутирует.
 */
export function absToFrameRelative(
  positions: Positions,
  store: TLStoreSnapshot,
  frameId?: string,
): Positions {
  const idx = buildStoreIndex(store, frameId);
  const frame = frameId ? positions[frameId] : undefined;
  const frameX = frame?.x ?? 0;
  const frameY = frame?.y ?? 0;
  const out: Positions = {};
  for (const [id, p] of Object.entries(positions)) {
    if (id === frameId) {
      // сам фрейм не нормализуется (он — origin top-level пространства)
      out[id] = { ...p };
      continue;
    }
    const shape = idx.shapeById.get(id);
    const pid = shape?.parentId;
    if (pid && idx.containers.has(pid) && pid !== frameId) {
      // ребёнок контейнера (не фрейма): отн. контейнера
      const cp = positions[pid];
      const baseX = cp?.x ?? 0;
      const baseY = cp?.y ?? 0;
      out[id] = { ...p, x: p.x - baseX, y: p.y - baseY };
    } else {
      // top-level: отн. фрейма
      out[id] = { ...p, x: p.x - frameX, y: p.y - frameY };
    }
  }
  return out;
}

/**
 * parent-relative flat → ABSOLUTE (обратная операция). Использует те же
 * parent-связи store. `positionsRel[frameId]` (если есть) держит origin —
 * для корректной реконструкции передавай abs-координаты фрейма.
 *
 * ВАЖНО: контейнер абсолютизируется по СВОЕЙ rel-координате + frame-origin
 * ПЕРЕД детьми (двупроходно), иначе ребёнок взял бы rel-координату контейнера
 * как базу. Реализовано через предвычисленные абсолютные позиции контейнеров.
 */
export function frameRelativeToAbs(
  positionsRel: Positions,
  store: TLStoreSnapshot,
  frameId?: string,
): Positions {
  const idx = buildStoreIndex(store, frameId);
  const frame = frameId ? positionsRel[frameId] : undefined;
  const frameX = frame?.x ?? 0;
  const frameY = frame?.y ?? 0;

  // абсолютные позиции контейнеров (top-level контейнер: rel отн. фрейма)
  const absContainer = new Map<string, { x: number; y: number }>();
  for (const cid of idx.containers.keys()) {
    if (cid === frameId) continue;
    const cp = positionsRel[cid];
    if (!cp) continue;
    // top-level контейнер хранится отн. фрейма → +origin.
    // (вложенные контейнеры в backend single-pass не появляются как rel-дети
    //  колонок Ф2, но на всякий случай поддержим через parentId-цепочку ниже)
    absContainer.set(cid, { x: cp.x + frameX, y: cp.y + frameY });
  }

  const out: Positions = {};
  for (const [id, p] of Object.entries(positionsRel)) {
    if (id === frameId) {
      out[id] = { ...p };
      continue;
    }
    const shape = idx.shapeById.get(id);
    const pid = shape?.parentId;
    if (pid && idx.containers.has(pid) && pid !== frameId) {
      const base = absContainer.get(pid) ?? { x: frameX, y: frameY };
      out[id] = { ...p, x: p.x + base.x, y: p.y + base.y };
    } else {
      out[id] = { ...p, x: p.x + frameX, y: p.y + frameY };
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// buildGlobalAlignArgs
// --------------------------------------------------------------------------

export interface GlobalAlignAdapterOpts {
  /** направление фрейма (resolved) — LR/RL → axisVertical, RL/BT → invertColumnOrder */
  frameDir: Cardinal;
  /** spacing-пресет — для rowGap/compGap (паритет с фронтом через globalAlignGaps) */
  spacing: Spacing;
  /**
   * scope-фрейм (root раскладки). Исключается из колонок/passive/loose —
   * он origin top-level, не участник Ф2. undefined для frameless (page-root).
   */
  frameId?: string;
  /** ⌘⌥⇧L: игнорировать пины (pinned пустой) */
  forceUnpin?: boolean;
}

/**
 * Собирает `GlobalAlignPassArgs` из store + parent-relative позиций.
 *
 * Зеркало elk-layout.ts:1531-1583:
 *  - columns ← контейнеры, чьё resolved-cardinal == laneDir (поперёк потока
 *    фрейма), с детьми, не sizePinned (если не forceUnpin);
 *  - looseIds ← top-level loose geo (не контейнеры, прямо под фреймом/на странице);
 *  - passive ← прочие контейнеры с детьми (вдоль потока, sizePinned, custom);
 *  - nodeEdges ← рёбра по bindings (resolveArrowEndpoints);
 *  - components ← partitionComponents+rankComponents по top-level + рёбрам;
 *  - rowGap/compGap ← globalAlignGaps(spacing) (=round(nodeNode*0.62), comp);
 *  - padTop = axisVertical ? 44 : 16; padBottom = 16;
 *  - pinned ← isPinned (+ sizePinned для passive); пусто при forceUnpin;
 *  - axisVertical ← LR/RL; invertColumnOrder ← RL/BT.
 *
 * `flat` берётся как ССЫЛКА на переданный `positionsRel` — runGlobalAlignPass
 * мутирует его на месте (как и фронт). Caller отвечает за abs↔rel нормализацию.
 */
export function buildGlobalAlignArgs(
  store: TLStoreSnapshot,
  positionsRel: Positions,
  opts: GlobalAlignAdapterOpts,
): GlobalAlignPassArgs {
  const { frameDir, spacing } = opts;
  const forceUnpin = opts.forceUnpin === true;
  const axisVertical = frameDir === "LR" || frameDir === "RL";
  const laneDir: Cardinal = axisVertical ? "TB" : "LR";

  const idx = buildStoreIndex(store, opts.frameId);

  // top-level = layout-кандидаты, чей parent — НЕ контейнер (под фреймом /
  // на странице). Контейнеры всегда top-level (их parent — фрейм/страница).
  const isTopLevel = (s: ShapeRec): boolean => {
    const pid = s.parentId;
    return !pid || !idx.containers.has(pid);
  };

  // ---- columns / passive / looseIds ----
  const columns: Array<{ id: string; kidIds: string[] }> = [];
  const passive: Array<{ id: string }> = [];
  const pinned = new Set<string>();

  for (const [cid, container] of idx.containers) {
    const kids = idx.childrenOf.get(cid) ?? [];
    if (kids.length === 0) continue; // пустой контейнер не участвует
    const cardinal = resolveContainerCardinal(container);
    const sizePinnedExcluded = !forceUnpin && isSizePinned(container);
    const isColumn = cardinal === laneDir && !sizePinnedExcluded;
    if (isColumn) {
      columns.push({ id: cid, kidIds: kids });
      if (!forceUnpin) {
        for (const kidId of kids) {
          const kid = idx.shapeById.get(kidId);
          if (kid && isPinned(kid)) pinned.add(kidId);
        }
      }
    } else {
      passive.push({ id: cid });
      if (!forceUnpin && (isPinned(container) || isSizePinned(container))) {
        pinned.add(cid);
      }
    }
  }

  const looseIds: string[] = [];
  for (const s of idx.shapeById.values()) {
    if (idx.containers.has(s.id)) continue; // контейнеры — не loose
    if (!isTopLevel(s)) continue; // дети контейнеров — не top-level
    // loose geo: top-level не-контейнер (geo/note/text), участвующий в потоке
    looseIds.push(s.id);
    if (!forceUnpin && isPinned(s)) pinned.add(s.id);
  }

  // ---- nodeEdges (рёбра по bindings) ----
  const nodeEdges: Array<{ from: string; to: string }> = [];
  for (const a of collectArrows(store)) {
    const ep = resolveArrowEndpoints(store, a.id);
    if (!ep) continue;
    nodeEdges.push({ from: ep.src, to: ep.tgt });
  }

  // ---- components (ranked top-level ids) ----
  // top-level id'ы для партиции: контейнеры + loose, поднимаем рёбра до owner'а.
  const ownerOf = new Map<string, string>();
  for (const [cid, kids] of idx.childrenOf) {
    for (const kid of kids) ownerOf.set(kid, cid);
  }
  const liftToTop = (id: string): string => ownerOf.get(id) ?? id;
  const topLevelIds = [
    ...columns.map((c) => c.id),
    ...passive.map((p) => p.id),
    ...looseIds,
  ];
  const topLevelSet = new Set(topLevelIds);
  const collapsedEdges: Array<{ from: string; to: string }> = [];
  for (const e of nodeEdges) {
    const from = liftToTop(e.from);
    const to = liftToTop(e.to);
    if (from === to) continue;
    if (!topLevelSet.has(from) || !topLevelSet.has(to)) continue;
    collapsedEdges.push({ from, to });
  }
  const ranked = rankComponents(
    partitionComponents(topLevelIds, collapsedEdges),
    {},
  );
  const components = ranked.map((c) => c.ids);

  // ---- gaps (паритет с фронтом) ----
  const { rowGap, compGap } = globalAlignGaps(spacing);

  return {
    flat: positionsRel,
    columns,
    looseIds,
    passive,
    nodeEdges,
    components,
    rowGap,
    compGap,
    // padTop: на LR/RL (axisVertical) заголовок контейнера сверху по y мешает → 44;
    // на TB/BT (!axisVertical) решаем x, заголовок не мешает → 16. (elk-layout.ts:1577)
    padTop: axisVertical ? 44 : 16,
    padBottom: 16,
    pinned: forceUnpin ? new Set<string>() : pinned,
    axisVertical,
    invertColumnOrder: frameDir === "RL" || frameDir === "BT",
  };
}
