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

describe("GET /api/board/container-title-position", () => {
  it("returns null for fresh room", async () => {
    const app = await setup();
    const res = await app.fetch(
      new Request(
        `http://x/api/board/container-title-position?space=${SPACE}&room=${ROOM}`,
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.value).toBeNull();
  });

  it("400 when space or room missing", async () => {
    const app = await setup();
    const res = await app.fetch(
      new Request("http://x/api/board/container-title-position"),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/board/container-title-position", () => {
  it("persists outside-banner and reads back", async () => {
    const app = await setup();
    const res = await app.fetch(
      new Request(
        `http://x/api/board/container-title-position?space=${SPACE}&room=${ROOM}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "outside-banner" }),
        },
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const getRes = await app.fetch(
      new Request(
        `http://x/api/board/container-title-position?space=${SPACE}&room=${ROOM}`,
      ),
    );
    const getBody = await getRes.json();
    expect(getBody.value).toBe("outside-banner");
  });

  it("persists outside-frame and reads back", async () => {
    const app = await setup();
    const res = await app.fetch(
      new Request(
        `http://x/api/board/container-title-position?space=${SPACE}&room=${ROOM}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "outside-frame" }),
        },
      ),
    );
    expect(res.status).toBe(200);
    const getRes = await app.fetch(
      new Request(
        `http://x/api/board/container-title-position?space=${SPACE}&room=${ROOM}`,
      ),
    );
    expect((await getRes.json()).value).toBe("outside-frame");
  });

  it("rejects legacy 'outside' value (strict 4-value enum, phase 2)", async () => {
    const app = await setup();
    const res = await app.fetch(
      new Request(
        `http://x/api/board/container-title-position?space=${SPACE}&room=${ROOM}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "outside" }),
        },
      ),
    );
    expect(res.status).toBe(400);
  });

  it("persists inside-center and inside-left", async () => {
    const app = await setup();
    await app.fetch(
      new Request(
        `http://x/api/board/container-title-position?space=${SPACE}&room=${ROOM}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "inside-center" }),
        },
      ),
    );
    let getRes = await app.fetch(
      new Request(
        `http://x/api/board/container-title-position?space=${SPACE}&room=${ROOM}`,
      ),
    );
    expect((await getRes.json()).value).toBe("inside-center");

    await app.fetch(
      new Request(
        `http://x/api/board/container-title-position?space=${SPACE}&room=${ROOM}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "inside-left" }),
        },
      ),
    );
    getRes = await app.fetch(
      new Request(
        `http://x/api/board/container-title-position?space=${SPACE}&room=${ROOM}`,
      ),
    );
    expect((await getRes.json()).value).toBe("inside-left");
  });

  it("null clears persisted", async () => {
    const app = await setup();
    await app.fetch(
      new Request(
        `http://x/api/board/container-title-position?space=${SPACE}&room=${ROOM}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "outside-banner" }),
        },
      ),
    );
    const res = await app.fetch(
      new Request(
        `http://x/api/board/container-title-position?space=${SPACE}&room=${ROOM}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: null }),
        },
      ),
    );
    expect(res.status).toBe(200);
    const getRes = await app.fetch(
      new Request(
        `http://x/api/board/container-title-position?space=${SPACE}&room=${ROOM}`,
      ),
    );
    const getBody = await getRes.json();
    expect(getBody.value).toBeNull();
  });

  it("400 on invalid value", async () => {
    const app = await setup();
    const res = await app.fetch(
      new Request(
        `http://x/api/board/container-title-position?space=${SPACE}&room=${ROOM}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "bogus" }),
        },
      ),
    );
    expect(res.status).toBe(400);
  });
});
