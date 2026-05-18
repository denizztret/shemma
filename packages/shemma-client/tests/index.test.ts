import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer } from "../../../apps/backend/src/index";
import { CanvasClient } from "../src/index";

let srv: { port: number; close: () => Promise<void> };
beforeAll(async () => {
  srv = await startServer({ inMemory: true, port: 0 });
});
afterAll(async () => {
  await srv.close();
});

describe("CanvasClient", () => {
  test("uses CLAUDE_SESSION_ID from env as default room", () => {
    process.env.CLAUDE_SESSION_ID = "abc";
    const c = new CanvasClient({ baseUrl: `http://localhost:${srv.port}` });
    expect(c.room).toBe("abc");
    // biome-ignore lint/performance/noDelete: env var must be unset for portability across runtimes (Node coerces `=undefined` to string "undefined")
    delete process.env.CLAUDE_SESSION_ID;
  });

  test("getState returns empty store for new room", async () => {
    const c = new CanvasClient({
      baseUrl: `http://localhost:${srv.port}`,
      room: "test1",
    });
    const s = (await c.getState({ fmt: "full" })) as {
      version: number;
      store: { store?: Record<string, unknown> };
    };
    expect(s.version).toBe(0);
    // Empty room ships with the tldraw scaffolding records (document + first
    // page) but zero user-created shapes/bindings.
    const records = Object.values(s.store.store ?? {}) as Array<{
      typeName?: string;
    }>;
    expect(records.some((r) => r.typeName === "shape")).toBe(false);
    expect(records.some((r) => r.typeName === "binding")).toBe(false);
  });

  test("applyDomain + getContext round-trip", async () => {
    // Phase 3.0: /api/patch removed; canonical mutation path is /api/domain.
    const c = new CanvasClient({
      baseUrl: `http://localhost:${srv.port}`,
      room: "test2",
    });
    const r = (await c.applyDomain({
      actions: [{ kind: "define", role: "service", name: "n1" }],
    })) as { ok: boolean; version: number };
    expect(r.ok).toBe(true);
    expect(r.version).toBeGreaterThan(0);

    const view = (await c.getContext()) as {
      ok: true;
      elements: Array<{ id: string; role?: string }>;
    };
    expect(view.elements.some((e) => e.id === "n1" && e.role === "service")).toBe(true);
  });

  test("getHealth returns profile + storage + version + pid (DRW-052, spec §7.4)", async () => {
    const c = new CanvasClient({ baseUrl: `http://localhost:${srv.port}` });
    const h = await c.getHealth();
    expect(h).not.toBeNull();
    expect(h!.ok).toBe(true);
    expect(typeof h!.profile).toBe("string");
    expect(typeof h!.storage).toBe("string");
    expect(typeof h!.version).toBe("string");
    expect(typeof h!.pid).toBe("number");
    expect(h!.pid).toBeGreaterThan(0);
  });

  test("getHealth returns null when daemon unreachable", async () => {
    // Pick a port we expect to be free.
    const c = new CanvasClient({ baseUrl: "http://localhost:1" });
    const h = await c.getHealth();
    expect(h).toBeNull();
  });

  test("deletePrompt + purgePrompts", async () => {
    const c = new CanvasClient({
      baseUrl: `http://localhost:${srv.port}`,
      room: "test3-prompts",
    });
    const a = await fetch(
      `http://localhost:${srv.port}/api/prompt?room=test3-prompts`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ selection: [], text: "keep" }),
      },
    ).then((r) => r.json());
    const b = await fetch(
      `http://localhost:${srv.port}/api/prompt?room=test3-prompts`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ selection: [], text: "delete-me" }),
      },
    ).then((r) => r.json());
    const c2 = await fetch(
      `http://localhost:${srv.port}/api/prompt?room=test3-prompts`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ selection: [], text: "purge-me" }),
      },
    ).then((r) => r.json());
    await c.resolvePrompt(c2.id, "done");

    const del = await c.deletePrompt(b.id);
    expect(del.ok).toBe(true);

    const purge = await c.purgePrompts();
    expect(purge.ok).toBe(true);
    expect(purge.removed).toBe(1);

    const s = await c.getState();
    expect(s.prompts).toHaveLength(1);
    expect(s.prompts[0].id).toBe(a.id);
  });
});
