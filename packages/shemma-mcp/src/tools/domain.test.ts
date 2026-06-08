import { afterEach, describe, expect, it } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "@shemma/client";
import { AutoOpenManager } from "../auto-open";
import { RoomResolver } from "../room-resolver";
import type { ResolveSpaceFn } from "../space-resolver";
import { registerDomainTools } from "./domain";

const fakeSpaceRecord = {
  id: "test-space",
  path: "/tmp/test-space",
  storageLayout: "project" as const,
  createdAt: "2026-01-01T00:00:00Z",
  lastUsedAt: "2026-01-01T00:00:00Z",
};

// DRW-116 Task 26: stub resolveSpace so the registry is not consulted during
// unit tests — explicit id passes through; otherwise default to the fake.
const fakeResolveSpace: ResolveSpaceFn = ({ space }) => {
  if (space) return { space: { ...fakeSpaceRecord, id: space }, source: "explicit" };
  return { space: fakeSpaceRecord, source: "default" };
};

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
  const handles = registerDomainTools(server, {
    client,
    resolver,
    resolveSpace: fakeResolveSpace,
  });
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
  const handles = registerDomainTools(server, {
    client,
    resolver,
    autoOpen: auto,
    resolveSpace: fakeResolveSpace,
  });
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

  // DRW-221: the daemon ANSWERED with an error — must NOT be conflated with a
  // transport failure (`daemon-unavailable`). A plain-text 500 maps to
  // `unexpected-error` (with status), a 422 to `validation-error` (with status).
  it("HTTP 500 (non-JSON body) → unexpected-error with status, not daemon-unavailable", async () => {
    globalThis.fetch = (async () =>
      new Response("Internal Server Error", {
        status: 500,
        headers: { "content-type": "text/plain" },
      })) as typeof fetch;
    const { handles } = setup({ mode: "direct", room: "r" });
    const r = await handles.define.call({ name: "x", role: "actor", clientOpId: "op-500" });
    expect(r.structuredContent).toMatchObject({
      ok: false,
      code: "unexpected-error",
      status: 500,
      clientOpId: "op-500",
    });
    expect(r.isError).toBe(true);
  });

  it("HTTP 422 (backend rejected) → validation-error with status", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, errors: [{ msg: "bad" }] }), {
        status: 422,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const { handles } = setup({ mode: "direct", room: "r" });
    const r = await handles.define.call({ name: "x", role: "actor", clientOpId: "op-422" });
    expect(r.structuredContent).toMatchObject({
      ok: false,
      code: "validation-error",
      status: 422,
      clientOpId: "op-422",
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

  // DRW-116 Task 26: space arg threads through to CanvasClient → URL query.
  it("shemma_define threads explicit space into URL query", async () => {
    let capturedUrl = "";
    mockFetch((url) => {
      capturedUrl = url;
      return { body: okDomainResponse };
    });
    const { handles } = setup({ mode: "direct", room: "r" });
    await handles.define.call({ name: "svc", role: "service", space: "my-project" });
    expect(capturedUrl).toContain("space=my-project");
  });

  it("shemma_define falls back to resolved default space when none provided", async () => {
    let capturedUrl = "";
    mockFetch((url) => {
      capturedUrl = url;
      return { body: okDomainResponse };
    });
    const { handles } = setup({ mode: "direct", room: "r" });
    await handles.define.call({ name: "svc", role: "service" });
    expect(capturedUrl).toContain("space=test-space");
  });

  it("shemma_define returns ambiguous-space when resolver fails", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    const client = new CanvasClient({ baseUrl: "http://test" });
    const resolver = new RoomResolver({
      configRoom: "r",
      sessionEnv: undefined,
      getActiveRooms: async () => ({ rooms: [] }),
      getInProgressTasks: async () => [],
    });
    const ambiguousResolveSpace: ResolveSpaceFn = () => ({
      space: undefined,
      source: "ambiguous",
      error: "space_ambiguous: no spaces registered.",
    });
    const handles = registerDomainTools(server, {
      client,
      resolver,
      resolveSpace: ambiguousResolveSpace,
    });
    const r = await handles.define.call({ name: "svc", role: "service" });
    expect(r.structuredContent).toMatchObject({
      ok: false,
      code: "ambiguous-space",
    });
    expect(r.isError).toBe(true);
  });

  it("shemma_define returns space-not-found when explicit space unknown", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    const client = new CanvasClient({ baseUrl: "http://test" });
    const resolver = new RoomResolver({
      configRoom: "r",
      sessionEnv: undefined,
      getActiveRooms: async () => ({ rooms: [] }),
      getInProgressTasks: async () => [],
    });
    const notFoundResolveSpace: ResolveSpaceFn = () => ({
      space: undefined,
      source: "not_found",
      error: "space_not_found: foo",
    });
    const handles = registerDomainTools(server, {
      client,
      resolver,
      resolveSpace: notFoundResolveSpace,
    });
    const r = await handles.define.call({ name: "svc", role: "service", space: "foo" });
    expect(r.structuredContent).toMatchObject({
      ok: false,
      code: "space-not-found",
    });
    expect(r.isError).toBe(true);
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

  it("importMermaid surfaces room_url on 503 no-client-connected", async () => {
    mockFetch(() => ({
      body: { error: "no client connected", room_url: "http://127.0.0.1:8787/?room=r" },
      status: 503,
    }));
    const { handles } = setup({ mode: "direct", room: "r" });
    const r = await handles.importMermaid.call({ source: "graph LR; A-->B" });
    expect(r.structuredContent).toMatchObject({
      ok: false,
      code: "no-client-connected",
      details: { room_url: "http://127.0.0.1:8787/?room=r" },
    });
    // The user-visible message should include the URL so the AI agent can act on it.
    const sc = r.structuredContent as { message: string };
    expect(sc.message).toContain("http://127.0.0.1:8787/?room=r");
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

  // DRW-086: focus parameter wire-up through MCP → backend
  it("importMermaid forwards focus='new' to POST body (DRW-086)", async () => {
    let capturedBody: unknown;
    mockFetch((_, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return { body: { ok: true, shape_ids: ["s1"], didraw_names: ["a"], root_ids: ["s1"] } };
    });
    const { handles } = setup({ mode: "direct", room: "test-room" });
    await handles.importMermaid.call({ source: "graph LR; A-->B", focus: "new" });
    expect((capturedBody as Record<string, unknown>).focus).toBe("new");
  });

  it("importMermaid forwards focus='fit-all' to POST body (DRW-086)", async () => {
    let capturedBody: unknown;
    mockFetch((_, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return { body: { ok: true, shape_ids: ["s1"], didraw_names: ["a"], root_ids: ["s1"] } };
    });
    const { handles } = setup({ mode: "direct", room: "test-room" });
    await handles.importMermaid.call({ source: "graph LR; A-->B", focus: "fit-all" });
    expect((capturedBody as Record<string, unknown>).focus).toBe("fit-all");
  });

  it("importMermaid forwards focus='none' to POST body (DRW-086)", async () => {
    let capturedBody: unknown;
    mockFetch((_, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return { body: { ok: true, shape_ids: ["s1"], didraw_names: ["a"], root_ids: ["s1"] } };
    });
    const { handles } = setup({ mode: "direct", room: "test-room" });
    await handles.importMermaid.call({ source: "graph LR; A-->B", focus: "none" });
    expect((capturedBody as Record<string, unknown>).focus).toBe("none");
  });

  it("importMermaid omits focus from body when not provided (DRW-086)", async () => {
    let capturedBody: unknown;
    mockFetch((_, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return { body: { ok: true, shape_ids: ["s1"], didraw_names: ["a"], root_ids: ["s1"] } };
    });
    const { handles } = setup({ mode: "direct", room: "test-room" });
    await handles.importMermaid.call({ source: "graph LR; A-->B" });
    expect((capturedBody as Record<string, unknown>).focus).toBeUndefined();
  });
});

describe("shemma_import_mermaid mode param (DRW-127)", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // mode:"storage" → calls POST /api/schema/create, returns frameId+nodeIds envelope
  it("mode:storage calls createSchema and returns frameId+nodeIds envelope", async () => {
    let capturedUrl = "";
    let capturedBody: unknown;
    mockFetch((url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init?.body as string);
      return {
        body: { ok: true, frameId: "frame-1", nodeIds: ["n1", "n2"], version: 3 },
      };
    });
    const { handles } = setup({ mode: "direct", room: "test-room" });
    const r = await handles.importMermaid.call({
      source: "graph LR\n  A-->B",
      mode: "storage",
    });
    expect(capturedUrl).toContain("/api/schema/create");
    expect(capturedUrl).toContain("room=test-room");
    expect((capturedBody as { raw: string }).raw).toBe("graph LR\n  A-->B");
    expect(r.structuredContent).toMatchObject({
      ok: true,
      room: "test-room",
      frameId: "frame-1",
      nodeIds: ["n1", "n2"],
      root_ids: ["frame-1"],
    });
    expect(r.isError).toBeUndefined();
  });

  // mode:"storage" — label is auto-derived from %% comment on first matching line
  it("mode:storage derives label from %% comment in mermaid source", async () => {
    let capturedBody: unknown;
    mockFetch((_, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return { body: { ok: true, frameId: "f2", nodeIds: [], version: 1 } };
    });
    const { handles } = setup({ mode: "direct", room: "r" });
    await handles.importMermaid.call({
      source: "graph LR\n%% My Diagram\n  A-->B",
      mode: "storage",
    });
    expect((capturedBody as { label: string }).label).toBe("My Diagram");
  });

  // mode:"storage" — fallback label when no comment present
  it("mode:storage falls back to 'Imported schema' when no label in source", async () => {
    let capturedBody: unknown;
    mockFetch((_, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return { body: { ok: true, frameId: "f3", nodeIds: [], version: 1 } };
    });
    const { handles } = setup({ mode: "direct", room: "r" });
    await handles.importMermaid.call({
      source: "graph LR\n  A-->B",
      mode: "storage",
    });
    expect((capturedBody as { label: string }).label).toBe("Imported schema");
  });

  // mode:"browser" (explicit) → uses existing WS path (/api/agent/import-mermaid)
  it("mode:browser calls /api/agent/import-mermaid (WS path)", async () => {
    let capturedUrl = "";
    mockFetch((url) => {
      capturedUrl = url;
      return { body: { ok: true, shape_ids: ["s1"], didraw_names: ["a"], root_ids: ["s1"] } };
    });
    const { handles } = setup({ mode: "direct", room: "r" });
    const r = await handles.importMermaid.call({
      source: "graph LR\n  A-->B",
      mode: "browser",
    });
    expect(capturedUrl).toContain("/api/agent/import-mermaid");
    expect(r.structuredContent).toMatchObject({ ok: true, shape_ids: ["s1"] });
    expect(r.isError).toBeUndefined();
  });

  // mode undefined (default) → browser behavior (backward compat)
  it("default mode (undefined) → browser path, same as mode:browser", async () => {
    let capturedUrl = "";
    mockFetch((url) => {
      capturedUrl = url;
      return { body: { ok: true, shape_ids: ["s2"], didraw_names: ["b"], root_ids: ["s2"] } };
    });
    const { handles } = setup({ mode: "direct", room: "r" });
    const r = await handles.importMermaid.call({ source: "graph LR\n  A-->B" });
    expect(capturedUrl).toContain("/api/agent/import-mermaid");
    expect(r.structuredContent).toMatchObject({ ok: true });
    expect(r.isError).toBeUndefined();
  });

  // mode:"auto" → storage succeeds → done (browser NOT called)
  it("mode:auto tries storage first; succeeds → returns storage result", async () => {
    const calls: string[] = [];
    mockFetch((url) => {
      if (url.includes("/api/schema/create")) {
        calls.push("storage");
        return { body: { ok: true, frameId: "f4", nodeIds: ["n4"], version: 2 } };
      }
      calls.push("browser");
      return { body: { ok: true, shape_ids: ["s4"], didraw_names: ["d"], root_ids: ["s4"] } };
    });
    const { handles } = setup({ mode: "direct", room: "r" });
    const r = await handles.importMermaid.call({
      source: "graph LR\n  A-->B",
      mode: "auto",
    });
    expect(calls).toEqual(["storage"]);
    expect(r.structuredContent).toMatchObject({ ok: true, frameId: "f4" });
  });

  // mode:"auto" → storage fails → fallback to browser
  it("mode:auto falls back to browser when storage fails", async () => {
    const calls: string[] = [];
    mockFetch((url) => {
      if (url.includes("/api/schema/create")) {
        calls.push("storage");
        return {
          body: { ok: false, errors: [{ code: "unsupported-diagram-type", message: "unsupported" }] },
        };
      }
      calls.push("browser");
      return { body: { ok: true, shape_ids: ["s5"], didraw_names: ["e"], root_ids: ["s5"] } };
    });
    const { handles } = setup({ mode: "direct", room: "r" });
    const r = await handles.importMermaid.call({
      source: "sequenceDiagram\n  A->>B: Hello",
      mode: "auto",
    });
    expect(calls).toEqual(["storage", "browser"]);
    expect(r.structuredContent).toMatchObject({ ok: true, shape_ids: ["s5"] });
  });

  // mode:"auto" → storage throws (network error) → fallback to browser
  it("mode:auto falls back to browser when storage throws network error", async () => {
    let callCount = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url.toString();
      callCount++;
      if (u.includes("/api/schema/create")) {
        throw new Error("ECONNREFUSED");
      }
      return new Response(
        JSON.stringify({ ok: true, shape_ids: ["s6"], didraw_names: ["f"], root_ids: ["s6"] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const { handles } = setup({ mode: "direct", room: "r" });
    const r = await handles.importMermaid.call({
      source: "graph LR\n  A-->B",
      mode: "auto",
    });
    expect(callCount).toBe(2);
    expect(r.structuredContent).toMatchObject({ ok: true, shape_ids: ["s6"] });
  });

  // mode:"storage" → createSchema network error → daemon-unavailable
  it("mode:storage network error returns daemon-unavailable", async () => {
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
    const { handles } = setup({ mode: "direct", room: "r" });
    const r = await handles.importMermaid.call({
      source: "graph LR\n  A-->B",
      mode: "storage",
    });
    expect(r.structuredContent).toMatchObject({ ok: false, code: "daemon-unavailable" });
    expect(r.isError).toBe(true);
  });

  // mode:"storage" → ok:false from backend → import-failed with errors
  it("mode:storage backend error returns import-failed", async () => {
    mockFetch(() => ({
      body: { ok: false, errors: [{ code: "unsupported-diagram-type", message: "not a flowchart" }] },
    }));
    const { handles } = setup({ mode: "direct", room: "r" });
    const r = await handles.importMermaid.call({
      source: "sequenceDiagram\n  A->>B: hi",
      mode: "storage",
    });
    expect(r.structuredContent).toMatchObject({
      ok: false,
      code: "import-failed",
      message: "not a flowchart",
    });
    expect(r.isError).toBe(true);
  });
});

describe("shemma_layout_selection tool (DRW-088)", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("registers shemma_layout_selection tool without throwing", () => {
    expect(() => setup()).not.toThrow();
  });

  it("layoutSelection calls POST /api/agent/layout-selection with ids", async () => {
    let capturedUrl = "";
    let capturedBody: unknown;
    mockFetch((url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init?.body as string);
      return { body: { ok: true, version: 3, count: 2, affected: ["shape:a", "shape:b"] } };
    });
    const { handles } = setup({ mode: "direct", room: "r1" });
    const r = await handles.layoutSelection.call({
      ids: ["shape:a", "shape:b"],
      mode: "layered-tb",
    });
    expect(capturedUrl).toContain("/api/agent/layout-selection");
    expect(capturedUrl).toContain("room=r1");
    expect((capturedBody as { ids: string[] }).ids).toEqual(["shape:a", "shape:b"]);
    expect((capturedBody as { mode: string }).mode).toBe("layered-tb");
    expect(r.structuredContent).toMatchObject({
      ok: true,
      room: "r1",
      version: 3,
      count: 2,
    });
    expect(r.isError).toBeUndefined();
  });

  it("layoutSelection with empty ids → ok:true, count:0, hint", async () => {
    mockFetch(() => ({
      body: { ok: true, count: 0, hint: "no shapes selected" },
    }));
    const { handles } = setup({ mode: "direct", room: "r" });
    const r = await handles.layoutSelection.call({ ids: [] });
    expect(r.structuredContent).toMatchObject({ ok: true, count: 0 });
  });

  it("layoutSelection delegates full canvas layout when ids omitted", async () => {
    let capturedBody: unknown;
    mockFetch((_, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return { body: { ok: true, count: 0, hint: "no shapes selected" } };
    });
    const { handles } = setup({ mode: "direct", room: "r" });
    await handles.layoutSelection.call({});
    // Empty ids when none provided
    expect((capturedBody as { ids: unknown[] }).ids).toEqual([]);
  });

  it("layoutSelection with ambiguous resolver returns code:ambiguous-room", async () => {
    const { handles } = setup({ mode: "ambiguous" });
    const r = await handles.layoutSelection.call({ ids: ["a", "b"] });
    expect(r.structuredContent).toMatchObject({ ok: false, code: "ambiguous-room" });
    expect(r.isError).toBe(true);
  });

  it("layoutSelection network error returns daemon-unavailable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const { handles } = setup({ mode: "direct", room: "r" });
    const r = await handles.layoutSelection.call({ ids: ["a", "b"] });
    expect(r.structuredContent).toMatchObject({ ok: false, code: "daemon-unavailable" });
    expect(r.isError).toBe(true);
  });

  it("layoutSelection forwards spacing param", async () => {
    let capturedBody: unknown;
    mockFetch((_, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return { body: { ok: true, count: 0 } };
    });
    const { handles } = setup({ mode: "direct", room: "r" });
    await handles.layoutSelection.call({ ids: ["a", "b"], spacing: "compact" });
    expect((capturedBody as { spacing: string }).spacing).toBe("compact");
  });
});
