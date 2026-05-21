import type { SpaceLocalDTO } from "@shemma/spaces";

/**
 * Frontend wrappers over the `/api/spaces` CRUD + `/api/session` info endpoint.
 *
 * Why session here: the landing page lets the user type paths with `~/` prefix.
 * Backend already exposes the daemon's `home` directory via `/api/session` —
 * we expand client-side so the POST payload is an absolute path the registry
 * can validate immediately.
 */

type SessionInfo = {
  sessionId: string;
  projectSlug: string;
  workspaceDir: string;
  home: string;
};

let sessionCache: Promise<SessionInfo> | null = null;

export function getSession(): Promise<SessionInfo> {
  if (!sessionCache) {
    sessionCache = fetch("/api/session").then((r) => {
      if (!r.ok) throw new Error(`/api/session failed: ${r.status}`);
      return r.json() as Promise<SessionInfo>;
    });
  }
  return sessionCache;
}

/** Test-only: clear the cached session promise. */
export function _resetSessionCache(): void {
  sessionCache = null;
}

/**
 * Expand a `~/` or `~` prefix to the daemon's home directory.
 * Non-tilde paths pass through unchanged.
 */
export async function expandHomePath(input: string): Promise<string> {
  if (input === "~") {
    const { home } = await getSession();
    return home;
  }
  if (input.startsWith("~/")) {
    const { home } = await getSession();
    return `${home}/${input.slice(2)}`;
  }
  return input;
}

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
