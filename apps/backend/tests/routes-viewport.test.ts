import { describe, expect, test } from "bun:test";
import { makeApp } from "../src/index";

describe("POST /api/viewport", () => {
  test("stores viewport per room; subsequent GET returns it", async () => {
    const { app } = makeApp({ inMemory: true });
    const post = await app.fetch(
      new Request("http://localhost/api/viewport?room=v1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x: 10, y: 20, w: 800, h: 600, zoom: 1 }),
      }),
    );
    expect(post.status).toBe(200);

    const get = await app.fetch(new Request("http://localhost/api/viewport?room=v1"));
    expect(get.status).toBe(200);
    const body = (await get.json()) as { viewport: { x: number; y: number; w: number; h: number; zoom: number } | null };
    expect(body.viewport).toEqual({ x: 10, y: 20, w: 800, h: 600, zoom: 1 });
  });

  test("GET on unknown room returns viewport:null", async () => {
    const { app } = makeApp({ inMemory: true });
    const get = await app.fetch(new Request("http://localhost/api/viewport?room=unknown"));
    const body = (await get.json()) as { viewport: unknown | null };
    expect(body.viewport).toBeNull();
  });

  test("invalid room id → 422", async () => {
    const { app } = makeApp({ inMemory: true });
    const res = await app.fetch(
      new Request("http://localhost/api/viewport?room=" + encodeURIComponent("bad name"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x: 0, y: 0, w: 1, h: 1 }),
      }),
    );
    expect(res.status).toBe(422);
  });
});
