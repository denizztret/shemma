// Task 4 (frame-container-direction-layout plan):
// POST /api/agent/layout-selection — body extension `layoutParamsOverride`.
//
// Spec §4.1 + §4.3:
//   * Body может содержать `layoutParamsOverride?: Record<ElementId, Partial<LayoutParams> | null>`.
//   * Применяется атомарно ДО runLayout — runLayoutSubgraph сразу видит updated meta.
//   * Partial<LayoutParams> → validate via validateLayoutParams + write
//     shape.meta.didrawLayoutParams.
//   * null → delete shape.meta.didrawLayoutParams.
//   * Validation fail → 400 atomic abort, никакие changes (ни directions, ни override).
//   * non-container id (shape exists, type !== frame && !== schema-container)
//     → ID добавляется в response.unresolved (skip silently).
//   * non-existent id → ID добавляется в response.unresolved.

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
  extraProps: Record<string, unknown> = {},
  parentId = "page:page",
  type = "geo",
): TLRecord {
  return {
    id,
    typeName: "shape",
    type,
    x,
    y,
    parentId,
    props: { w: 120, h: 60, geo: "rectangle", ...extraProps },
    meta: { didrawName: name, ...extraMeta },
  } as TLRecord;
}

function makeFrame(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  name: string,
  extraMeta: Record<string, unknown> = {},
): TLRecord {
  return {
    id,
    typeName: "shape",
    type: "frame",
    x,
    y,
    parentId: "page:page",
    props: { w, h, name, color: "black" },
    meta: { didrawName: name, ...extraMeta },
  } as TLRecord;
}

async function postLayoutSelection(
  app: ReturnType<typeof makeApp>["app"],
  body: unknown,
  room: string,
) {
  return app.fetch(
    new Request(`http://localhost/api/agent/layout-selection?room=${room}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/agent/layout-selection — layoutParamsOverride", () => {
  // Case 1: POST с {[frameId]: {spacing: "compact"}} → пишет meta + applies layout.
  test("Partial<LayoutParams> override writes shape.meta.didrawLayoutParams and applies layout", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const room = "test-override-write";
    const r = await rooms.get(room);
    const snap = emptySnapshot();
    // Frame with 2 children
    snap.store["shape:frame1"] = makeFrame("shape:frame1", 0, 0, 400, 300, "frame1");
    snap.store["shape:c1"] = makeShape("shape:c1", 0, 0, "c1", {}, { w: 80, h: 40 }, "shape:frame1");
    snap.store["shape:c2"] = makeShape("shape:c2", 0, 0, "c2", {}, { w: 80, h: 40 }, "shape:frame1");
    r.store = snap;
    r.version = 1;

    const res = await postLayoutSelection(
      app,
      {
        ids: ["shape:frame1"],
        mode: "layered-tb",
        layoutParamsOverride: { "shape:frame1": { spacing: "compact" } },
      },
      room,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const rAfter = await rooms.get(room);
    const frame = rAfter.store.store["shape:frame1"] as { meta: Record<string, unknown> };
    expect(frame.meta.didrawLayoutParams).toEqual({ spacing: "compact" });
  });

  // Case 2: POST с {[frameId]: null} → удаляет meta key.
  test("null override deletes shape.meta.didrawLayoutParams", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const room = "test-override-delete";
    const r = await rooms.get(room);
    const snap = emptySnapshot();
    // Frame with pre-existing didrawLayoutParams meta
    snap.store["shape:frame1"] = makeFrame(
      "shape:frame1",
      0,
      0,
      400,
      300,
      "frame1",
      { didrawLayoutParams: { spacing: "loose" } },
    );
    snap.store["shape:c1"] = makeShape("shape:c1", 0, 0, "c1", {}, { w: 80, h: 40 }, "shape:frame1");
    snap.store["shape:c2"] = makeShape("shape:c2", 0, 0, "c2", {}, { w: 80, h: 40 }, "shape:frame1");
    r.store = snap;
    r.version = 1;

    // Pre-condition: meta key present
    const frameBefore = r.store.store["shape:frame1"] as { meta: Record<string, unknown> };
    expect(frameBefore.meta.didrawLayoutParams).toEqual({ spacing: "loose" });

    const res = await postLayoutSelection(
      app,
      {
        ids: ["shape:frame1"],
        mode: "layered-tb",
        layoutParamsOverride: { "shape:frame1": null },
      },
      room,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const rAfter = await rooms.get(room);
    const frame = rAfter.store.store["shape:frame1"] as { meta: Record<string, unknown> };
    expect(frame.meta.didrawLayoutParams).toBeUndefined();
  });

  // Case 3: invalid LayoutParams → 400 atomic abort.
  test("invalid LayoutParams → 400 atomic abort (no directions, no override applied)", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const room = "test-override-invalid";
    const r = await rooms.get(room);
    const snap = emptySnapshot();
    snap.store["shape:frame1"] = makeFrame("shape:frame1", 0, 0, 400, 300, "frame1");
    snap.store["shape:c1"] = makeShape("shape:c1", 0, 0, "c1", {}, { w: 80, h: 40 }, "shape:frame1");
    snap.store["shape:c2"] = makeShape("shape:c2", 0, 0, "c2", {}, { w: 80, h: 40 }, "shape:frame1");
    r.store = snap;
    r.version = 1;

    const versionBefore = r.version;
    const c1XBefore = (r.store.store["shape:c1"] as { x: number }).x;
    const c1YBefore = (r.store.store["shape:c1"] as { y: number }).y;
    const frameMetaBefore = (r.store.store["shape:frame1"] as { meta: Record<string, unknown> }).meta;

    const res = await postLayoutSelection(
      app,
      {
        ids: ["shape:frame1"],
        mode: "layered-tb",
        // Also include a directions field that would otherwise apply — to prove atomic abort.
        // (Frame doesn't accept directions but include something irrelevant; key check is store unchanged.)
        layoutParamsOverride: { "shape:frame1": { spacing: "INVALID_VALUE" } },
      },
      room,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBeTruthy();

    // Store unchanged: version, child positions, frame meta all match pre-conditions.
    const rAfter = await rooms.get(room);
    expect(rAfter.version).toBe(versionBefore);
    const c1After = rAfter.store.store["shape:c1"] as { x: number; y: number };
    expect(c1After.x).toBe(c1XBefore);
    expect(c1After.y).toBe(c1YBefore);
    const frameAfter = rAfter.store.store["shape:frame1"] as { meta: Record<string, unknown> };
    expect(frameAfter.meta).toEqual(frameMetaBefore);
  });

  // Case 4: non-container id (geo leaf) → skip + добавляется в `unresolved`.
  test("non-container id in override → skipped + added to response.unresolved; meta not written", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const room = "test-override-noncontainer";
    const r = await rooms.get(room);
    const snap = emptySnapshot();
    // Two geo leaves on the page — neither is a frame/container.
    snap.store["shape:leaf1"] = makeShape("shape:leaf1", 0, 0, "leaf1");
    snap.store["shape:leaf2"] = makeShape("shape:leaf2", 5, 0, "leaf2");
    r.store = snap;
    r.version = 1;

    const res = await postLayoutSelection(
      app,
      {
        ids: ["shape:leaf1", "shape:leaf2"],
        mode: "layered-tb",
        // leaf1 is a plain geo, NOT a container — must end up unresolved.
        layoutParamsOverride: { "shape:leaf1": { spacing: "compact" } },
      },
      room,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      unresolved?: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.unresolved).toContain("shape:leaf1");

    // Geo leaf must not have didrawLayoutParams written.
    const rAfter = await rooms.get(room);
    const leaf = rAfter.store.store["shape:leaf1"] as { meta: Record<string, unknown> };
    expect(leaf.meta.didrawLayoutParams).toBeUndefined();
  });
});
