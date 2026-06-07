/**
 * DRW-212: управление не-схемными шейпами — adopt в схему и удаление.
 *
 * schema-adopt-shape: рукотворный шейп (без didrawId) получает identity/
 * role/label in-place (позиция/размер/вид сохраняются), узел появляется в raw.
 * schema-delete-shape: удаление не-схемного шейпа по tldraw id с каскадом
 * биндингов/висячих стрелок.
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

function makeSchemaNode(
  shapeId: string,
  nodeId: string,
  label: string,
): TLRecord {
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

/** Рукотворный шейп — НЕТ didraw-меты. */
function makeHandShape(shapeId: string, text: string): TLRecord {
  return {
    id: shapeId,
    typeName: "shape",
    type: "geo",
    x: 600,
    y: 300,
    parentId: FRAME,
    index: "a2",
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: {
      w: 180,
      h: 120,
      geo: "ellipse",
      color: "orange",
      fill: "semi",
      richText: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      },
    },
    meta: {},
  } as TLRecord;
}

describe("schema-adopt-shape (DRW-212)", () => {
  test("adopts in place: identity stamped, geometry untouched, raw gains define, no duplicate shape", () => {
    const room = makeRoom({
      "shape:na": makeSchemaNode("shape:na", "svc-a-aaa001", "Svc A"),
      "shape:hand": makeHandShape("shape:hand", "old db"),
    });
    const frame = makeFrame(RAW);
    room.store.store[FRAME] = frame as never;

    const actions: SchemaAction[] = [
      {
        kind: "schema-adopt-shape",
        shapeId: "shape:hand",
        role: "datastore",
        label: "DB Backup",
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

    // In-place: updated, не пересоздан.
    const upd = res.batch.updated["shape:hand"];
    expect(upd).toBeDefined();
    if (!upd) return;
    const rec = upd[1] as {
      x: number;
      y: number;
      props: Record<string, unknown>;
      meta: Record<string, unknown>;
    };
    expect(rec.meta.didrawId).toBeDefined();
    expect(rec.meta.didrawLabel).toBe("DB Backup");
    expect(rec.meta.didrawSchemaParent).toBe(FRAME);
    expect(rec.meta.didrawRole).toBe("datastore");
    // Геометрия и вид нетронуты.
    expect(rec.x).toBe(600);
    expect(rec.y).toBe(300);
    expect(rec.props.w).toBe(180);
    expect(rec.props.h).toBe(120);
    expect(rec.props.geo).toBe("ellipse");
    expect(rec.props.color).toBe("orange");
    // Label обновлён (явно задан).
    expect(JSON.stringify(rec.props.richText)).toContain("DB Backup");
    // Дубль-шейп НЕ создан.
    const addedGeo = Object.values(res.batch.added).filter(
      (s) => (s as { type?: string }).type === "geo",
    );
    expect(addedGeo).toHaveLength(0);
    // Raw получил define узла.
    expect(res.newRaw).toContain("DB Backup");
    // Overlay-позиция зафиксирована.
    const nid = rec.meta.didrawId as string;
    expect(res.newOverlays[nid]?.position).toEqual({ x: 600, y: 300 });
  });

  test("adopt + connect in the same batch binds the arrow to the adopted shape", () => {
    const room = makeRoom({
      "shape:na": makeSchemaNode("shape:na", "svc-a-aaa001", "Svc A"),
      "shape:hand": makeHandShape("shape:hand", "old db"),
    });
    const frame = makeFrame(RAW);
    room.store.store[FRAME] = frame as never;

    const actions: SchemaAction[] = [
      {
        kind: "schema-adopt-shape",
        shapeId: "shape:hand",
        role: "datastore",
        label: "DB Backup",
        nodeId: "db-backup-zz0001",
      },
      { kind: "schema-connect", from: "svc-a-aaa001", to: "db-backup-zz0001" },
    ];
    const res = applySchemaActions({
      room,
      frame,
      actions,
      suffixLen: SUFFIX_LEN,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const bindings = Object.values(res.batch.added).filter(
      (r) => (r as { typeName?: string }).typeName === "binding",
    ) as Array<{ toId: string; props: { terminal: string } }>;
    expect(bindings).toHaveLength(2);
    const end = bindings.find((b) => b.props.terminal === "end");
    expect(end?.toId).toBe("shape:hand");
  });

  test("validation: unknown shape / already-adopted shape", () => {
    const room = makeRoom({
      "shape:na": makeSchemaNode("shape:na", "svc-a-aaa001", "Svc A"),
    });
    const frame = makeFrame(RAW);
    room.store.store[FRAME] = frame as never;

    const unknown = applySchemaActions({
      room,
      frame,
      actions: [
        { kind: "schema-adopt-shape", shapeId: "shape:nope", role: "service" },
      ],
      suffixLen: SUFFIX_LEN,
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.errors[0]?.code).toBe("unknown-shape");

    const adopted = applySchemaActions({
      room,
      frame,
      actions: [
        { kind: "schema-adopt-shape", shapeId: "shape:na", role: "service" },
      ],
      suffixLen: SUFFIX_LEN,
    });
    expect(adopted.ok).toBe(false);
    if (!adopted.ok) expect(adopted.errors[0]?.code).toBe("not-adoptable");
  });
});

describe("schema-delete-shape (DRW-212)", () => {
  test("removes a hand shape with binding/arrow cascade; raw untouched", () => {
    const room = makeRoom({
      "shape:na": makeSchemaNode("shape:na", "svc-a-aaa001", "Svc A"),
      "shape:hand": makeHandShape("shape:hand", "scratch"),
      "shape:harrow": {
        id: "shape:harrow",
        typeName: "shape",
        type: "arrow",
        x: 0,
        y: 0,
        parentId: FRAME,
        index: "a3",
        isLocked: false,
        opacity: 1,
        rotation: 0,
        props: { kind: "arc", color: "black" },
        meta: {},
      } as TLRecord,
      "binding:h1": {
        id: "binding:h1",
        typeName: "binding",
        type: "arrow",
        fromId: "shape:harrow",
        toId: "shape:hand",
        props: { terminal: "end" },
      } as TLRecord,
      "binding:h2": {
        id: "binding:h2",
        typeName: "binding",
        type: "arrow",
        fromId: "shape:harrow",
        toId: "shape:na",
        props: { terminal: "start" },
      } as TLRecord,
    });
    const frame = makeFrame(RAW);
    room.store.store[FRAME] = frame as never;

    const res = applySchemaActions({
      room,
      frame,
      actions: [{ kind: "schema-delete-shape", shapeId: "shape:hand" }],
      suffixLen: SUFFIX_LEN,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.batch.removed["shape:hand"]).toBeDefined();
    // Каскад: binding на удалённый шейп + висячая стрелка + её второй binding.
    expect(res.batch.removed["binding:h1"]).toBeDefined();
    expect(res.batch.removed["shape:harrow"]).toBeDefined();
    expect(res.batch.removed["binding:h2"]).toBeDefined();
    // Raw не изменился (узел svc-a жив).
    expect(res.newRaw).toContain("svc-a-aaa001");
  });

  test("didraw node is rejected (use schema-delete-node)", () => {
    const room = makeRoom({
      "shape:na": makeSchemaNode("shape:na", "svc-a-aaa001", "Svc A"),
    });
    const frame = makeFrame(RAW);
    room.store.store[FRAME] = frame as never;

    const res = applySchemaActions({
      room,
      frame,
      actions: [{ kind: "schema-delete-shape", shapeId: "shape:na" }],
      suffixLen: SUFFIX_LEN,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0]?.code).toBe("not-adoptable");
  });
});
