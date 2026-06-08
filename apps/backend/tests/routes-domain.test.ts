import { describe, expect, test } from "bun:test";
import { makeApp } from "../src/index";

async function postDomain(app: ReturnType<typeof makeApp>["app"], body: unknown, room = "d1") {
  return app.fetch(
    new Request(`http://localhost/api/domain?room=${room}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function shapes(state: { store: { store: Record<string, { typeName: string; type?: string }> } }) {
  return Object.values(state.store.store).filter((r) => r.typeName === "shape");
}

function shapesByType(
  state: { store: { store: Record<string, { typeName: string; type?: string }> } },
  type: string,
) {
  return shapes(state).filter((r) => (r as { type?: string }).type === type);
}

describe("POST /api/domain", () => {
  test("happy path: define + connect + group end-to-end (§5.1 worked example)", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const res = await postDomain(app, {
      actions: [
        { kind: "define", role: "service", name: "auth" },
        { kind: "define", role: "datastore", name: "users-db" },
        { kind: "connect", from: "auth", to: "users-db", connectionKind: "data" },
        { kind: "group", ids: ["auth", "users-db"], as: "network", name: "vpc-prod" },
      ],
      layoutHint: { mode: "layered-lr" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      version: number;
      results: Array<{ elementId?: string }>;
      layout: { applied: boolean };
    };
    expect(body.ok).toBe(true);
    expect(body.results.length).toBe(4);
    expect(body.results[0]?.elementId).toBe("auth");
    expect(body.results[1]?.elementId).toBe("users-db");
    expect(body.results[3]?.elementId).toBe("vpc-prod");

    const r = await rooms.get("d1");
    expect(shapesByType(r, "geo").length).toBe(2);
    expect(shapesByType(r, "arrow").length).toBe(1);
    expect(shapesByType(r, "frame").length).toBe(1);
  });

  test("invalid action → 422 with errors, state untouched", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const res = await postDomain(app, {
      actions: [
        { kind: "define", role: "service", name: "ok" },
        { kind: "connect", from: "ok", to: "nope" },
      ],
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { ok: boolean; errors: Array<{ code: string }> };
    expect(body.ok).toBe(false);
    expect(body.errors[0]?.code).toBe("unknown-ref");

    const r = await rooms.get("d1");
    expect(shapesByType(r, "geo").length).toBe(0);
  });

  test("dryRun:true — no state change, generatedOps populated", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const res = await postDomain(app, {
      actions: [{ kind: "define", role: "service", name: "preview" }],
      dryRun: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      results: Array<{ generatedOps?: { added: Record<string, unknown> } }>;
      version: number;
    };
    expect(body.ok).toBe(true);
    expect(body.results[0]?.generatedOps).toBeDefined();
    const added = body.results[0]?.generatedOps?.added ?? {};
    expect(Object.keys(added).length).toBeGreaterThan(0);

    const r = await rooms.get("d1");
    expect(shapesByType(r, "geo").length).toBe(0);
    expect(body.version).toBe(r.version);
  });

  test("idempotency — repeated clientOpId returns cached result", async () => {
    const { app } = makeApp({ inMemory: true });
    const req = {
      actions: [{ kind: "define", role: "service", name: "once" }],
      clientOpId: "abc-123",
    };
    const r1 = await postDomain(app, req);
    const b1 = (await r1.json()) as { version: number };
    const r2 = await postDomain(app, req);
    const b2 = (await r2.json()) as { version: number; idempotent?: true };
    expect(b1.version).toBe(b2.version);
    expect(b2.idempotent).toBe(true);
  });

  test("idempotency cache evicts oldest entries past max (LRU bound)", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const MAX = 1000;
    // Send MAX+1 unique-clientOpId domain requests; each defines a distinct node.
    for (let i = 0; i <= MAX; i++) {
      const r = await postDomain(app, {
        actions: [{ kind: "define", role: "service", name: `n${i}` }],
        clientOpId: `op-${i}`,
        layoutHint: null,
      });
      expect(r.status).toBe(200);
    }
    // op-0 should be evicted now (oldest beyond MAX). Resending must hit the route fresh:
    // version must bump, response must NOT have idempotent:true (would be true if still cached).
    const before = (await rooms.get("d1")).version;
    const res = await postDomain(app, {
      actions: [{ kind: "define", role: "service", name: "n0" }],
      clientOpId: "op-0",
      layoutHint: null,
    });
    const body = (await res.json()) as { idempotent?: boolean; version: number };
    expect(body.idempotent).toBeFalsy();
    const after = (await rooms.get("d1")).version;
    expect(after).toBeGreaterThan(before);
  }, 30000);

  test("layout best-effort — domain mutations land even if layoutHint=null", async () => {
    const { app } = makeApp({ inMemory: true });
    const res = await postDomain(app, {
      actions: [{ kind: "define", role: "service", name: "x" }],
      layoutHint: null,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; layout?: { applied: boolean } };
    expect(body.ok).toBe(true);
    expect(body.layout?.applied).toBe(false);  // null hint → skip layout
  });

  test("delete container without cascade → 422 cascade-confirm-required", async () => {
    const { app } = makeApp({ inMemory: true });
    await postDomain(app, {
      actions: [
        { kind: "define", role: "service", name: "a" },
        { kind: "group", ids: ["a"], as: "network", name: "vpc" },
      ],
    });
    const res = await postDomain(app, { actions: [{ kind: "delete", id: "vpc" }] });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors: Array<{ code: string; affected?: string[] }> };
    expect(body.errors[0]?.code).toBe("cascade-confirm-required");
    expect(body.errors[0]?.affected).toContain("a");
  });

  test("delete container with cascade:true succeeds", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    await postDomain(app, {
      actions: [
        { kind: "define", role: "service", name: "a" },
        { kind: "group", ids: ["a"], as: "network", name: "vpc" },
      ],
    });
    const res = await postDomain(app, { actions: [{ kind: "delete", ids: ["vpc"], cascade: true }] });
    expect(res.status).toBe(200);
    const r = await rooms.get("d1");
    // After cascade-delete of vpc frame: frame removed; children get reparented
    // (NOT deleted — store-ops cascadeDeleteShape leaves them as orphans).
    // So only the frame disappears.
    expect(shapesByType(r, "frame").length).toBe(0);
  });

  test("layout action runs ELK and bumps version", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    await postDomain(app, {
      actions: [
        { kind: "define", role: "service", name: "a" },
        { kind: "define", role: "service", name: "b" },
      ],
      layoutHint: { mode: "layered-lr" },
    });
    const versionBefore = (await rooms.get("d1")).version;

    const res = await postDomain(app, {
      actions: [{ kind: "layout", mode: "force", scope: "all", spacing: "loose" }],
      layoutHint: { mode: "layered-lr" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { layout: { applied: boolean }; version: number };
    expect(body.layout.applied).toBe(true);
    expect(body.version).toBeGreaterThan(versionBefore);
  });

  test("layout updates shape x/y", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const res = await postDomain(app, {
      actions: [
        { kind: "define", role: "service", name: "a" },
        { kind: "define", role: "datastore", name: "b" },
        { kind: "connect", from: "a", to: "b", connectionKind: "data" },
      ],
      layoutHint: { mode: "layered-lr" },
    });
    expect(res.status).toBe(200);
    const r = await rooms.get("d1");
    const aId = r.didrawIndex.get("a");
    const bId = r.didrawIndex.get("b");
    expect(aId).toBeDefined();
    expect(bId).toBeDefined();
    const aShape = aId ? r.store.store[aId] : undefined;
    const bShape = bId ? r.store.store[bId] : undefined;
    // After layered-lr layout, a/b should have different x or y.
    expect(aShape?.x !== bShape?.x || aShape?.y !== bShape?.y).toBe(true);
  });

  // DRW-223: an agent creating nodes one `shemma_define` at a time hits the
  // layout no-op (a single affected node can't be laid out) — without smart
  // placement every node lands at (0,0) and piles. Each separate single define
  // must land in its own free slot.
  test("separate single defines don't pile at the origin (DRW-223)", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    await postDomain(app, { actions: [{ kind: "define", role: "service", name: "a" }] });
    await postDomain(app, { actions: [{ kind: "define", role: "service", name: "b" }] });
    const r = await rooms.get("d1");
    const aId = r.didrawIndex.get("a");
    const bId = r.didrawIndex.get("b");
    const a = aId ? r.store.store[aId] : undefined;
    const b = bId ? r.store.store[bId] : undefined;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    const ax = a?.x ?? 0;
    const ay = a?.y ?? 0;
    const bx = b?.x ?? 0;
    const by = b?.y ?? 0;
    // Not the same point...
    expect(ax === bx && ay === by).toBe(false);
    // ...and the two 220×80 boxes must not overlap.
    const overlap = !(ax + 220 <= bx || bx + 220 <= ax || ay + 80 <= by || by + 80 <= ay);
    expect(overlap).toBe(false);
  });
});

// DRW-220: the MCP layer (shemma_group / GroupArgs) sends group members as
// `children`, while the domain action historically read `ids`. The mismatch
// crashed the validator (`for (const id of a.ids)` on undefined) → unhandled
// 500 text/plain → client r.json() "Failed to parse JSON" → mislabeled
// daemon-unavailable. The backend must accept `children` as the canonical
// member field (alias of `ids`) and never crash on a malformed group action.
describe("POST /api/domain — group members via `children` (DRW-220)", () => {
  test("group via `children` creates a frame and reparents members (was 500)", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const res = await postDomain(app, {
      actions: [
        { kind: "define", role: "service", name: "auth" },
        { kind: "define", role: "datastore", name: "users-db" },
        { kind: "group", children: ["auth", "users-db"], as: "boundary", name: "vpc" },
      ],
      layoutHint: { mode: "layered-lr" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      results: Array<{ elementId?: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.results[2]?.elementId).toBe("vpc");

    const r = await rooms.get("d1");
    const frames = shapesByType(r, "frame");
    expect(frames.length).toBe(1);
    const frameId = (frames[0] as { id: string }).id;
    // Both members must be reparented into the frame.
    const authId = r.didrawIndex.get("auth");
    const dbId = r.didrawIndex.get("users-db");
    expect(authId && r.store.store[authId]?.parentId).toBe(frameId);
    expect(dbId && r.store.store[dbId]?.parentId).toBe(frameId);
  });

  test("`children` and `ids` are interchangeable — `ids` still works", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const res = await postDomain(app, {
      actions: [
        { kind: "define", role: "service", name: "a" },
        { kind: "group", ids: ["a"], as: "network", name: "net" },
      ],
    });
    expect(res.status).toBe(200);
    const r = await rooms.get("d1");
    expect(shapesByType(r, "frame").length).toBe(1);
  });

  test("group with neither `children` nor `ids` → 422 structured error, no crash", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const res = await postDomain(app, {
      actions: [{ kind: "group", as: "boundary", name: "empty" }],
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { ok: boolean; errors: Array<{ field?: string }> };
    expect(body.ok).toBe(false);
    expect(body.errors.length).toBeGreaterThan(0);
    // State untouched — no frame created.
    const r = await rooms.get("d1");
    expect(shapesByType(r, "frame").length).toBe(0);
  });
});
