// DRW-088: Integration tests for POST /api/agent/layout-selection
//
// Сценарий: store с 5 shapes (2 selected, 1 pinned среди selected, 2 не в selection)
// → POST /api/agent/layout-selection с body.ids → assert:
//   * pinned shape coords unchanged
//   * non-selected coords unchanged
//   * selected non-pinned shape moved

import { describe, expect, test } from "bun:test";
import { makeApp } from "../src/index";
import type { TLRecord } from "../src/store-types";

function emptySnapshot() {
  return {
    schema: { schemaVersion: 1, storeVersion: 4, recordVersions: {} },
    store: {
      "document:document": { id: "document:document", typeName: "document" } as TLRecord,
      "page:page": { id: "page:page", typeName: "page" } as TLRecord,
    },
  };
}

function makeShape(
  id: string,
  x: number,
  y: number,
  name: string,
  extraMeta: Record<string, unknown> = {},
): TLRecord {
  return {
    id,
    typeName: "shape",
    type: "geo",
    x,
    y,
    parentId: "page:page",
    props: { w: 120, h: 60, geo: "rectangle" },
    meta: { didrawName: name, ...extraMeta },
  } as TLRecord;
}

async function postLayoutSelection(
  app: ReturnType<typeof makeApp>["app"],
  body: unknown,
  room = "test-layout-sel",
) {
  return app.fetch(
    new Request(`http://localhost/api/agent/layout-selection?room=${room}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/agent/layout-selection", () => {
  test("AC#3 + AC#4: non-selected + pinned shapes unchanged; selected non-pinned shape moves", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const room = "test-lsel-1";

    // Seed room with 5 shapes
    const r = await rooms.get(room);
    const snap = emptySnapshot();
    // selected-non-pinned: should move
    snap.store["shape:sel-a"] = makeShape("shape:sel-a", 0, 0, "sel-a");
    snap.store["shape:sel-b"] = makeShape("shape:sel-b", 0, 0, "sel-b");
    // selected-pinned: should NOT move
    snap.store["shape:sel-pinned"] = makeShape("shape:sel-pinned", 999, 999, "sel-pinned", {
      pinned: true,
      position: { x: 999, y: 999 },
    });
    // not in selection: should NOT move
    snap.store["shape:out-a"] = makeShape("shape:out-a", 200, 200, "out-a");
    snap.store["shape:out-b"] = makeShape("shape:out-b", 300, 300, "out-b");
    r.store = snap;
    r.version = 1;

    const res = await postLayoutSelection(
      app,
      {
        ids: ["shape:sel-a", "shape:sel-b", "shape:sel-pinned"],
        mode: "layered-tb",
      },
      room,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      version?: number;
      count?: number;
      affected?: string[];
    };
    expect(body.ok).toBe(true);

    const rAfter = await rooms.get(room);

    // pinned shape stays at original coords
    const pinnedAfter = rAfter.store.store["shape:sel-pinned"]!;
    expect(pinnedAfter.x).toBe(999);
    expect(pinnedAfter.y).toBe(999);

    // non-selected shapes unchanged
    const outAAfter = rAfter.store.store["shape:out-a"]!;
    expect(outAAfter.x).toBe(200);
    expect(outAAfter.y).toBe(200);
    const outBAfter = rAfter.store.store["shape:out-b"]!;
    expect(outBAfter.x).toBe(300);
    expect(outBAfter.y).toBe(300);

    // at least one selected non-pinned shape moved
    const selAAfter = rAfter.store.store["shape:sel-a"]!;
    const selBAfter = rAfter.store.store["shape:sel-b"]!;
    const anyMoved =
      selAAfter.x !== 0 ||
      selAAfter.y !== 0 ||
      selBAfter.x !== 0 ||
      selBAfter.y !== 0;
    expect(anyMoved).toBe(true);
  });

  test("AC#9: empty ids → 200 with count:0 and hint", async () => {
    const { app } = makeApp({ inMemory: true });
    const res = await postLayoutSelection(app, { ids: [] }, "test-lsel-empty");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; count: number; hint?: string };
    expect(body.ok).toBe(true);
    expect(body.count).toBe(0);
    expect(body.hint).toBeTruthy();
  });

  test("AC#10: single id → 200 with count:0 and hint", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const room = "test-lsel-single";
    const r = await rooms.get(room);
    const snap = emptySnapshot();
    snap.store["shape:x"] = makeShape("shape:x", 0, 0, "x");
    r.store = snap;

    const res = await postLayoutSelection(app, { ids: ["shape:x"] }, room);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; count: number; hint?: string };
    expect(body.ok).toBe(true);
    expect(body.count).toBe(0);
    expect(body.hint).toBeTruthy();
  });

  test("resolving didrawName ids: MCP sends names, endpoint resolves them", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const room = "test-lsel-names";
    const r = await rooms.get(room);
    const snap = emptySnapshot();
    snap.store["shape:e_node-a"] = makeShape("shape:e_node-a", 0, 0, "node-a");
    snap.store["shape:e_node-b"] = makeShape("shape:e_node-b", 0, 0, "node-b");
    r.store = snap;
    // Rebuild index
    const { rebuildDidrawIndex } = await import("../src/store-ops");
    r.didrawIndex = rebuildDidrawIndex(r.store);

    const res = await postLayoutSelection(app, { ids: ["node-a", "node-b"], mode: "layered-tb" }, room);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("all ids unresolved → 400", async () => {
    const { app } = makeApp({ inMemory: true });
    const res = await postLayoutSelection(
      app,
      { ids: ["nonexistent-1", "nonexistent-2"] },
      "test-lsel-unresolved",
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBeTruthy();
  });

  test("missing room → 422", async () => {
    const { app } = makeApp({ inMemory: true });
    const res = app.fetch(
      new Request("http://localhost/api/agent/layout-selection?room=", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [] }),
      }),
    );
    const r = await res;
    expect(r.status).toBe(422);
  });
});
