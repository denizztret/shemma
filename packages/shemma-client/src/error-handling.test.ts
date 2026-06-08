/**
 * DRW-221: `applyDomain` must NOT blindly `r.json()`. When the daemon answers
 * with a non-2xx status (including a non-JSON body like a plain-text 500), the
 * client returns the body annotated with `httpStatus` — it does NOT throw, so
 * the MCP layer can map it to a backend code instead of conflating it with a
 * transport failure (`daemon-unavailable`). Only a genuine fetch rejection
 * (connection refused / timeout) propagates as a throw.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { CanvasClient } from "./index";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function client() {
  return new CanvasClient({ baseUrl: "http://x", space: "s", room: "r" });
}

describe("CanvasClient.applyDomain — error-aware response handling (DRW-221)", () => {
  it("non-JSON 500 → returns body annotated with httpStatus, does not throw", async () => {
    globalThis.fetch = (async () =>
      new Response("Internal Server Error", {
        status: 500,
        headers: { "content-type": "text/plain" },
      })) as typeof fetch;
    const res = (await client().applyDomain({ actions: [] })) as {
      ok?: boolean;
      httpStatus?: number;
      error?: string;
    };
    expect(res.httpStatus).toBe(500);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Internal Server Error");
  });

  it("JSON 422 → returns parsed body annotated with httpStatus", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ ok: false, errors: [{ msg: "name taken" }] }),
        {
          status: 422,
          headers: { "content-type": "application/json" },
        },
      )) as typeof fetch;
    const res = (await client().applyDomain({ actions: [] })) as {
      ok?: boolean;
      httpStatus?: number;
      errors?: unknown[];
    };
    expect(res.httpStatus).toBe(422);
    expect(res.ok).toBe(false);
    expect(Array.isArray(res.errors)).toBe(true);
  });

  it("2xx JSON → returns body as-is, no httpStatus annotation", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, version: 7 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const res = (await client().applyDomain({ actions: [] })) as {
      ok?: boolean;
      version?: number;
      httpStatus?: number;
    };
    expect(res.ok).toBe(true);
    expect(res.version).toBe(7);
    expect(res.httpStatus).toBeUndefined();
  });

  it("transport failure (fetch rejects) → propagates as throw", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    await expect(client().applyDomain({ actions: [] })).rejects.toThrow(
      "ECONNREFUSED",
    );
  });
});
