import { describe, expect, test } from "bun:test";
import { makeApp } from "../src/index";

type FetchableApp = ReturnType<typeof makeApp>["app"];

const post = (app: FetchableApp, room: string, body: unknown) =>
  app.fetch(
    new Request(`http://x/api/patch?room=${room}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe("POST /api/patch", () => {
  test("ok + version increments", async () => {
    const { app } = makeApp({ inMemory: true });
    const r = await post(app, "a", {
      ops: [
        {
          op: "add",
          target: "node",
          value: { id: "n1", kind: "rect", x: 0, y: 0 },
        },
      ],
      source: "ai",
    });
    const b = await r.json();
    expect(b.ok).toBe(true);
    expect(b.version).toBe(1);
  });

  test("422 on validation error, version unchanged", async () => {
    const { app } = makeApp({ inMemory: true });
    const r = await post(app, "a", {
      ops: [
        {
          op: "add",
          target: "edge",
          value: {
            id: "e",
            from: { kind: "node", id: "missing" },
            to: { kind: "node", id: "n" },
          },
        },
      ],
      source: "ai",
    });
    expect(r.status).toBe(422);
  });

  test("idempotency by clientOpId", async () => {
    const { app } = makeApp({ inMemory: true });
    const body = {
      ops: [
        {
          op: "add",
          target: "node",
          value: { id: "n1", kind: "rect", x: 0, y: 0 },
        },
      ],
      source: "user",
      clientOpId: "abc",
    };
    const r1 = await post(app, "a", body);
    const b1 = await r1.json();
    const r2 = await post(app, "a", body);
    const b2 = await r2.json();
    expect(b1.version).toBe(1);
    expect(b2.version).toBe(1);
    expect(b2.idempotent).toBe(true);
  });

  test("rooms isolated", async () => {
    const { app } = makeApp({ inMemory: true });
    await post(app, "a", {
      ops: [
        {
          op: "add",
          target: "node",
          value: { id: "n1", kind: "rect", x: 0, y: 0 },
        },
      ],
      source: "user",
    });
    const r = await app.fetch(new Request("http://x/api/state?room=b"));
    expect((await r.json()).canvas.nodes).toEqual([]);
  });
});
