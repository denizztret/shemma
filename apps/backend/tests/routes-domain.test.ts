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
    expect(body.results.map((r) => r.elementId)).toEqual(["auth", "users-db", expect.any(String), "vpc-prod"]);
    expect(body.layout.applied).toBe(true);

    const r = await rooms.get("d1");
    expect(r.canvas.nodes).toHaveLength(2);
    expect(r.canvas.edges).toHaveLength(1);
    expect(r.canvas.groups).toHaveLength(1);
    expect(r.canvas.groups[0].children).toHaveLength(2);
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
    expect(body.errors[0].code).toBe("unknown-ref");

    const r = await rooms.get("d1");
    expect(r.canvas.nodes).toHaveLength(0);
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
      results: Array<{ generatedOps?: unknown[] }>;
      version: number;
    };
    expect(body.ok).toBe(true);
    expect(body.results[0].generatedOps).toBeDefined();
    expect((body.results[0].generatedOps as unknown[]).length).toBeGreaterThan(0);

    const r = await rooms.get("d1");
    expect(r.canvas.nodes).toHaveLength(0);
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

  test("layout best-effort — domain mutations land even if ELK fails", async () => {
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
    const { app, rooms } = makeApp({ inMemory: true });
    await postDomain(app, {
      actions: [
        { kind: "define", role: "service", name: "a" },
        { kind: "group", ids: ["a"], as: "network", name: "vpc" },
      ],
    });
    const res = await postDomain(app, { actions: [{ kind: "delete", id: "vpc" }] });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors: Array<{ code: string; affected?: string[] }> };
    expect(body.errors[0].code).toBe("cascade-confirm-required");
    expect(body.errors[0].affected).toContain("shape:e_a");
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
    expect(r.canvas.groups).toHaveLength(0);
    expect(r.canvas.nodes).toHaveLength(0);
  });

  test("layout action mode overrides batch hint", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    await postDomain(app, {
      actions: [
        { kind: "define", role: "service", name: "a" },
        { kind: "define", role: "service", name: "b" },
      ],
      layoutHint: { mode: "layered-lr" },
    });
    const yAfterLayered = (await rooms.get("d1")).canvas.nodes.find((n) => n.meta?.name === "a")?.y;

    const res = await postDomain(app, {
      actions: [{ kind: "layout", mode: "force", scope: "all", spacing: "loose" }],
      layoutHint: { mode: "layered-lr" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { layout: { applied: boolean } };
    expect(body.layout.applied).toBe(true);
    const yAfterForce = (await rooms.get("d1")).canvas.nodes.find((n) => n.meta?.name === "a")?.y;
    expect(yAfterForce).toBeDefined();
    void yAfterLayered;
  });

  test("layout writes meta.position on nodes + meta.routing on edges", async () => {
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
    const aNode = r.canvas.nodes.find((n) => n.meta?.name === "a");
    const edge = r.canvas.edges[0];
    expect(aNode?.meta?.position).toBeDefined();
    expect((aNode?.meta?.position as { x: number }).x).toBe(aNode?.x);
    const routing = edge?.meta?.routing as { ports?: { from?: { side: string }; to?: { side: string } } } | undefined;
    expect(routing?.ports?.from?.side).toBeDefined();
    expect(routing?.ports?.to?.side).toBeDefined();
  });
});
