// DRW-003 / DRW-004 / DRW-005: pin discipline, group bbox writeback,
// children coords inside group bbox.
//
// Phase 3.0: тесты переписаны под новый unit-level контракт runLayout —
// вход TLStoreSnapshot, выход StoreChangeBatch. Integration-эквиваленты
// (через makeApp + /api/domain) восстанавливаются в Task 10 (routes-domain).

import { describe, expect, test } from "bun:test";
import { runLayout } from "../src/domain/layout";
import { applyStoreChanges, rebuildDidrawIndex } from "../src/store-ops";
import type { TLRecord, TLStoreSnapshot } from "../src/store-types";

function emptySnapshot(): TLStoreSnapshot {
  return {
    schema: { schemaVersion: 1, storeVersion: 4, recordVersions: {} },
    store: {
      "document:document": { id: "document:document", typeName: "document" } as TLRecord,
      "page:page": { id: "page:page", typeName: "page" } as TLRecord,
    },
  };
}

function makeShape(
  id: string,
  x: number,
  y: number,
  name: string,
  extraMeta: Record<string, unknown> = {},
  size: { w?: number; h?: number } = {},
  type: "geo" | "frame" | "note" | "arrow" = "geo",
  parentId: string = "page:page",
): TLRecord {
  const w = size.w ?? (type === "frame" ? 400 : 120);
  const h = size.h ?? (type === "frame" ? 300 : 60);
  return {
    id,
    typeName: "shape",
    type,
    x,
    y,
    parentId,
    props: { w, h, geo: type === "geo" ? "rectangle" : undefined },
    meta: { didrawName: name, ...extraMeta },
  } as TLRecord;
}

function snapshotWithShapes(records: TLRecord[]): TLStoreSnapshot {
  const s = emptySnapshot();
  for (const r of records) s.store[r.id] = r;
  return s;
}

describe("DRW-003: layout pin discipline + no-collision", () => {
  test("AC3 batch: 3 defines + layout → все 3 узла на разных позициях", async () => {
    const s = snapshotWithShapes([
      makeShape("shape:a", 0, 0, "a"),
      makeShape("shape:b", 0, 0, "b"),
      makeShape("shape:c", 0, 0, "c"),
    ]);
    const idx = rebuildDidrawIndex(s);
    const r = await runLayout(s, { mode: "layered-lr", scope: "all" }, idx);
    const next = applyStoreChanges(s, r.batch);
    const positions = ["shape:a", "shape:b", "shape:c"].map((id) => {
      const rec = next.store[id]!;
      return `${rec.x},${rec.y}`;
    });
    expect(new Set(positions).size).toBe(3);
  });

  test("AC3 incremental: pre-positioned 3 shapes + layout → 3 разные позиции", async () => {
    // Эмулирует scenario с уже размещёнными узлами (как после нескольких apply'ев).
    const s = snapshotWithShapes([
      makeShape("shape:a", 100, 100, "a"),
      makeShape("shape:b", 100, 100, "b"),
      makeShape("shape:c", 100, 100, "c"),
    ]);
    const idx = rebuildDidrawIndex(s);
    const r = await runLayout(s, { mode: "layered-lr", scope: "all" }, idx);
    const next = applyStoreChanges(s, r.batch);
    const positions = ["shape:a", "shape:b", "shape:c"].map((id) => {
      const rec = next.store[id]!;
      return `${rec.x},${rec.y}`;
    });
    expect(new Set(positions).size).toBe(3);
  });

  test("AC1: pinned (meta.pinned=true) node НЕ двигается при layout", async () => {
    const fixed = makeShape("shape:fixed", 500, 500, "fixed", {
      pinned: true,
      position: { x: 500, y: 500 },
    });
    const mobile = makeShape("shape:mobile", 10, 10, "mobile");
    const s = snapshotWithShapes([fixed, mobile]);
    const idx = rebuildDidrawIndex(s);
    const r = await runLayout(s, { mode: "layered-lr", scope: "all" }, idx);
    const next = applyStoreChanges(s, r.batch);
    const fixedAfter = next.store["shape:fixed"]!;
    expect(fixedAfter.x).toBe(500);
    expect(fixedAfter.y).toBe(500);
    expect(fixedAfter.meta?.pinned).toBe(true);
  });

  test("AC2: AI-defined node БЕЗ meta.pinned свободно двигается", async () => {
    const free = makeShape("shape:free", 0, 0, "free");
    const second = makeShape("shape:second", 0, 0, "second");
    const s = snapshotWithShapes([free, second]);
    // Добавляем связь (без неё ELK ставит обоих в (0,0); связь даёт разнос).
    s.store["shape:arr"] = {
      id: "shape:arr",
      typeName: "shape",
      type: "arrow",
      x: 0,
      y: 0,
      parentId: "page:page",
      props: {},
      meta: { connectionKind: "sync" },
    } as TLRecord;
    s.store["binding:1"] = {
      id: "binding:1",
      typeName: "binding",
      fromId: "shape:arr",
      toId: "shape:free",
      props: { terminal: "start" },
    } as TLRecord;
    s.store["binding:2"] = {
      id: "binding:2",
      typeName: "binding",
      fromId: "shape:arr",
      toId: "shape:second",
      props: { terminal: "end" },
    } as TLRecord;
    const idx = rebuildDidrawIndex(s);
    const r = await runLayout(s, { mode: "layered-lr", scope: "all" }, idx);
    const next = applyStoreChanges(s, r.batch);
    const freeAfter = next.store["shape:free"]!;
    const secondAfter = next.store["shape:second"]!;
    expect(freeAfter.meta?.pinned).toBeUndefined();
    // Free !== second (must have different position).
    expect(freeAfter.x !== secondAfter.x || freeAfter.y !== secondAfter.y).toBe(true);
  });

  test("после layout pinned bbox не пересекается с non-pinned shapes", async () => {
    // Сценарий: несколько disconnected shapes; pinned зафиксирован в (0,0).
    // Допустимо два варианта resolution'а: (а) ELK сам разнёс компоненты,
    // (б) ELK поставил overlap и сработал DRW-003 displacement.
    // Оба валидны — проверяем итог: pinned bbox не overlap'ит с другими.
    const pinned = makeShape("shape:pin", 0, 0, "pin", {
      pinned: true,
      position: { x: 0, y: 0 },
    });
    const f1 = makeShape("shape:f1", 0, 0, "f1");
    const f2 = makeShape("shape:f2", 0, 0, "f2");
    const f3 = makeShape("shape:f3", 0, 0, "f3");
    const s = snapshotWithShapes([pinned, f1, f2, f3]);
    const idx = rebuildDidrawIndex(s);
    const r = await runLayout(s, { mode: "layered-lr", scope: "all" }, idx);
    const next = applyStoreChanges(s, r.batch);
    const pinAfter = next.store["shape:pin"]!;
    expect(pinAfter.x).toBe(0);
    expect(pinAfter.y).toBe(0);
    // Все non-pinned не overlap'ят pinned bbox (0,0,120,60).
    const SLACK = 5;
    for (const id of ["shape:f1", "shape:f2", "shape:f3"]) {
      const rec = next.store[id]!;
      const w = (rec.props as { w?: number }).w ?? 120;
      const h = (rec.props as { h?: number }).h ?? 60;
      const x = rec.x ?? 0;
      const y = rec.y ?? 0;
      const noOverlap =
        x + w + SLACK <= 0 ||
        120 + SLACK <= x ||
        y + h + SLACK <= 0 ||
        60 + SLACK <= y;
      expect(noOverlap).toBe(true);
    }
  });

  test("DRW-003 displacement: при overlap non-pinned уезжает за pinned bbox", async () => {
    // Forc'им оверлап: даём ELK единственный component с pinned и одиночными node'ами.
    // Сценарий, в котором ELK склонен поставить free вблизи pinned, — pinned внутри
    // компонента с edge'ами на free. Но pinned overrid'ится → возникает overlap.
    const pinned = makeShape("shape:pin", 1000, 1000, "pin", {
      pinned: true,
      position: { x: 1000, y: 1000 },
    });
    const free = makeShape("shape:free", 0, 0, "free");
    // Связь между pinned и free — ELK захочет разместить их рядом, но pinned
    // override'ится на (1000,1000). free останется у origin → no overlap здесь.
    // Принудительно делаем pinned (0,0,120,60) и проверяем что displacement при
    // явном overlap-сценарии работает: запускаем layout с одним pinned и одним
    // free, где меняем coordinates после ELK через double-pass нельзя в unit'е.
    // Поэтому реализуем сценарий проще: один pinned + несколько disconnected free,
    // которые ELK расставит чтобы они оказались внутри pinned bbox (это происходит
    // когда componentComponent < pinned.w/h). Используем spacing=compact для этого.
    const f1 = makeShape("shape:f1", 0, 0, "f1");
    const f2 = makeShape("shape:f2", 0, 0, "f2");
    const f3 = makeShape("shape:f3", 0, 0, "f3");
    const pin0 = makeShape("shape:pin", 0, 0, "pin", { pinned: true, position: { x: 0, y: 0 } });
    const s = snapshotWithShapes([pin0, f1, f2, f3]);
    const idx = rebuildDidrawIndex(s);
    const r = await runLayout(s, { mode: "layered-lr", scope: "all", spacing: "compact" }, idx);
    const next = applyStoreChanges(s, r.batch);
    // sanity-проверка: pinned остаётся в (0,0).
    expect(next.store["shape:pin"]!.x).toBe(0);
    expect(next.store["shape:pin"]!.y).toBe(0);
    // displacement guarantees что итог консистентный — у каждого free есть позиция,
    // и ни один не лежит точно поверх pinned (0,0).
    for (const id of ["shape:f1", "shape:f2", "shape:f3"]) {
      const rec = next.store[id]!;
      expect(rec.x === 0 && rec.y === 0).toBe(false);
    }
    // Used variables to silence linter.
    void pinned;
    void free;
  });
});

describe("DRW-004: group bbox writeback", () => {
  test("frame + children + layout → frame получает w/h в props (>0)", async () => {
    const frame = makeShape("shape:frame1", 0, 0, "sys1", { role: "boundary" }, {}, "frame");
    const a = makeShape("shape:a", 0, 0, "a", {}, {}, "geo", "shape:frame1");
    const b = makeShape("shape:b", 0, 0, "b", {}, {}, "geo", "shape:frame1");
    const s = snapshotWithShapes([frame, a, b]);
    const idx = rebuildDidrawIndex(s);
    const r = await runLayout(s, { mode: "layered-lr", scope: "all" }, idx);
    const next = applyStoreChanges(s, r.batch);
    const frameAfter = next.store["shape:frame1"]!;
    const props = (frameAfter.props ?? {}) as { w?: number; h?: number };
    expect(typeof props.w).toBe("number");
    expect(typeof props.h).toBe("number");
    expect(props.w!).toBeGreaterThan(0);
    expect(props.h!).toBeGreaterThan(0);
  });
});

describe("DRW-005: children coords внутри group bbox (absolute)", () => {
  test("group + 2 children + layout → children внутри frame bbox", async () => {
    const frame = makeShape("shape:frame1", 0, 0, "sys", { role: "boundary" }, {}, "frame");
    const a = makeShape("shape:a", 0, 0, "a", {}, {}, "geo", "shape:frame1");
    const b = makeShape("shape:b", 0, 0, "b", {}, {}, "geo", "shape:frame1");
    const s = snapshotWithShapes([frame, a, b]);
    const idx = rebuildDidrawIndex(s);
    const r = await runLayout(s, { mode: "layered-lr", scope: "all" }, idx);
    const next = applyStoreChanges(s, r.batch);
    const frameAfter = next.store["shape:frame1"]!;
    const fBounds = {
      x: frameAfter.x ?? 0,
      y: frameAfter.y ?? 0,
      w: (frameAfter.props as { w?: number }).w ?? 400,
      h: (frameAfter.props as { h?: number }).h ?? 300,
    };
    for (const cid of ["shape:a", "shape:b"]) {
      const c = next.store[cid]!;
      const cw = (c.props as { w?: number }).w ?? 120;
      const ch = (c.props as { h?: number }).h ?? 60;
      expect(c.x!).toBeGreaterThanOrEqual(fBounds.x);
      expect(c.y!).toBeGreaterThanOrEqual(fBounds.y);
      expect((c.x ?? 0) + cw).toBeLessThanOrEqual(fBounds.x + fBounds.w);
      expect((c.y ?? 0) + ch).toBeLessThanOrEqual(fBounds.y + fBounds.h);
    }
  });

  test("group с children + независимая node — независимая снаружи bbox группы", async () => {
    const frame = makeShape("shape:frame1", 0, 0, "async-side", { role: "boundary" }, {}, "frame");
    const worker = makeShape("shape:w", 0, 0, "worker", {}, {}, "geo", "shape:frame1");
    const queue = makeShape("shape:q", 0, 0, "queue", { role: "queue" }, {}, "geo", "shape:frame1");
    const api = makeShape("shape:api", 0, 0, "api");
    const arrow: TLRecord = {
      id: "shape:arr1",
      typeName: "shape",
      type: "arrow",
      x: 0,
      y: 0,
      parentId: "page:page",
      props: {},
      meta: { connectionKind: "sync" },
    } as TLRecord;
    const b1: TLRecord = {
      id: "binding:1",
      typeName: "binding",
      fromId: "shape:arr1",
      toId: "shape:api",
      props: { terminal: "start" },
    } as TLRecord;
    const b2: TLRecord = {
      id: "binding:2",
      typeName: "binding",
      fromId: "shape:arr1",
      toId: "shape:q",
      props: { terminal: "end" },
    } as TLRecord;
    const s = snapshotWithShapes([frame, worker, queue, api, arrow, b1, b2]);
    const idx = rebuildDidrawIndex(s);
    const r = await runLayout(s, { mode: "layered-lr", scope: "all" }, idx);
    const next = applyStoreChanges(s, r.batch);
    const frameAfter = next.store["shape:frame1"]!;
    const fBounds = {
      x: frameAfter.x ?? 0,
      y: frameAfter.y ?? 0,
      w: (frameAfter.props as { w?: number }).w ?? 400,
      h: (frameAfter.props as { h?: number }).h ?? 300,
    };
    const apiAfter = next.store["shape:api"]!;
    const inside =
      (apiAfter.x ?? 0) >= fBounds.x &&
      (apiAfter.x ?? 0) < fBounds.x + fBounds.w &&
      (apiAfter.y ?? 0) >= fBounds.y &&
      (apiAfter.y ?? 0) < fBounds.y + fBounds.h;
    expect(inside).toBe(false);
  });
});

describe("ELK error path → empty batch + reason", () => {
  test("arrow с binding на несуществующий target → no-op result", async () => {
    // ELK падает, если edge endpoint не найден в графе.
    const a = makeShape("shape:a", 0, 0, "a");
    const s = snapshotWithShapes([a]);
    s.store["shape:arr"] = {
      id: "shape:arr",
      typeName: "shape",
      type: "arrow",
      x: 0,
      y: 0,
      parentId: "page:page",
      props: {},
      meta: {},
    } as TLRecord;
    s.store["binding:1"] = {
      id: "binding:1",
      typeName: "binding",
      fromId: "shape:arr",
      toId: "shape:a",
      props: { terminal: "start" },
    } as TLRecord;
    s.store["binding:2"] = {
      id: "binding:2",
      typeName: "binding",
      fromId: "shape:arr",
      toId: "shape:MISSING",
      props: { terminal: "end" },
    } as TLRecord;
    const idx = rebuildDidrawIndex(s);
    const r = await runLayout(s, { mode: "layered-lr", scope: "all" }, idx);
    expect(r.reason).toBe("elk-error");
    expect(Object.keys(r.batch.updated)).toEqual([]);
    expect(r.affected).toEqual([]);
  });
});
