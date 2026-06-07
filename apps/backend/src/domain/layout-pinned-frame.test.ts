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
});
