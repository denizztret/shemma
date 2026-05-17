import { describe, expect, test } from "bun:test";
import { makeApp } from "../src/index";

// Minimal V2-shaped schema — backend treats it opaquely; only schemaVersion
// and presence of `sequences` matter (see ws-protocol.isPlaceholderSchema).
function realSchema(label = "a") {
  return {
    schemaVersion: 2,
    sequences: {
      "com.tldraw.store": 4,
      [`com.tldraw.${label}`]: 1,
    },
  };
}

describe("POST /api/state/seed-schema", () => {
  test("fresh room: upgrades placeholder schema with client V2 schema", async () => {
    const { app } = makeApp({ inMemory: true });
    const schema = realSchema("a");

    const post = await app.fetch(
      new Request("http://localhost/api/state/seed-schema?room=seed1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schema }),
      }),
    );
    expect(post.status).toBe(200);
    const body = (await post.json()) as {
      ok: boolean;
      upgraded: boolean;
      version: number;
    };
    expect(body.ok).toBe(true);
    expect(body.upgraded).toBe(true);
    expect(body.version).toBe(0);

    const get = await app.fetch(new Request("http://localhost/api/state?room=seed1"));
    expect(get.status).toBe(200);
    const state = (await get.json()) as { store: { schema: unknown } };
    expect(state.store.schema).toEqual(schema);
  });

  test("already-real room: repeat seed is noop (upgraded:false, no overwrite)", async () => {
    const { app } = makeApp({ inMemory: true });
    const first = realSchema("a");
    const second = realSchema("b");

    const r1 = await app.fetch(
      new Request("http://localhost/api/state/seed-schema?room=seed2", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schema: first }),
      }),
    );
    expect(((await r1.json()) as { upgraded: boolean }).upgraded).toBe(true);

    const r2 = await app.fetch(
      new Request("http://localhost/api/state/seed-schema?room=seed2", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schema: second }),
      }),
    );
    expect(r2.status).toBe(200);
    const body = (await r2.json()) as { ok: boolean; upgraded: boolean };
    expect(body.ok).toBe(true);
    expect(body.upgraded).toBe(false);

    const get = await app.fetch(new Request("http://localhost/api/state?room=seed2"));
    const state = (await get.json()) as { store: { schema: unknown } };
    expect(state.store.schema).toEqual(first);
  });

  test("missing schema body → 400 schema-required", async () => {
    const { app } = makeApp({ inMemory: true });
    const res = await app.fetch(
      new Request("http://localhost/api/state/seed-schema?room=seed3", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("schema-required");
  });

  test("schema:null → 400 schema-required", async () => {
    const { app } = makeApp({ inMemory: true });
    const res = await app.fetch(
      new Request("http://localhost/api/state/seed-schema?room=seed4", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schema: null }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("schema-required");
  });

  test("schema as string → 400 schema-required", async () => {
    const { app } = makeApp({ inMemory: true });
    const res = await app.fetch(
      new Request("http://localhost/api/state/seed-schema?room=seed5", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schema: "not-an-object" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("schema-required");
  });

  test("invalid room id → 422", async () => {
    const { app } = makeApp({ inMemory: true });
    const res = await app.fetch(
      new Request(
        "http://localhost/api/state/seed-schema?room=" + encodeURIComponent("bad name"),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ schema: realSchema() }),
        },
      ),
    );
    expect(res.status).toBe(422);
  });
});
