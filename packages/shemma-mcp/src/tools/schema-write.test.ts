/**
 * Tests for schema write MCP tools (DRW-134 Task 2.8):
 *   shemma_create_schema, shemma_patch_schema, shemma_set_overlay.
 *
 * Also covers multi-schema resolver:
 *   - no-schema-frame (0 frames)
 *   - ambiguous-schema-frame (≥2 frames)
 *   - auto-pick (1 frame, no frameId provided)
 */

import { afterEach, describe, expect, it } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "@shemma/client";
import type { ResolveSpaceFn } from "../space-resolver";
import { registerSchemaWriteTools } from "./schema-write";

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

/** Mock fetch with a sequence: first N calls → handlers[i]; remainder → last handler. */
function mockFetchSequence(handlers: FetchHandler[]) {
  let idx = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    const handler = handlers[Math.min(idx++, handlers.length - 1)];
    const { body, status = 200 } = handler(u, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function mockFetch(handler: FetchHandler) {
  mockFetchSequence([handler]);
}

function setup() {
  const server = new McpServer({ name: "t", version: "0" });
  const client = new CanvasClient({ baseUrl: "http://test" });
  const handles = registerSchemaWriteTools(server, {
    client,
    resolveSpace: fakeResolveSpace,
  });
  return { server, client, handles };
}

describe("shemma_create_schema", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("registers tools without throwing", () => {
    expect(() => setup()).not.toThrow();
  });

  it("Mode A (raw): valid mermaid → posts to /api/schema/create, returns frameId + nodeIds", async () => {
    let capturedBody: unknown;
    mockFetch((url, init) => {
      if (url.includes("/api/schema/create")) {
        capturedBody = JSON.parse(init?.body as string);
        return { body: { ok: true, frameId: "shape:f_abc", nodeIds: ["user-xyz", "api-xyz"], version: 2 } };
      }
      return { body: {} };
    });

    const { handles } = setup();
    const r = await handles.create_schema.call({
      label: "Auth flow",
      raw: "graph LR\n  user[User] --> api[API]",
    });
    expect(r.structuredContent).toMatchObject({
      ok: true,
      data: { frameId: "shape:f_abc", nodeIds: ["user-xyz", "api-xyz"] },
    });
    expect((capturedBody as Record<string, unknown>).raw).toBe("graph LR\n  user[User] --> api[API]");
    expect((capturedBody as Record<string, unknown>).label).toBe("Auth flow");
  });

  it("Mode B (actions): posts actions to /api/schema/create", async () => {
    let capturedBody: unknown;
    mockFetch((url, init) => {
      if (url.includes("/api/schema/create")) {
        capturedBody = JSON.parse(init?.body as string);
        return { body: { ok: true, frameId: "shape:f_bcd", nodeIds: ["api-xxx"], version: 1 } };
      }
      return { body: {} };
    });

    const { handles } = setup();
    const r = await handles.create_schema.call({
      label: "Simple",
      actions: [{ kind: "schema-define", role: "service", label: "API" }],
    });
    expect(r.structuredContent).toMatchObject({ ok: true, data: { frameId: "shape:f_bcd" } });
    const body = capturedBody as Record<string, unknown>;
    expect(Array.isArray(body.actions)).toBe(true);
    expect(body.raw).toBeUndefined();
  });

  it("neither raw nor actions → validation-error without calling backend", async () => {
    let fetchCalled = false;
    mockFetch(() => { fetchCalled = true; return { body: {} }; });

    const { handles } = setup();
    const r = await handles.create_schema.call({ label: "Empty" });
    expect(r.structuredContent).toMatchObject({ ok: false, code: "validation-error" });
    expect(r.isError).toBe(true);
    expect(fetchCalled).toBe(false);
  });

  it("backend returns unsupported-diagram-type → surfaced as validation-error", async () => {
    mockFetch(() => ({
      body: { ok: false, errors: [{ actionIndex: -1, code: "unsupported-diagram-type", message: "unsupported diagram type" }] },
      status: 422,
    }));

    const { handles } = setup();
    const r = await handles.create_schema.call({
      label: "Bad",
      raw: "sequenceDiagram\n A->>B: hi",
    });
    expect(r.structuredContent).toMatchObject({ ok: false, code: "validation-error" });
    expect(r.isError).toBe(true);
  });

  it("clientOpId is propagated to backend", async () => {
    let capturedBody: unknown;
    mockFetch((_, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return { body: { ok: true, frameId: "shape:f_x", nodeIds: [], version: 1 } };
    });

    const { handles } = setup();
    await handles.create_schema.call({ label: "L", raw: "graph LR\n  a[A]", clientOpId: "my-op-id" });
    expect((capturedBody as Record<string, unknown>).clientOpId).toBe("my-op-id");
  });

  it("daemon unavailable → daemon-unavailable error", async () => {
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
    const { handles } = setup();
    const r = await handles.create_schema.call({ label: "L", raw: "graph LR\n  a[A]" });
    expect(r.structuredContent).toMatchObject({ ok: false, code: "daemon-unavailable" });
    expect(r.isError).toBe(true);
  });

  // DRW-229: a backend 500 must NOT be conflated with daemon-unavailable.
  it("backend 500 (JSON) → unexpected-error WITH status (not daemon-unavailable)", async () => {
    mockFetch(() => ({ body: { error: "boom" }, status: 500 }));
    const { handles } = setup();
    const r = await handles.create_schema.call({ label: "L", raw: "graph LR\n  a[A]" });
    expect(r.structuredContent).toMatchObject({ ok: false, code: "unexpected-error", status: 500 });
    expect(r.isError).toBe(true);
  });

  it("backend 500 (non-JSON body) → unexpected-error, not daemon-unavailable", async () => {
    globalThis.fetch = (async () =>
      new Response("Internal Server Error", {
        status: 500,
        headers: { "content-type": "text/plain" },
      })) as typeof fetch;
    const { handles } = setup();
    const r = await handles.create_schema.call({ label: "L", raw: "graph LR\n  a[A]" });
    expect(r.structuredContent).toMatchObject({ ok: false, code: "unexpected-error", status: 500 });
    expect(r.isError).toBe(true);
  });
});

describe("shemma_patch_schema", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("explicit frameId: posts patch to /api/schema/:frameId/patch", async () => {
    let capturedUrl = "";
    mockFetch((url, init) => {
      capturedUrl = url;
      if (url.includes("/patch")) {
        return {
          body: {
            ok: true,
            frameId: "shape:f_abc",
            version: 3,
            addedNodeIds: ["new-node-xyz"],
            removedNodeIds: [],
            orphanedOverlays: 0,
            destructiveScore: 0,
          },
        };
      }
      return { body: {} };
    });

    const { handles } = setup();
    const r = await handles.patch_schema.call({
      frameId: "shape:f_abc",
      actions: [{ kind: "schema-define", role: "service", label: "New" }],
    });
    expect(r.structuredContent).toMatchObject({
      ok: true,
      data: { frameId: "shape:f_abc", addedNodeIds: ["new-node-xyz"] },
    });
    expect(capturedUrl).toContain("shape%3Af_abc");
    expect(capturedUrl).toContain("/patch");
  });

  it("no frameId + 0 schema-frames → no-schema-frame error", async () => {
    // First call is to canvas/view to resolve frames.
    mockFetch((url) => {
      if (url.includes("/api/canvas/view")) {
        return { body: { schemaVersion: "v2", frames: [], free: [] } };
      }
      return { body: {} };
    });

    const { handles } = setup();
    const r = await handles.patch_schema.call({
      actions: [{ kind: "schema-define", role: "service", label: "X" }],
    });
    expect(r.structuredContent).toMatchObject({ ok: false, code: "no-schema-frame" });
    expect(r.isError).toBe(true);
  });

  it("no frameId + v1 room → no-schema-frame error", async () => {
    mockFetch((url) => {
      if (url.includes("/api/canvas/view")) {
        return { body: { schemaVersion: "v1", legacy: {}, hint: "" } };
      }
      return { body: {} };
    });

    const { handles } = setup();
    const r = await handles.patch_schema.call({
      actions: [{ kind: "schema-define", role: "service", label: "X" }],
    });
    expect(r.structuredContent).toMatchObject({ ok: false, code: "no-schema-frame" });
    expect(r.isError).toBe(true);
  });

  it("no frameId + 2 schema-frames → ambiguous-schema-frame with availableFrameIds", async () => {
    mockFetch((url) => {
      if (url.includes("/api/canvas/view")) {
        return {
          body: {
            schemaVersion: "v2",
            frames: [
              { id: "shape:f_aaa", label: "Frame A", bbox: {}, raw: "", overlays: {} },
              { id: "shape:f_bbb", label: "Frame B", bbox: {}, raw: "", overlays: {} },
            ],
            free: [],
          },
        };
      }
      return { body: {} };
    });

    const { handles } = setup();
    const r = await handles.patch_schema.call({
      actions: [{ kind: "schema-define", role: "service", label: "X" }],
    });
    expect(r.structuredContent).toMatchObject({ ok: false, code: "ambiguous-schema-frame" });
    expect(r.isError).toBe(true);
    const content = r.structuredContent as { details?: { availableFrameIds?: string[] } };
    expect(content.details?.availableFrameIds).toEqual(["shape:f_aaa", "shape:f_bbb"]);
  });

  it("no frameId + 1 schema-frame → auto-picks that frame, request proceeds", async () => {
    let capturedPatchUrl = "";
    mockFetchSequence([
      // First call: canvas/view
      (url) => {
        if (url.includes("/api/canvas/view")) {
          return {
            body: {
              schemaVersion: "v2",
              frames: [{ id: "shape:f_solo", label: "Solo", bbox: {}, raw: "", overlays: {} }],
              free: [],
            },
          };
        }
        return { body: {} };
      },
      // Second call: patch
      (url) => {
        capturedPatchUrl = url;
        return {
          body: {
            ok: true,
            frameId: "shape:f_solo",
            version: 5,
            addedNodeIds: [],
            removedNodeIds: [],
            orphanedOverlays: 0,
            destructiveScore: 0,
          },
        };
      },
    ]);

    const { handles } = setup();
    const r = await handles.patch_schema.call({
      actions: [{ kind: "schema-define", role: "service", label: "Auto" }],
    });
    expect(r.structuredContent).toMatchObject({ ok: true, data: { frameId: "shape:f_solo" } });
    expect(capturedPatchUrl).toContain("shape%3Af_solo");
  });

  it("backend unknown-node error → surfaced as validation-error", async () => {
    mockFetch((url) => {
      if (url.includes("/patch")) {
        return {
          body: {
            ok: false,
            errors: [{ actionIndex: 0, code: "unknown-node", message: "node 'bad-node' not found" }],
          },
          status: 422,
        };
      }
      return { body: {} };
    });

    const { handles } = setup();
    const r = await handles.patch_schema.call({
      frameId: "shape:f_x",
      actions: [{ kind: "schema-connect", from: "bad-node", to: "other" }],
    });
    expect(r.structuredContent).toMatchObject({ ok: false, code: "validation-error" });
    expect(r.isError).toBe(true);
  });

  it("clientOpId propagated to backend", async () => {
    let capturedBody: unknown;
    mockFetch((url, init) => {
      if (url.includes("/patch")) {
        capturedBody = JSON.parse(init?.body as string);
        return { body: { ok: true, frameId: "shape:f_x", version: 1, addedNodeIds: [], removedNodeIds: [], orphanedOverlays: 0, destructiveScore: 0 } };
      }
      return { body: {} };
    });

    const { handles } = setup();
    await handles.patch_schema.call({
      frameId: "shape:f_x",
      actions: [],
      clientOpId: "op-xyz",
    });
    expect((capturedBody as Record<string, unknown>).clientOpId).toBe("op-xyz");
  });
});

describe("shemma_set_overlay", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("posts overlay to /api/schema/:frameId/overlay", async () => {
    let capturedBody: unknown;
    let capturedUrl = "";
    mockFetch((url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init?.body as string);
      return { body: { ok: true } };
    });

    const { handles } = setup();
    const r = await handles.set_overlay.call({
      frameId: "shape:f_abc",
      nodeId: "api-xyz123",
      overlay: { position: { x: 10, y: 20 }, styleOwnedBy: "user" },
    });
    expect(r.structuredContent).toMatchObject({ ok: true, data: { ok: true } });
    expect(capturedUrl).toContain("shape%3Af_abc");
    expect(capturedUrl).toContain("/overlay");
    const body = capturedBody as Record<string, unknown>;
    expect(body.nodeId).toBe("api-xyz123");
    expect((body.overlay as Record<string, unknown>)?.styleOwnedBy).toBe("user");
  });

  it("backend overlay-user-owned error → validation-error", async () => {
    mockFetch(() => ({
      body: { ok: false, error: "overlay-user-owned" },
      status: 422,
    }));

    const { handles } = setup();
    const r = await handles.set_overlay.call({
      frameId: "shape:f_abc",
      nodeId: "api-xyz",
      overlay: { color: "blue" },
    });
    expect(r.structuredContent).toMatchObject({ ok: false, code: "validation-error" });
    expect(r.isError).toBe(true);
  });

  it("daemon unavailable → daemon-unavailable error", async () => {
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
    const { handles } = setup();
    const r = await handles.set_overlay.call({
      frameId: "shape:f_abc",
      nodeId: "api-xyz",
      overlay: { color: "red" },
    });
    expect(r.structuredContent).toMatchObject({ ok: false, code: "daemon-unavailable" });
    expect(r.isError).toBe(true);
  });

  it("space resolver error is returned early", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    const client = new CanvasClient({ baseUrl: "http://test" });
    const handles = registerSchemaWriteTools(server, {
      client,
      resolveSpace: () => ({ space: undefined, source: "not_found", error: "space_not_found: x" }),
    });
    const r = await handles.set_overlay.call({
      frameId: "shape:f_abc",
      nodeId: "node",
      overlay: { color: "red" },
      space: "bad-space",
    });
    expect(r.structuredContent).toMatchObject({ ok: false, code: "space-not-found" });
    expect(r.isError).toBe(true);
  });
});
