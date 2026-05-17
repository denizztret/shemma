export type ClientOpts = { baseUrl?: string; room?: string };

// Phase 3.0 response shapes (mirror backend payloads).
// Backend is source of truth (apps/backend/src/routes/state.ts,
// apps/backend/src/domain/context.ts). Updated whenever the backend response
// shape changes.

/** Element entry in `/api/agent/context` view. */
export type DomainElement = {
  id: string;
  type: "shape" | "connection" | "group" | "note";
  label?: string;
  role?: string;
  connectionKind?: string;
  from?: string;
  to?: string;
  children?: string[];
  pinned?: boolean;
  bounds?: { x: number; y: number; w: number; h: number };
};

/** `/api/agent/context` response. */
export type DomainView = {
  ok: true;
  version: number;
  diffSince?: number;
  elements: DomainElement[];
  pendingPrompts?: unknown[];
};

/** `/api/state` (full) response. `store` is an opaque TLStoreSnapshot. */
export type StateResponse = {
  version: number;
  store: { schema?: unknown; store?: Record<string, unknown> };
  prompts: unknown[];
  aiActivity: unknown | null;
};

/** `/api/state?since=N` response — incremental diff or truncation signal. */
export type StateDiffResponse =
  | { since: number; version: number; diff: unknown[] }
  | { since: number; version: number; truncated: true };

export class CanvasClient {
  readonly room: string;
  private base: string;

  constructor(opts: ClientOpts = {}) {
    this.room = opts.room ?? process.env.CLAUDE_SESSION_ID ?? "default";
    this.base =
      opts.baseUrl ?? `http://localhost:${process.env.SHEMMA_PORT ?? 8787}`;
  }

  private q(extra: Record<string, string | number | undefined> = {}) {
    const params = new URLSearchParams({ room: this.room });
    for (const [k, v] of Object.entries(extra))
      if (v !== undefined) params.set(k, String(v));
    return params.toString();
  }

  async getState(opts: { fmt?: "full" | "compact"; since?: number } = {}) {
    const r = await fetch(
      `${this.base}/api/state?${this.q({ fmt: opts.fmt ?? "compact", since: opts.since })}`,
    );
    return r.json();
  }

  async applyPatch(
    ops: unknown[],
    opts: { clientOpId?: string; source?: "ai" | "user" } = {},
  ) {
    const r = await fetch(`${this.base}/api/patch?${this.q()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ops,
        source: opts.source ?? "ai",
        clientOpId: opts.clientOpId,
      }),
    });
    return r.json();
  }

  async layout(algorithm: "elk-layered" | "dagre", nodeIds?: string[]) {
    const r = await fetch(`${this.base}/api/layout?${this.q()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ algorithm, nodeIds }),
    });
    return r.json();
  }

  async getPrompts(
    status: "pending" | "resolved" | "dismissed" | "all" = "pending",
  ) {
    const r = await fetch(`${this.base}/api/prompts?${this.q({ status })}`);
    return r.json();
  }

  async resolvePrompt(id: string, response?: string) {
    const r = await fetch(`${this.base}/api/prompt/${id}/resolve?${this.q()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response }),
    });
    return r.json();
  }

  async dismissPrompt(id: string) {
    const r = await fetch(`${this.base}/api/prompt/${id}/dismiss?${this.q()}`, {
      method: "POST",
    });
    return r.json();
  }

  async deletePrompt(id: string) {
    const r = await fetch(`${this.base}/api/prompt/${id}?${this.q()}`, {
      method: "DELETE",
    });
    return r.json();
  }

  async purgePrompts() {
    const r = await fetch(`${this.base}/api/prompts?${this.q()}`, {
      method: "DELETE",
    });
    return r.json();
  }

  /**
   * @deprecated Phase 3.0: `/api/patch` was removed. This helper relied on the
   * legacy `{ canvas: { nodes, edges, groups } }` state shape which no longer
   * exists. Kept only so `shemma clear` keeps importing (CLI back-compat per
   * spec §10). Callers should use the domain API (`POST /api/domain` with
   * `{ kind: "delete", ids: [...] }`) instead.
   */
  async clear() {
    return {
      ok: false,
      error:
        "clear() is no longer supported (/api/patch removed in Phase 3.0); use domain delete actions",
    };
  }

  async health(): Promise<boolean> {
    try {
      return (await fetch(`${this.base}/healthz`)).ok;
    } catch {
      return false;
    }
  }

  /**
   * Extended health probe (`GET /api/health`).
   * Returns daemon profile, resolved storage path, and version on success;
   * `null` if the daemon is unreachable or the response is malformed.
   * Used by `shemma open` (DRW-052) for storage-conflict detection.
   */
  async getHealth(): Promise<{
    ok: true;
    profile: string;
    storage: string;
    version: string;
  } | null> {
    try {
      const r = await fetch(`${this.base}/api/health`);
      if (!r.ok) return null;
      const j = (await r.json()) as {
        ok?: unknown;
        profile?: unknown;
        storage?: unknown;
        version?: unknown;
      };
      if (
        j.ok !== true ||
        typeof j.profile !== "string" ||
        typeof j.storage !== "string" ||
        typeof j.version !== "string"
      ) {
        return null;
      }
      return {
        ok: true,
        profile: j.profile,
        storage: j.storage,
        version: j.version,
      };
    } catch {
      return null;
    }
  }

  async getVersion() {
    const r = await fetch(`${this.base}/api/version`);
    return r.json();
  }

  async aiStart(actor: string, task: string) {
    const r = await fetch(`${this.base}/api/ai/start?${this.q()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor, task }),
    });
    return r.json();
  }
  async aiStop() {
    const r = await fetch(`${this.base}/api/ai/stop?${this.q()}`, {
      method: "POST",
    });
    return r.json();
  }
  async aiActivity() {
    const r = await fetch(`${this.base}/api/ai/activity?${this.q()}`);
    return r.json();
  }

  async listRooms() {
    const r = await fetch(`${this.base}/api/rooms`);
    return r.json();
  }

  async archiveRoom(id: string) {
    const r = await fetch(
      `${this.base}/api/rooms/${encodeURIComponent(id)}/archive`,
      { method: "POST" },
    );
    return r.json();
  }

  async restoreRoom(id: string) {
    const r = await fetch(
      `${this.base}/api/rooms/${encodeURIComponent(id)}/restore`,
      { method: "POST" },
    );
    return r.json();
  }

  async exportRoom(id: string, to: string) {
    const r = await fetch(
      `${this.base}/api/rooms/${encodeURIComponent(id)}/export`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to }),
      },
    );
    return r.json();
  }

  async importRoom(from: string, opts: { as?: string; force?: boolean } = {}) {
    const r = await fetch(`${this.base}/api/rooms/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from, as: opts.as, force: opts.force }),
    });
    return r.json();
  }

  async deleteRoom(
    id: string,
    confirm = false,
    opts: { mode?: "archive" | "hard"; force?: boolean } = {},
  ) {
    const r = await fetch(
      `${this.base}/api/rooms/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm, ...opts }),
      },
    );
    return r.json();
  }

  async renameRoom(id: string, to: string, opts: { force?: boolean } = {}) {
    const r = await fetch(
      `${this.base}/api/rooms/${encodeURIComponent(id)}/rename`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to, force: opts.force }),
      },
    );
    return r.json();
  }

  async duplicateRoom(id: string, as: string) {
    const r = await fetch(
      `${this.base}/api/rooms/${encodeURIComponent(id)}/duplicate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ as }),
      },
    );
    return r.json();
  }

  async duplicateAuto(id: string): Promise<{ ok: true; id: string }> {
    const r = await fetch(
      `${this.base}/api/rooms/${encodeURIComponent(id)}/duplicate-auto`,
      { method: "POST" },
    );
    return r.json();
  }

  async purgeArchive(): Promise<{ ok: true; removed: number }> {
    const r = await fetch(`${this.base}/api/rooms/purge-archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    return r.json();
  }

  async applyDomain(body: {
    actions: unknown[];
    clientOpId?: string;
    dryRun?: boolean;
    layoutHint?: unknown;
  }) {
    const r = await fetch(`${this.base}/api/domain?${this.q()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.json();
  }

  async getContext(opts: { since?: number; viewport?: string; select?: string[] } = {}) {
    const params = new URLSearchParams({ room: this.room });
    if (opts.since !== undefined) params.set("since", String(opts.since));
    if (opts.viewport) params.set("viewport", opts.viewport);
    if (opts.select?.length) params.set("select", opts.select.join(","));
    const r = await fetch(`${this.base}/api/agent/context?${params.toString()}`);
    return r.json();
  }

  async postViewport(vp: { x: number; y: number; w: number; h: number; zoom?: number }) {
    const r = await fetch(`${this.base}/api/viewport?${this.q()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(vp),
    });
    return r.json();
  }
}
