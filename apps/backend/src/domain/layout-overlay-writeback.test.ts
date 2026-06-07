// apps/backend/src/domain/layout-overlay-writeback.test.ts
//
// DRW-209: backend layout пишет финальные позиции didraw-узлов schema-фрейма
// в frame.meta.didrawOverlays (merge, тем же батчем). Без этого фронтовый
// hydrate (schema-overlay-hydrate.ts: overlay.position → shape.x/y) на reload
// показывает доску ДО layout — два источника правды (live-репро 2026-06-07:
// стор v843 — одна раскладка, reload — другая).

import { describe, expect, test } from "bun:test";
import type { OverlayEntry } from "@shemma/domain";
import { applyStoreChanges } from "../store-ops";
import type { TLStoreSnapshot } from "../store-types";
import { runLayout } from "./layout";

type Child = {
  id: string;
  nodeId: string;
  x: number;
  y: number;
  pinned?: boolean;
};

const CHILDREN: Child[] = [
  { id: "shape:n0", nodeId: "node-a-aaaaaa", x: 10, y: 10 },
  { id: "shape:n1", nodeId: "node-b-bbbbbb", x: 20, y: 20 },
  { id: "shape:n2", nodeId: "node-p-pppppp", x: 600, y: 500, pinned: true },
];

// Существующие overlays: stale-позиция + стиль у node-a (двигал юзер давно),
// у pinned-узла актуальная позиция; node-b записи не имеет вовсе.
const EXISTING_OVERLAYS: Record<string, OverlayEntry> = {
  "node-a-aaaaaa": { position: { x: 999, y: 999 }, color: "red" },
  "node-p-pppppp": { position: { x: 600, y: 500 }, pinned: true },
};

function snap(): TLStoreSnapshot {
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
      meta: {
        didrawSchemaFrame: true,
        didrawProtocol: "v2",
        schemaProtocolVersion: "1.0",
        mermaidSource: "graph LR\n  a --> b\n  b --> p",
        didrawOverlays: structuredClone(EXISTING_OVERLAYS),
      },
    },
  };
  for (const c of CHILDREN) {
    store[c.id] = {
      id: c.id,
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
        didrawId: c.nodeId,
        didrawLabel: c.nodeId,
        didrawSchemaParent: "shape:frame",
        ...(c.pinned ? { pinned: true } : {}),
      },
    };
  }
  // Chain arrows n0→n1→n2 (ELK edges).
  for (let i = 0; i < CHILDREN.length - 1; i++) {
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
      toId: CHILDREN[i]?.id,
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
      toId: CHILDREN[i + 1]?.id,
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

describe("layout overlay writeback (DRW-209)", () => {
  test("scope=all: final node positions mirrored into didrawOverlays, merge keeps fields", async () => {
    const s0 = snap();
    const res = await runLayout(
      s0,
      { mode: "layered-lr", scope: "all" },
      new Map(),
    );

    const frameUpd = res.batch.updated["shape:frame"];
    expect(frameUpd).toBeDefined();
    if (!frameUpd) return;
    // biome-ignore lint/suspicious/noExplicitAny: TLRecord union — test introspection
    const overlays = (frameUpd[1] as any).meta?.didrawOverlays as
      | Record<string, OverlayEntry>
      | undefined;
    expect(overlays).toBeDefined();
    if (!overlays) return;

    const finalOf = (id: string): { x: number; y: number } => {
      const upd = res.batch.updated[id];
      // biome-ignore lint/suspicious/noExplicitAny: TLRecord union — test introspection
      const rec = (
        upd ? upd[1] : (s0.store as Record<string, unknown>)[id]
      ) as any;
      return { x: rec.x, y: rec.y };
    };

    // node-a: stale-позиция заменена финальной, color сохранён (merge).
    expect(overlays["node-a-aaaaaa"]?.position).toEqual(finalOf("shape:n0"));
    expect(overlays["node-a-aaaaaa"]?.color).toBe("red");
    // node-b: записи не было — создана с финальной позицией.
    expect(overlays["node-b-bbbbbb"]?.position).toEqual(finalOf("shape:n1"));
    // pinned: позиция не изменилась, pinned-флаг сохранён.
    expect(overlays["node-p-pppppp"]?.position).toEqual({ x: 600, y: 500 });
    expect(overlays["node-p-pppppp"]?.pinned).toBe(true);
  });

  test("fixpoint guard: re-run after apply produces an empty batch (no overlay churn)", async () => {
    const s0 = snap();
    const r1 = await runLayout(
      s0,
      { mode: "layered-lr", scope: "all" },
      new Map(),
    );
    const s1 = applyStoreChanges(s0, r1.batch);
    const r2 = await runLayout(
      s1,
      { mode: "layered-lr", scope: "all" },
      new Map(),
    );
    expect(Object.keys(r2.batch.updated)).toEqual([]);
  });
});
