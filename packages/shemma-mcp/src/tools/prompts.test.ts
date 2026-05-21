import { afterEach, describe, expect, it } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "@shemma/client";
import type { ResolveSpaceFn } from "../space-resolver";
import { registerPromptAndActivityTools } from "./prompts";

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

describe("prompt+activity tools", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function setup() {
    const server = new McpServer({ name: "t", version: "0" });
    const client = new CanvasClient({ baseUrl: "http://test" });
    const handles = registerPromptAndActivityTools(server, {
      client,
      defaultRoom: "default",
      resolveSpace: fakeResolveSpace,
    });
    return { server, client, handles };
  }

  it("registers all 4 tools without throwing", () => {
    expect(() => setup()).not.toThrow();
  });

  it("shemma_prompt_resolve POST /api/prompt/:id/resolve", async () => {
    mockFetch((url) => {
      expect(url).toContain("/api/prompt/abc/resolve");
      return { body: { ok: true } };
    });
    const { handles } = setup();
    const r = await handles.prompt_resolve.call({ id: "abc", response: "answer" });
    expect(r.structuredContent).toMatchObject({ ok: true });
  });

  it("shemma_prompt_dismiss POST /api/prompt/:id/dismiss", async () => {
    mockFetch((url) => {
      expect(url).toContain("/api/prompt/xyz/dismiss");
      return { body: { ok: true } };
    });
    const { handles } = setup();
    const r = await handles.prompt_dismiss.call({ id: "xyz" });
    expect(r.structuredContent).toMatchObject({ ok: true });
  });

  it("shemma_ai_activity_start with actor and task", async () => {
    mockFetch(() => ({ body: { ok: true, activity: { actor: "claude", task: "drawing" } } }));
    const { handles } = setup();
    const r = await handles.ai_activity_start.call({ actor: "claude", task: "drawing" });
    expect(r.structuredContent).toMatchObject({ ok: true });
  });

  it("shemma_ai_activity_stop clears activity", async () => {
    mockFetch(() => ({ body: { ok: true } }));
    const { handles } = setup();
    const r = await handles.ai_activity_stop.call({});
    expect(r.structuredContent).toMatchObject({ ok: true });
  });

  it("network error returns daemon-unavailable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const { handles } = setup();
    const r = await handles.prompt_resolve.call({ id: "abc" });
    expect(r.structuredContent).toMatchObject({ ok: false, code: "daemon-unavailable" });
  });

  it("custom room parameter scopes the request URL", async () => {
    let capturedUrl = "";
    mockFetch((url) => {
      capturedUrl = url;
      return { body: { ok: true } };
    });
    const { handles } = setup();
    await handles.prompt_resolve.call({ id: "abc", room: "custom-room" });
    expect(capturedUrl).toContain("room=custom-room");
  });

  it("prompt_resolve echoes room in response", async () => {
    mockFetch(() => ({ body: { ok: true } }));
    const { handles } = setup();
    const r = await handles.prompt_resolve.call({ id: "abc", room: "custom-room" });
    expect(r.structuredContent).toMatchObject({ ok: true, room: "custom-room" });
  });

  it("prompt_dismiss without room uses defaultRoom", async () => {
    mockFetch(() => ({ body: { ok: true } }));
    const { handles } = setup();
    const r = await handles.prompt_dismiss.call({ id: "xyz" });
    expect(r.structuredContent).toMatchObject({ ok: true, room: "default" });
  });

  it("ai_activity_start responds with room", async () => {
    mockFetch(() => ({ body: { ok: true } }));
    const { handles } = setup();
    const r = await handles.ai_activity_start.call({ actor: "claude", task: "layout" });
    expect(r.structuredContent).toMatchObject({ ok: true, room: "default" });
  });

  it("ai_activity_stop custom room scopes request", async () => {
    let capturedUrl = "";
    mockFetch((url) => {
      capturedUrl = url;
      return { body: { ok: true } };
    });
    const { handles } = setup();
    await handles.ai_activity_stop.call({ room: "other-room" });
    expect(capturedUrl).toContain("room=other-room");
  });
});
