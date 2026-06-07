/**
 * DRW-211: объектная стилизация рёбер — schema-set-edge-overlay.
 *
 * Ребро адресуется направленной парой from→to; style-блок применяется к
 * живой стрелке сразу (batch.updated) и персистится в
 * frame.meta.didrawEdgeOverlays (через ApplyResult.newEdgeOverlays).
 */

import { describe, expect, test } from "bun:test";
import { type SchemaAction, edgeOverlayKey } from "@shemma/domain";
import type { TLRecord } from "../../store-types";
import type { RoomState } from "../../types";
import { applySchemaActions } from "./apply";

const SUFFIX_LEN = 6;
const FRAME = "shape:frame";
const RAW = `graph LR
  svc-a-aaa001[Svc A]
  svc-b-aaa002[Svc B]
  svc-a-aaa001 -->|calls| svc-b-aaa002`;

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

function makeFrame(
  mermaidSource: string,
  edgeOverlays: Record<string, unknown> = {},
): TLRecord {
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
      didrawEdgeOverlays: edgeOverlays,
    },
  } as TLRecord;
}

function makeNode(
  shapeId: string,
  nodeId: string,
  label: string,
  x: number,
): TLRecord {
  return {
    id: shapeId,
    typeName: "shape",
    type: "geo",
    x,
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

function makeArrow(
  arrowId: string,
  fromSid: string,
  toSid: string,
): Record<string, TLRecord> {
  return {
    [arrowId]: {
      id: arrowId,
      typeName: "shape",
      type: "arrow",
      x: 0,
      y: 0,
      parentId: FRAME,
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
        labelPosition: 0.5,
        scale: 1,
        richText: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "calls" }] },
          ],
        },
        arrowheadStart: "none",
        arrowheadEnd: "arrow",
      },
      meta: { connectionKind: "sync" },
    } as TLRecord,
    [`binding:s-${arrowId}`]: {
      id: `binding:s-${arrowId}`,
      typeName: "binding",
      type: "arrow",
      fromId: arrowId,
      toId: fromSid,
      props: { terminal: "start" },
    } as TLRecord,
    [`binding:e-${arrowId}`]: {
      id: `binding:e-${arrowId}`,
      typeName: "binding",
      type: "arrow",
      fromId: arrowId,
      toId: toSid,
      props: { terminal: "end" },
    } as TLRecord,
  };
}

const KEY = edgeOverlayKey("svc-a-aaa001", "svc-b-aaa002");

describe("schema-set-edge-overlay (DRW-211)", () => {
  test("restyles the live arrow and persists the entry", () => {
    const room = makeRoom({
      "shape:na": makeNode("shape:na", "svc-a-aaa001", "Svc A", 100),
      "shape:nb": makeNode("shape:nb", "svc-b-aaa002", "Svc B", 500),
      ...makeArrow("shape:ar1", "shape:na", "shape:nb"),
    });
    const frame = makeFrame(RAW);
    room.store.store[FRAME] = frame as never;

    const actions: SchemaAction[] = [
      {
        kind: "schema-set-edge-overlay",
        from: "svc-a-aaa001",
        to: "svc-b-aaa002",
        overlay: {
          color: "red",
          dash: "dashed",
          size: "l",
          kind: "arc",
          arrowheadEnd: "triangle",
          label: "pays",
        },
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

    const upd = res.batch.updated["shape:ar1"];
    expect(upd).toBeDefined();
    if (!upd) return;
    const props = (upd[1] as { props: Record<string, unknown> }).props;
    expect(props.color).toBe("red");
    expect(props.dash).toBe("dashed");
    expect(props.size).toBe("l");
    expect(props.kind).toBe("arc");
    expect(props.arrowheadEnd).toBe("triangle");
    expect(JSON.stringify(props.richText)).toContain("pays");

    expect(res.newEdgeOverlays[KEY]).toMatchObject({
      color: "red",
      dash: "dashed",
      size: "l",
      kind: "arc",
      arrowheadEnd: "triangle",
      label: "pays",
    });
  });

  test("merge keeps previously stored edge style fields", () => {
    const room = makeRoom({
      "shape:na": makeNode("shape:na", "svc-a-aaa001", "Svc A", 100),
      "shape:nb": makeNode("shape:nb", "svc-b-aaa002", "Svc B", 500),
      ...makeArrow("shape:ar1", "shape:na", "shape:nb"),
    });
    const frame = makeFrame(RAW, { [KEY]: { color: "red", size: "l" } });
    room.store.store[FRAME] = frame as never;

    const actions: SchemaAction[] = [
      {
        kind: "schema-set-edge-overlay",
        from: "svc-a-aaa001",
        to: "svc-b-aaa002",
        overlay: { dash: "dotted" },
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
    expect(res.newEdgeOverlays[KEY]).toMatchObject({
      color: "red",
      size: "l",
      dash: "dotted",
    });
  });

  test("unknown edge → validation error unknown-edge", () => {
    const room = makeRoom({
      "shape:na": makeNode("shape:na", "svc-a-aaa001", "Svc A", 100),
      "shape:nb": makeNode("shape:nb", "svc-b-aaa002", "Svc B", 500),
    });
    const frame = makeFrame(RAW);
    room.store.store[FRAME] = frame as never;

    const actions: SchemaAction[] = [
      {
        kind: "schema-set-edge-overlay",
        from: "svc-b-aaa002",
        to: "svc-a-aaa001", // reverse direction — edge does not exist
        overlay: { color: "red" },
      },
    ];
    const res = applySchemaActions({
      room,
      frame,
      actions,
      suffixLen: SUFFIX_LEN,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors[0]?.code).toBe("unknown-edge");
  });

  test("connect + set-edge-overlay in one batch is valid (pending edge)", () => {
    const room = makeRoom({
      "shape:na": makeNode("shape:na", "svc-a-aaa001", "Svc A", 100),
      "shape:nb": makeNode("shape:nb", "svc-b-aaa002", "Svc B", 500),
      ...makeArrow("shape:ar1", "shape:na", "shape:nb"),
    });
    const frame = makeFrame(RAW);
    room.store.store[FRAME] = frame as never;

    const actions: SchemaAction[] = [
      { kind: "schema-connect", from: "svc-b-aaa002", to: "svc-a-aaa001" },
      {
        kind: "schema-set-edge-overlay",
        from: "svc-b-aaa002",
        to: "svc-a-aaa001",
        overlay: { color: "green" },
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
    // Новая стрелка в батче получает stored style сразу.
    const newArrow = Object.values(res.batch.added).find(
      (s) => (s as { type?: string }).type === "arrow",
    ) as { props: Record<string, unknown> } | undefined;
    expect(newArrow).toBeDefined();
    expect(newArrow?.props.color).toBe("green");
  });

  test("re-added edge picks up the stored edge style", () => {
    // didrawEdgeOverlays держит стиль, ребра нет ни в raw, ни на доске.
    const flatRaw = `graph LR
  svc-a-aaa001[Svc A]
  svc-b-aaa002[Svc B]`;
    const room = makeRoom({
      "shape:na": makeNode("shape:na", "svc-a-aaa001", "Svc A", 100),
      "shape:nb": makeNode("shape:nb", "svc-b-aaa002", "Svc B", 500),
    });
    const frame = makeFrame(flatRaw, {
      [KEY]: { color: "violet", dash: "dotted" },
    });
    room.store.store[FRAME] = frame as never;

    const actions: SchemaAction[] = [
      { kind: "schema-connect", from: "svc-a-aaa001", to: "svc-b-aaa002" },
    ];
    const res = applySchemaActions({
      room,
      frame,
      actions,
      suffixLen: SUFFIX_LEN,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const newArrow = Object.values(res.batch.added).find(
      (s) => (s as { type?: string }).type === "arrow",
    ) as { props: Record<string, unknown> } | undefined;
    expect(newArrow).toBeDefined();
    expect(newArrow?.props.color).toBe("violet");
    expect(newArrow?.props.dash).toBe("dotted");
  });
});
