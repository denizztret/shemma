// apps/backend/src/domain/schema/detect.ts
// Room-level v1/v2 protocol detection (DRW-134 Task 1.4).
// Читает room.meta.didrawProtocol — не путать с envelope-level schemaVersion (1/2/3).

import {
  DEFAULT_SUFFIX_LENGTH,
  SUFFIX_LENGTH_MAX,
  SUFFIX_LENGTH_MIN,
} from "@shemma/domain";
import type { RoomState } from "../../types";

/** Returns true если room помечена как v2 (didrawProtocol === "v2").
 *  Безопасен к undefined/null room и к отсутствию meta-поля. */
export function isV2Room(room: RoomState | undefined | null): boolean {
  return room?.meta?.didrawProtocol === "v2";
}

/** Возвращает валидный suffix length для генерации NodeId, ограниченный [MIN, MAX].
 *  Fallback — DEFAULT_SUFFIX_LENGTH (6) при отсутствии поля, null/undefined room,
 *  нечисловом значении или дробном (non-integer) числе. */
export function roomSuffixLength(room: RoomState | undefined | null): number {
  const raw = room?.meta?.didrawIdSuffixLength;
  if (typeof raw !== "number" || !Number.isInteger(raw))
    return DEFAULT_SUFFIX_LENGTH;
  if (raw < SUFFIX_LENGTH_MIN) return SUFFIX_LENGTH_MIN;
  if (raw > SUFFIX_LENGTH_MAX) return SUFFIX_LENGTH_MAX;
  return raw;
}
