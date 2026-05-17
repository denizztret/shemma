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
