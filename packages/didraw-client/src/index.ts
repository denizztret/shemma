export type ClientOpts = { baseUrl?: string; room?: string };

export class CanvasClient {
  readonly room: string;
  private base: string;

  constructor(opts: ClientOpts = {}) {
    this.room = opts.room ?? process.env.CLAUDE_SESSION_ID ?? "default";
    this.base =
      opts.baseUrl ?? `http://localhost:${process.env.DIDRAW_PORT ?? 8787}`;
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

  async clear() {
    const s = await this.getState({ fmt: "full" });
    const ops = [
      // biome-ignore lint/suspicious/noExplicitAny: state shape not fully typed yet
      ...s.canvas.edges.map((e: any) => ({
        op: "delete",
        target: "edge",
        id: e.id,
      })),
      // biome-ignore lint/suspicious/noExplicitAny: state shape not fully typed yet
      ...s.canvas.nodes.map((n: any) => ({
        op: "delete",
        target: "node",
        id: n.id,
      })),
      // biome-ignore lint/suspicious/noExplicitAny: state shape not fully typed yet
      ...s.canvas.groups.map((g: any) => ({
        op: "delete",
        target: "group",
        id: g.id,
      })),
    ];
    return this.applyPatch(ops);
  }

  async health(): Promise<boolean> {
    try {
      return (await fetch(`${this.base}/healthz`)).ok;
    } catch {
      return false;
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

  async deleteRoom(id: string, confirm = false) {
    const r = await fetch(
      `${this.base}/api/rooms/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm }),
      },
    );
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
