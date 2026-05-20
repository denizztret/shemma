// apps/backend/src/export/miro/client.ts
//
// DRW-103: Miro REST v2 HTTP wrapper.
// - Bearer auth (token DI'd; backend reads via readMiroToken()).
// - URL encoding for board ids (= → %3D, §5.6 quirk).
// - 429 exponential backoff: 1s/2s/4s, max 3 retries (§6.4).
// - Error mapping: 401 → MiroAuthError, 404 → MiroNotFoundError,
//   429 (exhausted) → MiroRateLimitError, others → Error with status.

export class MiroAuthError extends Error {
  readonly code = "miro-auth-failed" as const;
  constructor(message = "Miro authentication failed (401)") {
    super(message);
    this.name = "MiroAuthError";
  }
}

export class MiroNotFoundError extends Error {
  readonly code = "miro-not-found" as const;
  constructor(message = "Miro resource not found (404)") {
    super(message);
    this.name = "MiroNotFoundError";
  }
}

export class MiroRateLimitError extends Error {
  readonly code = "miro-rate-limited" as const;
  constructor(message = "Miro rate-limit exceeded after retries (429)") {
    super(message);
    this.name = "MiroRateLimitError";
  }
}

export interface MiroBoard {
  id: string;
  name: string;
  viewLink?: string;
}

export interface MiroBulkItem {
  type: "shape" | "sticky_note" | "text" | "frame";
  data?: Record<string, unknown>;
  style?: Record<string, unknown>;
  position?: { x: number; y: number };
  geometry?: { width?: number; height?: number };
  parent?: { id: string };
  // metadata/appData reserved (Miro probe Task 1 showed these are not accepted
  // by shape create — but kept optional in case Miro adds them later).
  metadata?: Record<string, unknown>;
  appData?: string;
}

export interface MiroConnectorPayload {
  startItem: { id: string; snapTo?: string; position?: { x: string; y: string } };
  endItem: { id: string; snapTo?: string; position?: { x: string; y: string } };
  shape?: "straight" | "elbowed" | "curved";
  style?: Record<string, unknown>;
  captions?: Array<{ content: string; position?: string }>;
  metadata?: Record<string, unknown>;
  appData?: string;
}

export interface MiroBulkResponse {
  data: Array<{ id: string; type?: string }>;
}

export interface MiroConnectorResponse {
  id: string;
}

export interface MiroClientOptions {
  token: string;
  baseUrl?: string;
  /** Override retry delays (ms). Default [1000, 2000, 4000]. */
  retryDelays?: number[];
  /** Per-request timeout (ms). Default 30000. */
  timeoutMs?: number;
}

const DEFAULT_BASE = "https://api.miro.com";
const DEFAULT_DELAYS = [1000, 2000, 4000];

export class MiroClient {
  private readonly token: string;
  private readonly base: string;
  private readonly retryDelays: number[];
  private readonly timeoutMs: number;

  constructor(opts: MiroClientOptions) {
    this.token = opts.token;
    this.base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
    this.retryDelays = opts.retryDelays ?? DEFAULT_DELAYS;
    this.timeoutMs = opts.timeoutMs ?? 30000;
  }

  private encodeBoardId(id: string): string {
    return id.replace(/=/g, "%3D");
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.base}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const attempts = this.retryDelays.length + 1;
    let lastResp: Response | null = null;
    for (let i = 0; i < attempts; i++) {
      const signal = AbortSignal.timeout(this.timeoutMs);
      const resp = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
      lastResp = resp;
      if (resp.status === 429 && i < this.retryDelays.length) {
        await new Promise((r) => setTimeout(r, this.retryDelays[i]));
        continue;
      }
      if (resp.status === 401) throw new MiroAuthError();
      if (resp.status === 404) throw new MiroNotFoundError();
      if (resp.status === 429) throw new MiroRateLimitError();
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`Miro ${method} ${path} failed: ${resp.status} ${text.slice(0, 200)}`);
      }
      return (await resp.json()) as T;
    }
    throw new MiroRateLimitError(
      `Miro ${method} ${path} exhausted ${attempts} attempts (last status: ${lastResp?.status ?? "?"})`,
    );
  }

  /** GET /v2/boards?limit=50 — returns list of accessible boards. */
  async listBoards(): Promise<MiroBoard[]> {
    const res = await this.request<{ data?: MiroBoard[] }>("GET", "/v2/boards?limit=50");
    return Array.isArray(res.data) ? res.data : [];
  }

  /** POST /v2/boards/<id>/items/bulk — batch create shapes/notes/text/frames. */
  async bulkItems(boardId: string, items: MiroBulkItem[]): Promise<MiroBulkResponse> {
    const encoded = this.encodeBoardId(boardId);
    return this.request<MiroBulkResponse>(
      "POST",
      `/v2/boards/${encoded}/items/bulk`,
      { data: items },
    );
  }

  /** POST /v2/boards/<id>/connectors — single connector create. */
  async postConnector(
    boardId: string,
    payload: MiroConnectorPayload,
  ): Promise<MiroConnectorResponse> {
    const encoded = this.encodeBoardId(boardId);
    return this.request<MiroConnectorResponse>(
      "POST",
      `/v2/boards/${encoded}/connectors`,
      payload,
    );
  }
}
