// apps/backend/src/domain/layout-pinned-frame.test.ts
//
// DRW-205 (приёмка 0.30.1): agent-triggered layout (shemma_layout → scope "all")
// на фрейме с pinned-детьми НЕ должен схлопывать фрейм вокруг ELK-компактного
// результата: пины после раскладки восстанавливаются в исходные координаты,
// и фрейм обязан их покрывать. Репро: фрейм сжимался до минимума, pinned-дети
// оказывались за рамкой (клиппились), see user screenshot 2026-06-07.

import { describe, expect, test } from "bun:test";
import type { TLStoreSnapshot } from "../store-types";
import { runLayout } from "./layout";

type Pin = { x: number; y: number; pinned?: boolean };

function frameStore(children: Pin[]): TLStoreSnapshot {
  const store: Record<string, unknown> = {
    "shape:frame": {
      id: "shape:frame",
      typeName: "shape",
      type: "frame",
      x: 100,
      y: 50,
      parentId: "page:page",
      index: "a1",
      isLocked: false,
      opacity: 1,
      rotation: 0,
      props: { w: 1600, h: 1000, name: "F" },
      meta: { didrawSchemaFrame: true },
    },
  };
  children.forEach((c, i) => {
    store[`shape:n${i}`] = {
      id: `shape:n${i}`,
      typeName: "shape",
      type: "geo",
      x: c.x,
      y: c.y,
      parentId: "shape:frame",
      index: "a1",
      isLocked: false,
      opacity: 1,
      rotation: 0,
      props: { geo: "rectangle", w: 220, h: 80 },
      meta: {
        didrawId: `node-${i}-aaaaaa`,
        didrawLabel: `Node ${i}`,
        ...(c.pinned ? { pinned: true } : {}),
      },
    };
  });
  // Chain arrows n0→n1→…
  for (let i = 0; i < children.length - 1; i++) {
    const aId = `shape:a${i}`;
    store[aId] = {
      id: aId,
      typeName: "shape",
      type: "arrow",
      x: 0,
      y: 0,
      parentId: "shape:frame",
      index: "a3",
      isLocked: false,
      opacity: 1,
      rotation: 0,
      props: {
        kind: "elbow",
        color: "black",
        fill: "none",
        dash: "draw",
        size: "m",
        labelColor: "black",
        font: "draw",
        start: { x: 0, y: 0 },
        end: { x: 0, y: 0 },
        bend: 0,
        elbowMidPoint: 0.5,
        labelPosition: 0.5,
        scale: 1,
        richText: { type: "doc", content: [{ type: "paragraph" }] },
        arrowheadStart: "none",
        arrowheadEnd: "arrow",
      },
      meta: {},
    };
    store[`binding:s${i}`] = {
      id: `binding:s${i}`,
      typeName: "binding",
      type: "arrow",
      fromId: aId,
      toId: `shape:n${i}`,
      props: {
        terminal: "start",
        normalizedAnchor: { x: 0.5, y: 0.5 },
        isExact: false,
        isPrecise: false,
        snap: "none",
      },
    };
    store[`binding:e${i}`] = {
      id: `binding:e${i}`,
      typeName: "binding",
      type: "arrow",
      fromId: aId,
      toId: `shape:n${i + 1}`,
      props: {
        terminal: "end",
        normalizedAnchor: { x: 0.5, y: 0.5 },
        isExact: false,
        isPrecise: false,
        snap: "none",
      },
    };
  }
  return {
    store: store as Record<string, never>,
    schema: {
      schemaVersion: 1,
      sequenceNumber: 0,
      storeVersion: 1,
      recordVersions: {},
    },
  } as unknown as TLStoreSnapshot;
}

type Box = { x: number; y: number; w: number; h: number };

/** Final frame-relative box of shape:nI after layout (updated or original). */
function finalBox(
  res: Awaited<ReturnType<typeof runLayout>>,
  snap: TLStoreSnapshot,
  i: number,
): Box {
  const upd = res.batch.updated[`shape:n${i}`];
  // biome-ignore lint/suspicious/noExplicitAny: TLRecord union — test introspection
  const rec = (upd ? upd[1] : snap.store[`shape:n${i}`]) as any;
  return { x: rec.x, y: rec.y, w: 220, h: 80 };
}

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  );
}

describe("agent layout vs pinned children (DRW-205)", () => {
  test("scope=all: frame covers restored pinned children, pins don't move", async () => {
    // 3 of 4 children pinned far apart (user arranged them); 1 unpinned.
    const original: Pin[] = [
      { x: 900, y: 700, pinned: true },
      { x: 1200, y: 100, pinned: true },
      { x: 600, y: 500, pinned: true },
      { x: 50, y: 50 },
    ];
    const snap = frameStore(original);
    const res = await runLayout(
      snap,
      { mode: "layered-lr", scope: "all" },
      new Map(),
    );

    // Pinned children must NOT move (pin discipline DRW-003).
    original.slice(0, 3).forEach((o, i) => {
      const upd = res.batch.updated[`shape:n${i}`];
      if (!upd) return; // untouched is fine
      // biome-ignore lint/suspicious/noExplicitAny: TLRecord union — test introspection
      const rec = upd[1] as any;
      expect({ i, x: rec.x, y: rec.y }).toEqual({ i, x: o.x, y: o.y });
    });

    // Frame must cover every pinned child's bounds (no collapse around the
    // compact ELK result).
    const frameUpd = res.batch.updated["shape:frame"];
    // biome-ignore lint/suspicious/noExplicitAny: TLRecord union — test introspection
    const fr = (frameUpd ? frameUpd[1] : snap.store["shape:frame"]) as any;
    const fw = fr.props.w as number;
    const fh = fr.props.h as number;
    for (const o of original.slice(0, 3)) {
      expect(fw).toBeGreaterThanOrEqual(o.x + 220);
      expect(fh).toBeGreaterThanOrEqual(o.y + 80);
    }

    // No child may end up at negative coords (escaping the frame top-left)
    // and EVERY child (including ones displaced away from pins, DRW-003) must
    // stay inside the resized frame.
    for (let i = 0; i < 4; i++) {
      const upd = res.batch.updated[`shape:n${i}`];
      // biome-ignore lint/suspicious/noExplicitAny: TLRecord union — test introspection
      const rec = (upd ? upd[1] : snap.store[`shape:n${i}`]) as any;
      expect(rec.x).toBeGreaterThanOrEqual(0);
      expect(rec.y).toBeGreaterThanOrEqual(0);
      expect(rec.x + 220).toBeLessThanOrEqual(fw + 1);
      expect(rec.y + 80).toBeLessThanOrEqual(fh + 1);
    }
  });

  // DRW-208: pins blanket the board → the old displacement fallback shoved
  // EVERY colliding node into one vertical column right of the pins (live
  // repro 2026-06-07: 21 of 23 nodes at x=2956). Displaced nodes must land
  // in the nearest free spot to their ELK position instead.
  test("scope=all: displaced nodes spread to nearest free slots, not a column", async () => {
    // 8 unpinned chain nodes FIRST (their ELK row lands at x≈0..2400, y≈40),
    // 6 pins blanket exactly that zone — several ELK positions are guaranteed
    // to collide with a pin and go through displacement.
    const original: Pin[] = [
      { x: 10, y: 10 },
      { x: 20, y: 20 },
      { x: 30, y: 30 },
      { x: 40, y: 40 },
      { x: 60, y: 60 },
      { x: 70, y: 70 },
      { x: 80, y: 80 },
      { x: 90, y: 90 },
      { x: 50, y: 50, pinned: true },
      { x: 450, y: 50, pinned: true },
      { x: 850, y: 50, pinned: true },
      { x: 50, y: 350, pinned: true },
      { x: 450, y: 350, pinned: true },
      { x: 850, y: 350, pinned: true },
    ];
    const res = await runLayout(
      frameStore(original),
      { mode: "layered-lr", scope: "all" },
      new Map(),
    );
    const snap = frameStore(original);

    // Pins must not move.
    original.slice(8).forEach((o, i) => {
      const b = finalBox(res, snap, i + 8);
      expect({ i: i + 8, x: b.x, y: b.y }).toEqual({
        i: i + 8,
        x: o.x,
        y: o.y,
      });
    });

    const freeBoxes = Array.from({ length: 8 }, (_, i) =>
      finalBox(res, snap, i),
    );
    const pinBoxes = Array.from({ length: 6 }, (_, i) =>
      finalBox(res, snap, i + 8),
    );

    // (a) Column signature: no 4+ unpinned nodes stacked at the same x.
    const byX = new Map<number, number>();
    for (const b of freeBoxes) byX.set(b.x, (byX.get(b.x) ?? 0) + 1);
    const maxSameX = Math.max(...byX.values());
    expect(maxSameX).toBeLessThan(4);

    // (b) No pairwise overlaps: node×node and node×pin.
    for (let i = 0; i < freeBoxes.length; i++) {
      const a = freeBoxes[i];
      if (!a) continue;
      for (let j = i + 1; j < freeBoxes.length; j++) {
        const b = freeBoxes[j];
        if (!b) continue;
        expect({ pair: `n${i}×n${j}`, overlap: overlaps(a, b) }).toEqual({
          pair: `n${i}×n${j}`,
          overlap: false,
        });
      }
      pinBoxes.forEach((p, j) => {
        expect({ pair: `n${i}×pin${j + 8}`, overlap: overlaps(a, p) }).toEqual({
          pair: `n${i}×pin${j + 8}`,
          overlap: false,
        });
      });
    }

    // (c) Everything inside the (possibly grown) frame, no negative coords.
    const frameUpd = res.batch.updated["shape:frame"];
    // biome-ignore lint/suspicious/noExplicitAny: TLRecord union — test introspection
    const fr = (frameUpd ? frameUpd[1] : snap.store["shape:frame"]) as any;
    for (const b of [...pinBoxes, ...freeBoxes]) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual((fr.props.w as number) + 1);
      expect(b.y + b.h).toBeLessThanOrEqual((fr.props.h as number) + 1);
    }

    // (d) Determinism: the same input yields the same final positions.
    const res2 = await runLayout(
      frameStore(original),
      { mode: "layered-lr", scope: "all" },
      new Map(),
    );
    for (let i = 0; i < original.length; i++) {
      expect({ i, ...finalBox(res2, snap, i) }).toEqual({
        i,
        ...finalBox(res, snap, i),
      });
    }
  });
});
