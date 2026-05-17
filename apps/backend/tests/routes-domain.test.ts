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
});
