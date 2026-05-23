/**
 * Schema frame duplication + delete logic — DRW-134 Task 3.1.
 *
 * `duplicateSchemaFrame` — полная копия frame'а с deep identity remap:
 *   1. Читает meta.mermaidSource + meta.didrawOverlays + children.
 *   2. Генерирует новые NodeId'ы для всех дочерних узлов (сохраняя slug, новый suffix).
 *   3. Заменяет все старые ID в RAW (regex) и в overlay keys.
 *   4. Позиционирует новый frame правее оригинала + 40px.
 *   5. Original frame NOT MODIFIED — проверяется в тестах.
 *
 * `buildDeleteSchemaFrameBatch` — batch для удаления frame + всех его children.
 *
 * Обе функции — pure, no I/O, no daemon calls.
 * Caller (route handler) несёт ответственность за persist.
 */

import { randomBytes } from "node:crypto";
import type { NodeId, OverlayEntry } from "@shemma/domain";
import { slugify } from "@shemma/domain";
import type { TLRecord, StoreChangeBatch } from "../../store-types";
import type { RoomState } from "../../types";
import { generateNodeIdServer } from "./identity";
import { assignBatchIndices } from "./index-key";

// ---- Random id helpers ----

function randHex(): string {
  return randomBytes(5).toString("hex");
}

function frameShapeId(): string {
  return `shape:f_${randHex()}`;
}

function childShapeId(): string {
  return `shape:${randHex()}`;
}

function bindingId(): string {
  return `binding:${randHex()}`;
}

// ---- Arrow / binding remap helpers (DRW-140) ----

/**
 * Remap `props.start.boundShapeId` / `props.end.boundShapeId` для arrow shape'ов.
 * Cloned arrow всё ещё ссылается на старые endpoint shape ids — без этой замены
 * tldraw рендерит arrow как orphan (визуально не привязан к фигурам).
 */
function remapArrowProps(
  shape: TLRecord,
  shapeIdMap: Map<string, string>,
): TLRecord {
  if (shape.type !== "arrow") return shape;
  // biome-ignore lint/suspicious/noExplicitAny: tldraw shape props are untyped
  const oldProps = ((shape as any).props ?? {}) as Record<string, unknown>;
  const newProps: Record<string, unknown> = { ...oldProps };
  let dirty = false;
  for (const key of ["start", "end"] as const) {
    const endpoint = oldProps[key] as Record<string, unknown> | undefined;
    if (!endpoint || typeof endpoint !== "object") continue;
    const boundShapeId = endpoint.boundShapeId;
    if (typeof boundShapeId !== "string") continue;
    const newBound = shapeIdMap.get(boundShapeId);
    if (newBound) {
      newProps[key] = { ...endpoint, boundShapeId: newBound };
      dirty = true;
    }
  }
  if (!dirty) return shape;
  return { ...shape, props: newProps } as TLRecord;
}

/**
 * Clone bindings, ссылающиеся на любой shape из shapeIdMap (либо `fromId`,
 * либо `toId` — клонированный shape).
 *
 * Binding клонируется только если ОБА endpoint'а тоже клонированы — иначе
 * получили бы binding ссылку с одной стороны на оригинал, что воссоздало бы
 * tldraw split-state (один shape в двух местах). Bindings, которые "только
 * частично" попадают во frame, пропускаем.
 */
function buildClonedBindings(
  store: Record<string, TLRecord | undefined>,
  shapeIdMap: Map<string, string>,
): TLRecord[] {
  const out: TLRecord[] = [];
  for (const id in store) {
    const r = store[id];
    if (!r || r.typeName !== "binding") continue;
    const b = r as unknown as { fromId?: unknown; toId?: unknown };
    const oldFromId = typeof b.fromId === "string" ? b.fromId : undefined;
    const oldToId = typeof b.toId === "string" ? b.toId : undefined;
    if (!oldFromId || !oldToId) continue;
    const newFromId = shapeIdMap.get(oldFromId);
    const newToId = shapeIdMap.get(oldToId);
    // Both endpoints must be cloned — otherwise the binding would dangle
    // between original and replica subtrees.
    if (!newFromId || !newToId) continue;
    const newId = bindingId();
    out.push({
      ...r,
      id: newId,
      fromId: newFromId,
      toId: newToId,
    } as TLRecord);
  }
  return out;
}

// ---- Find all direct/indirect children of a frame ----

/**
 * Возвращает все shapes, которые являются потомками данного frame'а
 * (по цепочке parentId, max 64 уровня — против циклов).
 */
export function findFrameChildren(
  store: Record<string, TLRecord | undefined>,
  frameId: string,
): TLRecord[] {
  const result: TLRecord[] = [];
  const seen = new Set<string>();

  // BFS через parentId-цепочку
  const queue: string[] = [frameId];
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    for (const id in store) {
      if (seen.has(id)) continue;
      const r = store[id];
      if (!r || r.typeName !== "shape") continue;
      if (r.id === frameId) continue; // сам frame не в результате
      if (r.parentId === parentId) {
        seen.add(id);
        result.push(r);
        queue.push(id); // рекурсивно спускаемся
      }
    }
  }

  return result;
}

// ---- NodeId remap helpers ----

/**
 * Строит карту oldNodeId → newNodeId для всех children frame'а.
 * Новый ID: тот же slug, новый случайный suffix.
 */
function buildNodeIdMap(
  children: TLRecord[],
  suffixLen: number,
): Record<NodeId, NodeId> {
  const nodeIdMap: Record<NodeId, NodeId> = {};
  const usedIds = new Set<NodeId>();

  for (const child of children) {
    const oldId = child.meta?.didrawId;
    if (typeof oldId !== "string") continue;

    // Восстанавливаем slug из старого ID: всё до последнего «-<suffix>».
    // Pattern: <slug>-<suffixLen chars base36> → slug = всё кроме последних suffixLen+1 chars.
    // Но надёжнее: re-slugify из didrawLabel (если есть), иначе из ID.
    const label = typeof child.meta?.didrawLabel === "string" ? child.meta.didrawLabel : "";
    const slug = label ? slugify(label) : extractSlugFromId(oldId, suffixLen);

    const newId = generateNodeIdServer({ slug, suffixLen, existingIds: usedIds });
    usedIds.add(newId);
    nodeIdMap[oldId] = newId;
  }

  return nodeIdMap;
}

/**
 * Вытаскивает slug из NodeId, зная длину suffix.
 * `api-x9k2lm` с suffixLen=6 → `api`.
 * Fallback: если строка слишком короткая → возвращаем пустую строку (→ anonymous form).
 */
function extractSlugFromId(nodeId: string, suffixLen: number): string {
  // suffixLen chars base36 + '-' separator
  const suffixWithDash = suffixLen + 1;
  if (nodeId.length <= suffixWithDash) return "";
  return nodeId.slice(0, nodeId.length - suffixWithDash);
}

/**
 * Заменяет все вхождения старых NodeId'ов на новые в RAW mermaid строке.
 * Каждый NodeId заменяется как отдельное слово (word boundary через пробел/пунктуацию).
 */
function remapIdsInRaw(raw: string, nodeIdMap: Record<NodeId, NodeId>): string {
  let result = raw;
  // Сортируем по длине (длинные первыми) чтобы избежать частичных замен
  const entries = Object.entries(nodeIdMap).sort(([a], [b]) => b.length - a.length);
  for (const [oldId, newId] of entries) {
    // Используем word boundary: nodeId окружён символами, которые не входят в [a-z0-9-]
    const escaped = oldId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`(?<![a-z0-9-])${escaped}(?![a-z0-9-])`, "g"), newId);
  }
  return result;
}

/**
 * Переотображает ключи в overlay map: старые NodeId → новые NodeId.
 * Значения (OverlayEntry) копируются без изменений.
 */
function remapOverlayKeys(
  overlays: Record<NodeId, OverlayEntry>,
  nodeIdMap: Record<NodeId, NodeId>,
): Record<NodeId, OverlayEntry> {
  const result: Record<NodeId, OverlayEntry> = {};
  for (const [oldId, entry] of Object.entries(overlays)) {
    const newId = nodeIdMap[oldId] ?? oldId; // unmapped IDs остаются (не-node overlays)
    result[newId] = entry;
  }
  return result;
}

// ---- duplicateSchemaFrame ----

export type DuplicateResult = {
  newFrameId: string;
  nodeIdMap: Record<NodeId, NodeId>;
  batch: StoreChangeBatch;
};

export function duplicateSchemaFrame(opts: {
  room: RoomState;
  oldFrame: TLRecord;
  newLabel: string;
  suffixLen: number;
}): DuplicateResult {
  const { room, oldFrame, newLabel, suffixLen } = opts;
  const store = room.store.store as Record<string, TLRecord | undefined>;

  // 1. Читаем meta оригинального frame'а
  const oldMeta = (oldFrame.meta ?? {}) as Record<string, unknown>;
  const oldRaw = typeof oldMeta.mermaidSource === "string" ? oldMeta.mermaidSource : "";
  const oldOverlays = (oldMeta.didrawOverlays ?? {}) as Record<NodeId, OverlayEntry>;

  // 2. Находим всех детей оригинального frame'а
  const children = findFrameChildren(store, oldFrame.id);

  // 3. Строим nodeIdMap: oldNodeId → newNodeId
  const nodeIdMap = buildNodeIdMap(children, suffixLen);

  // 4. Ремапим RAW и overlays
  const newRaw = remapIdsInRaw(oldRaw, nodeIdMap);
  const newOverlays = remapOverlayKeys(oldOverlays, nodeIdMap);

  // 5. Позиция нового frame'а: правее оригинала + 40px
  const oldX = typeof oldFrame.x === "number" ? oldFrame.x : 0;
  const oldY = typeof oldFrame.y === "number" ? oldFrame.y : 0;
  const oldProps = (oldFrame.props ?? {}) as { w?: unknown };
  const oldW = typeof oldProps.w === "number" ? oldProps.w : 640;
  const newPosition = { x: oldX + oldW + 40, y: oldY };

  // 6. Создаём новый frame shape
  const newFrameId = frameShapeId();
  const newFrame: TLRecord = {
    ...oldFrame,
    id: newFrameId,
    x: newPosition.x,
    y: newPosition.y,
    props: {
      ...(oldFrame.props as object ?? {}),
      name: newLabel,
    },
    meta: {
      ...oldMeta,
      mermaidSource: newRaw,
      didrawOverlays: newOverlays,
      // Обязательные v2 meta-поля
      didrawSchemaFrame: true,
      didrawProtocol: "v2",
      schemaProtocolVersion: "1.0",
    },
  } as TLRecord;

  // 7. Создаём клоны дочерних shapes с новыми nodeId'ами
  //
  // DRW-140: shapeIdMap (oldShapeId → newShapeId) включает И frame, И всех
  // children — нужен чтобы (а) remap'ить boundShapeId в cloned arrow props,
  // (б) клонировать bindings между новыми endpoint'ами. Без этого arrow shapes
  // остаются как orphan'ы и стрелок визуально нет.
  const batch: StoreChangeBatch = { added: {}, updated: {}, removed: {} };
  batch.added[newFrameId] = newFrame;
  const shapeIdMap = new Map<string, string>();
  shapeIdMap.set(oldFrame.id, newFrameId);

  // 7a. First pass — clone all children, build shapeIdMap. We have to defer
  // arrow `props` remap to a second pass because arrows may reference geo
  // siblings that haven't been cloned yet (insertion order isn't guaranteed).
  const arrowsToFix: TLRecord[] = [];
  for (const child of children) {
    const oldId = child.meta?.didrawId;
    const newChildId = childShapeId();
    shapeIdMap.set(child.id, newChildId);

    if (typeof oldId !== "string") {
      // Ребёнок без didrawId (arrow и т.п.) — клонируем as-is + parentId.
      // Arrow `props.start/end.boundShapeId` ремапим во втором проходе.
      const clonedChild: TLRecord = {
        ...child,
        id: newChildId,
        parentId: newFrameId,
      } as TLRecord;
      batch.added[newChildId] = clonedChild;
      if (child.type === "arrow") arrowsToFix.push(clonedChild);
      continue;
    }

    const newNodeId = nodeIdMap[oldId];
    if (!newNodeId) continue; // не должно случиться

    const childMeta = (child.meta ?? {}) as Record<string, unknown>;
    const clonedChild: TLRecord = {
      ...child,
      id: newChildId,
      parentId: newFrameId,
      meta: {
        ...childMeta,
        didrawId: newNodeId,
        didrawName: newNodeId, // legacy mirror
        didrawSchemaParent: newFrameId,
      },
    } as TLRecord;
    batch.added[newChildId] = clonedChild;
  }

  // 7b. Second pass — remap arrow props.start/end.boundShapeId.
  for (const arrow of arrowsToFix) {
    const remapped = remapArrowProps(arrow, shapeIdMap);
    if (remapped !== arrow) batch.added[arrow.id] = remapped;
  }

  // 7c. Clone bindings whose both endpoints are in the cloned subtree.
  for (const cloned of buildClonedBindings(store, shapeIdMap)) {
    batch.added[cloned.id] = cloned;
  }

  // DRW-141: assign unique fractional indices to the cloned children so that
  // a native tldraw `Cmd+D` on the replica doesn't collide on identical "a1"
  // indices. Existing siblings of `newFrameId` should be none (frame is brand
  // new), but using `store` as the prior snapshot stays consistent with other
  // call sites and handles edge cases gracefully.
  assignBatchIndices(batch, store);

  // Проверяем что оригинальный frame НЕ попал в batch.updated/removed
  // (инвариант из spec §Frame duplication)
  // (это structural guarantee — мы никогда не добавляем oldFrame.id в updated/removed)

  return { newFrameId, nodeIdMap, batch };
}

// ---- buildDeleteSchemaFrameBatch ----

/**
 * Строит StoreChangeBatch для удаления schema-frame и всех его дочерних shapes.
 * Pure function — не мутирует room.store.
 */
export function buildDeleteSchemaFrameBatch(opts: {
  room: RoomState;
  frame: TLRecord;
}): StoreChangeBatch {
  const { room, frame } = opts;
  const store = room.store.store as Record<string, TLRecord | undefined>;

  const batch: StoreChangeBatch = { added: {}, updated: {}, removed: {} };

  // Удаляем frame
  batch.removed[frame.id] = frame;

  // Удаляем всех детей (рекурсивно)
  const children = findFrameChildren(store, frame.id);
  for (const child of children) {
    batch.removed[child.id] = child;
  }

  return batch;
}
