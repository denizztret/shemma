import { describe, expect, test } from "bun:test";
import type { TLRecord, TLStoreSnapshot } from "../store-types";
import { anchorForSide, computeAnchors, snapAngleToSide } from "./anchors";

const PI = Math.PI;

describe("snapAngleToSide", () => {
  test("angle 0 (east) → right", () => {
    expect(snapAngleToSide(0)).toBe("right");
  });
  test("angle π/2 (south, atan2 y-down) → bottom", () => {
    expect(snapAngleToSide(PI / 2)).toBe("bottom");
  });
  test("angle π (west) → left", () => {
    expect(snapAngleToSide(PI)).toBe("left");
  });
  test("angle -π/2 (north) → top", () => {
    expect(snapAngleToSide(-PI / 2)).toBe("top");
  });
  test("angle just past π/4 boundary → bottom (open lower bound)", () => {
    expect(snapAngleToSide(PI / 4 + 0.01)).toBe("bottom");
  });
  test("angle just before π/4 boundary → right (closed upper bound)", () => {
    expect(snapAngleToSide(PI / 4 - 0.01)).toBe("right");
  });
});

describe("anchorForSide", () => {
  test("top side, offset 0.5 → (0.5, 0)", () => {
    expect(anchorForSide("top", 0.5)).toEqual({ x: 0.5, y: 0 });
  });
  test("bottom side, offset 0.33 → (0.33, 1)", () => {
    expect(anchorForSide("bottom", 0.33)).toEqual({ x: 0.33, y: 1 });
  });
  test("left side, offset 0.25 → (0, 0.25)", () => {
    expect(anchorForSide("left", 0.25)).toEqual({ x: 0, y: 0.25 });
  });
  test("right side, offset 0.75 → (1, 0.75)", () => {
    expect(anchorForSide("right", 0.75)).toEqual({ x: 1, y: 0.75 });
  });
});

// ---- Store fixture helpers ----

let nextId = 0;
function freshId(prefix: string): string {
  return `${prefix}:${++nextId}`;
}

function makeStore(records: TLRecord[]): TLStoreSnapshot {
  const store: Record<string, TLRecord> = {};
  for (const r of records) store[r.id] = r;
  return {
    schema: { schemaVersion: 1, storeVersion: 1, recordVersions: {} },
    store,
  };
}

function makeShape(opts: {
  id?: string;
  type?: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  parentId?: string;
  meta?: Record<string, unknown>;
  props?: Record<string, unknown>;
}): TLRecord {
  return {
    id: opts.id ?? freshId("shape"),
    typeName: "shape",
    type: opts.type ?? "geo",
    x: opts.x,
    y: opts.y,
    parentId: opts.parentId ?? "page:page",
    props: { w: opts.w ?? 100, h: opts.h ?? 50, ...(opts.props ?? {}) },
    meta: opts.meta ?? {},
  };
}

function makeArrow(id: string, meta?: Record<string, unknown>): TLRecord {
  return {
    id,
    typeName: "shape",
    type: "arrow",
    x: 0,
    y: 0,
    parentId: "page:page",
    props: { kind: "arc" },
    meta: meta ?? {},
  };
}

function makeBinding(opts: {
  id: string;
  arrowId: string;
  toId: string;
  terminal: "start" | "end";
  isExact?: boolean;
  isPrecise?: boolean;
  anchor?: { x: number; y: number };
}): TLRecord {
  return {
    id: opts.id,
    typeName: "binding",
    type: "arrow",
    fromId: opts.arrowId,
    toId: opts.toId,
    props: {
      terminal: opts.terminal,
      normalizedAnchor: opts.anchor ?? { x: 0.5, y: 0.5 },
      isExact: opts.isExact ?? false,
      isPrecise: opts.isPrecise ?? false,
      snap: "none",
    },
    meta: {},
  };
}

describe("computeAnchors — basic distribution", () => {
  test("single arrow A → B (B to the right of A) → source side right, target side left", () => {
    const a = makeShape({ id: "shape:A", x: 0, y: 0, w: 100, h: 100 });
    const b = makeShape({ id: "shape:B", x: 300, y: 0, w: 100, h: 100 });
    const arrow = makeArrow("shape:arr1");
    const start = makeBinding({
      id: "binding:s1",
      arrowId: arrow.id,
      toId: a.id,
      terminal: "start",
    });
    const end = makeBinding({
      id: "binding:e1",
      arrowId: arrow.id,
      toId: b.id,
      terminal: "end",
    });
    const store = makeStore([a, b, arrow, start, end]);

    const batch = computeAnchors(store);
    const sourceUpdate = batch.updated["binding:s1"];
    const targetUpdate = batch.updated["binding:e1"];
    const arrowUpdate = batch.updated["shape:arr1"];

    expect(sourceUpdate).toBeDefined();
    expect(targetUpdate).toBeDefined();
    expect(arrowUpdate).toBeDefined();

    const sourceNew = sourceUpdate![1].props as {
      normalizedAnchor: { x: number; y: number };
      isPrecise: boolean;
    };
    expect(sourceNew.normalizedAnchor).toEqual({ x: 1, y: 0.5 });
    expect(sourceNew.isPrecise).toBe(true);

    const targetNew = targetUpdate![1].props as {
      normalizedAnchor: { x: number; y: number };
      isPrecise: boolean;
    };
    expect(targetNew.normalizedAnchor).toEqual({ x: 0, y: 0.5 });
    expect(targetNew.isPrecise).toBe(true);

    const arrowNew = arrowUpdate![1].meta as Record<string, unknown>;
    expect(arrowNew.didrawSourcePort).toBe("right");
    expect(arrowNew.didrawTargetPort).toBe("left");
  });

  test("hub with 3 outgoing arrows on right side → distributed (1/4, 2/4, 3/4)", () => {
    const hub = makeShape({ id: "shape:hub", x: 0, y: 0, w: 100, h: 300 });
    // 3 targets to the right at different y positions
    const t1 = makeShape({ id: "shape:t1", x: 400, y: 0, w: 50, h: 50 });
    const t2 = makeShape({ id: "shape:t2", x: 400, y: 125, w: 50, h: 50 });
    const t3 = makeShape({ id: "shape:t3", x: 400, y: 250, w: 50, h: 50 });

    const arrow1 = makeArrow("shape:arr1");
    const arrow2 = makeArrow("shape:arr2");
    const arrow3 = makeArrow("shape:arr3");
    const b1s = makeBinding({
      id: "binding:1s",
      arrowId: arrow1.id,
      toId: hub.id,
      terminal: "start",
    });
    const b1e = makeBinding({
      id: "binding:1e",
      arrowId: arrow1.id,
      toId: t1.id,
      terminal: "end",
    });
    const b2s = makeBinding({
      id: "binding:2s",
      arrowId: arrow2.id,
      toId: hub.id,
      terminal: "start",
    });
    const b2e = makeBinding({
      id: "binding:2e",
      arrowId: arrow2.id,
      toId: t2.id,
      terminal: "end",
    });
    const b3s = makeBinding({
      id: "binding:3s",
      arrowId: arrow3.id,
      toId: hub.id,
      terminal: "start",
    });
    const b3e = makeBinding({
      id: "binding:3e",
      arrowId: arrow3.id,
      toId: t3.id,
      terminal: "end",
    });

    const store = makeStore([
      hub,
      t1,
      t2,
      t3,
      arrow1,
      arrow2,
      arrow3,
      b1s,
      b1e,
      b2s,
      b2e,
      b3s,
      b3e,
    ]);
    const batch = computeAnchors(store);

    // All 3 hub-source bindings should be on right side, distributed by target y.
    const sources = ["binding:1s", "binding:2s", "binding:3s"].map((id) => {
      const u = batch.updated[id];
      return (u![1].props as { normalizedAnchor: { x: number; y: number } })
        .normalizedAnchor;
    });
    // Sorted by target y: t1 (y=0+25=25), t2 (y=125+25=150), t3 (y=250+25=275)
    expect(sources[0]).toEqual({ x: 1, y: 0.25 });
    expect(sources[1]).toEqual({ x: 1, y: 0.5 });
    expect(sources[2]).toEqual({ x: 1, y: 0.75 });
  });

  test("hub with 4 outgoing arrows on 4 different sides → 1 per side at 0.5", () => {
    const hub = makeShape({ id: "shape:hub", x: 100, y: 100, w: 100, h: 100 });
    // Targets in cardinal directions
    const tRight = makeShape({ id: "shape:tR", x: 400, y: 125, w: 50, h: 50 });
    const tBottom = makeShape({ id: "shape:tB", x: 125, y: 400, w: 50, h: 50 });
    const tLeft = makeShape({ id: "shape:tL", x: -200, y: 125, w: 50, h: 50 });
    const tTop = makeShape({ id: "shape:tT", x: 125, y: -200, w: 50, h: 50 });

    const ids = ["R", "B", "L", "T"];
    const targets = [tRight, tBottom, tLeft, tTop];
    const records: TLRecord[] = [hub, ...targets];
    for (let i = 0; i < 4; i++) {
      const arrow = makeArrow(`shape:arr${ids[i]}`);
      const start = makeBinding({
        id: `binding:s${ids[i]}`,
        arrowId: arrow.id,
        toId: hub.id,
        terminal: "start",
      });
      const end = makeBinding({
        id: `binding:e${ids[i]}`,
        arrowId: arrow.id,
        toId: targets[i]!.id,
        terminal: "end",
      });
      records.push(arrow, start, end);
    }
    const store = makeStore(records);
    const batch = computeAnchors(store);

    const portByArrow: Record<string, { source: string; target: string }> = {};
    for (const id of ids) {
      const meta = batch.updated[`shape:arr${id}`]![1].meta as Record<
        string,
        unknown
      >;
      portByArrow[id] = {
        source: meta.didrawSourcePort as string,
        target: meta.didrawTargetPort as string,
      };
    }
    expect(portByArrow.R).toEqual({ source: "right", target: "left" });
    expect(portByArrow.B).toEqual({ source: "bottom", target: "top" });
    expect(portByArrow.L).toEqual({ source: "left", target: "right" });
    expect(portByArrow.T).toEqual({ source: "top", target: "bottom" });
  });
});

describe("computeAnchors — preservation rules", () => {
  test("arrow with meta.styleOwnedBy=user → skipped (no updates)", () => {
    const a = makeShape({ id: "shape:A", x: 0, y: 0 });
    const b = makeShape({ id: "shape:B", x: 200, y: 0 });
    const arrow = makeArrow("shape:arr1", { styleOwnedBy: "user" });
    const start = makeBinding({
      id: "binding:s",
      arrowId: arrow.id,
      toId: a.id,
      terminal: "start",
    });
    const end = makeBinding({
      id: "binding:e",
      arrowId: arrow.id,
      toId: b.id,
      terminal: "end",
    });
    const store = makeStore([a, b, arrow, start, end]);
    const batch = computeAnchors(store);
    expect(Object.keys(batch.updated)).toHaveLength(0);
  });

  test("binding with isExact=true → skipped", () => {
    const a = makeShape({ id: "shape:A", x: 0, y: 0 });
    const b = makeShape({ id: "shape:B", x: 200, y: 0 });
    const arrow = makeArrow("shape:arr1");
    const start = makeBinding({
      id: "binding:s",
      arrowId: arrow.id,
      toId: a.id,
      terminal: "start",
      isExact: true,
    });
    const end = makeBinding({
      id: "binding:e",
      arrowId: arrow.id,
      toId: b.id,
      terminal: "end",
    });
    const store = makeStore([a, b, arrow, start, end]);
    const batch = computeAnchors(store);
    expect(Object.keys(batch.updated)).toHaveLength(0);
  });

  test("dangling arrow (only 1 binding) → skipped", () => {
    const a = makeShape({ id: "shape:A", x: 0, y: 0 });
    const arrow = makeArrow("shape:arr1");
    const start = makeBinding({
      id: "binding:s",
      arrowId: arrow.id,
      toId: a.id,
      terminal: "start",
    });
    const store = makeStore([a, arrow, start]);
    const batch = computeAnchors(store);
    expect(Object.keys(batch.updated)).toHaveLength(0);
  });

  test("missing endpoint shape → skipped", () => {
    const a = makeShape({ id: "shape:A", x: 0, y: 0 });
    const arrow = makeArrow("shape:arr1");
    const start = makeBinding({
      id: "binding:s",
      arrowId: arrow.id,
      toId: a.id,
      terminal: "start",
    });
    const end = makeBinding({
      id: "binding:e",
      arrowId: arrow.id,
      toId: "shape:missing",
      terminal: "end",
    });
    const store = makeStore([a, arrow, start, end]);
    const batch = computeAnchors(store);
    expect(Object.keys(batch.updated)).toHaveLength(0);
  });

  test("idempotent: re-running on already-computed store → empty batch", () => {
    const a = makeShape({ id: "shape:A", x: 0, y: 0, w: 100, h: 100 });
    const b = makeShape({ id: "shape:B", x: 300, y: 0, w: 100, h: 100 });
    const arrow = makeArrow("shape:arr1");
    const start = makeBinding({
      id: "binding:s",
      arrowId: arrow.id,
      toId: a.id,
      terminal: "start",
    });
    const end = makeBinding({
      id: "binding:e",
      arrowId: arrow.id,
      toId: b.id,
      terminal: "end",
    });
    const store = makeStore([a, b, arrow, start, end]);

    const batch1 = computeAnchors(store);
    expect(Object.keys(batch1.updated).length).toBeGreaterThan(0);

    // Apply batch1 changes to store
    for (const [id, [, newRec]] of Object.entries(batch1.updated)) {
      store.store[id] = newRec;
    }

    const batch2 = computeAnchors(store);
    expect(Object.keys(batch2.updated)).toHaveLength(0);
  });
});

describe("computeAnchors — arrowIds filter", () => {
  test("when arrowIds provided, only matching arrows are processed", () => {
    const a = makeShape({ id: "shape:A", x: 0, y: 0 });
    const b = makeShape({ id: "shape:B", x: 200, y: 0 });
    const c = makeShape({ id: "shape:C", x: 0, y: 200 });
    const arrow1 = makeArrow("shape:arr1");
    const arrow2 = makeArrow("shape:arr2");
    const records: TLRecord[] = [
      a,
      b,
      c,
      arrow1,
      arrow2,
      makeBinding({
        id: "binding:1s",
        arrowId: arrow1.id,
        toId: a.id,
        terminal: "start",
      }),
      makeBinding({
        id: "binding:1e",
        arrowId: arrow1.id,
        toId: b.id,
        terminal: "end",
      }),
      makeBinding({
        id: "binding:2s",
        arrowId: arrow2.id,
        toId: a.id,
        terminal: "start",
      }),
      makeBinding({
        id: "binding:2e",
        arrowId: arrow2.id,
        toId: c.id,
        terminal: "end",
      }),
    ];
    const store = makeStore(records);

    const batch = computeAnchors(store, new Set(["shape:arr1"]));
    expect(batch.updated["binding:1s"]).toBeDefined();
    expect(batch.updated["binding:1e"]).toBeDefined();
    expect(batch.updated["binding:2s"]).toBeUndefined();
    expect(batch.updated["binding:2e"]).toBeUndefined();
  });
});

describe("computeAnchors — coordinate space", () => {
  test("child shape in frame: anchor computed using absolute page-space center", () => {
    // Frame at (1000, 1000), child A at local (0, 0) inside frame → absolute (1000, 1000)
    // External shape B at (1300, 1000)
    // A's source should still be "right" (B is east of A in absolute space).
    const frame = makeShape({
      id: "shape:frame1",
      type: "frame",
      x: 1000,
      y: 1000,
      w: 200,
      h: 200,
    });
    const a = makeShape({
      id: "shape:A",
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      parentId: frame.id,
    });
    const b = makeShape({ id: "shape:B", x: 1300, y: 1000, w: 100, h: 100 });
    const arrow = makeArrow("shape:arr1");
    const start = makeBinding({
      id: "binding:s",
      arrowId: arrow.id,
      toId: a.id,
      terminal: "start",
    });
    const end = makeBinding({
      id: "binding:e",
      arrowId: arrow.id,
      toId: b.id,
      terminal: "end",
    });
    const store = makeStore([frame, a, b, arrow, start, end]);
    const batch = computeAnchors(store);
    const meta = batch.updated["shape:arr1"]![1].meta as Record<
      string,
      unknown
    >;
    expect(meta.didrawSourcePort).toBe("right");
    expect(meta.didrawTargetPort).toBe("left");
  });
});
