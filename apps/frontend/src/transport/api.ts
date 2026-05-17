// Phase 3.0: REST surface сокращён до /api/state (initial hydrate) +
// /api/prompt[s] (через transport/prompts.ts) + /api/ai/activity (App polls).
// Все mutations идут через tldraw store → WS (transport/ws.ts). Никакого
// /api/patch больше нет.

export const room =
  new URLSearchParams(location.search).get("room") ?? "default";

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

export async function getState(): Promise<StateResponse> {
  const r = await fetch(`/api/state?room=${encodeURIComponent(room)}`);
  if (!r.ok) throw new Error(`getState ${r.status}`);
  return r.json();
}

// DRW-047: upload editor's real V2 schema before getState so the initial
// snapshot already carries a usable schema. Backend replaces only when the
// stored schema is still the V1 placeholder (idempotent on already-real rooms).
// Best-effort: errors are swallowed by callers — getState still works.
export async function seedSchema(
  roomId: string,
  schema: unknown,
): Promise<{
  ok: boolean;
  upgraded?: boolean;
  version?: number;
  error?: string;
}> {
  const r = await fetch(
    `/api/state/seed-schema?room=${encodeURIComponent(roomId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schema }),
    },
  );
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

export async function listRooms(opts: {
  includeArchived?: boolean;
} = {}): Promise<ListRoomsResponse> {
  const qs = opts.includeArchived ? "?include=archived" : "";
  const r = await fetch(`/api/rooms${qs}`);
  if (!r.ok) throw new Error(`listRooms ${r.status}`);
  return r.json();
}

export async function archiveRoom(id: string): Promise<void> {
  const r = await fetch(`/api/rooms/${encodeURIComponent(id)}/archive`, {
    method: "POST",
  });
  if (!r.ok) throw new Error(`archiveRoom ${r.status}`);
}

export async function restoreRoom(id: string): Promise<void> {
  const r = await fetch(`/api/rooms/${encodeURIComponent(id)}/restore`, {
    method: "POST",
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `restoreRoom ${r.status}`);
  }
}

export async function deleteRoom(
  id: string,
  opts: { mode: "archive" | "hard"; force?: boolean },
): Promise<void> {
  const r = await fetch(`/api/rooms/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: true, mode: opts.mode, force: opts.force }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `deleteRoom ${r.status}`);
  }
}

export async function exportRoom(id: string, to: string): Promise<void> {
  const r = await fetch(`/api/rooms/${encodeURIComponent(id)}/export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to }),
  });
  if (!r.ok) throw new Error(`exportRoom ${r.status}`);
}

export async function renameRoom(
  id: string,
  to: string,
  opts: { force?: boolean } = {},
): Promise<{ ok: boolean; id?: string; error?: string; existingId?: string }> {
  const r = await fetch(`/api/rooms/${encodeURIComponent(id)}/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to, force: opts.force }),
  });
  return r.json();
}

export async function duplicateRoom(
  id: string,
  as: string,
): Promise<{ ok: boolean; id?: string; error?: string; existingId?: string }> {
  const r = await fetch(`/api/rooms/${encodeURIComponent(id)}/duplicate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ as }),
  });
  return r.json();
}

export async function duplicateRoomAuto(
  id: string,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const r = await fetch(`/api/rooms/${encodeURIComponent(id)}/duplicate-auto`, {
    method: "POST",
  });
  return r.json();
}

export async function purgeArchive(): Promise<{ removed: number }> {
  const r = await fetch("/api/rooms/purge-archive", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: true }),
  });
  if (!r.ok) throw new Error(`purgeArchive ${r.status}`);
  return r.json();
}
