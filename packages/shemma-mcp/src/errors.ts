export type ShemmaMcpErrorCode =
  | "daemon-unavailable"
  | "validation-error"
  | "domain-error"
  | "http-error"
  | "unexpected-error"
  | "ambiguous-room"
  | "ambiguous-space"
  | "space-not-found"
  | "no-client-connected"
  | "import-failed";

export type ShemmaMcpError = {
  ok: false;
  code: ShemmaMcpErrorCode;
  message: string;
  status?: number;
  clientOpId?: string;
  details?: unknown;
};

export type ShemmaMcpSuccess<T> = {
  ok: true;
  room?: string;
  roomSource?: "arg" | "config" | "session" | "active" | "task" | "lastTouched" | "default";
  version?: number;
  clientOpId?: string;
  idempotent?: true;
  data: T;
};

export function mapFetchError(e: unknown): ShemmaMcpError {
  const msg = e instanceof Error ? e.message : String(e);
  return { ok: false, code: "daemon-unavailable", message: msg };
}

export function mapHttpResponse(
  status: number,
  body: unknown,
  clientOpId?: string,
): ShemmaMcpError {
  if (status === 422) {
    return { ok: false, code: "validation-error", message: "validation failed", status, details: body, clientOpId };
  }
  if (status === 409) {
    return { ok: false, code: "domain-error", message: "domain conflict", status, details: body, clientOpId };
  }
  if (status >= 500) {
    return { ok: false, code: "unexpected-error", message: "server error", status, details: body, clientOpId };
  }
  return { ok: false, code: "http-error", message: `HTTP ${status}`, status, details: body, clientOpId };
}

/**
 * DRW-221: map an error response the daemon ACTUALLY returned to a backend
 * code. The client (CanvasClient.result) annotates non-2xx bodies with
 * `httpStatus`, so we route through `mapHttpResponse` (422→validation-error,
 * 5xx→unexpected-error, …) instead of `mapFetchError` (which is reserved for
 * transport failures — `daemon-unavailable`). A body without `httpStatus` is an
 * in-band 2xx `{ok:false}` rejection — keep the historical `validation-error`.
 */
export function mapBackendError(resp: unknown, clientOpId?: string): ShemmaMcpError {
  const status = (resp as { httpStatus?: unknown } | null)?.httpStatus;
  if (typeof status === "number") return mapHttpResponse(status, resp, clientOpId);
  return {
    ok: false,
    code: "validation-error",
    message: "request rejected by backend",
    details: resp,
    clientOpId,
  };
}

export type ToolResult = ReturnType<typeof toolResult>;

export function toolResult<T>(payload: ShemmaMcpSuccess<T> | ShemmaMcpError) {
  if (payload.ok) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  }
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}
