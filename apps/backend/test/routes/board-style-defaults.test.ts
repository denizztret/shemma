import { describe, expect, it } from "bun:test";
import { makeApp } from "../../src/index";

const SPACE = "default";
const ROOM = "default";

async function setup() {
  const { app } = makeApp({ inMemory: true });
  await app.fetch(
    new Request(`http://x/api/state?space=${SPACE}&room=${ROOM}`, {
      method: "GET",
    }),
  );
  return app;
}

describe("GET /api/board/style-defaults", () => {
  it("returns null raw and native effective for fresh room", async () => {
    const app = await setup();
    const res = await app.fetch(
      new Request(`http://x/api/board/style-defaults?space=${SPACE}&room=${ROOM}`),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.raw).toBeNull();
    expect(body.effective).toEqual({ dash: "draw", font: "draw", size: "m" });
  });

  it("400 when space or room missing", async () => {
    const app = await setup();
    const res = await app.fetch(new Request("http://x/api/board/style-defaults"));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/board/style-defaults", () => {
  it("persists partial and returns effective", async () => {
    const app = await setup();
    const res = await app.fetch(
      new Request(`http://x/api/board/style-defaults?space=${SPACE}&room=${ROOM}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ defaults: { dash: "solid", font: "sans" } }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.effective).toEqual({ dash: "solid", font: "sans", size: "m" });

    const getRes = await app.fetch(
      new Request(`http://x/api/board/style-defaults?space=${SPACE}&room=${ROOM}`),
    );
    const getBody = await getRes.json();
    expect(getBody.raw).toEqual({ dash: "solid", font: "sans" });
  });

  it("null clears persisted", async () => {
    const app = await setup();
    await app.fetch(
      new Request(`http://x/api/board/style-defaults?space=${SPACE}&room=${ROOM}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ defaults: { dash: "solid" } }),
      }),
    );
    const res = await app.fetch(
      new Request(`http://x/api/board/style-defaults?space=${SPACE}&room=${ROOM}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ defaults: null }),
      }),
    );
    expect(res.status).toBe(200);
    const getRes = await app.fetch(
      new Request(`http://x/api/board/style-defaults?space=${SPACE}&room=${ROOM}`),
    );
    const getBody = await getRes.json();
    expect(getBody.raw).toBeNull();
  });

  it("400 on invalid field", async () => {
    const app = await setup();
    const res = await app.fetch(
      new Request(`http://x/api/board/style-defaults?space=${SPACE}&room=${ROOM}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ defaults: { dash: "dashed" } }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
