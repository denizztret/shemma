export const room =
  new URLSearchParams(location.search).get("room") ?? "default";

export async function getState(): Promise<{
  version: number;
  // biome-ignore lint/suspicious/noExplicitAny: canvas schema is validated on backend
  canvas: any;
  // biome-ignore lint/suspicious/noExplicitAny: prompts are opaque backend schema
  prompts: any[];
}> {
  const r = await fetch(`/api/state?room=${encodeURIComponent(room)}`);
  if (!r.ok) throw new Error(`getState ${r.status}`);
  return r.json();
}

export async function sendPatch(ops: unknown[], clientOpId: string) {
  const r = await fetch(`/api/patch?room=${encodeURIComponent(room)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ops, source: "user", clientOpId }),
  });
  return r.json();
}
