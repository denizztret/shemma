import { describe, expect, test } from "bun:test";
import { startServer } from "../src/index";

const json = (port: number, path: string, init?: RequestInit) =>
  fetch(`http://localhost:${port}${path}`, init).then((r) => r.json());

describe("prompts", () => {
  test("POST /api/prompt creates pending", async () => {
    const srv = await startServer({ inMemory: true, port: 0 });
    const b = await json(srv.port, "/api/prompt?room=a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection: ["n1"], text: "?" }),
    });
    expect(b.id).toBeDefined();
    expect(b.status).toBe("pending");
    await srv.close();
  });

  test("resolve + list", async () => {
    const srv = await startServer({ inMemory: true, port: 0 });
    const p = await json(srv.port, "/api/prompt?room=a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection: [], text: "x" }),
    });
    await json(srv.port, `/api/prompt/${p.id}/resolve?room=a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: "ok" }),
    });
    const r = await json(srv.port, "/api/prompts?room=a&status=resolved");
    expect(r.prompts[0].response).toBe("ok");
    await srv.close();
  });

  test("DELETE /api/prompt/:id removes a single prompt", async () => {
    const srv = await startServer({ inMemory: true, port: 0 });
    const p = await json(srv.port, "/api/prompt?room=a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection: [], text: "to-delete" }),
    });
    const del = await json(srv.port, `/api/prompt/${p.id}?room=a`, {
      method: "DELETE",
    });
    expect(del.ok).toBe(true);
    const r = await json(srv.port, "/api/prompts?room=a&status=all");
    expect(
      r.prompts.find((x: { id: string }) => x.id === p.id),
    ).toBeUndefined();
    await srv.close();
  });

  test("DELETE /api/prompt/:id returns 404 for unknown id", async () => {
    const srv = await startServer({ inMemory: true, port: 0 });
    const r = await fetch(
      `http://localhost:${srv.port}/api/prompt/does-not-exist?room=a`,
      { method: "DELETE" },
    );
    expect(r.status).toBe(404);
    await srv.close();
  });

  test("DELETE /api/prompts purges non-pending only by default", async () => {
    const srv = await startServer({ inMemory: true, port: 0 });
    const a = await json(srv.port, "/api/prompt?room=a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection: [], text: "keep-pending" }),
    });
    const b = await json(srv.port, "/api/prompt?room=a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection: [], text: "to-resolve" }),
    });
    const c = await json(srv.port, "/api/prompt?room=a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection: [], text: "to-dismiss" }),
    });
    await json(srv.port, `/api/prompt/${b.id}/resolve?room=a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: "done" }),
    });
    await json(srv.port, `/api/prompt/${c.id}/dismiss?room=a`, {
      method: "POST",
    });
    const purge = await json(srv.port, "/api/prompts?room=a", {
      method: "DELETE",
    });
    expect(purge.removed).toBe(2);
    const all = await json(srv.port, "/api/prompts?room=a&status=all");
    expect(all.prompts).toHaveLength(1);
    expect(all.prompts[0].id).toBe(a.id);
    await srv.close();
  });
});
