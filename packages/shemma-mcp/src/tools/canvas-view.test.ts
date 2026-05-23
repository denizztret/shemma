/**
 * Tests for shemma_canvas_view MCP tool (DRW-134 Task 2.8).
 */

import { afterEach, describe, expect, it } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "@shemma/client";
import type { ResolveSpaceFn } from "../space-resolver";
import { registerCanvasViewTool } from "./canvas-view";

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

function mockFetch(handler: (url: string) => { body: unknown; status?: number }) {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url.toString();
    const { body, status = 200 } = handler(u);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function setup() {
  const server = new McpServer({ name: "t", version: "0" });
  const client = new CanvasClient({ baseUrl: "http://test" });
  const handles = registerCanvasViewTool(server, {
    client,
    resolveSpace: fakeResolveSpace,
  });
  return { server, client, handles };
}

describe("shemma_canvas_view", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("registers tool without throwing", () => {
    expect(() => setup()).not.toThrow();
  });

  it("v2 room: returns full canvas view payload", async () => {
    const v2Payload = {
      schemaVersion: "v2",
      frames: [
        {
          id: "shape:f_abc123",
          label: "Auth flow",
          bbox: { x: 100, y: 100, w: 640, h: 480 },
          raw: "graph LR\n  user[User] --> api[API]",
          overlays: {},
        },
      ],
      free: [],
    };

    mockFetch(() => ({ body: v2Payload }));
    const { handles } = setup();
    const r = await handles.canvas_view.call({});
    expect(r.structuredContent).toMatchObject({
      ok: true,
      data: { schemaVersion: "v2", frames: [{ id: "shape:f_abc123" }], free: [] },
    });
  });

  it("v1 room: returns v1 wrapped payload unchanged", async () => {
    const v1Payload = {
      schemaVersion: "v1",
      legacy: { ok: true, version: 5, elements: [] },
      hint: "room uses legacy protocol",
    };

    mockFetch(() => ({ body: v1Payload }));
    const { handles } = setup();
    const r = await handles.canvas_view.call({});
    expect(r.structuredContent).toMatchObject({
      ok: true,
      data: { schemaVersion: "v1" },
    });
    // isError should not be set
    expect(r.isError).toBeUndefined();
  });

  it("space resolver error returns structured error", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    const client = new CanvasClient({ baseUrl: "http://test" });
    const handles = registerCanvasViewTool(server, {
      client,
      resolveSpace: () => ({ space: undefined, source: "not_found", error: "space_not_found: bad" }),
    });
    const r = await handles.canvas_view.call({ space: "bad" });
    expect(r.structuredContent).toMatchObject({ ok: false, code: "space-not-found" });
    expect(r.isError).toBe(true);
  });

  it("daemon unavailable returns error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const { handles } = setup();
    const r = await handles.canvas_view.call({});
    expect(r.structuredContent).toMatchObject({ ok: false, code: "daemon-unavailable" });
    expect(r.isError).toBe(true);
  });

  it("uses room parameter in request URL", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (url: string | URL | Request) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      return new Response(JSON.stringify({ schemaVersion: "v1", legacy: {}, hint: "" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const { handles } = setup();
    await handles.canvas_view.call({ room: "my-room" });
    expect(capturedUrl).toContain("room=my-room");
    expect(capturedUrl).toContain("/api/canvas/view");
  });
});
