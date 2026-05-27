import type { LayoutParams } from "@shemma/domain";

export type LayoutParamsResponse = {
  raw: Partial<LayoutParams> | null;
  effective: LayoutParams;
};

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export async function getLayoutParams(space: string, room: string): Promise<LayoutParamsResponse> {
  const url = `/api/board/layout-params?space=${encodeURIComponent(space)}&room=${encodeURIComponent(room)}`;
  const res = await fetch(url, { method: "GET" });
  return jsonOrThrow(res);
}

export async function postLayoutParams(
  space: string,
  room: string,
  params: Partial<LayoutParams> | null,
): Promise<{ ok: true; effective: LayoutParams }> {
  const url = `/api/board/layout-params?space=${encodeURIComponent(space)}&room=${encodeURIComponent(room)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ params }),
  });
  return jsonOrThrow(res);
}

export type LayoutSelectionInput = {
  ids: string[];
  direction?: "TB" | "BT" | "LR" | "RL" | "custom";
  forceUnpin?: boolean;
  /** Frame-container fix (spec 5.2): "self" skips Pass B (parent preserved); "auto" — existing behavior. */
  scope?: "self" | "auto";
};

export async function postLayoutSelection(
  space: string,
  room: string,
  input: LayoutSelectionInput,
): Promise<{ ok: true }> {
  const url = `/api/agent/layout-selection?space=${encodeURIComponent(space)}&room=${encodeURIComponent(room)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return jsonOrThrow(res);
}
