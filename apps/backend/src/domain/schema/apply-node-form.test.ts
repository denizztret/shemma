/**
 * DRW-215: объектное форматирование — geo-форма/opacity узлов, стили
 * контейнеров (schema-set-container-style) и фрейма (schema-set-frame-style).
 */

import { describe, expect, test } from "bun:test";
import type { SchemaAction } from "@shemma/domain";
import type { TLRecord } from "../../store-types";
import type { RoomState } from "../../types";
import { applySchemaActions } from "./apply";

const SUFFIX_LEN = 6;
const FRAME = "shape:frame";
const RAW = `graph LR
  svc-a-aaa001[Svc A]
  subgraph api-layer [API Layer]
    svc-b-aaa002[Svc B]
  end`;

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
    props: { w: 1200, h: 800, name: "Test Frame", color: "black" },
    meta: {
      didrawSchemaFrame: true,
      didrawProtocol: "v2",
      schemaProtocolVersion: "1.0",
      mermaidSource: RAW,
      didrawOverlays: {},
    },
  } as TLRecord;
}

function makeNode(
  shapeId: string,
  nodeId: string,
  label: string,
  parentId: string = FRAME,
): TLRecord {
  return {
    id: shapeId,
    typeName: "shape",
    type: "geo",
    x: 100,
    y: 100,
    parentId,
    index: "a1",
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: { w: 220, h: 80, geo: "rectangle", color: "blue" },
    meta: { didrawId: nodeId, didrawLabel: label, didrawSchemaParent: FRAME },
  } as TLRecord;
}

function makeContainer(
  shapeId: string,
  groupName: string,
  label: string,
): TLRecord {
  return {
    id: shapeId,
    typeName: "shape",
    type: "schema-container",
    x: 400,
    y: 40,
    parentId: FRAME,
    index: "a1",
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: {
      w: 400,
      h: 300,
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

function baseStore(): Record<string, TLRecord> {
  return {
    "shape:na": makeNode("shape:na", "svc-a-aaa001", "Svc A"),
    "shape:cont": makeContainer("shape:cont", "api-layer", "API Layer"),
    "shape:nb": makeNode("shape:nb", "svc-b-aaa002", "Svc B", "shape:cont"),
  };
}

describe("node geo form + opacity (DRW-215)", () => {
  test("set-overlay{geo, opacity} remodels the existing node", () => {
    const room = makeRoom(baseStore());
    const frame = makeFrame();
    room.store.store[FRAME] = frame as never;

    const actions: SchemaAction[] = [
      {
        kind: "schema-set-overlay",
        nodeId: "svc-a-aaa001",
        overlay: { geo: "ellipse", opacity: 0.5 },
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

    const upd = res.batch.updated["shape:na"];
    expect(upd).toBeDefined();
    if (!upd) return;
    const rec = upd[1] as { opacity: number; props: Record<string, unknown> };
    expect(rec.props.geo).toBe("ellipse");
    expect(rec.opacity).toBe(0.5);
  });

  test("define + set-overlay{geo, opacity} seeds the new node", () => {
    const room = makeRoom(baseStore());
    const frame = makeFrame();
    room.store.store[FRAME] = frame as never;

    const actions: SchemaAction[] = [
      {
        kind: "schema-define",
        nodeId: "cloud-zz0001",
        role: "external",
        label: "Cloud",
      },
      {
        kind: "schema-set-overlay",
        nodeId: "cloud-zz0001",
        overlay: { geo: "cloud", opacity: 0.7 },
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

    const shape = Object.values(res.batch.added).find(
      (s) =>
        (s as { meta?: Record<string, unknown> }).meta?.didrawId ===
        "cloud-zz0001",
    ) as { opacity: number; props: Record<string, unknown> } | undefined;
    expect(shape).toBeDefined();
    expect(shape?.props.geo).toBe("cloud");
    expect(shape?.opacity).toBe(0.7);
  });
});

describe("container style (DRW-215)", () => {
  test("schema-set-container-style restyles the live container", () => {
    const room = makeRoom(baseStore());
    const frame = makeFrame();
    room.store.store[FRAME] = frame as never;

    const actions: SchemaAction[] = [
      {
        kind: "schema-set-container-style",
        name: "api-layer",
        style: {
          color: "orange",
          fill: "semi",
          titlePosition: "outside-banner",
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

    const upd = res.batch.updated["shape:cont"];
    expect(upd).toBeDefined();
    if (!upd) return;
    const props = (upd[1] as { props: Record<string, unknown> }).props;
    expect(props.color).toBe("orange");
    expect(props.fill).toBe("semi");
    expect(props.titlePosition).toBe("outside-banner");
    // name (label) не тронут — это территория schema-group.
    expect(props.name).toBe("API Layer");
  });

  test("unknown group → unknown-shape", () => {
    const room = makeRoom(baseStore());
    const frame = makeFrame();
    room.store.store[FRAME] = frame as never;

    const res = applySchemaActions({
      room,
      frame,
      actions: [
        {
          kind: "schema-set-container-style",
          name: "nope-layer",
          style: { color: "red" },
        },
      ],
      suffixLen: SUFFIX_LEN,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0]?.code).toBe("unknown-shape");
  });

  test("styles a container materialized by schema-group in the same batch", () => {
    const room = makeRoom({
      "shape:na": makeNode("shape:na", "svc-a-aaa001", "Svc A"),
      "shape:nb": makeNode("shape:nb", "svc-b-aaa002", "Svc B"),
    });
    const frame = makeFrame();
    // Плоский raw — группы ещё нет.
    (frame.meta as Record<string, unknown>).mermaidSource = `graph LR
  svc-a-aaa001[Svc A]
  svc-b-aaa002[Svc B]`;
    room.store.store[FRAME] = frame as never;

    const actions: SchemaAction[] = [
      {
        kind: "schema-group",
        nodeIds: ["svc-b-aaa002"],
        as: "boundary",
        name: "data-layer",
        label: "Data Layer",
      },
      {
        kind: "schema-set-container-style",
        name: "data-layer",
        style: { color: "green" },
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

    const cont = Object.values(res.batch.added).find(
      (s) => (s as { type?: string }).type === "schema-container",
    ) as { props: Record<string, unknown> } | undefined;
    expect(cont).toBeDefined();
    expect(cont?.props.color).toBe("green");
  });
});

describe("frame style (DRW-215)", () => {
  test("schema-set-frame-style updates frame color and label", () => {
    const room = makeRoom(baseStore());
    const frame = makeFrame();
    room.store.store[FRAME] = frame as never;

    const actions: SchemaAction[] = [
      {
        kind: "schema-set-frame-style",
        style: { color: "violet", label: "Shop Platform v2" },
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

    const upd = res.batch.updated[FRAME];
    expect(upd).toBeDefined();
    if (!upd) return;
    const props = (upd[1] as { props: Record<string, unknown> }).props;
    expect(props.color).toBe("violet");
    expect(props.name).toBe("Shop Platform v2");
  });
});
