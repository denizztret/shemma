// apps/backend/src/domain/schema/view.ts
// Чистый builder для v2 CanvasViewResponse из RoomState. DRW-134 Task 2.1.
// Pure function без side-effects — тестируется без HTTP layer.

import type { CanvasViewResponse, NodeId, OverlayEntry } from "@shemma/domain";
import type { TLRecord } from "../../store-types";
import type { RoomState } from "../../types";
import { richTextToString } from "../context";

/** Максимальная глубина ancestry walk для защиты от циклов в store. */
const MAX_ANCESTRY_HOPS = 64;

/**
 * Возвращает true если запись является page-level записью.
 * Проверяет `typeName === "page"` либо id начинается с "page:".
 */
function isPageRecord(r: TLRecord | undefined): boolean {
  if (!r) return false;
  return r.typeName === "page" || r.id.startsWith("page:");
}

/**
 * Возвращает true если shape является прямым или косвенным ребёнком schema-frame.
 * Ancestry walk по parentId-цепочке до page. Cycle guard: max 64 hops.
 * Возвращает `{ isChild: true, frameId }` если встретили schema-frame предка;
 * возвращает `{ isChild: false }` если цепочка заканчивается на page без frame'а.
 */
function findFrameAncestor(
  shape: TLRecord,
  records: Record<string, TLRecord | undefined>,
): { found: true; frameId: string } | { found: false } {
  let currentId: string | undefined = shape.parentId;
  let hops = 0;

  while (currentId && hops < MAX_ANCESTRY_HOPS) {
    const parent = records[currentId] as TLRecord | undefined;

    // Достигли page-record — shape является free shape.
    if (!parent || isPageRecord(parent)) return { found: false };

    // Если parent является schema-frame — shape является его членом.
    if (
      parent.typeName === "shape" &&
      parent.meta?.didrawSchemaFrame === true
    ) {
      return { found: true, frameId: parent.id };
    }

    currentId = parent.parentId;
    hops++;
  }

  // Либо цикл (guard), либо chain кончился без page-record.
  return { found: false };
}

/**
 * Вычисляет bounding box shape'а через props.w/h + x/y.
 * Integer-rounded per spec §bbox computation.
 */
function shapeBbox(r: TLRecord): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const x = typeof r.x === "number" ? r.x : 0;
  const y = typeof r.y === "number" ? r.y : 0;
  const props = (r.props ?? {}) as { w?: unknown; h?: unknown };
  const w = typeof props.w === "number" ? props.w : 0;
  const h = typeof props.h === "number" ? props.h : 0;
  return {
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(w),
    h: Math.round(h),
  };
}

/**
 * Вычисляет union bbox из массива bbox'ов.
 * Если массив пустой — возвращает { x:0, y:0, w:0, h:0 }.
 */
function unionBbox(
  bboxes: Array<{ x: number; y: number; w: number; h: number }>,
): { x: number; y: number; w: number; h: number } {
  if (bboxes.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = bboxes[0].x;
  let minY = bboxes[0].y;
  let maxX = bboxes[0].x + bboxes[0].w;
  let maxY = bboxes[0].y + bboxes[0].h;
  for (let i = 1; i < bboxes.length; i++) {
    const b = bboxes[i];
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.w > maxX) maxX = b.x + b.w;
    if (b.y + b.h > maxY) maxY = b.y + b.h;
  }
  return {
    x: Math.round(minX),
    y: Math.round(minY),
    w: Math.round(maxX - minX),
    h: Math.round(maxY - minY),
  };
}

/**
 * Извлекает label из tldraw shape.
 * Читает richText из props.richText (ProseMirror doc) через richTextToString,
 * либо string-fallback из props.text, либо из frame props.name (для frame shapes).
 */
function extractLabel(r: TLRecord): string {
  const props = (r.props ?? {}) as Record<string, unknown>;

  // Frame shapes используют props.name как label.
  if (
    r.type === "frame" &&
    typeof props.name === "string" &&
    props.name.length > 0
  ) {
    return props.name;
  }

  // richText (ProseMirror) — основной формат note/geo/text.
  if (props.richText) {
    const text = richTextToString(props.richText);
    if (text.length > 0) return text;
  }

  // Fallback на plain text (legacy shapes).
  if (typeof props.text === "string" && props.text.length > 0) {
    return props.text;
  }

  return "";
}

/**
 * Строит CanvasViewResponse для v2 room.
 * Разбивает все shapes на schema-frames и free shapes.
 * Schema-frame children НЕ включаются в free[].
 *
 * @param room — текущее состояние room (должна быть v2).
 */
export function buildCanvasView(room: RoomState): CanvasViewResponse {
  const records = room.store.store ?? {};

  // Собираем все shapes.
  const allShapes: TLRecord[] = [];
  for (const id in records) {
    const r = records[id] as TLRecord | undefined;
    if (r?.typeName === "shape") allShapes.push(r);
  }

  // Первый проход: находим все schema-frames.
  const frameShapes = allShapes.filter(
    (s) => s.meta?.didrawSchemaFrame === true,
  );
  const frameIds = new Set(frameShapes.map((f) => f.id));

  // Строим индекс children per frame (прямые children).
  const directChildrenByFrame = new Map<string, TLRecord[]>();
  for (const s of allShapes) {
    if (typeof s.parentId === "string" && frameIds.has(s.parentId)) {
      const arr = directChildrenByFrame.get(s.parentId);
      if (arr) arr.push(s);
      else directChildrenByFrame.set(s.parentId, [s]);
    }
  }

  // Второй проход: определяем какие shapes — free (не потомки ни одного schema-frame).
  // Использует ancestry walk для косвенных потомков (через group'ы).
  const freeShapes: TLRecord[] = [];
  for (const s of allShapes) {
    // Сами schema-frames — не free и не children.
    if (frameIds.has(s.id)) continue;

    // Прямые дети frame'а — не free.
    if (typeof s.parentId === "string" && frameIds.has(s.parentId)) continue;

    // Для остальных — ancestry walk.
    const ancestor = findFrameAncestor(
      s,
      records as Record<string, TLRecord | undefined>,
    );
    if (!ancestor.found) {
      freeShapes.push(s);
    }
    // Если есть frame-предок — shape является внутренним, не free.
  }

  // Строим frames[].
  const frames: CanvasViewResponse["frames"] = frameShapes.map((frame) => {
    const frameMeta = (frame.meta ?? {}) as Record<string, unknown>;
    const raw =
      typeof frameMeta.mermaidSource === "string"
        ? frameMeta.mermaidSource
        : "";
    const overlays =
      (frameMeta.didrawOverlays as Record<NodeId, OverlayEntry> | undefined) ??
      {};

    // Label из props.name (tldraw frame name) или meta.didrawLabel fallback.
    const props = (frame.props ?? {}) as Record<string, unknown>;
    let label = typeof props.name === "string" ? props.name : "";
    if (!label && typeof frameMeta.didrawLabel === "string") {
      label = frameMeta.didrawLabel;
    }

    // bbox: union children, fallback — frame's own bounds.
    const children = directChildrenByFrame.get(frame.id) ?? [];
    let bbox: { x: number; y: number; w: number; h: number };
    if (children.length > 0) {
      bbox = unionBbox(children.map(shapeBbox));
    } else {
      bbox = shapeBbox(frame);
    }

    return { id: frame.id, label, bbox, raw, overlays };
  });

  // Строим free[].
  const free: CanvasViewResponse["free"] = freeShapes.map((s) => {
    const entry: CanvasViewResponse["free"][number] = {
      id: s.id,
      type: s.type ?? "unknown",
      bbox: shapeBbox(s),
    };
    const label = extractLabel(s);
    if (label.length > 0) entry.label = label;
    return entry;
  });

  return { schemaVersion: "v2", frames, free };
}
