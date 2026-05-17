export type SessionInfo = {
  sessionId: string | null;
  projectSlug: string;
  workspaceDir: string;
};

let cached: Promise<SessionInfo> | null = null;

export function fetchSession(): Promise<SessionInfo> {
  if (cached === null) {
    cached = fetch("/api/session").then((r) => r.json());
  }
  return cached;
}
