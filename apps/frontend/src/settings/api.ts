import type { LayoutParams, StyleDefaults, ResolvedStyleDefaults } from "@shemma/domain";
import type { SchemaContainerTitlePosition } from "../shapes/schema-container/title-position";

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

export type StyleDefaultsResponse = {
  raw: StyleDefaults | null;
  effective: ResolvedStyleDefaults;
};

export async function getStyleDefaults(
  space: string,
  room: string,
): Promise<StyleDefaultsResponse> {
  const url = `/api/board/style-defaults?space=${encodeURIComponent(space)}&room=${encodeURIComponent(room)}`;
  const res = await fetch(url, { method: "GET" });
  return jsonOrThrow(res);
}

export async function postStyleDefaults(
  space: string,
  room: string,
  defaults: StyleDefaults | null,
): Promise<{ ok: true; effective: ResolvedStyleDefaults }> {
  const url = `/api/board/style-defaults?space=${encodeURIComponent(space)}&room=${encodeURIComponent(room)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ defaults }),
  });
  return jsonOrThrow(res);
}

export type StyleApplyInput = {
  selectedIds: string[];
  styles: StyleDefaults;
  respectUserOwned?: boolean;
};

export async function postStyleApply(
  space: string,
  room: string,
  input: StyleApplyInput,
): Promise<{ ok: true; count: number }> {
  const url = `/api/agent/style-apply?space=${encodeURIComponent(space)}&room=${encodeURIComponent(room)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return jsonOrThrow(res);
}

export type ContainerTitlePositionResponse = {
  value: SchemaContainerTitlePosition | null;
};

export async function getContainerTitlePosition(
  space: string,
  room: string,
): Promise<ContainerTitlePositionResponse> {
  const url = `/api/board/container-title-position?space=${encodeURIComponent(space)}&room=${encodeURIComponent(room)}`;
  const res = await fetch(url, { method: "GET" });
  return jsonOrThrow(res);
}

export async function postContainerTitlePosition(
  space: string,
  room: string,
  value: SchemaContainerTitlePosition | null,
): Promise<{ ok: true }> {
  const url = `/api/board/container-title-position?space=${encodeURIComponent(space)}&room=${encodeURIComponent(room)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value }),
  });
  return jsonOrThrow(res);
}
