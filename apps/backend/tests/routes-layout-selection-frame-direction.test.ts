// Follow-up task (frame-container-direction-layout plan, Task 6 polish):
// POST /api/agent/layout-selection — `directions` map must accept `frame` entries.
//
// Background:
//   * DRW-166/167 решал race между frontend optimistic `editor.updateShape`
//     (broadcast через WS 50ms debounce) и POST `/api/agent/layout-selection`:
//     directions включены в POST body чтобы backend применил их АТОМАРНО
//     ДО runLayout.
//   * До этого fix только `schema-container` entries в `directions` обрабатывались
//     корректно; frame entries shape.type !== "schema-container" попадали в
//     `unresolved` → backend читал stale meta при runLayout → layout с board
//     default direction вместо user choice.
//
// Goal: Frame entries in `directions` map применяются как
//       `shape.meta.didrawDirection = dir` (frame не имеет props.direction).
//       Frame НЕ попадает в `unresolved` при valid direction value.
//
// Same fix pattern that DRW-166/167 added for schema-container.

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

describe("POST /api/agent/layout-selection — directions accepts frame", () => {
  // Case 1: POST с frame entry в directions → backend пишет meta.didrawDirection
  //         (НЕ props.direction — frame schema не имеет этого field).
  test("frame entry in directions writes shape.meta.didrawDirection (not props.direction)", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const room = "test-frame-dir-write";
    const r = await rooms.get(room);
    const snap = emptySnapshot();
    snap.store["shape:frame1"] = makeFrame("shape:frame1", 0, 0, 400, 300, "frame1");
    snap.store["shape:c1"] = makeShape("shape:c1", 0, 0, "c1", {}, { w: 80, h: 40 }, "shape:frame1");
    snap.store["shape:c2"] = makeShape("shape:c2", 0, 0, "c2", {}, { w: 80, h: 40 }, "shape:frame1");
    r.store = snap;
    r.version = 1;

    const res = await postLayoutSelection(
      app,
      {
        ids: ["shape:frame1"],
        scope: "self",
        directions: { "shape:frame1": "LR" },
      },
      room,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; unresolved?: string[] };
    expect(body.ok).toBe(true);

    const rAfter = await rooms.get(room);
    const frame = rAfter.store.store["shape:frame1"] as {
      props: Record<string, unknown>;
      meta: Record<string, unknown>;
    };
    expect(frame.meta.didrawDirection).toBe("LR");
    // Frame schema does NOT have props.direction — make sure we did NOT
    // accidentally write that field (would pollute frame schema).
    expect(frame.props.direction).toBeUndefined();
  });

  // Case 2: Frame entry — НЕ попадает в response.unresolved при valid value.
  test("frame entry with valid direction is NOT added to response.unresolved", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const room = "test-frame-dir-resolved";
    const r = await rooms.get(room);
    const snap = emptySnapshot();
    snap.store["shape:frame1"] = makeFrame("shape:frame1", 0, 0, 400, 300, "frame1");
    snap.store["shape:c1"] = makeShape("shape:c1", 0, 0, "c1", {}, { w: 80, h: 40 }, "shape:frame1");
    snap.store["shape:c2"] = makeShape("shape:c2", 0, 0, "c2", {}, { w: 80, h: 40 }, "shape:frame1");
    r.store = snap;
    r.version = 1;

    const res = await postLayoutSelection(
      app,
      {
        ids: ["shape:frame1"],
        scope: "self",
        directions: { "shape:frame1": "TB" },
      },
      room,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      unresolved?: string[];
    };
    expect(body.ok).toBe(true);
    // unresolved is either undefined (no entries) OR does not contain the frame.
    if (body.unresolved) {
      expect(body.unresolved).not.toContain("shape:frame1");
    }
  });

  // Case 3: Race regression — POST с directions: {[frameId]: "LR"} +
  //         scope:"self" + ids: [frameId] → backend применяет direction ДО
  //         runLayout → children layout horizontally.
  //         Если direction НЕ применён ДО runLayout (старое поведение, до этого
  //         fix), default board direction TB → children stack по Y, не X.
  test("race regression: directions applied BEFORE runLayout → frame children laid out horizontally for LR", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const room = "test-frame-dir-race";
    const r = await rooms.get(room);
    const snap = emptySnapshot();
    // Frame with 3 children chained via arrows → ELK gives a layered DAG.
    snap.store["shape:frame1"] = makeFrame("shape:frame1", 0, 0, 600, 400, "frame1");
    snap.store["shape:c1"] = makeShape("shape:c1", 0, 0, "c1", {}, { w: 80, h: 40 }, "shape:frame1");
    snap.store["shape:c2"] = makeShape("shape:c2", 0, 0, "c2", {}, { w: 80, h: 40 }, "shape:frame1");
    snap.store["shape:c3"] = makeShape("shape:c3", 0, 0, "c3", {}, { w: 80, h: 40 }, "shape:frame1");
    // Chain c1 → c2 → c3 to give ELK a clear DAG.
    snap.store["shape:arr1"] = {
      id: "shape:arr1",
      typeName: "shape",
      type: "arrow",
      x: 0,
      y: 0,
      parentId: "page:page",
      props: {
        start: { type: "binding", boundShapeId: "shape:c1", normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false },
        end: { type: "binding", boundShapeId: "shape:c2", normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false },
      },
      meta: {},
    } as TLRecord;
    snap.store["shape:arr2"] = {
      id: "shape:arr2",
      typeName: "shape",
      type: "arrow",
      x: 0,
      y: 0,
      parentId: "page:page",
      props: {
        start: { type: "binding", boundShapeId: "shape:c2", normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false },
        end: { type: "binding", boundShapeId: "shape:c3", normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false },
      },
      meta: {},
    } as TLRecord;
    r.store = snap;
    r.version = 1;

    const res = await postLayoutSelection(
      app,
      {
        ids: ["shape:frame1"],
        scope: "self",
        directions: { "shape:frame1": "LR" },
      },
      room,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Layout should have spread the chain along X axis (LR direction).
    // Если bug: direction stale → default TB → children stacked vertically →
    //          large dy, small dx.
    const rAfter = await rooms.get(room);
    const c1 = rAfter.store.store["shape:c1"] as { x: number; y: number };
    const c3 = rAfter.store.store["shape:c3"] as { x: number; y: number };

    const dx = Math.abs(c3.x - c1.x);
    const dy = Math.abs(c3.y - c1.y);

    // For LR: dx должен значительно превышать dy (horizontal chain).
    // Use simple invariant: dx > dy + 50 (tolerant к ELK spacing variations).
    expect(dx).toBeGreaterThan(dy + 50);

    // Frame meta was persisted before runLayout:
    const frameAfter = rAfter.store.store["shape:frame1"] as {
      meta: Record<string, unknown>;
    };
    expect(frameAfter.meta.didrawDirection).toBe("LR");
  });
});
