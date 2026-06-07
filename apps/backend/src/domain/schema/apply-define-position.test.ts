/**
 * DRW-213: define + set-overlay{position} в одном батче ставит узел в
 * указанную точку. Раньше overlay читался из состояния ДО батча — smart-insert
 * перебивал явную позицию, узел ложился по эвристике.
 */

import { describe, expect, test } from "bun:test";
import type { SchemaAction } from "@shemma/domain";
import type { TLRecord } from "../../store-types";
import type { RoomState } from "../../types";
import { applySchemaActions } from "./apply";

const SUFFIX_LEN = 6;
const FRAME = "shape:frame";
const RAW = `graph LR
  svc-a-aaa001[Svc A]`;

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

function makeFrame(): TLRecord {
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
      mermaidSource: RAW,
      didrawOverlays: {},
    },
  } as TLRecord;
}

function makeNode(shapeId: string, nodeId: string, label: string): TLRecord {
  return {
    id: shapeId,
    typeName: "shape",
    type: "geo",
    x: 100,
    y: 100,
    parentId: FRAME,
    index: "a1",
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: { w: 220, h: 80, geo: "rectangle", color: "blue" },
    meta: { didrawId: nodeId, didrawLabel: label, didrawSchemaParent: FRAME },
  } as TLRecord;
}

function addedByNodeId(
  res: { batch: { added: Record<string, TLRecord> } },
  nodeId: string,
): TLRecord | undefined {
  return Object.values(res.batch.added).find(
    (s) => (s as { meta?: Record<string, unknown> }).meta?.didrawId === nodeId,
  );
}

describe("define with in-batch position (DRW-213)", () => {
  test("define + set-overlay{position} places the node exactly there", () => {
    const room = makeRoom({
      "shape:na": makeNode("shape:na", "svc-a-aaa001", "Svc A"),
    });
    const frame = makeFrame();
    room.store.store[FRAME] = frame as never;

    const actions: SchemaAction[] = [
      {
        kind: "schema-define",
        nodeId: "new-node-zz0001",
        role: "service",
        label: "New Node",
      },
      {
        kind: "schema-set-overlay",
        nodeId: "new-node-zz0001",
        overlay: { position: { x: 777, y: 444 } },
      },
    ];
    const res = applySchemaActions({
      room,
      frame,
      actions,
      suffixLen: SUFFIX_LEN,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const shape = addedByNodeId(res, "new-node-zz0001") as
      | { x: number; y: number }
      | undefined;
    expect(shape).toBeDefined();
    expect(shape?.x).toBe(777);
    expect(shape?.y).toBe(444);
  });

  test("explicitly positioned node beyond the frame grows the frame (fit)", () => {
    const room = makeRoom({
      "shape:na": makeNode("shape:na", "svc-a-aaa001", "Svc A"),
    });
    const frame = makeFrame();
    room.store.store[FRAME] = frame as never;

    const actions: SchemaAction[] = [
      {
        kind: "schema-define",
        nodeId: "far-node-zz0002",
        role: "service",
        label: "Far",
      },
      {
        kind: "schema-set-overlay",
        nodeId: "far-node-zz0002",
        overlay: { position: { x: 1500, y: 900 } },
      },
    ];
    const res = applySchemaActions({
      room,
      frame,
      actions,
      suffixLen: SUFFIX_LEN,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const frameUpd = res.batch.updated[FRAME];
    expect(frameUpd).toBeDefined();
    if (!frameUpd) return;
    const props = (frameUpd[1] as { props: { w: number; h: number } }).props;
    expect(props.w).toBeGreaterThanOrEqual(1500 + 220);
    expect(props.h).toBeGreaterThanOrEqual(900 + 80);
  });

  test("pinned:true in the same batch lands on the created shape", () => {
    const room = makeRoom({
      "shape:na": makeNode("shape:na", "svc-a-aaa001", "Svc A"),
    });
    const frame = makeFrame();
    room.store.store[FRAME] = frame as never;

    const actions: SchemaAction[] = [
      {
        kind: "schema-define",
        nodeId: "pin-node-zz0003",
        role: "service",
        label: "Pinned",
      },
      {
        kind: "schema-set-overlay",
        nodeId: "pin-node-zz0003",
        overlay: { position: { x: 500, y: 500 }, pinned: true },
      },
    ];
    const res = applySchemaActions({
      room,
      frame,
      actions,
      suffixLen: SUFFIX_LEN,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const shape = addedByNodeId(res, "pin-node-zz0003") as
      | { meta: Record<string, unknown> }
      | undefined;
    expect(shape).toBeDefined();
    expect(shape?.meta.pinned).toBe(true);
  });
});
