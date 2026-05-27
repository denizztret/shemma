import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { boardLayoutParamsRoutes } from "../src/routes/board-layout-params";

function buildApp() {
  const app = new Hono();
  const rooms = new Map<string, { meta?: Record<string, unknown> }>();
  rooms.set("default::r1", { meta: { layoutParams: { nodePadding: 8 } } });
  rooms.set("default::r2", { meta: {} });

  app.route("/", boardLayoutParamsRoutes({
    getRoom: (space, room) => rooms.get(`${space}::${room}`),
    persistRoom: () => {},
    broadcastRoomMeta: () => {},
  }));
  return app;
}

describe("GET /api/board/layout-params", () => {
  test("returns raw + effective when params present", async () => {
    const app = buildApp();
    const res = await app.request("/api/board/layout-params?space=default&room=r1");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.raw).toEqual({ nodePadding: 8 });
    expect(json.effective.nodePadding).toBe(8);
    expect(json.effective.containerPadding).toBe(24);
  });

  test("returns raw=null + full defaults when no params set", async () => {
    const app = buildApp();
    const res = await app.request("/api/board/layout-params?space=default&room=r2");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.raw).toBeNull();
    expect(json.effective.nodePadding).toBe(16);
  });

  test("400 if space or room missing", async () => {
    const app = buildApp();
    const res = await app.request("/api/board/layout-params?space=default");
    expect(res.status).toBe(400);
  });
});
