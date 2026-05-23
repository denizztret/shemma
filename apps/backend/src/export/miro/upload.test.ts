import { describe, expect, it } from "bun:test";
import { makeRoomState } from "../../rooms";
import { MiroClient } from "./client";
import { framesInDepthFirstOrder, runMiroExport } from "./upload";
import type { RawShape } from "./coords";

/**
 * Start a Bun.serve mock that mimics Miro v2 bulk + connectors endpoints.
 * Returns the recorded request log + ephemeral baseUrl.
 */
function startMockMiro(opts: {
  bulkResponder?: (items: unknown[]) => unknown[];
  connectorResponder?: (body: unknown) => unknown;
  groupResponder?: (body: unknown) => unknown;
  rateLimitFirstN?: number;
} = {}) {
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  let rlCount = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = req.body ? await req.json().catch(() => null) : null;
      requests.push({ path: url.pathname, method: req.method, body });
      if (opts.rateLimitFirstN && rlCount < opts.rateLimitFirstN) {
        rlCount += 1;
        return new Response("{}", { status: 429 });
      }
      if (url.pathname.endsWith("/items/bulk")) {
        const items = body as unknown[];
        const responder = opts.bulkResponder ?? ((arr) => arr.map((_, i) => ({ id: `m-${requests.length}-${i}` })));
        return new Response(JSON.stringify({ data: responder(items) }), { status: 201 });
      }
      if (url.pathname.endsWith("/connectors")) {
        const responder = opts.connectorResponder ?? ((_b) => ({ id: `c-${requests.length}` }));
        return new Response(JSON.stringify(responder(body)), { status: 201 });
      }
      if (url.pathname.endsWith("/groups")) {
        const responder = opts.groupResponder ?? ((_b) => ({ id: `g-${requests.length}`, type: "group", data: {}, links: {} }));
        return new Response(JSON.stringify(responder(body)), { status: 201 });
      }
      return new Response("{}", { status: 200 });
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    stop: () => server.stop(true),
    requests,
  };
}

function geoShape(id: string, x: number, y: number, w = 100, h = 50): RawShape {
  return {
    id, typeName: "shape", type: "geo", x, y,
    parentId: "page:page",
    props: { w, h, geo: "rectangle", richText: null },
  };
}

function frameShape(id: string, x: number, y: number, w = 400, h = 300, name = "F"): RawShape {
  return {
    id, typeName: "shape", type: "frame", x, y,
    parentId: "page:page",
    props: { w, h, name },
  };
}

function arrowShape(id: string, fromId: string, toId: string, anchorIn = { x: 0.9, y: 0.5 }, anchorOut = { x: 0.1, y: 0.5 }): RawShape[] {
  return [
    { id, typeName: "shape", type: "arrow", parentId: "page:page", props: { bend: 0, richText: null } },
    { id: `binding:${id}-s`, typeName: "binding", type: "arrow", fromId: id, toId: fromId, props: { terminal: "start", normalizedAnchor: anchorIn } } as unknown as RawShape,
    { id: `binding:${id}-e`, typeName: "binding", type: "arrow", fromId: id, toId: toId, props: { terminal: "end", normalizedAnchor: anchorOut } } as unknown as RawShape,
  ];
}

describe("runMiroExport — happy path (5 shapes + 3 connectors, no frame)", () => {
  it("Pass A1 skipped, A2 creates 5 shapes, B creates 3 connectors", async () => {
    const mock = startMockMiro();
    try {
      const room = makeRoomState();
      const store = room.store.store as Record<string, RawShape>;
      ["a", "b", "c", "d", "e"].forEach((c, i) => (store[`shape:${c}`] = geoShape(`shape:${c}`, i * 200, 0)));
      [...arrowShape("shape:ab", "shape:a", "shape:b"),
       ...arrowShape("shape:cd", "shape:c", "shape:d"),
       ...arrowShape("shape:de", "shape:d", "shape:e")].forEach((r) => { store[r.id] = r; });

      const client = new MiroClient({ token: "t", baseUrl: mock.url });
      const result = await runMiroExport({
        client,
        room,
        boardId: "B1",
        selection: ["shape:a", "shape:b", "shape:c", "shape:d", "shape:e", "shape:ab", "shape:cd", "shape:de"],
      });

      expect(result.itemsCreated).toBe(5);
      expect(result.connectorsCreated).toBe(3);
      expect(result.skipped).toEqual([]);

      const bulkCalls = mock.requests.filter((r) => r.path.endsWith("/items/bulk"));
      const connectorCalls = mock.requests.filter((r) => r.path.endsWith("/connectors"));
      expect(bulkCalls).toHaveLength(1); // single A2 bulk (no frames → A1 skipped)
      expect(connectorCalls).toHaveLength(3);
    } finally {
      mock.stop();
    }
  });
});

describe("runMiroExport — Pass A1 / A2 split with frame + children", () => {
  it("creates frame-as-shape in A1, children in A2", async () => {
    const mock = startMockMiro();
    try {
      const room = makeRoomState();
      const store = room.store.store as Record<string, RawShape>;
      store["shape:F"] = frameShape("shape:F", 100, 100, 400, 300, "Frame");
      store["shape:child1"] = { ...geoShape("shape:child1", 10, 10), parentId: "shape:F" };
      store["shape:child2"] = { ...geoShape("shape:child2", 60, 60), parentId: "shape:F" };

      const client = new MiroClient({ token: "t", baseUrl: mock.url });
      const result = await runMiroExport({
        client, room, boardId: "B1",
        selection: ["shape:F", "shape:child1", "shape:child2"],
      });

      const bulkCalls = mock.requests.filter((r) => r.path.endsWith("/items/bulk"));
      expect(bulkCalls).toHaveLength(2); // A1 (frame-as-shape) + A2 (children)

      const a1Body = bulkCalls[0].body as Array<{ type: string; data?: { shape?: string } }>;
      // Frame is now exported as a rectangle shape, not a Miro frame widget
      expect(a1Body.every((it) => it.type === "shape")).toBe(true);
      expect(a1Body.every((it) => it.data?.shape === "rectangle")).toBe(true);
      const a2Body = bulkCalls[1].body as Array<{ type: string }>;
      expect(a2Body.every((it) => it.type !== "frame")).toBe(true);

      expect(result.itemsCreated).toBe(3); // 1 frame-as-shape + 2 children
    } finally {
      mock.stop();
    }
  });
});

describe("runMiroExport — frame children auto-expansion (DRW-105)", () => {
  it("frame in selection without children → children walked in + exported", async () => {
    const mock = startMockMiro();
    try {
      const room = makeRoomState();
      const store = room.store.store as Record<string, RawShape>;
      store["shape:F"] = frameShape("shape:F", 100, 100, 400, 300, "Frame");
      store["shape:c1"] = { ...geoShape("shape:c1", 10, 10), parentId: "shape:F" };
      store["shape:c2"] = { ...geoShape("shape:c2", 60, 60), parentId: "shape:F" };

      const client = new MiroClient({ token: "t", baseUrl: mock.url });
      const result = await runMiroExport({
        client, room, boardId: "B1",
        selection: ["shape:F"], // ONLY the frame; children excluded by tldraw mutex
      });

      expect(result.itemsCreated).toBe(3); // frame + 2 expanded children
      expect(result.skipped).toEqual([]);
    } finally {
      mock.stop();
    }
  });

  it("frame in selection without arrow between children → arrow auto-included", async () => {
    const mock = startMockMiro();
    try {
      const room = makeRoomState();
      const store = room.store.store as Record<string, RawShape>;
      store["shape:F"] = frameShape("shape:F", 100, 100, 400, 300, "Frame");
      store["shape:c1"] = { ...geoShape("shape:c1", 10, 10), parentId: "shape:F" };
      store["shape:c2"] = { ...geoShape("shape:c2", 60, 60), parentId: "shape:F" };
      arrowShape("shape:arr", "shape:c1", "shape:c2").forEach((r) => { store[r.id] = r; });

      const client = new MiroClient({ token: "t", baseUrl: mock.url });
      const result = await runMiroExport({
        client, room, boardId: "B1",
        selection: ["shape:F"], // frame only — children + arrow excluded by tldraw mutex
      });

      expect(result.itemsCreated).toBe(3); // frame + 2 children
      expect(result.connectorsCreated).toBe(1); // arrow between children auto-included
      expect(result.skipped).toEqual([]);
    } finally {
      mock.stop();
    }
  });

  it("nested frames: descendants walked recursively", async () => {
    const mock = startMockMiro();
    try {
      const room = makeRoomState();
      const store = room.store.store as Record<string, RawShape>;
      store["shape:outer"] = frameShape("shape:outer", 0, 0, 600, 400, "Outer");
      store["shape:inner"] = {
        ...frameShape("shape:inner", 50, 50, 300, 200, "Inner"),
        parentId: "shape:outer",
      };
      store["shape:leaf"] = { ...geoShape("shape:leaf", 10, 10), parentId: "shape:inner" };

      const client = new MiroClient({ token: "t", baseUrl: mock.url });
      const result = await runMiroExport({
        client, room, boardId: "B1",
        selection: ["shape:outer"],
      });

      expect(result.itemsCreated).toBe(3); // outer frame + inner frame + leaf
    } finally {
      mock.stop();
    }
  });
});

describe("runMiroExport — connector skipping", () => {
  it("free-floating arrow → skip with reason='unsupported-type'", async () => {
    const mock = startMockMiro();
    try {
      const room = makeRoomState();
      const store = room.store.store as Record<string, RawShape>;
      store["shape:a"] = geoShape("shape:a", 0, 0);
      store["shape:lone"] = { id: "shape:lone", typeName: "shape", type: "arrow", parentId: "page:page", props: {} };

      const client = new MiroClient({ token: "t", baseUrl: mock.url });
      const result = await runMiroExport({
        client, room, boardId: "B1",
        selection: ["shape:a", "shape:lone"],
      });
      expect(result.skipped).toEqual([{ elementId: "shape:lone", reason: "unsupported-type" }]);
      expect(result.connectorsCreated).toBe(0);
    } finally {
      mock.stop();
    }
  });

  it("cross-selection connector (endpoint outside selection) → skip", async () => {
    const mock = startMockMiro();
    try {
      const room = makeRoomState();
      const store = room.store.store as Record<string, RawShape>;
      store["shape:a"] = geoShape("shape:a", 0, 0);
      store["shape:b"] = geoShape("shape:b", 200, 0); // not in selection
      arrowShape("shape:arr", "shape:a", "shape:b").forEach((r) => { store[r.id] = r; });

      const client = new MiroClient({ token: "t", baseUrl: mock.url });
      const result = await runMiroExport({
        client, room, boardId: "B1",
        selection: ["shape:a", "shape:arr"], // shape:b excluded
      });
      expect(result.skipped).toContainEqual({ elementId: "shape:arr", reason: "cross-selection-connector" });
    } finally {
      mock.stop();
    }
  });
});

describe("runMiroExport — group selection expansion", () => {
  it("group with 3 children: group dropped, 3 shapes exported", async () => {
    const mock = startMockMiro();
    try {
      const room = makeRoomState();
      const store = room.store.store as Record<string, RawShape>;
      store["shape:g"] = { id: "shape:g", typeName: "shape", type: "group", parentId: "page:page", props: {} };
      ["c1", "c2", "c3"].forEach((c) => (store[`shape:${c}`] = { ...geoShape(`shape:${c}`, 0, 0), parentId: "shape:g" }));

      const client = new MiroClient({ token: "t", baseUrl: mock.url });
      const result = await runMiroExport({
        client, room, boardId: "B1",
        selection: ["shape:g"],
      });
      expect(result.itemsCreated).toBe(3);
    } finally {
      mock.stop();
    }
  });
});

describe("runMiroExport — tracking persistence", () => {
  it("writes room.meta.miroExports after Pass A2 + Pass B, fires onCommit", async () => {
    const mock = startMockMiro();
    try {
      const room = makeRoomState();
      const store = room.store.store as Record<string, RawShape>;
      store["shape:a"] = geoShape("shape:a", 0, 0);
      store["shape:b"] = geoShape("shape:b", 200, 0);
      arrowShape("shape:ab", "shape:a", "shape:b").forEach((r) => { store[r.id] = r; });

      const client = new MiroClient({ token: "t", baseUrl: mock.url });
      const commitCalls: number[] = [];
      await runMiroExport({
        client, room, boardId: "B1", boardName: "B One",
        selection: ["shape:a", "shape:b", "shape:ab"],
        onCommit: () => commitCalls.push(Date.now()),
      });
      const tracking = room.meta?.miroExports?.["B1"];
      expect(tracking?.boardName).toBe("B One");
      expect(Object.keys(tracking?.items ?? {})).toEqual(expect.arrayContaining(["shape:a", "shape:b"]));
      expect(Object.keys(tracking?.connectors ?? {})).toEqual(["shape:ab"]);
      // onCommit must fire after each commitBoardExport call: A2 chunk (1) + Pass B (1) = 2.
      // (No frames → A1 skipped, single A2 chunk for 2 items.)
      expect(commitCalls.length).toBe(2);
    } finally {
      mock.stop();
    }
  });

  it("fires onCommit after A1, every A2 chunk, Pass B, and Pass C", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        const body = req.body ? await req.json().catch(() => null) : null;
        if (url.pathname.endsWith("/items/bulk")) {
          const items = body as unknown[];
          return new Response(JSON.stringify({ data: items.map((_, i) => ({ id: `m-${i}` })) }), { status: 201 });
        }
        if (url.pathname.endsWith("/connectors")) {
          return new Response(JSON.stringify({ id: `c-1` }), { status: 201 });
        }
        if (url.pathname.endsWith("/groups")) {
          return new Response(JSON.stringify({ id: "g-1", type: "group", data: {}, links: {} }), { status: 201 });
        }
        return new Response("{}", { status: 200 });
      },
    });
    try {
      const room = makeRoomState();
      const store = room.store.store as Record<string, RawShape>;
      store["shape:F"] = frameShape("shape:F", 0, 0);
      store["shape:c1"] = { ...geoShape("shape:c1", 10, 10), parentId: "shape:F" };
      store["shape:c2"] = { ...geoShape("shape:c2", 60, 60), parentId: "shape:F" };
      arrowShape("shape:arr", "shape:c1", "shape:c2").forEach((r) => { store[r.id] = r; });

      const client = new MiroClient({ token: "t", baseUrl: `http://localhost:${server.port}` });
      let commitCount = 0;
      await runMiroExport({
        client, room, boardId: "B1",
        selection: ["shape:F", "shape:c1", "shape:c2", "shape:arr"],
        onCommit: () => { commitCount += 1; },
      });
      // A1 (1) + A2 chunk (1) + Pass B (1) + Pass C group (1) = 4.
      expect(commitCount).toBe(4);
    } finally {
      server.stop(true);
    }
  });
});

describe("runMiroExport — Pass A2 validation errors → per-chunk skip", () => {
  it("chunk that returns 422 → items skipped with reason='validation-error', other chunks proceed", async () => {
    // Mock: first A2 chunk fails 422, second succeeds. Forces BULK_CHUNK_SIZE
    // via injecting 51 items so we get 2 chunks.
    let bulkCount = 0;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/items/bulk")) {
          bulkCount += 1;
          const items = (await req.json()) as Array<{ type: string }>;
          if (bulkCount === 1) {
            return new Response("{\"message\":\"validation\"}", { status: 422 });
          }
          return new Response(
            JSON.stringify({ data: items.map((_, i) => ({ id: `m-${bulkCount}-${i}` })) }),
            { status: 201 },
          );
        }
        return new Response("{}", { status: 200 });
      },
    });
    try {
      const room = makeRoomState();
      const store = room.store.store as Record<string, RawShape>;
      const ids: string[] = [];
      // 21 leaf shapes → 2 chunks (20 + 1) when BULK_CHUNK_SIZE = 20.
      for (let i = 0; i < 21; i += 1) {
        const id = `shape:i${i}`;
        store[id] = geoShape(id, i * 10, 0);
        ids.push(id);
      }

      const client = new MiroClient({ token: "t", baseUrl: `http://localhost:${server.port}` });
      const result = await runMiroExport({
        client, room, boardId: "B1",
        selection: ids,
      });

      // First chunk: 20 items skipped with validation-error.
      const skippedValidation = result.skipped.filter((s) => s.reason === "validation-error");
      expect(skippedValidation.length).toBe(20);
      // Second chunk: 1 item created.
      expect(result.itemsCreated).toBe(1);
      expect(result.error).toMatch(/pass-a2 validation errors/);
    } finally {
      server.stop(true);
    }
  });
});

describe("runMiroExport — partial commit when Pass A2 fatally aborts", () => {
  it("A1 succeeds, A2 401 (fatal) → tracking + onCommit fired for frames only", async () => {
    let bulkCount = 0;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/items/bulk")) {
          bulkCount += 1;
          const items = (await req.json()) as Array<{ type: string }>;
          if (bulkCount === 1) {
            return new Response(JSON.stringify({ data: items.map((_, i) => ({ id: `f-${i}` })) }), { status: 201 });
          }
          return new Response("{\"message\":\"unauthorized\"}", { status: 401 });
        }
        return new Response("{}", { status: 200 });
      },
    });
    try {
      const room = makeRoomState();
      const store = room.store.store as Record<string, RawShape>;
      store["shape:F"] = frameShape("shape:F", 0, 0);
      store["shape:c"] = { ...geoShape("shape:c", 10, 10), parentId: "shape:F" };

      const client = new MiroClient({ token: "t", baseUrl: `http://localhost:${server.port}` });
      const commitSnapshots: number[] = [];
      const result = await runMiroExport({
        client, room, boardId: "B1",
        selection: ["shape:F", "shape:c"],
        onCommit: (r) => {
          // Snapshot how many items are tracked at each commit point.
          commitSnapshots.push(Object.keys(r.meta?.miroExports?.["B1"]?.items ?? {}).length);
        },
      });
      expect(result.error).toBeDefined();
      // A1 committed (frame tracked) BEFORE A2 abort — partial-commit invariant.
      expect(room.meta?.miroExports?.["B1"]?.items?.["shape:F"]).toBeDefined();
      expect(room.meta?.miroExports?.["B1"]?.items?.["shape:c"]).toBeUndefined();
      // onCommit fired exactly once (after A1, before A2 aborted).
      expect(commitSnapshots).toEqual([1]);
    } finally {
      server.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Task 12: Pass A2 does NOT pass parent.id (DRW-111)
// ---------------------------------------------------------------------------

describe("runMiroExport — Pass A2 не передаёт parent.id (DRW-111)", () => {
  it("child of frame in A2: payload has no parent field", async () => {
    const mock = startMockMiro();
    try {
      const room = makeRoomState();
      const store = room.store.store as Record<string, RawShape>;
      store["shape:F"] = frameShape("shape:F", 0, 0, 200, 200, "Frame");
      store["shape:S1"] = { ...geoShape("shape:S1", 50, 50, 50, 50), parentId: "shape:F" };

      const client = new MiroClient({ token: "t", baseUrl: mock.url });
      await runMiroExport({
        client, room, boardId: "B1",
        selection: ["shape:F", "shape:S1"],
      });

      const bulkCalls = mock.requests.filter((r) => r.path.endsWith("/items/bulk"));
      expect(bulkCalls).toHaveLength(2); // A1 (frame) + A2 (child)

      const a2Body = bulkCalls[1].body as Array<{ parent?: unknown }>;
      expect(a2Body).toHaveLength(1);
      expect(a2Body[0].parent).toBeUndefined();
    } finally {
      mock.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Task 16: Pass C — group widget (DRW-111)
// ---------------------------------------------------------------------------

describe("Pass C — group widget (DRW-111)", () => {
  it("single frame + 2 children → 1 createGroup call with [frame_rect, c1, c2]", async () => {
    const groupCalls: Array<{ boardId: string; itemIds: string[] }> = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        const body = req.body ? await req.json().catch(() => null) : null;
        if (url.pathname.endsWith("/items/bulk")) {
          const items = body as unknown[];
          return new Response(JSON.stringify({ data: items.map((_, i) => ({ id: `m-${i}` })) }), { status: 201 });
        }
        if (url.pathname.endsWith("/groups")) {
          const { data } = body as { data: { items: string[] } };
          groupCalls.push({ boardId: "B1", itemIds: data.items });
          return new Response(JSON.stringify({ id: "g_F1", type: "group", data: {}, links: {} }), { status: 201 });
        }
        return new Response("{}", { status: 200 });
      },
    });
    try {
      const room = makeRoomState();
      const store = room.store.store as Record<string, RawShape>;
      store["shape:F1"] = frameShape("shape:F1", 0, 0, 300, 200, "F1");
      store["shape:S1"] = { ...geoShape("shape:S1", 10, 10, 50, 50), parentId: "shape:F1" };
      store["shape:S2"] = { ...geoShape("shape:S2", 80, 10, 50, 50), parentId: "shape:F1" };

      const client = new MiroClient({ token: "t", baseUrl: `http://localhost:${server.port}` });
      await runMiroExport({ client, room, boardId: "B1", selection: ["shape:F1"] });

      expect(groupCalls).toHaveLength(1);
      // frame rect miroId is index 0 of A1 bulk → "m-0"; children S1→"m-0", S2→"m-1" in A2 bulk (req 2)
      // All 3 miro ids must be present in the group items array
      expect(groupCalls[0].itemIds).toHaveLength(3);
      expect(room.meta?.miroExports?.["B1"]?.groups?.["shape:F1"]).toBe("g_F1");
    } finally {
      server.stop(true);
    }
  });

  it("nested frames → 2 createGroup calls, outer is FLAT (no nested groupId)", async () => {
    const groupCalls: Array<{ itemIds: string[] }> = [];
    const groupCallIdx = { n: 0 };
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        const body = req.body ? await req.json().catch(() => null) : null;
        if (url.pathname.endsWith("/items/bulk")) {
          const items = body as unknown[];
          // Return sequential miroIds so we can track them
          return new Response(JSON.stringify({ data: items.map((_, i) => ({ id: `m-bulk${groupCalls.length}-${i}` })) }), { status: 201 });
        }
        if (url.pathname.endsWith("/groups")) {
          const { data } = body as { data: { items: string[] } };
          groupCalls.push({ itemIds: data.items });
          const gId = `g_${groupCallIdx.n++}`;
          return new Response(JSON.stringify({ id: gId, type: "group", data: {}, links: {} }), { status: 201 });
        }
        return new Response("{}", { status: 200 });
      },
    });
    try {
      const room = makeRoomState();
      const store = room.store.store as Record<string, RawShape>;
      // F1 ⊃ { F2 ⊃ { S2 }, S1 }
      store["shape:F1"] = frameShape("shape:F1", 0, 0, 400, 300, "F1");
      store["shape:F2"] = { ...frameShape("shape:F2", 50, 50, 200, 150, "F2"), parentId: "shape:F1" };
      store["shape:S1"] = { ...geoShape("shape:S1", 10, 10, 50, 50), parentId: "shape:F1" };
      store["shape:S2"] = { ...geoShape("shape:S2", 60, 60, 50, 50), parentId: "shape:F2" };

      const client = new MiroClient({ token: "t", baseUrl: `http://localhost:${server.port}` });
      await runMiroExport({ client, room, boardId: "B1", selection: ["shape:F1"] });

      expect(groupCalls).toHaveLength(2);

      // Inner group (F2) processed first (deepest-first): must contain [m_F2, m_S2]
      const innerItems = groupCalls[0].itemIds;
      expect(innerItems).toHaveLength(2);

      // Outer group (F1): flat list — must NOT contain any group id (g_0)
      const outerItems = groupCalls[1].itemIds;
      expect(outerItems).not.toContain("g_0");
      // Outer flat list: frame rect + ALL descendants (F2 rect + S1 + S2) = 4 items
      expect(outerItems).toHaveLength(4);

      expect(room.meta?.miroExports?.["B1"]?.groups?.["shape:F1"]).toBeDefined();
      expect(room.meta?.miroExports?.["B1"]?.groups?.["shape:F2"]).toBeDefined();
    } finally {
      server.stop(true);
    }
  });

  it("frame with 0 children → no createGroup call (skip when 0 descendants)", async () => {
    const groupCalls: number[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        const body = req.body ? await req.json().catch(() => null) : null;
        if (url.pathname.endsWith("/items/bulk")) {
          const items = body as unknown[];
          return new Response(JSON.stringify({ data: items.map((_, i) => ({ id: `m-${i}` })) }), { status: 201 });
        }
        if (url.pathname.endsWith("/groups")) {
          groupCalls.push(1);
          return new Response(JSON.stringify({ id: "g_x" }), { status: 201 });
        }
        return new Response("{}", { status: 200 });
      },
    });
    try {
      const room = makeRoomState();
      const store = room.store.store as Record<string, RawShape>;
      store["shape:F1"] = frameShape("shape:F1", 0, 0, 300, 200, "F1"); // no children

      const client = new MiroClient({ token: "t", baseUrl: `http://localhost:${server.port}` });
      await runMiroExport({ client, room, boardId: "B1", selection: ["shape:F1"] });

      expect(groupCalls).toHaveLength(0); // no group call
      expect(room.meta?.miroExports?.["B1"]?.groups?.["shape:F1"]).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  it("frame with 1 child → createGroup called (frame rect + 1 child = 2 items meets Miro min)", async () => {
    const groupCalls: Array<{ itemIds: string[] }> = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        const body = req.body ? await req.json().catch(() => null) : null;
        if (url.pathname.endsWith("/items/bulk")) {
          const items = body as unknown[];
          return new Response(JSON.stringify({ data: items.map((_, i) => ({ id: `m-${i}` })) }), { status: 201 });
        }
        if (url.pathname.endsWith("/groups")) {
          const { data } = body as { data: { items: string[] } };
          groupCalls.push({ itemIds: data.items });
          return new Response(JSON.stringify({ id: "g_F1" }), { status: 201 });
        }
        return new Response("{}", { status: 200 });
      },
    });
    try {
      const room = makeRoomState();
      const store = room.store.store as Record<string, RawShape>;
      store["shape:F1"] = frameShape("shape:F1", 0, 0, 300, 200, "F1");
      store["shape:S1"] = { ...geoShape("shape:S1", 10, 10, 50, 50), parentId: "shape:F1" };

      const client = new MiroClient({ token: "t", baseUrl: `http://localhost:${server.port}` });
      await runMiroExport({ client, room, boardId: "B1", selection: ["shape:F1"] });

      expect(groupCalls).toHaveLength(1); // frame + 1 child = 2 items, valid
      expect(groupCalls[0].itemIds).toHaveLength(2);
      expect(room.meta?.miroExports?.["B1"]?.groups?.["shape:F1"]).toBe("g_F1");
    } finally {
      server.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Task 11: framesInDepthFirstOrder (DRW-111)
// ---------------------------------------------------------------------------

describe("framesInDepthFirstOrder (DRW-111)", () => {
  it("returns frames outer-first → inner-last by parent depth", () => {
    const frames = [
      { id: "F2", parentId: "F1" },
      { id: "F1", parentId: undefined },
      { id: "F3", parentId: "F2" },
    ];
    const ordered = framesInDepthFirstOrder(frames);
    expect(ordered.map(f => f.id)).toEqual(["F1", "F2", "F3"]);
  });

  it("frames with parents outside set are treated as roots", () => {
    const frames = [
      { id: "F1", parentId: "page:p1" },  // page parent → depth 0
      { id: "F2", parentId: "F1" },
    ];
    const ordered = framesInDepthFirstOrder(frames);
    expect(ordered.map(f => f.id)).toEqual(["F1", "F2"]);
  });
});
