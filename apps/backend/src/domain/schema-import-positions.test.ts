import { describe, expect, test } from "bun:test";
import { applyImportPositions } from "./schema-import-positions";
import type { TLRecord, TLStoreSnapshot } from "../store-types";

function rec(id: string, type: string, parentId: string, props: Record<string, unknown> = {}): TLRecord {
  return { id, typeName: "shape", type, x: 0, y: 0, parentId, props: { w: 100, h: 50, ...props }, meta: {} } as TLRecord;
}
function store(records: TLRecord[]): TLStoreSnapshot {
  const m: Record<string, TLRecord> = {};
  for (const r of records) m[r.id] = r;
  return { store: m } as unknown as TLStoreSnapshot;
}

describe("applyImportPositions", () => {
  test("top-level leaf written at flat coord (frame-relative); frame sized to union + pad", () => {
    const frameId = "shape:frame";
    const leaf = rec("shape:a", "geo", frameId);
    const s = store([rec(frameId, "frame", "page:page", { w: 640, h: 480 }), leaf]);

    const batch = applyImportPositions({
      store: s,
      frameId,
      positions: { a: { x: 50, y: 30, w: 120, h: 60 } },
      leafShapeIdByMermaidId: new Map([["a", "shape:a"]]),
      containerShapeIdByMermaidId: new Map(),
      subgraphMermaidIdByMemberMermaidId: new Map(),
      framePad: 40,
    });

    const leafUpd = batch.updated["shape:a"]?.[1] as TLRecord;
    expect(leafUpd.x).toBe(50);
    expect(leafUpd.y).toBe(30);
    expect((leafUpd.props as { w: number }).w).toBe(120);

    const frameUpd = batch.updated[frameId]?.[1] as TLRecord;
    // union right = 50+120=170; bottom = 30+60=90; + pad 40
    expect((frameUpd.props as { w: number }).w).toBe(170 + 40);
    expect((frameUpd.props as { h: number }).h).toBe(90 + 40);
    // frame position unchanged (only w/h written)
    expect(frameUpd.x).toBe(0);
  });

  test("child of subgraph converted to parent-relative; container sized from subgraph w/h", () => {
    const frameId = "shape:frame";
    const container = rec("shape:sg", "schema-container", frameId, { w: 300, h: 200 });
    const child = rec("shape:c", "geo", "shape:sg");
    const s = store([rec(frameId, "frame", "page:page", { w: 640, h: 480 }), container, child]);

    const batch = applyImportPositions({
      store: s,
      frameId,
      positions: {
        SG: { x: 200, y: 100, w: 260, h: 160 }, // subgraph flat
        c: { x: 220, y: 130, w: 80, h: 40 },    // child flat (inside subgraph)
      },
      leafShapeIdByMermaidId: new Map([["c", "shape:c"]]),
      containerShapeIdByMermaidId: new Map([["SG", "shape:sg"]]),
      subgraphMermaidIdByMemberMermaidId: new Map([["c", "SG"]]),
      framePad: 40,
    });

    const childUpd = batch.updated["shape:c"]?.[1] as TLRecord;
    // parent-relative: 220-200=20, 130-100=30
    expect(childUpd.x).toBe(20);
    expect(childUpd.y).toBe(30);

    const contUpd = batch.updated["shape:sg"]?.[1] as TLRecord;
    expect(contUpd.x).toBe(200); // container frame-relative = subgraph flat
    expect(contUpd.y).toBe(100);
    expect((contUpd.props as { w: number }).w).toBe(260); // from harvested subgraph w
    expect((contUpd.props as { h: number }).h).toBe(160);
  });

  test("unmatched mermaid id reported, not silently dropped", () => {
    const frameId = "shape:frame";
    const s = store([rec(frameId, "frame", "page:page", { w: 640, h: 480 })]);
    const res = applyImportPositions({
      store: s,
      frameId,
      positions: { ghost: { x: 1, y: 1, w: 1, h: 1 } },
      leafShapeIdByMermaidId: new Map(),
      containerShapeIdByMermaidId: new Map(),
      subgraphMermaidIdByMemberMermaidId: new Map(),
      framePad: 40,
    });
    expect(res.unmatched).toContain("ghost");
  });

  test("arrows are never positioned (no arrow ids in maps → no arrow updates)", () => {
    const frameId = "shape:frame";
    const arrow = rec("shape:arr", "arrow", frameId);
    const s = store([rec(frameId, "frame", "page:page", { w: 640, h: 480 }), arrow]);
    const batch = applyImportPositions({
      store: s, frameId, positions: {},
      leafShapeIdByMermaidId: new Map(), containerShapeIdByMermaidId: new Map(),
      subgraphMermaidIdByMemberMermaidId: new Map(), framePad: 40,
    });
    expect(batch.updated["shape:arr"]).toBeUndefined();
  });
});
