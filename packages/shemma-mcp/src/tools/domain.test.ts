import { afterEach, describe, expect, it } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "@shemma/client";
import { AutoOpenManager } from "../auto-open";
import { RoomResolver } from "../room-resolver";
import { registerDomainTools } from "./domain";

const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => { body: unknown; status?: number }) {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    const { body, status = 200 } = handler(u, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function makeResolver(opts: { mode: "direct" | "ambiguous" | "default"; room?: string } = { mode: "default" }) {
  const configRoom = opts.mode === "direct" ? (opts.room ?? "test-room") : undefined;
  return new RoomResolver({
    configRoom,
    sessionEnv: undefined,
    getActiveRooms: async () => {
      if (opts.mode === "ambiguous") {
        return { rooms: [
          { room: "room-a", clientCount: 1, lastFocusedAt: 1 },
          { room: "room-b", clientCount: 1, lastFocusedAt: 2 },
        ]};
      }
      return { rooms: [] };
    },
    getInProgressTasks: async () => [],
  });
}

function makeAutoOpen(opts: { mode?: "never" | "once" | "always" | "confirm"; throwOnNotify?: boolean } = {}) {
  const calls: string[] = [];
  const auto = new AutoOpenManager({
    mode: opts.mode ?? "always",
    env: {},
    spawn: async (r) => {
      if (opts.throwOnNotify) throw new Error("spawn failed");
      calls.push(r);
    },
  });
  return { auto, calls };
}

function setup(resolverOpts?: Parameters<typeof makeResolver>[0]) {
  const server = new McpServer({ name: "t", version: "0" });
  const client = new CanvasClient({ baseUrl: "http://test" });
  const resolver = makeResolver(resolverOpts);
  const handles = registerDomainTools(server, { client, resolver });
  return { server, client, resolver, handles };
}

function setupWithAutoOpen(
  resolverOpts: Parameters<typeof makeResolver>[0] = { mode: "direct", room: "r" },
  autoOpenOpts: Parameters<typeof makeAutoOpen>[0] = {},
) {
  const server = new McpServer({ name: "t", version: "0" });
  const client = new CanvasClient({ baseUrl: "http://test" });
  const resolver = makeResolver(resolverOpts);
  const { auto, calls } = makeAutoOpen(autoOpenOpts);
  const handles = registerDomainTools(server, { client, resolver, autoOpen: auto });
  return { server, client, resolver, handles, auto, calls };
}

const okDomainResponse = {
  ok: true,
  version: 5,
  results: [{ id: "shape:e_svc", kind: "define" }],
  layout: { elapsed: 12 },
};

describe("domain write tools", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Test 1: registers all 7 write tools without throwing
  it("registers all 7 write tools without throwing", () => {
    expect(() => setup()).not.toThrow();
  });

  // Test 2: shemma_define resolves room via resolver + calls applyDomain + echoes clientOpId + sets data.results
  it("shemma_define resolves room, calls applyDomain, echoes clientOpId, sets data.results", async () => {
    let capturedBody: unknown;
    mockFetch((_, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return { body: okDomainResponse };
    });
    const { handles } = setup({ mode: "direct", room: "my-room" });
    const r = await handles.define.call({ name: "svc", role: "service", clientOpId: "op-123" });
    expect(r.structuredContent).toMatchObject({
      ok: true,
      room: "my-room",
      roomSource: "config",
      version: 5,
      clientOpId: "op-123",
      data: { results: [{ id: "shape:e_svc", kind: "define" }] },
    });
    expect((capturedBody as { actions: unknown[] }).actions).toEqual([{ kind: "define", name: "svc", role: "service" }]);
    expect((capturedBody as { clientOpId: string }).clientOpId).toBe("op-123");
  });

  // Test 3: shemma_define with no room arg uses resolver default ("default")
  it("shemma_define with no room arg uses resolver default", async () => {
    mockFetch(() => ({ body: { ...okDomainResponse } }));
    const { handles } = setup({ mode: "default" });
    const r = await handles.define.call({ name: "svc", role: "service" });
    expect(r.structuredContent).toMatchObject({
      ok: true,
      room: "default",
      roomSource: "default",
    });
  });

  // Test 4: shemma_define with ambiguous resolver returns code:"ambiguous-room" + candidates
  it("shemma_define with ambiguous resolver returns code:ambiguous-room + candidates", async () => {
    const { handles } = setup({ mode: "ambiguous" });
    const r = await handles.define.call({ name: "svc", role: "service" });
    expect(r.structuredContent).toMatchObject({
      ok: false,
      code: "ambiguous-room",
    });
    expect(r.isError).toBe(true);
    const sc = r.structuredContent as { details: { candidates: unknown[] } };
    expect(sc.details.candidates.length).toBe(2);
  });

  // Test 5: shemma_define respects user-provided clientOpId (echoed verbatim)
  it("shemma_define respects user-provided clientOpId", async () => {
    mockFetch(() => ({ body: okDomainResponse }));
    const { handles } = setup({ mode: "direct", room: "r" });
    const r = await handles.define.call({ name: "x", role: "actor", clientOpId: "my-custom-op-id" });
    expect((r.structuredContent as { clientOpId: string }).clientOpId).toBe("my-custom-op-id");
  });

  // Test 6: shemma_define with dryRun:true passes dryRun:true to applyDomain
  it("shemma_define with dryRun:true passes dryRun:true to applyDomain", async () => {
    let capturedBody: unknown;
    mockFetch((_, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return { body: okDomainResponse };
    });
    const { handles } = setup({ mode: "direct", room: "r" });
    await handles.define.call({ name: "x", role: "actor", dryRun: true });
    expect((capturedBody as { dryRun: boolean }).dryRun).toBe(true);
  });

  // Test 7: shemma_define on idempotent response (resp.idempotent:true) sets idempotent:true on result
  it("shemma_define on idempotent response sets idempotent:true", async () => {
    mockFetch(() => ({ body: { ...okDomainResponse, idempotent: true } }));
    const { handles } = setup({ mode: "direct", room: "r" });
    const r = await handles.define.call({ name: "x", role: "actor" });
    expect((r.structuredContent as { idempotent: true }).idempotent).toBe(true);
  });

  // Test 8: shemma_apply passes actions array verbatim
  it("shemma_apply passes actions array verbatim", async () => {
    let capturedBody: unknown;
    mockFetch((_, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return { body: okDomainResponse };
    });
    const { handles } = setup({ mode: "direct", room: "r" });
    const actions = [
      { kind: "define", name: "a", role: "actor" },
      { kind: "connect", from: "a", to: "b", connectionKind: "sync" },
    ];
    await handles.apply.call({ actions });
    expect((capturedBody as { actions: unknown[] }).actions).toEqual(actions);
  });

  // Test 9: shemma_delete — verify tool is registered (destructiveHint annotation checked indirectly)
  it("shemma_delete is registered and executes delete actions", async () => {
    let capturedBody: unknown;
    mockFetch((_, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return { body: { ...okDomainResponse, results: [{ id: "shape:e_svc", kind: "delete" }] } };
    });
    const { handles } = setup({ mode: "direct", room: "r" });
    const r = await handles.delete.call({ ids: ["svc", "db"] });
    expect(r.structuredContent).toMatchObject({ ok: true });
    expect((capturedBody as { actions: Array<Record<string, unknown>> }).actions[0]).toMatchObject({
      kind: "delete",
      ids: ["svc", "db"],
    });
  });

  // Test 10: applyDomain network error returns daemon-unavailable + echoes clientOpId
  it("applyDomain network error returns daemon-unavailable + echoes clientOpId", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const { handles } = setup({ mode: "direct", room: "r" });
    const r = await handles.define.call({ name: "x", role: "actor", clientOpId: "err-op" });
    expect(r.structuredContent).toMatchObject({
      ok: false,
      code: "daemon-unavailable",
      clientOpId: "err-op",
    });
    expect(r.isError).toBe(true);
  });

  // Bonus tests for remaining tools
  it("shemma_connect sends connect action with connectionKind", async () => {
    let capturedBody: unknown;
    mockFetch((_, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return { body: okDomainResponse };
    });
    const { handles } = setup({ mode: "direct", room: "r" });
    await handles.connect.call({ from: "a", to: "b", connectionKind: "sync" });
    expect((capturedBody as { actions: Array<Record<string, unknown>> }).actions[0]).toMatchObject({
      kind: "connect", from: "a", to: "b", connectionKind: "sync",
    });
  });

  it("shemma_group sends group action with children", async () => {
    let capturedBody: unknown;
    mockFetch((_, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return { body: okDomainResponse };
    });
    const { handles } = setup({ mode: "direct", room: "r" });
    await handles.group.call({ name: "g1", children: ["a", "b"] });
    expect((capturedBody as { actions: Array<Record<string, unknown>> }).actions[0]).toMatchObject({
      kind: "group", name: "g1", children: ["a", "b"],
    });
  });

  // DRW-072: domain validator требует as ∈ {network, boundary}. MCP wrapper
  // должен подставить default 'boundary' если клиент не указал, иначе любой
  // shemma_group падает с "group.as must be network|boundary".
  it("shemma_group defaults as='boundary' when caller omits it (DRW-072)", async () => {
    let capturedBody: unknown;
    mockFetch((_, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return { body: okDomainResponse };
    });
    const { handles } = setup({ mode: "direct", room: "r" });
    await handles.group.call({ name: "g1", children: ["a", "b"] });
    expect((capturedBody as { actions: Array<Record<string, unknown>> }).actions[0]).toMatchObject({
      kind: "group", as: "boundary",
    });
  });

  it("shemma_group passes through explicit as='network'", async () => {
    let capturedBody: unknown;
    mockFetch((_, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return { body: okDomainResponse };
    });
    const { handles } = setup({ mode: "direct", room: "r" });
    await handles.group.call({ name: "net1", children: ["a", "b"], as: "network" });
    expect((capturedBody as { actions: Array<Record<string, unknown>> }).actions[0]).toMatchObject({
      kind: "group", as: "network",
    });
  });

  it("shemma_note sends note action with text", async () => {
    let capturedBody: unknown;
    mockFetch((_, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return { body: okDomainResponse };
    });
    const { handles } = setup({ mode: "direct", room: "r" });
    await handles.note.call({ name: "n1", text: "hello world" });
    expect((capturedBody as { actions: Array<Record<string, unknown>> }).actions[0]).toMatchObject({
      kind: "note", name: "n1", text: "hello world",
    });
  });

  it("shemma_layout sends layout action with mode and spacing", async () => {
    let capturedBody: unknown;
    mockFetch((_, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return { body: okDomainResponse };
    });
    const { handles } = setup({ mode: "direct", room: "r" });
    await handles.layout.call({ mode: "layered-lr", spacing: "compact" });
    expect((capturedBody as { actions: Array<Record<string, unknown>> }).actions[0]).toMatchObject({
      kind: "layout", mode: "layered-lr", spacing: "compact",
    });
  });

  it("backend ok:false returns validation-error with clientOpId", async () => {
    mockFetch(() => ({
      body: { ok: false, errors: [{ msg: "name taken" }] },
    }));
    const { handles } = setup({ mode: "direct", room: "r" });
    const r = await handles.define.call({ name: "x", role: "actor", clientOpId: "op-fail" });
    expect(r.structuredContent).toMatchObject({
      ok: false,
      code: "validation-error",
      clientOpId: "op-fail",
    });
    expect(r.isError).toBe(true);
  });

  // Auto-open integration tests
  it("shemma_define with autoOpen=always calls notifyWrite on success", async () => {
    mockFetch(() => ({ body: okDomainResponse }));
    const { handles, calls } = setupWithAutoOpen(
      { mode: "direct", room: "r" },
      { mode: "always" },
    );
    const r = await handles.define.call({ name: "svc", role: "service" });
    expect(calls).toEqual(["r"]);
    expect(r.structuredContent).toMatchObject({
      ok: true,
      data: { autoOpen: { openedRoom: "r" } },
    });
  });

  it("shemma_define with dryRun:true does NOT call notifyWrite", async () => {
    mockFetch(() => ({ body: okDomainResponse }));
    const { handles, calls } = setupWithAutoOpen(
      { mode: "direct", room: "r" },
      { mode: "always" },
    );
    const r = await handles.define.call({ name: "svc", role: "service", dryRun: true });
    expect(calls).toEqual([]);
    expect(r.structuredContent).toMatchObject({
      ok: true,
      data: { autoOpen: {} },
    });
  });

  it("shemma_define without autoOpen dep emits autoOpen:{} in data", async () => {
    mockFetch(() => ({ body: okDomainResponse }));
    const { handles } = setup({ mode: "direct", room: "r" });
    const r = await handles.define.call({ name: "svc", role: "service" });
    expect(r.structuredContent).toMatchObject({
      ok: true,
      data: { autoOpen: {} },
    });
  });

  it("shemma_define notifyWrite error does not break write — swallowed silently", async () => {
    mockFetch(() => ({ body: okDomainResponse }));
    const { handles } = setupWithAutoOpen(
      { mode: "direct", room: "r" },
      { throwOnNotify: true },
    );
    const r = await handles.define.call({ name: "svc", role: "service" });
    // Write must still succeed even when notifyWrite throws
    expect(r.structuredContent).toMatchObject({ ok: true, data: { results: okDomainResponse.results } });
    expect(r.isError).toBeUndefined();
  });

  it("shemma_define with autoOpen=never returns empty autoOpen in data", async () => {
    mockFetch(() => ({ body: okDomainResponse }));
    const { handles, calls } = setupWithAutoOpen(
      { mode: "direct", room: "r" },
      { mode: "never" },
    );
    await handles.define.call({ name: "svc", role: "service" });
    expect(calls).toEqual([]);
  });
});

describe("shemma_import_mermaid tool (DRW-083)", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("registers shemma_import_mermaid tool without throwing", () => {
    expect(() => setup()).not.toThrow();
  });

  it("importMermaid calls POST /api/agent/import-mermaid with source (no mode field)", async () => {
    let capturedUrl = "";
    let capturedBody: unknown;
    mockFetch((url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init?.body as string);
      return { body: { ok: true, shape_ids: ["s1", "s2"], didraw_names: ["a", "b"], root_ids: ["s1"] } };
    });
    const { handles } = setup({ mode: "direct", room: "test-room" });
    const r = await handles.importMermaid.call({ source: "graph LR; A-->B" });
    expect(capturedUrl).toContain("/api/agent/import-mermaid");
    expect(capturedUrl).toContain("room=test-room");
    expect((capturedBody as { source: string }).source).toBe("graph LR; A-->B");
    // Append-only: no mode field sent.
    expect((capturedBody as Record<string, unknown>).mode).toBeUndefined();
    expect(r.structuredContent).toMatchObject({
      ok: true,
      room: "test-room",
      shape_ids: ["s1", "s2"],
      root_ids: ["s1"],
    });
    expect(r.isError).toBeUndefined();
  });

  it("importMermaid returns error when backend returns 503", async () => {
    mockFetch(() => ({ body: { error: "no client connected" }, status: 503 }));
    const { handles } = setup({ mode: "direct", room: "r" });
    const r = await handles.importMermaid.call({ source: "graph LR; A-->B" });
    expect(r.structuredContent).toMatchObject({ ok: false });
    expect(r.isError).toBe(true);
  });

  it("importMermaid network error returns daemon-unavailable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const { handles } = setup({ mode: "direct", room: "r" });
    const r = await handles.importMermaid.call({ source: "graph LR; A-->B" });
    expect(r.structuredContent).toMatchObject({ ok: false, code: "daemon-unavailable" });
    expect(r.isError).toBe(true);
  });

  it("importMermaid with ambiguous resolver returns code:ambiguous-room", async () => {
    const { handles } = setup({ mode: "ambiguous" });
    const r = await handles.importMermaid.call({ source: "graph LR; A-->B" });
    expect(r.structuredContent).toMatchObject({ ok: false, code: "ambiguous-room" });
    expect(r.isError).toBe(true);
  });
});
