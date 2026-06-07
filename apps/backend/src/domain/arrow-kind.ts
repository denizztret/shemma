// apps/backend/src/domain/arrow-kind.ts
//
// DRW-207: тип НОВЫХ AI/domain-стрелок. Board default из
// room.meta.styleDefaults.arrowKind; фолбэк "elbow" — статус-кво для
// AI/import-путей (ручные стрелки без default остаются нативными arc).

import type { ArrowKind } from "@shemma/domain";
import type { RoomMeta } from "../types";

export function roomArrowKind(meta: RoomMeta | undefined): ArrowKind {
  return meta?.styleDefaults?.arrowKind ?? "elbow";
}
