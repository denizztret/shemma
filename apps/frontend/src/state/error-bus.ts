// Singleton pub/sub for user-facing error toasts (Phase 2.2 — no-silent-fail).
// HTTP API rejections (422) and similar surface here; WS errors must NOT be
// pushed (would toast on every reconnect blip).
export type ErrItem = { id: string; text: string; at: number };
type Listener = (errors: ErrItem[]) => void;

const items: ErrItem[] = [];
const listeners = new Set<Listener>();
const MAX_VISIBLE = 3;
const TTL_MS = 5000;

export function pushError(text: string): void {
  const item: ErrItem = { id: crypto.randomUUID(), text, at: Date.now() };
  items.unshift(item);
  if (items.length > MAX_VISIBLE) items.pop();
  notify();
  setTimeout(() => {
    const idx = items.findIndex((i) => i.id === item.id);
    if (idx >= 0) {
      items.splice(idx, 1);
      notify();
    }
  }, TTL_MS);
}

export function subscribeErrors(l: Listener): () => void {
  listeners.add(l);
  l([...items]);
  return () => {
    listeners.delete(l);
  };
}

function notify(): void {
  const snapshot = [...items];
  for (const l of listeners) l(snapshot);
}
