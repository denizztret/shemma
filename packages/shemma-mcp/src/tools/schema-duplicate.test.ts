/**
 * Tests for schema duplicate + delete MCP tools — DRW-134 Task 3.1.
 *
 *   shemma_duplicate_schema — wraps POST /api/schema/:frameId/duplicate
 *   shemma_delete_schema    — wraps DELETE /api/schema/:frameId
 */

import { afterEach, describe, expect, it } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "@shemma/client";
import type { ResolveSpaceFn } from "../space-resolver";
import { registerSchemaDuplicateTools } from "./schema-duplicate";

const fakeSpaceRecord = {
  id: "test-space",
  path: "/tmp/test-space",
  storageLayout: "project" as const,
  createdAt: "2026-01-01T00:00:00Z",
  lastUsedAt: "2026-01-01T00:00:00Z",
};

const fakeResolveSpace: ResolveSpaceFn = ({ space }) => {
  if (space) return { space: { ...fakeSpaceRecord, id: space }, source: "explicit" };
  return { space: fakeSpaceRecord, source: "default" };
};

const originalFetch = globalThis.fetch;

type FetchHandler = (url: string, init?: RequestInit) => { body: unknown; status?: number };

function mockFetch(handler: FetchHandler) {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    const { body, status = 200 } = handler(u, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function setup() {
  const server = new McpServer({ name: "t", version: "0" });
  const client = new CanvasClient({ baseUrl: "http://test" });
  const handles = registerSchemaDuplicateTools(server, {
    client,
    resolveSpace: fakeResolveSpace,
  });
  return { server, client, handles };
}

// ---- shemma_duplicate_schema ----

describe("shemma_duplicate_schema", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("registers tools without throwing", () => {
    expect(() => setup()).not.toThrow();
  });

  it("happy path: posts to /api/schema/:frameId/duplicate, returns newFrameId + nodeIdMap", async () => {
    let capturedUrl = "";
    let capturedBody: unknown;

    mockFetch((url, init) => {
      capturedUrl = url;
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return {
        body: {
          ok: true,
          newFrameId: "shape:f_new123",
          nodeIdMap: { "api-aaaaaa": "api-bbbbbb", "db-cccccc": "db-dddddd" },
        },
      };
    });

    const { handles } = setup();
    const result = await handles.duplicate_schema.call({
      frameId: "shape:f_abc123",
      newLabel: "Schema v2",
    });

    expect((result as { isError?: boolean }).isError).toBeUndefined();
    expect(capturedUrl).toContain("/api/schema/shape%3Af_abc123/duplicate");
    expect((capturedBody as { newLabel?: string })?.newLabel).toBe("Schema v2");

    const parsed = JSON.parse(result.content[0]!.text) as {
      ok: boolean;
      data: { newFrameId: string; nodeIdMap: Record<string, string> };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.newFrameId).toBe("shape:f_new123");
    expect(parsed.data.nodeIdMap["api-aaaaaa"]).toBe("api-bbbbbb");
    expect(parsed.data.nodeIdMap["db-cccccc"]).toBe("db-dddddd");
  });

  it("backend error (frame-not-found) → isError: true, code validation-error", async () => {
    mockFetch(() => ({
      body: { ok: false, error: "schema-frame 'shape:f_abc' not found", code: "frame-not-found" },
      status: 404,
    }));

    const { handles } = setup();
    const result = await handles.duplicate_schema.call({ frameId: "shape:f_abc" });

    expect((result as { isError?: boolean }).isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text) as { ok: boolean; code: string };
    expect(parsed.ok).toBe(false);
  });

  it("network error → isError: true, code daemon-unavailable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;

    const { handles } = setup();
    const result = await handles.duplicate_schema.call({ frameId: "shape:f_abc" });

    expect((result as { isError?: boolean }).isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text) as { ok: boolean; code: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("daemon-unavailable");
  });

  it("without newLabel: body sent without newLabel field (uses backend default)", async () => {
    let capturedBody: unknown;
    mockFetch((_, init) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return {
        body: { ok: true, newFrameId: "shape:f_copy", nodeIdMap: {} },
      };
    });

    const { handles } = setup();
    await handles.duplicate_schema.call({ frameId: "shape:f_abc" });

    expect((capturedBody as { newLabel?: string })?.newLabel).toBeUndefined();
  });
});

// ---- shemma_delete_schema ----

describe("shemma_delete_schema", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("happy path: sends DELETE to /api/schema/:frameId, returns ok:true", async () => {
    let capturedUrl = "";
    let capturedMethod = "";

    mockFetch((url, init) => {
      capturedUrl = url;
      capturedMethod = init?.method ?? "";
      return { body: { ok: true } };
    });

    const { handles } = setup();
    const result = await handles.delete_schema.call({ frameId: "shape:f_abc123" });

    expect((result as { isError?: boolean }).isError).toBeUndefined();
    expect(capturedUrl).toContain("/api/schema/shape%3Af_abc123");
    expect(capturedMethod).toBe("DELETE");

    const parsed = JSON.parse(result.content[0]!.text) as {
      ok: boolean;
      data: { ok: boolean; deletedFrameId: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.deletedFrameId).toBe("shape:f_abc123");
  });

  it("frame-not-found → isError: true", async () => {
    mockFetch(() => ({
      body: { ok: false, error: "frame not found", code: "frame-not-found" },
      status: 404,
    }));

    const { handles } = setup();
    const result = await handles.delete_schema.call({ frameId: "shape:f_nonexistent" });

    expect((result as { isError?: boolean }).isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text) as { ok: boolean };
    expect(parsed.ok).toBe(false);
  });

  it("network error → daemon-unavailable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network failure");
    }) as typeof fetch;

    const { handles } = setup();
    const result = await handles.delete_schema.call({ frameId: "shape:f_abc" });

    expect((result as { isError?: boolean }).isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text) as { code: string };
    expect(parsed.code).toBe("daemon-unavailable");
  });
});
