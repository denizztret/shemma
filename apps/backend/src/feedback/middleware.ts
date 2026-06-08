// apps/backend/src/feedback/middleware.ts
//
// DRW-227.01: Hono middleware that writes the objective `request` record for
// every logged agent call. Mounted on /api/* AFTER installBundleResolver (so
// bundleForRequest works) and ONLY when feedback is enabled. Everything after
// `next()` is best-effort — a logging failure never affects the response.

import type { Context } from "hono";
import { bundleForRequest } from "../routes/_space-context";
import { buildRequestRecord, isLoggedRoute } from "./record";
import type { FeedbackWriter } from "./writer";

export interface FeedbackMiddlewareOptions {
  writer: FeedbackWriter;
  /** Per-field size cap for payload/result. Default 4 KiB. */
  maxFieldBytes?: number;
  /** Injectable clock (ms since epoch). Defaults to Date.now. */
  now?: () => number;
}

const DEFAULT_MAX_FIELD_BYTES = 4096;

function queryObject(c: Context): Record<string, string> {
  try {
    return Object.fromEntries(new URL(c.req.url).searchParams);
  } catch {
    return {};
  }
}

function readField(payload: unknown, key: string): string | undefined {
  if (payload && typeof payload === "object") {
    const v = (payload as Record<string, unknown>)[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

export function feedbackMiddleware(opts: FeedbackMiddlewareOptions) {
  const { writer } = opts;
  const maxFieldBytes = opts.maxFieldBytes ?? DEFAULT_MAX_FIELD_BYTES;
  const now = opts.now ?? (() => Date.now());

  return async (c: Context, next: () => Promise<void>): Promise<void> => {
    if (!isLoggedRoute(c.req.path)) return next();

    const startedAt = now();
    const method = c.req.method;
    // Snapshot the request input before the handler runs. Hono caches the
    // parsed JSON body, so the handler's own c.req.json() returns this value.
    let reqPayload: unknown;
    if (method !== "GET" && method !== "HEAD") {
      reqPayload = await c.req.json().catch(() => undefined);
    } else {
      reqPayload = queryObject(c); // GET (context): the query carries the input
    }

    await next();

    try {
      const endedAt = now();
      const httpStatus = c.res.status;
      let respBody: unknown;
      try {
        respBody = await c.res.clone().json();
      } catch {
        respBody = undefined; // non-JSON / empty body
      }

      const room = c.req.query("room") ?? readField(reqPayload, "room");
      if (!room) return; // cannot key the file without a room
      const { space } = bundleForRequest(c);
      const clientOpId =
        readField(reqPayload, "clientOpId") ??
        c.req.query("clientOpId") ??
        undefined;

      const record = buildRequestRecord({
        ts: new Date(endedAt).toISOString(),
        method,
        path: c.req.path,
        space: space.id,
        room,
        clientOpId,
        durationMs: Math.max(0, endedAt - startedAt),
        httpStatus,
        reqPayload,
        respBody,
        maxFieldBytes,
      });
      writer.append(space.id, room, record);
    } catch {
      // best-effort telemetry: never break the already-produced response
    }
  };
}
