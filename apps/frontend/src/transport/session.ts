export type SessionInfo = {
  sessionId: string | null;
  projectSlug: string;
  workspaceDir: string;
  home: string;
};

let cached: Promise<SessionInfo> | null = null;

export function fetchSession(): Promise<SessionInfo> {
  if (cached === null) {
    cached = fetch("/api/session").then((r) => {
      if (!r.ok) throw new Error(`/api/session failed: ${r.status}`);
      return r.json() as Promise<SessionInfo>;
    });
  }
  return cached;
}

/** Test-only: clear the cached session promise. */
export function _resetSessionCache(): void {
  cached = null;
}

/**
 * Expand a `~/` or `~` prefix to the daemon's home directory. Non-tilde
 * paths pass through unchanged. Used by Add Space / Open Space path-input.
 */
export async function expandHomePath(input: string): Promise<string> {
  if (input === "~") {
    const { home } = await fetchSession();
    return home;
  }
  if (input.startsWith("~/")) {
    const { home } = await fetchSession();
    return `${home}/${input.slice(2)}`;
  }
  return input;
}
