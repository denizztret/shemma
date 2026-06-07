/**
 * DRW-210: schema-group материализует контейнеры на доске.
 *
 * До фикса schema-group менял только mermaidSource (raw): generateMermaid
 * корректно эмитил членов внутри subgraph-блока, но на ДОСКЕ контейнеры не
 * создавались и члены не репарентились — «объедини сервисы в подгруппы»
 * визуально не делал ничего (live-репро 2026-06-07, drw-205-accept).
 */

import { describe, expect, test } from "bun:test";
import type { SchemaAction } from "@shemma/domain";
import type { TLRecord } from "../../store-types";
import type { RoomState } from "../../types";
import { applySchemaActions } from "./apply";

const SUFFIX_LEN = 6;
const FRAME = "shape:frame";

function makeRoom(extraStore: Record<string, TLRecord> = {}): RoomState {
  return {
    store: {
      schema: { schemaVersion: 1, storeVersion: 1, recordVersions: {} },
      store: {
        "page:page": { id: "page:page", typeName: "page" } as TLRecord,
        ...extraStore,
      },
    },
    opLog: [],
    prompts: [],
    version: 1,
    dirty: false,
    lastTouched: Date.now(),
    didrawIndex: new Map(),
  } as unknown as RoomState;
}

function makeFrame(mermaidSource: string): TLRecord {
  return {
    id: FRAME,
    typeName: "shape",
    type: "frame",
    x: 0,
    y: 0,
    parentId: "page:page",
    index: "a1",
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: { w: 1200, h: 800, name: "Test Frame" },
    meta: {
      didrawSchemaFrame: true,
      didrawProtocol: "v2",
      schemaProtocolVersion: "1.0",
      mermaidSource,
      didrawOverlays: {},
    },
  } as TLRecord;
}

function makeNode(
  shapeId: string,
  nodeId: string,
  label: string,
  x: number,
  y: number,
  parentId: string = FRAME,
): TLRecord {
  return {
    id: shapeId,
    typeName: "shape",
    type: "geo",
    x,
    y,
    parentId,
    index: "a1",
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: {
      w: 220,
      h: 80,
      geo: "rectangle",
      color: "blue",
      richText: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: label }] }],
      },
    },
    meta: { didrawId: nodeId, didrawLabel: label, didrawSchemaParent: FRAME },
  } as TLRecord;
}

function makeContainer(
  shapeId: string,
  groupName: string,
  label: string,
  x: number,
  y: number,
  w: number,
  h: number,
): TLRecord {
  return {
    id: shapeId,
    typeName: "shape",
    type: "schema-container",
    x,
    y,
    parentId: FRAME,
    index: "a1",
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: {
      w,
      h,
      name: label,
      direction: "TB",
      titlePosition: "inside-center",
      color: "grey",
      fill: "solid",
      dash: "dashed",
    },
    meta: {
      didrawSubgraph: true,
      didrawSubgraphId: groupName,
      didrawSubgraphName: label,
      didrawSchemaParent: FRAME,
    },
  } as TLRecord;
}

const FLAT_RAW = `graph LR
  svc-a-aaa001[Svc A]
  svc-b-aaa002[Svc B]
  svc-c-aaa003[Svc C]
  svc-a-aaa001 --> svc-b-aaa002`;

const GROUPED_RAW = `graph LR
  svc-c-aaa003[Svc C]
  subgraph api-layer [API Layer]
    svc-a-aaa001[Svc A]
    svc-b-aaa002[Svc B]
    svc-a-aaa001 --> svc-b-aaa002
  end`;

/** Найти единственный schema-container в added-части батча. */
function addedContainer(batch: {
  added: Record<string, TLRecord>;
}): TLRecord | undefined {
  return Object.values(batch.added).find(
    (s) => (s as { type?: string }).type === "schema-container",
  );
}

describe("schema-group materialization (DRW-210)", () => {
  test("group on a flat board: container added, members reparented, abs positions preserved", () => {
    const room = makeRoom({
      "shape:na": makeNode("shape:na", "svc-a-aaa001", "Svc A", 100, 100),
      "shape:nb": makeNode("shape:nb", "svc-b-aaa002", "Svc B", 400, 120),
      "shape:nc": makeNode("shape:nc", "svc-c-aaa003", "Svc C", 100, 400),
    });
    const frame = makeFrame(FLAT_RAW);
    room.store.store[FRAME] = frame as never;

    const actions: SchemaAction[] = [
      {
        kind: "schema-group",
        nodeIds: ["svc-a-aaa001", "svc-b-aaa002"],
        as: "boundary",
        name: "api-layer",
        label: "API Layer",
      },
    ];
    const res = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Container materialized on the board.
    const cont = addedContainer(res.batch);
    expect(cont).toBeDefined();
    if (!cont) return;
    expect(cont.parentId).toBe(FRAME);
    const cMeta = cont.meta as Record<string, unknown>;
    expect(cMeta.didrawSubgraph).toBe(true);
    expect(cMeta.didrawSubgraphId).toBe("api-layer");
    const cProps = cont.props as { w: number; h: number; name: string };
    expect(cProps.name).toBe("API Layer");

    const cx = cont.x as number;
    const cy = cont.y as number;

    // Members reparented into the container; absolute positions preserved.
    for (const [sid, abs] of [
      ["shape:na", { x: 100, y: 100 }],
      ["shape:nb", { x: 400, y: 120 }],
    ] as const) {
      const upd = res.batch.updated[sid];
      expect(upd).toBeDefined();
      if (!upd) continue;
      const rec = upd[1] as { parentId: string; x: number; y: number };
      expect(rec.parentId).toBe(cont.id);
      expect(cx + rec.x).toBeCloseTo(abs.x, 5);
      expect(cy + rec.y).toBeCloseTo(abs.y, 5);
      // Inside the container bounds.
      expect(rec.x).toBeGreaterThanOrEqual(0);
      expect(rec.y).toBeGreaterThanOrEqual(0);
      expect(rec.x + 220).toBeLessThanOrEqual(cProps.w + 1);
      expect(rec.y + 80).toBeLessThanOrEqual(cProps.h + 1);
    }

    // Non-member untouched.
    expect(res.batch.updated["shape:nc"]).toBeUndefined();

    // Raw: members emitted INSIDE the subgraph block.
    const sub = res.newRaw.slice(
      res.newRaw.indexOf("subgraph api-layer"),
      res.newRaw.indexOf("end"),
    );
    expect(sub).toContain("svc-a-aaa001[Svc A]");
    expect(sub).toContain("svc-b-aaa002[Svc B]");
    expect(sub).not.toContain("svc-c-aaa003");

    // Overlays: reparented members get their new parent-relative position
    // (otherwise reload-hydrate would snap them back to stale frame coords).
    const ovA = res.newOverlays["svc-a-aaa001"];
    const updA = res.batch.updated["shape:na"]?.[1] as { x: number; y: number };
    expect(ovA?.position).toEqual({ x: updA.x, y: updA.y });
  });

  test("idempotent: re-applying the same group is a no-op on the board", () => {
    const room = makeRoom({
      "shape:cont": makeContainer("shape:cont", "api-layer", "API Layer", 60, 28, 600, 240),
      "shape:na": makeNode("shape:na", "svc-a-aaa001", "Svc A", 40, 72, "shape:cont"),
      "shape:nb": makeNode("shape:nb", "svc-b-aaa002", "Svc B", 340, 92, "shape:cont"),
      "shape:nc": makeNode("shape:nc", "svc-c-aaa003", "Svc C", 100, 400),
    });
    const frame = makeFrame(GROUPED_RAW);
    room.store.store[FRAME] = frame as never;

    const actions: SchemaAction[] = [
      {
        kind: "schema-group",
        nodeIds: ["svc-a-aaa001", "svc-b-aaa002"],
        as: "boundary",
        name: "api-layer",
        label: "API Layer",
      },
    ];
    const res = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(addedContainer(res.batch)).toBeUndefined();
    expect(res.batch.updated["shape:na"]).toBeUndefined();
    expect(res.batch.updated["shape:nb"]).toBeUndefined();
    expect(Object.keys(res.batch.removed)).toEqual([]);
  });

  test("member leaves the group: reparented back to the frame, abs position preserved", () => {
    const room = makeRoom({
      "shape:cont": makeContainer("shape:cont", "api-layer", "API Layer", 60, 28, 600, 240),
      "shape:na": makeNode("shape:na", "svc-a-aaa001", "Svc A", 40, 72, "shape:cont"),
      "shape:nb": makeNode("shape:nb", "svc-b-aaa002", "Svc B", 340, 92, "shape:cont"),
      "shape:nc": makeNode("shape:nc", "svc-c-aaa003", "Svc C", 100, 400),
    });
    const frame = makeFrame(GROUPED_RAW);
    room.store.store[FRAME] = frame as never;

    const actions: SchemaAction[] = [
      {
        kind: "schema-group",
        nodeIds: ["svc-a-aaa001"],
        as: "boundary",
        name: "api-layer",
        label: "API Layer",
      },
    ];
    const res = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const upd = res.batch.updated["shape:nb"];
    expect(upd).toBeDefined();
    if (!upd) return;
    const rec = upd[1] as { parentId: string; x: number; y: number };
    expect(rec.parentId).toBe(FRAME);
    // Frame-relative abs: container(60,28) + member(340,92) = (400,120).
    expect(rec.x).toBeCloseTo(400, 5);
    expect(rec.y).toBeCloseTo(120, 5);

    // Raw: svc-b now declared at top level, not inside the block.
    const sub = res.newRaw.slice(
      res.newRaw.indexOf("subgraph api-layer"),
      res.newRaw.indexOf("end"),
    );
    expect(sub).not.toContain("svc-b-aaa002[Svc B]");
    expect(res.newRaw).toContain("svc-b-aaa002[Svc B]");
  });

  test("group dissolved (empty nodeIds): container removed, members back to the frame", () => {
    const room = makeRoom({
      "shape:cont": makeContainer("shape:cont", "api-layer", "API Layer", 60, 28, 600, 240),
      "shape:na": makeNode("shape:na", "svc-a-aaa001", "Svc A", 40, 72, "shape:cont"),
      "shape:nb": makeNode("shape:nb", "svc-b-aaa002", "Svc B", 340, 92, "shape:cont"),
      "shape:nc": makeNode("shape:nc", "svc-c-aaa003", "Svc C", 100, 400),
    });
    const frame = makeFrame(GROUPED_RAW);
    room.store.store[FRAME] = frame as never;

    const actions: SchemaAction[] = [
      {
        kind: "schema-group",
        nodeIds: [],
        as: "boundary",
        name: "api-layer",
        label: "API Layer",
      },
    ];
    const res = applySchemaActions({ room, frame, actions, suffixLen: SUFFIX_LEN });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.batch.removed["shape:cont"]).toBeDefined();
    for (const [sid, abs] of [
      ["shape:na", { x: 100, y: 100 }],
      ["shape:nb", { x: 400, y: 120 }],
    ] as const) {
      const upd = res.batch.updated[sid];
      expect(upd).toBeDefined();
      if (!upd) continue;
      const rec = upd[1] as { parentId: string; x: number; y: number };
      expect(rec.parentId).toBe(FRAME);
      expect(rec.x).toBeCloseTo(abs.x, 5);
      expect(rec.y).toBeCloseTo(abs.y, 5);
    }
    expect(res.newRaw).not.toContain("subgraph");
  });
});
