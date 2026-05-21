import { afterEach, describe, expect, it } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "@shemma/client";
import type { ResolveSpaceFn } from "../space-resolver";
import { registerReadOnlyTools } from "./read-only";

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

describe("read-only tools", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function setup() {
    const server = new McpServer({ name: "t", version: "0" });
    const client = new CanvasClient({ baseUrl: "http://test" });
    const handles = registerReadOnlyTools(server, {
      client,
      defaultRoom: "default",
      resolveSpace: fakeResolveSpace,
    });
    return { server, client, handles };
  }

  it("registers all 7 tools without throwing", () => {
    expect(() => setup()).not.toThrow();
  });

  it("shemma_health returns healthy:true on health() success", async () => {
    mockFetch(() => ({ body: { ok: true } }));
    const { handles } = setup();
    const r = await handles.health.call({});
    expect(r.structuredContent).toMatchObject({ ok: true, data: { healthy: true } });
  });

  it("shemma_health with extended=true returns daemon info", async () => {
    mockFetch(() => ({ body: { ok: true, profile: "release", storage: "/tmp", version: "0.12.3", pid: 99 } }));
    const { handles } = setup();
    const r = await handles.health.call({ extended: true });
    expect(r.structuredContent).toMatchObject({ ok: true, data: { profile: "release", version: "0.12.3", pid: 99 } });
  });

  it("shemma_health extended returns daemon-unavailable when getHealth returns null", async () => {
    mockFetch(() => ({ body: { ok: false }, status: 500 }));
    const { handles } = setup();
    const r = await handles.health.call({ extended: true });
    expect(r.structuredContent).toMatchObject({ ok: false, code: "daemon-unavailable" });
    expect(r.isError).toBe(true);
  });

  it("shemma_version returns version data", async () => {
    mockFetch(() => ({ body: { version: "0.12.3", schema: 2 } }));
    const { handles } = setup();
    const r = await handles.version.call({});
    expect(r.structuredContent).toMatchObject({ ok: true, data: { version: "0.12.3" } });
  });

  it("shemma_rooms_list returns rooms array", async () => {
    mockFetch(() => ({ body: [{ id: "default" }, { id: "drw-054" }] }));
    const { handles } = setup();
    const r = await handles.rooms_list.call({});
    expect(r.structuredContent).toMatchObject({ ok: true });
  });

  it("shemma_active_rooms returns active rooms", async () => {
    mockFetch(() => ({ body: { rooms: [{ room: "x", clientCount: 1, lastFocusedAt: 1 }] } }));
    const { handles } = setup();
    const r = await handles.active_rooms.call({});
    expect(r.structuredContent).toMatchObject({ ok: true });
  });

  it("shemma_context returns data and echoes room", async () => {
    mockFetch(() => ({ body: { ok: true, version: 1, elements: [] } }));
    const { handles } = setup();
    const r = await handles.context.call({ room: "custom-room" });
    expect(r.structuredContent).toMatchObject({ ok: true, room: "custom-room" });
  });

  it("shemma_context uses default room when none provided", async () => {
    mockFetch(() => ({ body: { ok: true, version: 1, elements: [] } }));
    const { handles } = setup();
    const r = await handles.context.call({});
    expect(r.structuredContent).toMatchObject({ ok: true, room: "default" });
  });

  it("shemma_prompts_list defaults to pending", async () => {
    mockFetch(() => ({ body: [] }));
    const { handles } = setup();
    const r = await handles.prompts_list.call({});
    expect(r.structuredContent).toMatchObject({ ok: true });
  });

  it("shemma_ai_activity_status returns activity", async () => {
    mockFetch(() => ({ body: null }));
    const { handles } = setup();
    const r = await handles.ai_activity_status.call({});
    expect(r.structuredContent).toMatchObject({ ok: true });
  });

  it("fetch error returns daemon-unavailable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const { handles } = setup();
    const r = await handles.version.call({});
    expect(r.structuredContent).toMatchObject({ ok: false, code: "daemon-unavailable" });
  });

  it("shemma_health with ensure:true on unreachable daemon includes warning", async () => {
    mockFetch(() => ({ body: { ok: false }, status: 500 }));
    const { handles } = setup();
    const r = await handles.health.call({ extended: true, ensure: true });
    expect(r.structuredContent).toMatchObject({
      ok: false,
      code: "daemon-unavailable",
      details: { warning: "ensure not yet implemented; pass --auto-ensure to shemma mcp start instead" },
    });
  });

  it("shemma_health basic with ensure:true and unhealthy returns warning in data", async () => {
    // health() calls /healthz and returns response.ok (HTTP status boolean).
    // Mock a 503 response so health() returns false.
    globalThis.fetch = (async () =>
      new Response("", { status: 503 })
    ) as typeof fetch;
    const { handles } = setup();
    const r = await handles.health.call({ ensure: true });
    expect(r.structuredContent).toMatchObject({
      ok: true,
      data: { healthy: false, warning: "ensure not yet implemented; pass --auto-ensure to shemma mcp start instead" },
    });
  });
});
