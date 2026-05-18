export type ShemmaMcpErrorCode =
  | "daemon-unavailable"
  | "validation-error"
  | "domain-error"
  | "http-error"
  | "unexpected-error"
  | "ambiguous-room";

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
