import { describe, expect, it } from "bun:test";
import {
  boundValue,
  buildRequestRecord,
  extractOutcome,
  isLoggedRoute,
  normalizeRoute,
} from "./record";

describe("normalizeRoute", () => {
  it("keeps static routes unchanged", () => {
    expect(normalizeRoute("/api/domain")).toBe("/api/domain");
    expect(normalizeRoute("/api/agent/context")).toBe("/api/agent/context");
    expect(normalizeRoute("/api/schema/create")).toBe("/api/schema/create");
  });

  it("collapses the schema frame id segment to :id", () => {
    expect(normalizeRoute("/api/schema/f_37cfa77e62")).toBe("/api/schema/:id");
    expect(normalizeRoute("/api/schema/f_37cfa77e62/patch")).toBe(
      "/api/schema/:id/patch",
    );
    expect(normalizeRoute("/api/schema/abc123/overlay")).toBe(
      "/api/schema/:id/overlay",
    );
  });

  it("strips a query string", () => {
    expect(normalizeRoute("/api/domain?room=r&space=s")).toBe("/api/domain");
  });
});

describe("isLoggedRoute (allowlist = agent mutations + context)", () => {
  it("logs agent mutations and context", () => {
    for (const p of [
      "/api/domain",
      "/api/layout",
      "/api/agent/layout-selection",
      "/api/agent/import-mermaid",
      "/api/agent/fit-text",
      "/api/agent/style-apply",
      "/api/agent/context",
      "/api/schema/create",
      "/api/schema/f_1/patch",
      "/api/schema/f_1/overlay",
      "/api/schema/f_1/duplicate",
      "/api/schema/f_1",
    ]) {
      expect(isLoggedRoute(p)).toBe(true);
    }
  });

  it("skips service / frontend / room-mgmt routes", () => {
    for (const p of [
      "/api/health",
      "/api/state",
      "/api/state/seed-schema",
      "/api/viewport",
      "/api/version",
      "/api/board/style-defaults",
      "/api/canvas/view",
      "/api/schema/f_1/measured-bounds",
      "/api/smart-insert",
      "/api/rooms/r/thumbnail",
      "/api/rooms/r/rename",
    ]) {
      expect(isLoggedRoute(p)).toBe(false);
    }
  });
});

describe("boundValue (size-bounding)", () => {
  it("returns small values unchanged", () => {
    expect(boundValue({ a: 1 }, 4096)).toEqual({ a: 1 });
    expect(boundValue("short", 4096)).toBe("short");
    expect(boundValue(undefined, 4096)).toBeUndefined();
  });

  it("truncates a large object to a marker", () => {
    const big = { blob: "x".repeat(5000) };
    const out = boundValue(big, 100) as {
      __truncated?: boolean;
      bytes?: number;
    };
    expect(out.__truncated).toBe(true);
    expect(typeof out.bytes).toBe("number");
    expect(out.bytes).toBeGreaterThan(100);
  });

  it("keeps a prefix of a large array with an __omitted count", () => {
    const arr = Array.from({ length: 50 }, (_, i) => ({
      i,
      pad: "y".repeat(20),
    }));
    const out = boundValue(arr, 200) as Array<unknown>;
    expect(Array.isArray(out)).toBe(true);
    const last = out[out.length - 1] as { __omitted?: number };
    expect(typeof last.__omitted).toBe("number");
    expect(last.__omitted).toBeGreaterThan(0);
    // some real elements survive + the marker accounts for the rest
    expect(out.length - 1 + (last.__omitted ?? 0)).toBe(50);
  });
});

describe("extractOutcome", () => {
  it("200 + ok:true → ok, no errorCode", () => {
    expect(extractOutcome(200, { ok: true, version: 5 })).toEqual({
      ok: true,
      errorCode: null,
    });
  });

  it("200 + in-band ok:false with code → not ok, errorCode from code", () => {
    expect(extractOutcome(200, { ok: false, code: "unknown-ref" })).toEqual({
      ok: false,
      errorCode: "unknown-ref",
    });
  });

  it("200 + in-band ok:false with error → errorCode from error", () => {
    expect(extractOutcome(200, { ok: false, error: "boom" })).toEqual({
      ok: false,
      errorCode: "boom",
    });
  });

  it("422 with error field → not ok, errorCode from error", () => {
    expect(extractOutcome(422, { error: "validation failed" })).toEqual({
      ok: false,
      errorCode: "validation failed",
    });
  });

  it("domain validation shape {ok:false, errors:[{code}]} → errorCode from first error code", () => {
    expect(
      extractOutcome(422, {
        ok: false,
        errors: [{ actionIndex: 0, field: "role", code: "unknown-role" }],
      }),
    ).toEqual({ ok: false, errorCode: "unknown-role" });
  });

  it("500 with non-json body → not ok, errorCode http-500", () => {
    expect(extractOutcome(500, undefined)).toEqual({
      ok: false,
      errorCode: "http-500",
    });
  });
});

describe("buildRequestRecord", () => {
  it("assembles a request record with injected ts, normalized route, bounded fields", () => {
    const rec = buildRequestRecord({
      ts: "2026-06-08T10:00:00.000Z",
      method: "POST",
      path: "/api/schema/f_1/patch?room=r",
      space: "di-draw",
      room: "r",
      clientOpId: "op-1",
      durationMs: 12,
      httpStatus: 200,
      reqPayload: { actions: [{ kind: "schema-patch" }] },
      respBody: { ok: true, version: 7 },
      maxFieldBytes: 4096,
    });
    expect(rec).toMatchObject({
      ts: "2026-06-08T10:00:00.000Z",
      kind: "request",
      route: "/api/schema/:id/patch",
      method: "POST",
      space: "di-draw",
      room: "r",
      clientOpId: "op-1",
      durationMs: 12,
      httpStatus: 200,
      ok: true,
      errorCode: null,
      payload: { actions: [{ kind: "schema-patch" }] },
      result: { ok: true, version: 7 },
    });
  });

  it("missing clientOpId → null", () => {
    const rec = buildRequestRecord({
      ts: "2026-06-08T10:00:00.000Z",
      method: "POST",
      path: "/api/domain",
      space: "s",
      room: "r",
      clientOpId: undefined,
      durationMs: 3,
      httpStatus: 200,
      reqPayload: {},
      respBody: { ok: true },
      maxFieldBytes: 4096,
    });
    expect(rec.clientOpId).toBeNull();
  });
});
