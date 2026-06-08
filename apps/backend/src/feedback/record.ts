// apps/backend/src/feedback/record.ts
//
// DRW-227.01: pure helpers + types for the objective feedback-telemetry
// backbone. A `request` record captures one agent-facing API call: its
// normalized route, input, outcome (status / ok / error code), timing, and a
// size-bounded snapshot of payload + result. All functions here are pure so
// they can be unit-tested without an HTTP server; the Hono middleware
// (./middleware.ts) and the JSONL writer (./writer.ts) wire them up.

/** One captured agent request. Shares the `kind` discriminator with the
 *  annotation record (DRW-227.02) so both live in one room JSONL. */
export interface RequestRecord {
  ts: string;
  kind: "request";
  route: string;
  method: string;
  space: string;
  room: string;
  clientOpId: string | null;
  durationMs: number;
  httpStatus: number;
  ok: boolean;
  errorCode: string | null;
  payload: unknown;
  result: unknown;
}

/**
 * Normalize a request path for grouping: strip the query and collapse the
 * dynamic schema-frame id segment to `:id` (so different rooms/frames group
 * under one route). `/api/schema/create` is static and kept as-is.
 */
export function normalizeRoute(path: string): string {
  const p = path.split("?")[0] ?? "";
  const m = p.match(/^\/api\/schema\/([^/]+)(\/.*)?$/);
  if (m && m[1] !== "create") {
    return `/api/schema/:id${m[2] ?? ""}`;
  }
  return p;
}

// Allowlist (normalized): agent-facing schema mutations + the context read.
// Frontend/service routes (state, viewport, board prefs, measured-bounds,
// smart-insert, room/space management, health, …) are deliberately excluded —
// they are the browser or housekeeping, not the agent working on the schema.
const LOGGED_ROUTES: ReadonlySet<string> = new Set([
  "/api/domain",
  "/api/layout",
  "/api/agent/layout-selection",
  "/api/agent/import-mermaid",
  "/api/agent/fit-text",
  "/api/agent/style-apply",
  "/api/agent/context",
  "/api/schema/create",
  "/api/schema/:id",
  "/api/schema/:id/patch",
  "/api/schema/:id/overlay",
  "/api/schema/:id/duplicate",
]);

/** True when a request to `path` should be logged by the backbone. */
export function isLoggedRoute(path: string): boolean {
  return LOGGED_ROUTES.has(normalizeRoute(path));
}

/**
 * Size-bound a value for storage: returns it unchanged when its serialized
 * form fits `maxBytes`. A large array keeps a prefix of its elements plus an
 * `{ __omitted: k }` marker; any other large value collapses to
 * `{ __truncated: true, bytes }`. Keeps structure + codes, drops bulk content.
 */
export function boundValue(value: unknown, maxBytes: number): unknown {
  if (value === undefined) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "";
  } catch {
    return { __truncated: true, bytes: -1 };
  }
  if (serialized.length <= maxBytes) return value;

  if (Array.isArray(value)) {
    const kept: unknown[] = [];
    for (const el of value) {
      kept.push(el);
      if (JSON.stringify(kept).length > maxBytes) {
        kept.pop();
        return [...kept, { __omitted: value.length - kept.length }];
      }
    }
    // Unreachable: whole array already exceeded maxBytes above.
    return [{ __omitted: value.length }];
  }

  return { __truncated: true, bytes: serialized.length };
}

/**
 * Derive the objective outcome from the HTTP status + response body. An
 * in-band `{ ok: false }` at HTTP 200 (the daemon's domain-rejection shape)
 * counts as not-ok; the error code prefers `body.code`, then `body.error`,
 * then a synthesized `http-<status>`.
 */
export function extractOutcome(
  httpStatus: number,
  body: unknown,
): { ok: boolean; errorCode: string | null } {
  const b =
    body && typeof body === "object"
      ? (body as Record<string, unknown>)
      : undefined;
  const inBandFail = b?.ok === false;
  const ok = httpStatus < 400 && !inBandFail;

  let errorCode: string | null = null;
  if (b && typeof b.code === "string") errorCode = b.code;
  else if (b && typeof b.error === "string") errorCode = b.error;
  else if (!ok) errorCode = `http-${httpStatus}`;

  return { ok, errorCode };
}

export interface BuildRequestRecordInput {
  ts: string;
  method: string;
  path: string;
  space: string;
  room: string;
  clientOpId: string | undefined;
  durationMs: number;
  httpStatus: number;
  reqPayload: unknown;
  respBody: unknown;
  maxFieldBytes: number;
}

/** Assemble a `request` record from captured request/response data. Pure. */
export function buildRequestRecord(
  input: BuildRequestRecordInput,
): RequestRecord {
  const { ok, errorCode } = extractOutcome(input.httpStatus, input.respBody);
  return {
    ts: input.ts,
    kind: "request",
    route: normalizeRoute(input.path),
    method: input.method,
    space: input.space,
    room: input.room,
    clientOpId: input.clientOpId ?? null,
    durationMs: input.durationMs,
    httpStatus: input.httpStatus,
    ok,
    errorCode,
    payload: boundValue(input.reqPayload, input.maxFieldBytes),
    result: boundValue(input.respBody, input.maxFieldBytes),
  };
}
