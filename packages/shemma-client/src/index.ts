export type ClientOpts = { baseUrl?: string; room?: string; space?: string };

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
  readonly space: string;
  private base: string;

  constructor(opts: ClientOpts = {}) {
    this.room = opts.room ?? process.env.CLAUDE_SESSION_ID ?? "default";
    this.space = opts.space ?? "__legacy__";
    this.base =
      opts.baseUrl ?? `http://localhost:${process.env.SHEMMA_PORT ?? 8787}`;
  }

  get baseUrl(): string {
    return this.base;
  }

  private q(
    extra: Record<string, string | number | undefined> = {},
    spaceOverride?: string,
  ) {
    const params = new URLSearchParams({
      space: spaceOverride ?? this.space,
      room: this.room,
    });
    for (const [k, v] of Object.entries(extra))
      if (v !== undefined) params.set(k, String(v));
    return params.toString();
  }

  /**
   * Build query string with `space` only — no `room`. Used by room-management
   * endpoints (`/api/rooms/<id>/<action>`), where the target room is encoded
   * in the path, but the request still needs space-bundle resolution
   * (DRW-116: backend `bundleForRequest` reads `c.get("space")`).
   */
  private qSpaceOnly(spaceOverride?: string): string {
    return new URLSearchParams({
      space: spaceOverride ?? this.space,
    }).toString();
  }

  /**
   * DRW-221: parse a response the daemon actually returned, WITHOUT blindly
   * `r.json()`-ing it. A non-2xx (incl. a plain-text 500 from an unhandled
   * error) is preserved — the body is annotated with `httpStatus` and returned,
   * not thrown — so callers (MCP) can map it to a backend code instead of
   * conflating it with a transport failure. A real fetch rejection (connection
   * refused / timeout) still propagates as a throw → `daemon-unavailable`.
   */
  private async result(r: Response): Promise<unknown> {
    const text = await r.text();
    let body: unknown;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = r.ok ? text : { ok: false, error: text };
      }
    } else {
      body = r.ok ? {} : { ok: false };
    }
    if (!r.ok && body && typeof body === "object") {
      (body as Record<string, unknown>).httpStatus = r.status;
    }
    return body;
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
  // DRW-126: `getHealth` accepts an optional `space` so callers can ask "what
  // storage does THIS space use" instead of always getting the daemon-default
  // fallback path. Pass-through to `/api/health?space=<id>`. Without `space`,
  // the daemon returns its closure-captured fallback storage and sets
  // `fallback: true` so the caller can tell the difference.
  //
  // Returns `null` on:
  //   - Network error / unreachable daemon.
  //   - 400 `invalid_space_id` / 404 `space_not_found` — when the caller
  //     passed a `space` that the registry rejects. Use `getHealthForSpace`
  //     for typed error reporting; legacy callers stay unaware of the
  //     distinction (the boolean "is the daemon up" probe still works).
  async getHealth(opts: { space?: string } = {}): Promise<{
    ok: true;
    profile: string;
    storage: string;
    version: string;
    pid: number;
    space?: string;
    fallback?: boolean;
  } | null> {
    try {
      const url = opts.space
        ? `${this.base}/api/health?space=${encodeURIComponent(opts.space)}`
        : `${this.base}/api/health`;
      const r = await fetch(url);
      if (!r.ok) return null;
      const j = (await r.json()) as {
        ok?: unknown;
        profile?: unknown;
        storage?: unknown;
        version?: unknown;
        pid?: unknown;
        space?: unknown;
        fallback?: unknown;
      };
      if (
        j.ok !== true ||
        typeof j.profile !== "string" ||
        typeof j.storage !== "string" ||
        typeof j.version !== "string" ||
        typeof j.pid !== "number"
      ) {
        return null;
      }
      const out: {
        ok: true;
        profile: string;
        storage: string;
        version: string;
        pid: number;
        space?: string;
        fallback?: boolean;
      } = {
        ok: true,
        profile: j.profile,
        storage: j.storage,
        version: j.version,
        pid: j.pid,
      };
      if (typeof j.space === "string") out.space = j.space;
      if (typeof j.fallback === "boolean") out.fallback = j.fallback;
      return out;
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
    const r = await fetch(`${this.base}/api/rooms?${this.qSpaceOnly()}`);
    return r.json();
  }

  /**
   * `/api/active-rooms` aggregates across all spaces by default; pass
   * `opts.space` to filter to a single space (DRW-116 Task 11).
   */
  async getActiveRooms(opts: { space?: string } = {}): Promise<{
    rooms: Array<{
      // DRW-116 Task 11: `space` is reported on every entry — `"legacy"` for
      // single-space daemons that haven't routed `?space=<id>` through WS yet.
      space?: string;
      room: string;
      clientCount: number;
      lastFocusedAt: number;
    }>;
  }> {
    const url = opts.space
      ? `${this.base}/api/active-rooms?space=${encodeURIComponent(opts.space)}`
      : `${this.base}/api/active-rooms`;
    const r = await fetch(url);
    return r.json();
  }

  async archiveRoom(id: string) {
    const r = await fetch(
      `${this.base}/api/rooms/${encodeURIComponent(id)}/archive?${this.qSpaceOnly()}`,
      { method: "POST" },
    );
    return r.json();
  }

  async restoreRoom(id: string) {
    const r = await fetch(
      `${this.base}/api/rooms/${encodeURIComponent(id)}/restore?${this.qSpaceOnly()}`,
      { method: "POST" },
    );
    return r.json();
  }

  async exportRoom(id: string, to: string) {
    const r = await fetch(
      `${this.base}/api/rooms/${encodeURIComponent(id)}/export?${this.qSpaceOnly()}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to }),
      },
    );
    return r.json();
  }

  async importRoom(from: string, opts: { as?: string; force?: boolean } = {}) {
    const r = await fetch(`${this.base}/api/rooms/import?${this.qSpaceOnly()}`, {
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
      `${this.base}/api/rooms/${encodeURIComponent(id)}?${this.qSpaceOnly()}`,
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
      `${this.base}/api/rooms/${encodeURIComponent(id)}/rename?${this.qSpaceOnly()}`,
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
      `${this.base}/api/rooms/${encodeURIComponent(id)}/duplicate?${this.qSpaceOnly()}`,
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
      `${this.base}/api/rooms/${encodeURIComponent(id)}/duplicate-auto?${this.qSpaceOnly()}`,
      { method: "POST" },
    );
    return r.json();
  }

  async purgeArchive(): Promise<{ ok: true; removed: number }> {
    const r = await fetch(`${this.base}/api/rooms/purge-archive?${this.qSpaceOnly()}`, {
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
    return this.result(r);
  }

  async getContext(
    opts: { since?: number; viewport?: string; select?: string[]; space?: string } = {},
  ) {
    const params = new URLSearchParams({
      space: opts.space ?? this.space,
      room: this.room,
    });
    if (opts.since !== undefined) params.set("since", String(opts.since));
    if (opts.viewport) params.set("viewport", opts.viewport);
    if (opts.select?.length) params.set("select", opts.select.join(","));
    const r = await fetch(`${this.base}/api/agent/context?${params.toString()}`);
    return r.json();
  }

  /**
   * Import a Mermaid diagram into the room. Append-only by design (DRW-083):
   * never replaces or deletes existing shapes — preserving the user's manual
   * layout edits is a hard product invariant.
   */
  async importMermaid(body: {
    source: string;
    clientOpId?: string;
    requestId?: string;
    /** DRW-086: viewport behavior after import. */
    focus?: "new" | "fit-all" | "none";
  }) {
    const r = await fetch(`${this.base}/api/agent/import-mermaid?${this.q()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.json();
  }

  /**
   * DRW-228: fit text shapes to their content (optimal width / minimal height).
   * Text metrics are browser-only, so — like importMermaid — this requires an
   * open tab with an active WS subscriber. `targets` (shape ids or didrawNames)
   * limits scope; omitted → all fittable geo/note shapes not size-pinned.
   */
  async fitText(body: { targets?: string[]; clientOpId?: string }) {
    const r = await fetch(`${this.base}/api/agent/fit-text?${this.q()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.json();
  }

  /**
   * DRW-227.02: record an optional agent annotation ("what I wanted / where I
   * got stuck") into the per-room feedback JSONL. No-op (recorded:false) when
   * the daemon has feedback disabled; never throws on that path.
   */
  async feedback(body: {
    text: string;
    phase?: "intent" | "blocker" | "resolution";
    clientOpId?: string;
    agent?: string;
    sessionId?: string;
  }) {
    const r = await fetch(`${this.base}/api/agent/feedback?${this.q()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.json();
  }

  /**
   * DRW-088: Tidy layout for a subset of selected shapes.
   * Calls POST /api/agent/layout-selection — runs ELK only on the given ids,
   * leaving all other shapes untouched.
   * Empty ids → full-canvas noop (returns count:0 + hint).
   */
  async layoutSelection(body: {
    ids: string[];
    mode?: string;
    spacing?: string;
  }) {
    const r = await fetch(`${this.base}/api/agent/layout-selection?${this.q()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
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

  // ── DRW-134 Schema API ────────────────────────────────────────────────────

  /**
   * GET /api/canvas/view — polymorphic canvas view.
   * v1 rooms → { schemaVersion:"v1", legacy:{...} }.
   * v2 rooms → { schemaVersion:"v2", frames:[...], free:[...] }.
   */
  async getCanvasView(opts: { space?: string } = {}) {
    const params = new URLSearchParams({
      space: opts.space ?? this.space,
      room: this.room,
    });
    const r = await fetch(`${this.base}/api/canvas/view?${params.toString()}`);
    return r.json();
  }

  /**
   * POST /api/schema/create — создать новый schema-frame.
   * Mode A: { label, raw } — mermaid RAW.
   * Mode B: { label, actions } — SchemaAction[].
   */
  async createSchema(body: {
    label: string;
    raw?: string;
    actions?: unknown[];
    clientOpId?: string;
  }) {
    const r = await fetch(`${this.base}/api/schema/create?${this.q()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.json();
  }

  /**
   * POST /api/schema/:frameId/patch — apply SchemaAction[] к schema-frame.
   */
  async patchSchema(
    frameId: string,
    body: {
      actions: unknown[];
      clientOpId?: string;
    },
  ) {
    const r = await fetch(
      `${this.base}/api/schema/${encodeURIComponent(frameId)}/patch?${this.q()}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return r.json();
  }

  /**
   * POST /api/schema/:frameId/overlay — write single overlay entry.
   */
  async setOverlay(
    frameId: string,
    body: {
      nodeId: string;
      overlay: Record<string, unknown>;
      clientOpId?: string;
    },
  ) {
    const r = await fetch(
      `${this.base}/api/schema/${encodeURIComponent(frameId)}/overlay?${this.q()}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return r.json();
  }

  /**
   * POST /api/schema/:frameId/duplicate — клонирует schema-frame с deep identity remap.
   * Returns: { ok, newFrameId, nodeIdMap }.
   */
  async duplicateSchema(
    frameId: string,
    body: { newLabel?: string } = {},
  ) {
    const r = await fetch(
      `${this.base}/api/schema/${encodeURIComponent(frameId)}/duplicate?${this.q()}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return r.json();
  }

  /**
   * DELETE /api/schema/:frameId — удаляет schema-frame и всех его детей.
   * Returns: { ok } или { ok: false, error, code }.
   */
  async deleteSchema(frameId: string) {
    const r = await fetch(
      `${this.base}/api/schema/${encodeURIComponent(frameId)}?${this.q()}`,
      {
        method: "DELETE",
      },
    );
    return r.json();
  }
}
