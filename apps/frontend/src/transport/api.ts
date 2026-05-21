// Phase 3.0: REST surface сокращён до /api/state (initial hydrate) +
// /api/prompt[s] (через transport/prompts.ts) + /api/ai/activity (App polls).
// Все mutations идут через tldraw store → WS (transport/ws.ts). Никакого
// /api/patch больше нет.
//
// DRW-116 Task 15: HTTP calls теперь несут оба параметра — `?space=<id>&room=<id>`.
// Раньше `room` читался из location.search единожды при импорте модуля; в multi-space
// мире каждый App-mount может работать с собственным room'ом, поэтому функции
// принимают `(space, room)` явно. Legacy module-level `room` сохранён только для
// `transport/prompts.ts` пока его не отрефакторят аналогично (см. ниже).

/**
 * Synthetic space id used by the frontend when running in the legacy
 * single-space mode (no `?space=` query). Mirrors the backend's
 * `LEGACY_SPACE_ID` constant — when `enableSpaceMiddleware` is OFF (default
 * for dev), the backend ignores the `?space=` query entirely and serves the
 * legacy bundle regardless of value, so the sentinel is invisible in
 * practice but keeps a single param shape across HTTP/WS.
 */
export const LEGACY_SPACE_ID = "__legacy__";

/**
 * @deprecated Legacy module-level room id parsed once from `location.search`.
 *   Прежде использовался `transport/prompts.ts`, теперь все callers пробрасывают
 *   `room` явно. Сохранён под `typeof location` guard'ом чтобы импорт модуля
 *   из bun-test (no DOM) не падал. Удалим вместе с финальной чисткой Task 24.
 */
export const room =
  typeof location !== "undefined"
    ? (new URLSearchParams(location.search).get("room") ?? "default")
    : "default";

// Backend TLStoreSnapshot opaque на frontend side — applySnapshot принимает
// то что отдал бэк. Структура: { schema, store: Record<id, TLRecord> }.
// biome-ignore lint/suspicious/noExplicitAny: snapshot validated tldraw-side on loadSnapshot
type TLStoreSnapshot = any;

export type StateResponse = {
  version: number;
  store: TLStoreSnapshot;
  // biome-ignore lint/suspicious/noExplicitAny: prompts are opaque backend schema
  prompts: any[];
  // biome-ignore lint/suspicious/noExplicitAny: aiActivity is opaque backend schema
  aiActivity: any | null;
};

/**
 * Compose `?space=<id>&room=<id>` query string. Both params are required for
 * symmetry with the backend route shape: legacy callers pass `LEGACY_SPACE_ID`.
 */
function qs(space: string, room: string): string {
  return `space=${encodeURIComponent(space)}&room=${encodeURIComponent(room)}`;
}

export async function getState(
  space: string,
  roomId: string,
): Promise<StateResponse> {
  const r = await fetch(`/api/state?${qs(space, roomId)}`);
  if (!r.ok) throw new Error(`getState ${r.status}`);
  return r.json();
}

// DRW-047: upload editor's real V2 schema before getState so the initial
// snapshot already carries a usable schema. Backend replaces only when the
// stored schema is still the V1 placeholder (idempotent on already-real rooms).
// Best-effort: errors are swallowed by callers — getState still works.
export async function seedSchema(
  space: string,
  roomId: string,
  schema: unknown,
): Promise<{
  ok: boolean;
  upgraded?: boolean;
  version?: number;
  error?: string;
}> {
  const r = await fetch(`/api/state/seed-schema?${qs(space, roomId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ schema }),
  });
  return r.json();
}

// ─── Gallery API (DRW-029) ────────────────────────────────────────────────────

export type RoomListItem = {
  id: string;
  version: number;
  elementCount: number;
  lastTouched: string;
  schemaVersion: number;
  linkedSession?: string;
  projectDir?: string;
  projectName?: string;
  archived?: boolean;
};

export type ListRoomsResponse = {
  ok: boolean;
  rooms: RoomListItem[];
  dir: string;
};

/**
 * DRW-116: `space` is now part of the request — backend uses it to scope the
 * room list to the per-space rooms directory when the space middleware is on.
 * In legacy mode (middleware off) the param is ignored; passing the sentinel
 * keeps the call shape stable.
 */
export async function listRooms(
  space: string,
  opts: {
    includeArchived?: boolean;
  } = {},
): Promise<ListRoomsResponse> {
  const params = new URLSearchParams();
  params.set("space", space);
  if (opts.includeArchived) params.set("include", "archived");
  const r = await fetch(`/api/rooms?${params.toString()}`);
  if (!r.ok) throw new Error(`listRooms ${r.status}`);
  return r.json();
}

export async function archiveRoom(space: string, id: string): Promise<void> {
  const r = await fetch(
    `/api/rooms/${encodeURIComponent(id)}/archive?space=${encodeURIComponent(space)}`,
    { method: "POST" },
  );
  if (!r.ok) throw new Error(`archiveRoom ${r.status}`);
}

export async function restoreRoom(space: string, id: string): Promise<void> {
  const r = await fetch(
    `/api/rooms/${encodeURIComponent(id)}/restore?space=${encodeURIComponent(space)}`,
    { method: "POST" },
  );
  if (!r.ok) {
    const body = await r.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `restoreRoom ${r.status}`);
  }
}

export async function deleteRoom(
  space: string,
  id: string,
  opts: { mode: "archive" | "hard"; force?: boolean },
): Promise<void> {
  const r = await fetch(
    `/api/rooms/${encodeURIComponent(id)}?space=${encodeURIComponent(space)}`,
    {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true, mode: opts.mode, force: opts.force }),
    },
  );
  if (!r.ok) {
    const body = await r.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `deleteRoom ${r.status}`);
  }
}

export async function exportRoom(
  space: string,
  id: string,
  to: string,
): Promise<void> {
  const r = await fetch(
    `/api/rooms/${encodeURIComponent(id)}/export?space=${encodeURIComponent(space)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to }),
    },
  );
  if (!r.ok) throw new Error(`exportRoom ${r.status}`);
}

export async function renameRoom(
  space: string,
  id: string,
  to: string,
  opts: { force?: boolean } = {},
): Promise<{ ok: boolean; id?: string; error?: string; existingId?: string }> {
  const r = await fetch(
    `/api/rooms/${encodeURIComponent(id)}/rename?space=${encodeURIComponent(space)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to, force: opts.force }),
    },
  );
  return r.json();
}

export async function duplicateRoom(
  space: string,
  id: string,
  as: string,
): Promise<{ ok: boolean; id?: string; error?: string; existingId?: string }> {
  const r = await fetch(
    `/api/rooms/${encodeURIComponent(id)}/duplicate?space=${encodeURIComponent(space)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ as }),
    },
  );
  return r.json();
}

export async function duplicateRoomAuto(
  space: string,
  id: string,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const r = await fetch(
    `/api/rooms/${encodeURIComponent(id)}/duplicate-auto?space=${encodeURIComponent(space)}`,
    { method: "POST" },
  );
  return r.json();
}

export async function purgeArchive(
  space: string,
): Promise<{ removed: number }> {
  const r = await fetch(
    `/api/rooms/purge-archive?space=${encodeURIComponent(space)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    },
  );
  if (!r.ok) throw new Error(`purgeArchive ${r.status}`);
  return r.json();
}
