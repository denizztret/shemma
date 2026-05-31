/**
 * Deep-link на объект (DL): `?space=&room=&id=<token>[,<token>…]`.
 *
 * Consumer-сторона резолвит каждый токен в shape-id'ы по приоритету identity,
 * producer-сторона строит обратную ссылку. Всё чистое (работает над `TLShape[]`
 * + явные origin/pathname), чтобы тестироваться без живого Editor'а.
 *
 * Identity-приоритет на резолве:
 *   1. сырой tldraw `shape:…` id — всегда уникален;
 *   2. `meta.didrawId` (v2 канон) — может матчить >1 шейпа после tldraw-дубля
 *      (копия несёт meta дословно), поэтому возвращаем ВСЕ совпадения;
 *   3. `meta.didrawName` (legacy v1);
 *   4. `meta.didrawLabel` — только если матч единственный (неоднозначный
 *      лейбл намеренно не резолвится, чтобы не «угадывать не тот»).
 */

import type { TLShape, TLShapeId } from "tldraw";

type DeepLinkMeta = Record<string, unknown> & {
  didrawId?: unknown;
  didrawName?: unknown;
  didrawLabel?: unknown;
};

function metaStr(
  shape: TLShape,
  key: "didrawId" | "didrawName" | "didrawLabel",
): string | undefined {
  const meta = (shape as unknown as { meta?: DeepLinkMeta }).meta;
  const v = meta?.[key];
  return typeof v === "string" ? v : undefined;
}

function rawId(shape: TLShape): string {
  return shape.id as unknown as string;
}

/**
 * Резолв одного токена в shape-id'ы по identity-приоритету. Первый непустой
 * tier побеждает; tier может вернуть несколько шейпов (см. п.2 в шапке файла).
 */
export function resolveTokenToShapes(
  shapes: TLShape[],
  token: string,
): TLShapeId[] {
  const t = token.trim();
  if (!t) return [];

  // 1. сырой shape:id — точное совпадение
  if (t.startsWith("shape:")) {
    const hit = shapes.find((s) => rawId(s) === t);
    return hit ? [hit.id] : [];
  }

  // 2. didrawId — все совпадения (коллизия после дубля)
  const byId = shapes.filter((s) => metaStr(s, "didrawId") === t);
  if (byId.length > 0) return byId.map((s) => s.id);

  // 3. didrawName (v1) — все совпадения
  const byName = shapes.filter((s) => metaStr(s, "didrawName") === t);
  if (byName.length > 0) return byName.map((s) => s.id);

  // 4. didrawLabel — только если единственный
  const byLabel = shapes.filter((s) => metaStr(s, "didrawLabel") === t);
  const onlyLabel = byLabel.length === 1 ? byLabel[0] : undefined;
  if (onlyLabel) return [onlyLabel.id];

  return [];
}

/**
 * Резолв списка токенов (comma-форма) в дедуплицированный список shape-id'ов
 * с сохранением порядка первого появления.
 */
export function resolveUrlIds(
  shapes: TLShape[],
  tokens: string[],
): TLShapeId[] {
  const seen = new Set<string>();
  const out: TLShapeId[] = [];
  for (const token of tokens) {
    for (const id of resolveTokenToShapes(shapes, token)) {
      const key = id as unknown as string;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(id);
    }
  }
  return out;
}

/** Распарсить значение `?id=` в trimmed непустые токены. */
export function parseIdParam(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Лучший идентификатор для deep-link на шейп: стабильный семантический id,
 * иначе legacy-имя, иначе сырой tldraw-id (всегда уникален, но эфемерен при
 * delete+recreate / ре-импорте).
 */
export function bestLinkId(shape: TLShape): string {
  return (
    metaStr(shape, "didrawId") ?? metaStr(shape, "didrawName") ?? rawId(shape)
  );
}

/**
 * Собрать shareable deep-link URL на шейпы внутри (space, room). Несколько
 * шейпов → comma-список в `id`. `origin`/`pathname` приходят от вызывающего
 * (location) — функция остаётся чистой.
 */
export function buildObjectLink(opts: {
  origin: string;
  pathname: string;
  space: string;
  room: string;
  shapes: TLShape[];
}): string {
  const { origin, pathname, space, room, shapes } = opts;
  const ids = shapes
    .map(bestLinkId)
    .map((s) => encodeURIComponent(s))
    .join(",");
  const qs = `space=${encodeURIComponent(space)}&room=${encodeURIComponent(
    room,
  )}&id=${ids}`;
  return `${origin}${pathname}?${qs}`;
}
