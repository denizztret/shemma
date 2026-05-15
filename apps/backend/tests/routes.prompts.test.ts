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
});
