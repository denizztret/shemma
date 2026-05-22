import type { SpaceLocalDTO } from "@shemma/spaces";

/**
 * Frontend wrappers over the `/api/spaces` CRUD endpoints.
 *
 * Session info + `~/` path expansion live in `transport/session.ts` (shared
 * by gallery chrome and the space pickers).
 */

export async function listSpacesApi(): Promise<SpaceLocalDTO[]> {
  const resp = await fetch("/api/spaces");
  if (!resp.ok) throw new Error(`/api/spaces failed: ${resp.status}`);
  const data = (await resp.json()) as { spaces: SpaceLocalDTO[] };
  return data.spaces;
}

export async function addSpaceApi(
  path: string,
  label?: string,
): Promise<{ space: SpaceLocalDTO; created: boolean }> {
  const resp = await fetch("/api/spaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, label }),
  });
  const data = (await resp.json()) as
    | { space: SpaceLocalDTO; created: boolean }
    | { error: string; message?: string };
  if (!resp.ok) {
    const err = data as { error: string; message?: string };
    throw new Error(err.message ?? err.error ?? "failed");
  }
  return data as { space: SpaceLocalDTO; created: boolean };
}

export async function forgetSpaceApi(id: string): Promise<void> {
  const resp = await fetch(`/api/spaces/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!resp.ok) throw new Error(`forget ${id} failed: ${resp.status}`);
}

export async function getSpaceApi(id: string): Promise<SpaceLocalDTO | null> {
  const resp = await fetch(`/api/spaces/${encodeURIComponent(id)}`);
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`/api/spaces/${id} failed: ${resp.status}`);
  const data = (await resp.json()) as { space: SpaceLocalDTO };
  return data.space;
}

export async function revealSpaceApi(id: string): Promise<void> {
  const resp = await fetch(`/api/spaces/${encodeURIComponent(id)}/reveal`, {
    method: "POST",
  });
  if (!resp.ok) {
    const data = (await resp.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    throw new Error(data.message ?? data.error ?? `reveal ${id} failed`);
  }
}

export type ProbeSpaceResult =
  | { ok: true; absolutePath: string; hasShemma: boolean }
  | { ok: false; error: string; message?: string };

export async function probeSpacePathApi(
  path: string,
): Promise<ProbeSpaceResult> {
  const resp = await fetch("/api/probe-space-path", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (resp.ok) {
    const data = (await resp.json()) as {
      absolutePath: string;
      hasShemma: boolean;
    };
    return { ok: true, ...data };
  }
  const data = (await resp.json().catch(() => ({}))) as {
    error?: string;
    message?: string;
  };
  return {
    ok: false,
    error: data.error ?? "probe_failed",
    message: data.message,
  };
}

export async function renameSpaceLabelApi(
  id: string,
  label: string,
): Promise<void> {
  const resp = await fetch(`/api/spaces/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label }),
  });
  if (!resp.ok) throw new Error(`rename ${id} failed: ${resp.status}`);
}
