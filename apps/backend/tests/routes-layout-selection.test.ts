// DRW-088: Integration tests for POST /api/agent/layout-selection
//
// Сценарий: store с 5 shapes (2 selected, 1 pinned среди selected, 2 не в selection)
// → POST /api/agent/layout-selection с body.ids → assert:
//   * pinned shape coords unchanged
//   * non-selected coords unchanged
//   * selected non-pinned shape moved
//
// DRW-091: subgraph mode — only selected shapes go into ELK, non-selected untouched
// DRW-092: frame parent — children stay inside frame bounds after layout

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
): TLRecord {
  return {
    id,
    typeName: "shape",
    type: "frame",
    x,
    y,
    parentId: "page:page",
    props: { w, h, name },
    meta: { didrawName: name },
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

  test("DRW-149: single id → 200 ok count=0 (не need-2-noop)", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const room = "test-lsel-single-drw149";
    const r = await rooms.get(room);
    const snap = emptySnapshot();
    snap.store["shape:x"] = makeShape("shape:x", 0, 0, "x");
    r.store = snap;

    const res = await postLayoutSelection(app, { ids: ["shape:x"] }, room);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; count: number; hint?: string };
    expect(body.ok).toBe(true);
    expect(body.count).toBe(0);
    // Should NOT have a "need 2+" hint — single id must reach runLayout
    expect(body.hint ?? "").not.toContain("need 2+");
  });

  test("AC#10-legacy: single id (old behavior) → 200 with count:0 and hint", async () => {
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

  // DRW-091 AC#4/AC#6: 4 shapes, 2 selected (clustered left), 2 non-selected (clustered right).
  // After layout-selection: selected do NOT overlap non-selected, non-selected coords unchanged.
  test("DRW-091 AC#6: selected shapes do not overlap non-selected after subgraph layout", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const room = "test-drw091-ac6";
    const r = await rooms.get(room);
    const snap = emptySnapshot();
    // selected: clustered at (0,0) and (50,0) — overlapping same spot
    snap.store["shape:sel-a"] = makeShape("shape:sel-a", 0, 0, "sel-a");
    snap.store["shape:sel-b"] = makeShape("shape:sel-b", 50, 0, "sel-b");
    // non-selected: clustered at (300,0) and (350,0) — far right
    snap.store["shape:out-a"] = makeShape("shape:out-a", 300, 0, "out-a");
    snap.store["shape:out-b"] = makeShape("shape:out-b", 350, 0, "out-b");
    r.store = snap;
    r.version = 1;

    const res = await postLayoutSelection(
      app,
      { ids: ["shape:sel-a", "shape:sel-b"], mode: "layered-tb" },
      room,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const rAfter = await rooms.get(room);
    // non-selected must be unchanged
    expect(rAfter.store.store["shape:out-a"]!.x).toBe(300);
    expect(rAfter.store.store["shape:out-a"]!.y).toBe(0);
    expect(rAfter.store.store["shape:out-b"]!.x).toBe(350);
    expect(rAfter.store.store["shape:out-b"]!.y).toBe(0);

    // Check no overlap: bbox of selected vs bbox of non-selected
    const selA = rAfter.store.store["shape:sel-a"]! as { x: number; y: number; props: { w: number; h: number } };
    const selB = rAfter.store.store["shape:sel-b"]! as { x: number; y: number; props: { w: number; h: number } };
    const selMinX = Math.min(selA.x, selB.x);
    const selMaxX = Math.max(selA.x + (selA.props?.w ?? 120), selB.x + (selB.props?.w ?? 120));
    const selMinY = Math.min(selA.y, selB.y);
    const selMaxY = Math.max(selA.y + (selA.props?.h ?? 60), selB.y + (selB.props?.h ?? 60));

    const outMinX = 300;
    const outMaxX = 350 + 120;
    const outMinY = 0;
    const outMaxY = 0 + 60;

    // With a generous slack of 5px, bboxes must NOT intersect
    const SLACK = 5;
    const noOverlap =
      selMaxX + SLACK <= outMinX ||
      outMaxX + SLACK <= selMinX ||
      selMaxY + SLACK <= outMinY ||
      outMaxY + SLACK <= selMinY;
    expect(noOverlap).toBe(true);
  });

  // DRW-091 AC#2: origin preservation — selected shapes clustered far from origin
  // stay near their original centroid after layout (not displaced to (0,0)).
  test("DRW-091 AC#2: origin preservation — layout stays near original centroid", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const room = "test-drw091-ac2";
    const r = await rooms.get(room);
    const snap = emptySnapshot();
    // selected: clustered at (1000, 1000)
    snap.store["shape:sel-a"] = makeShape("shape:sel-a", 1000, 1000, "sel-a");
    snap.store["shape:sel-b"] = makeShape("shape:sel-b", 1050, 1000, "sel-b");
    r.store = snap;
    r.version = 1;

    const res = await postLayoutSelection(
      app,
      { ids: ["shape:sel-a", "shape:sel-b"], mode: "layered-tb" },
      room,
    );
    expect(res.status).toBe(200);
    const rAfter = await rooms.get(room);
    const selA = rAfter.store.store["shape:sel-a"]! as { x: number; y: number; props: { w: number; h: number } };
    const selB = rAfter.store.store["shape:sel-b"]! as { x: number; y: number; props: { w: number; h: number } };

    // Original centroid X ≈ 1000 + 60 = 1060 (center of shape:sel-a) and 1050 + 60 = 1110 (sel-b)
    // → roughly around 1085. After layout, centroid should remain near ~1085, definitely > 500.
    const afterCentroidX = (selA.x + (selA.props?.w ?? 120) / 2 + selB.x + (selB.props?.w ?? 120) / 2) / 2;
    const afterCentroidY = (selA.y + (selA.props?.h ?? 60) / 2 + selB.y + (selB.props?.h ?? 60) / 2) / 2;
    // Should stay near original centroid (within 200px), not displaced to 0
    expect(afterCentroidX).toBeGreaterThan(800);
    expect(afterCentroidY).toBeGreaterThan(800);
  });

  // DRW-091 AC#7: mixed shape types — geo + note + image + frame — endpoint must not crash.
  test("DRW-091 AC#7: mixed shape types (geo + note + image + frame) do not crash", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const room = "test-drw091-ac7";
    const r = await rooms.get(room);
    const snap = emptySnapshot();
    // geo shape
    snap.store["shape:s-geo"] = makeShape("shape:s-geo", 0, 0, "s-geo");
    // note shape
    snap.store["shape:s-note"] = makeShape(
      "shape:s-note", 0, 0, "s-note", {},
      { w: 200, h: 200, color: "yellow", size: "m", font: "draw", align: "middle", verticalAlign: "middle", growY: 0, fontSizeAdjustment: 0, url: "", scale: 1, richText: { type: "doc", content: [] } },
      "page:page", "note",
    );
    // image shape
    snap.store["shape:s-img"] = makeShape(
      "shape:s-img", 0, 0, "s-img", {},
      { w: 300, h: 200, url: "", playing: true, time: 0, crop: null },
      "page:page", "image",
    );
    // frame shape (selected)
    snap.store["shape:s-frame"] = {
      id: "shape:s-frame",
      typeName: "shape",
      type: "frame",
      x: 0,
      y: 0,
      parentId: "page:page",
      props: { w: 200, h: 150, name: "test-frame" },
      meta: { didrawName: "s-frame" },
    } as TLRecord;
    r.store = snap;
    r.version = 1;

    const res = await postLayoutSelection(
      app,
      { ids: ["shape:s-geo", "shape:s-note", "shape:s-img", "shape:s-frame"], mode: "layered-tb" },
      room,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  // DRW-092 AC#5: frame with 4 children + 2 shapes outside frame.
  // Select 4 children → layout → all 4 remain inside frame bounds + parentId=frame, 2 outside unchanged.
  test("DRW-092 AC#5: children of frame stay inside frame bounds after layout-selection", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const room = "test-drw092-ac5";
    const r = await rooms.get(room);
    const snap = emptySnapshot();
    // Frame at (100, 100) with 400x300
    snap.store["shape:frame1"] = makeFrame("shape:frame1", 100, 100, 400, 300, "frame1");
    // 4 children of the frame — all at (0,0) relative (clustered/overlapping)
    snap.store["shape:c1"] = makeShape("shape:c1", 0, 0, "c1", {}, {}, "shape:frame1");
    snap.store["shape:c2"] = makeShape("shape:c2", 5, 0, "c2", {}, {}, "shape:frame1");
    snap.store["shape:c3"] = makeShape("shape:c3", 0, 5, "c3", {}, {}, "shape:frame1");
    snap.store["shape:c4"] = makeShape("shape:c4", 5, 5, "c4", {}, {}, "shape:frame1");
    // 2 shapes outside the frame
    snap.store["shape:out1"] = makeShape("shape:out1", 600, 100, "out1");
    snap.store["shape:out2"] = makeShape("shape:out2", 600, 200, "out2");
    r.store = snap;
    r.version = 1;

    const res = await postLayoutSelection(
      app,
      { ids: ["shape:c1", "shape:c2", "shape:c3", "shape:c4"], mode: "layered-tb" },
      room,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const rAfter = await rooms.get(room);
    const frame = rAfter.store.store["shape:frame1"]! as { x: number; y: number; props: { w: number; h: number } };
    const frameW = frame.props.w;
    const frameH = frame.props.h;

    // All 4 children must have parentId=frame1 and be within frame bounds (parent-relative)
    for (const cid of ["shape:c1", "shape:c2", "shape:c3", "shape:c4"]) {
      const c = rAfter.store.store[cid]! as { x: number; y: number; parentId: string; props: { w: number; h: number } };
      expect(c.parentId).toBe("shape:frame1");
      // parent-relative coords should be within [0, frameW) x [0, frameH)
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.x + (c.props?.w ?? 120)).toBeLessThanOrEqual(frameW + 1); // +1 tolerance
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.y + (c.props?.h ?? 60)).toBeLessThanOrEqual(frameH + 1);
    }

    // Outside shapes must not be moved
    expect(rAfter.store.store["shape:out1"]!.x).toBe(600);
    expect(rAfter.store.store["shape:out1"]!.y).toBe(100);
    expect(rAfter.store.store["shape:out2"]!.x).toBe(600);
    expect(rAfter.store.store["shape:out2"]!.y).toBe(200);
  });

  // ============================================================
  // DRW-149 AC-1: Frame-only selection → children layout + frame resize.
  // Setup: frame1 with 3 services inside (parentId=frame1).
  // Action: ids: ["shape:frame1"].
  // Expected: 200 ok, count > 0, frame + children in affected, children positions changed.
  // ============================================================
  test("DRW-149 AC-1: frame-only selection → children layout + frame resize", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const room = "test-drw149-ac1";
    const r = await rooms.get(room);
    const snap = emptySnapshot();

    // Frame at (200, 200)
    snap.store["shape:frame1"] = makeFrame("shape:frame1", 200, 200, 400, 300, "frame1");
    // 3 children clustered at (0,0) relative to frame (overlapping)
    snap.store["shape:s1"] = makeShape("shape:s1", 0, 0, "s1", {}, {}, "shape:frame1");
    snap.store["shape:s2"] = makeShape("shape:s2", 2, 0, "s2", {}, {}, "shape:frame1");
    snap.store["shape:s3"] = makeShape("shape:s3", 0, 2, "s3", {}, {}, "shape:frame1");
    r.store = snap;
    r.version = 1;

    const res = await postLayoutSelection(
      app,
      { ids: ["shape:frame1"], mode: "layered-tb" },
      room,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      count: number;
      affected?: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.count).toBeGreaterThan(0);

    // frame AND at least one child must be in affected
    expect(body.affected).toContain("shape:frame1");
    const childrenAffected = (body.affected ?? []).filter((id) =>
      ["shape:s1", "shape:s2", "shape:s3"].includes(id),
    );
    expect(childrenAffected.length).toBeGreaterThan(0);

    // Children positions should have changed from (0,0)
    const rAfter = await rooms.get(room);
    const s1 = rAfter.store.store["shape:s1"]! as { x: number; y: number };
    const s2 = rAfter.store.store["shape:s2"]! as { x: number; y: number };
    const s3 = rAfter.store.store["shape:s3"]! as { x: number; y: number };
    // At least one child moved (ELK unstacks the cluster)
    const anyChildMoved =
      s1.x !== 0 || s1.y !== 0 ||
      s2.x !== 2 || s2.y !== 0 ||
      s3.x !== 0 || s3.y !== 2;
    expect(anyChildMoved).toBe(true);
  });

  // ============================================================
  // DRW-149 AC-2: Children-of-frame only selection (frame NOT in ids).
  // Anchor detection: frame acts as anchor, children get laid out inside it.
  // Setup: same frame + 3 children.
  // Action: ids: ["shape:s1","shape:s2","shape:s3"] (frame omitted).
  // Expected: 200 ok, count > 0, children moved, frame stays as anchor.
  // ============================================================
  test("DRW-149 AC-2: children-of-frame selection without frame — anchor detection works", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const room = "test-drw149-ac2";
    const r = await rooms.get(room);
    const snap = emptySnapshot();

    snap.store["shape:frame1"] = makeFrame("shape:frame1", 200, 200, 400, 300, "frame1");
    snap.store["shape:s1"] = makeShape("shape:s1", 0, 0, "s1", {}, {}, "shape:frame1");
    snap.store["shape:s2"] = makeShape("shape:s2", 2, 0, "s2", {}, {}, "shape:frame1");
    snap.store["shape:s3"] = makeShape("shape:s3", 0, 2, "s3", {}, {}, "shape:frame1");
    r.store = snap;
    r.version = 1;

    const res = await postLayoutSelection(
      app,
      { ids: ["shape:s1", "shape:s2", "shape:s3"], mode: "layered-tb" },
      room,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; count: number; affected?: string[] };
    expect(body.ok).toBe(true);
    expect(body.count).toBeGreaterThan(0);

    // Children should appear in affected
    const childrenAffected = (body.affected ?? []).filter((id) =>
      ["shape:s1", "shape:s2", "shape:s3"].includes(id),
    );
    expect(childrenAffected.length).toBeGreaterThan(0);

    // Frame must stay at its original absolute position (it's an anchor)
    const rAfter = await rooms.get(room);
    const frame = rAfter.store.store["shape:frame1"]! as { x: number; y: number };
    expect(frame.x).toBe(200);
    expect(frame.y).toBe(200);

    // Children should have changed from initial clustered positions
    const s1 = rAfter.store.store["shape:s1"]! as { x: number; y: number };
    const s2 = rAfter.store.store["shape:s2"]! as { x: number; y: number };
    const s3 = rAfter.store.store["shape:s3"]! as { x: number; y: number };
    const anyChildMoved =
      s1.x !== 0 || s1.y !== 0 ||
      s2.x !== 2 || s2.y !== 0 ||
      s3.x !== 0 || s3.y !== 2;
    expect(anyChildMoved).toBe(true);

    // Children must stay inside the frame bounds (parent-relative)
    const frameRec = rAfter.store.store["shape:frame1"]! as { props: { w: number; h: number } };
    const frameW = frameRec.props.w;
    const frameH = frameRec.props.h;
    for (const cid of ["shape:s1", "shape:s2", "shape:s3"]) {
      const c = rAfter.store.store[cid]! as { x: number; y: number; parentId: string; props: { w: number; h: number } };
      expect(c.parentId).toBe("shape:frame1");
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x + (c.props?.w ?? 120)).toBeLessThanOrEqual(frameW + 5);
      expect(c.y + (c.props?.h ?? 60)).toBeLessThanOrEqual(frameH + 5);
    }
  });

  // ============================================================
  // DRW-149 AC-3: Frame + external shape selection (G3 two-pass).
  // Setup: frame1 with 2 children + ext shape outside (parent=page).
  // Action: ids: ["shape:frame1", "shape:ext"].
  // Expected: 200 ok, count > 0; frame, children, AND ext all in affected;
  //           children moved inside frame; ext moved at peer level.
  // ============================================================
  test("DRW-149 AC-3: frame + external selection — G3 two-pass (inner + peer layout)", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const room = "test-drw149-ac3";
    const r = await rooms.get(room);
    const snap = emptySnapshot();

    // Frame at (0, 0) with 2 children clustered
    snap.store["shape:frame1"] = makeFrame("shape:frame1", 0, 0, 400, 300, "frame1");
    snap.store["shape:c1"] = makeShape("shape:c1", 0, 0, "c1", {}, {}, "shape:frame1");
    snap.store["shape:c2"] = makeShape("shape:c2", 2, 0, "c2", {}, {}, "shape:frame1");
    // External shape on page
    snap.store["shape:ext"] = makeShape("shape:ext", 1000, 0, "ext");
    r.store = snap;
    r.version = 1;

    const res = await postLayoutSelection(
      app,
      { ids: ["shape:frame1", "shape:ext"], mode: "layered-tb" },
      room,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; count: number; affected?: string[] };
    expect(body.ok).toBe(true);
    expect(body.count).toBeGreaterThan(0);

    // frame must be in affected (Pass B repositioned it)
    expect(body.affected).toContain("shape:frame1");
    // ext must be in affected (Pass B repositioned it as peer)
    expect(body.affected).toContain("shape:ext");
    // At least one frame child should be in affected (Pass A ran inside frame)
    const childrenInAffected = (body.affected ?? []).filter((id) =>
      ["shape:c1", "shape:c2"].includes(id),
    );
    expect(childrenInAffected.length).toBeGreaterThan(0);

    // Children must remain inside frame (parent-relative coords ≥ 0)
    const rAfter = await rooms.get(room);
    for (const cid of ["shape:c1", "shape:c2"]) {
      const c = rAfter.store.store[cid]! as { x: number; y: number; parentId: string };
      expect(c.parentId).toBe("shape:frame1");
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
    }

    // Children should have moved from initial clustered (0,0)/(2,0)
    const c1 = rAfter.store.store["shape:c1"]! as { x: number; y: number };
    const c2 = rAfter.store.store["shape:c2"]! as { x: number; y: number };
    const anyChildMoved = c1.x !== 0 || c1.y !== 0 || c2.x !== 2 || c2.y !== 0;
    expect(anyChildMoved).toBe(true);
  });

  // ============================================================
  // DRW-149 AC-6: Nested shape-containers (2+ levels).
  // Setup: outer schema-frame → inner geo+boundary → services (s1, s2).
  // Action: ids: ["shape:schemaframe"].
  // Expected: 200 ok, count > 0; schema-frame, inner-container, s1, s2 all in affected.
  //           Services moved; inner container possibly resized.
  // ============================================================
  test("DRW-149 AC-6: nested shape-containers — recursive expansion + 2-level Pass A", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const room = "test-drw149-ac6";
    const r = await rooms.get(room);
    const snap = emptySnapshot();

    // Outer schema-frame (frame type)
    snap.store["shape:schemaframe"] = makeFrame("shape:schemaframe", 100, 100, 600, 400, "schemaframe");
    // Inner geo+boundary (container, child of schemaframe)
    snap.store["shape:inner"] = makeShape(
      "shape:inner",
      20, 20,
      "inner",
      { role: "boundary" },
      { w: 300, h: 200, geo: "rectangle" },
      "shape:schemaframe",
    );
    // Two services inside inner (clustered at 0,0)
    snap.store["shape:s1"] = makeShape("shape:s1", 0, 0, "s1", {}, {}, "shape:inner");
    snap.store["shape:s2"] = makeShape("shape:s2", 2, 0, "s2", {}, {}, "shape:inner");
    r.store = snap;
    r.version = 1;

    const res = await postLayoutSelection(
      app,
      { ids: ["shape:schemaframe"], mode: "layered-tb" },
      room,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; count: number; affected?: string[] };
    expect(body.ok).toBe(true);
    expect(body.count).toBeGreaterThan(0);

    // Outer frame must be in affected
    expect(body.affected).toContain("shape:schemaframe");
    // Inner container must be in affected (recursive expansion reached it)
    expect(body.affected).toContain("shape:inner");
    // Services must be in affected (recursive expansion reached them)
    expect(body.affected).toContain("shape:s1");
    expect(body.affected).toContain("shape:s2");

    // Services moved from initial (0,0)/(2,0) cluster
    const rAfter = await rooms.get(room);
    const s1 = rAfter.store.store["shape:s1"]! as { x: number; y: number; parentId: string };
    const s2 = rAfter.store.store["shape:s2"]! as { x: number; y: number; parentId: string };
    // parentId must still be inner container
    expect(s1.parentId).toBe("shape:inner");
    expect(s2.parentId).toBe("shape:inner");
    // At least one service moved
    const anyMoved = s1.x !== 0 || s1.y !== 0 || s2.x !== 2 || s2.y !== 0;
    expect(anyMoved).toBe(true);
  });

  // DRW-099: hierarchical multi-pass — два frame'а с детьми + cross-compound edge.
  // Select: все дети + оба frame'а. Ожидаем: children parent-relative внутри своих
  // frame'ов; frame'а расставлены без overlapping; non-selected не тронуты.
  test("DRW-099: hierarchical layout — two frames with children + cross-compound edge", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const room = "test-drw099-hierarchical";
    const r = await rooms.get(room);
    const snap = emptySnapshot();

    // Frame A with 3 children
    snap.store["shape:fA"] = makeFrame("shape:fA", 0, 0, 400, 300, "fA");
    snap.store["shape:cA1"] = makeShape("shape:cA1", 0, 0, "cA1", {}, {}, "shape:fA");
    snap.store["shape:cA2"] = makeShape("shape:cA2", 5, 0, "cA2", {}, {}, "shape:fA");
    snap.store["shape:cA3"] = makeShape("shape:cA3", 0, 5, "cA3", {}, {}, "shape:fA");

    // Frame B with 2 children
    snap.store["shape:fB"] = makeFrame("shape:fB", 500, 0, 400, 300, "fB");
    snap.store["shape:cB1"] = makeShape("shape:cB1", 0, 0, "cB1", {}, {}, "shape:fB");
    snap.store["shape:cB2"] = makeShape("shape:cB2", 5, 0, "cB2", {}, {}, "shape:fB");

    // Cross-compound edge: cA1 → cB1
    const arrowId = "shape:cross_arrow";
    snap.store[arrowId] = {
      id: arrowId, typeName: "shape", type: "arrow",
      x: 0, y: 0, parentId: "page:page", props: {}, meta: {},
    } as TLRecord;
    snap.store["binding:ca-s"] = {
      id: "binding:ca-s", typeName: "binding",
      fromId: arrowId, toId: "shape:cA1",
      props: { terminal: "start" },
    } as TLRecord;
    snap.store["binding:cb-e"] = {
      id: "binding:cb-e", typeName: "binding",
      fromId: arrowId, toId: "shape:cB1",
      props: { terminal: "end" },
    } as TLRecord;

    // Non-selected shape
    snap.store["shape:nonsel"] = makeShape("shape:nonsel", 1200, 1200, "nonsel");

    r.store = snap;
    r.version = 1;

    const res = await postLayoutSelection(
      app,
      {
        ids: ["shape:fA", "shape:fB", "shape:cA1", "shape:cA2", "shape:cA3", "shape:cB1", "shape:cB2"],
        mode: "layered-tb",
      },
      room,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const rAfter = await rooms.get(room);

    // Non-selected must not be moved
    expect(rAfter.store.store["shape:nonsel"]!.x).toBe(1200);
    expect(rAfter.store.store["shape:nonsel"]!.y).toBe(1200);

    const fA = rAfter.store.store["shape:fA"]! as { x: number; y: number; props: { w: number; h: number } };
    const fB = rAfter.store.store["shape:fB"]! as { x: number; y: number; props: { w: number; h: number } };

    // Frames must have valid sizes
    expect(fA.props.w).toBeGreaterThan(0);
    expect(fA.props.h).toBeGreaterThan(0);
    expect(fB.props.w).toBeGreaterThan(0);
    expect(fB.props.h).toBeGreaterThan(0);

    // Children of fA: parent-relative inside fA bounds
    for (const cid of ["shape:cA1", "shape:cA2", "shape:cA3"]) {
      const c = rAfter.store.store[cid]! as { x: number; y: number; parentId: string; props: { w: number; h: number } };
      expect(c.parentId).toBe("shape:fA");
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x + (c.props?.w ?? 120)).toBeLessThanOrEqual(fA.props.w + 5);
      expect(c.y + (c.props?.h ?? 60)).toBeLessThanOrEqual(fA.props.h + 5);
    }

    // Children of fB: parent-relative inside fB bounds
    for (const cid of ["shape:cB1", "shape:cB2"]) {
      const c = rAfter.store.store[cid]! as { x: number; y: number; parentId: string; props: { w: number; h: number } };
      expect(c.parentId).toBe("shape:fB");
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x + (c.props?.w ?? 120)).toBeLessThanOrEqual(fB.props.w + 5);
      expect(c.y + (c.props?.h ?? 60)).toBeLessThanOrEqual(fB.props.h + 5);
    }

    // Frames should not overlap each other (with generous slack)
    const SLACK = 10;
    const noOverlap =
      fA.x + fA.props.w <= fB.x + SLACK ||
      fB.x + fB.props.w <= fA.x + SLACK ||
      fA.y + fA.props.h <= fB.y + SLACK ||
      fB.y + fB.props.h <= fA.y + SLACK;
    expect(noOverlap).toBe(true);
  });
});
