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

export type PatchResult =
  | { ok: true; version: number; idempotent?: boolean }
  | { ok: false; error: string };

export async function sendPatch(
  ops: unknown[],
  clientOpId: string,
): Promise<PatchResult> {
  try {
    const r = await fetch(`/api/patch?room=${encodeURIComponent(room)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ops, source: "user", clientOpId }),
    });
    // Backend returns ok:true or ok:false in JSON body for both 200 and 422.
    // Network failures fall through to the catch.
    return (await r.json()) as PatchResult;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
