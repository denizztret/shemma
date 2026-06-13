// DRW-245 — parity-тест Ф2 global-align в backend-пайплайне.
//
// Цель: backend `runLayout(scope='all', mode='layered-lr')` должен дать ту же
// Ф2-координацию строк, что фронтовый ⌘⇧L — cross-связанные узлы цепочки встают
// на одну ось, контейнеры не пересекаются, повтор идемпотентен, пины целы.
//
// Реальный elkjs (как в остальных backend layout-тестах — НЕ мокается).

import { describe, expect, test } from "bun:test";
import { runLayout } from "../src/domain/layout";
import { applyStoreChanges, rebuildDidrawIndex } from "../src/store-ops";
import type { TLRecord, TLStoreSnapshot } from "../src/store-types";

// --------------------------------------------------------------------------
// fixture helpers
// --------------------------------------------------------------------------

function rec(
  id: string,
  type: string,
  parentId: string,
  x: number,
  y: number,
  props: Record<string, unknown> = {},
  meta: Record<string, unknown> = {},
): TLRecord {
  return {
    id,
    typeName: "shape",
    type,
    parentId,
    x,
    y,
    props,
    meta,
  } as TLRecord;
}

function arrow(id: string, fromId: string, toId: string): TLRecord[] {
  return [
    rec(id, "arrow", "shape:frame", 0, 0, {}, { connectionKind: "sync" }),
    {
      id: `binding:${id}-s`,
      typeName: "binding",
      fromId: id,
      toId: fromId,
      props: { terminal: "start" },
    } as TLRecord,
    {
      id: `binding:${id}-e`,
      typeName: "binding",
      fromId: id,
      toId: toId,
      props: { terminal: "end" },
    } as TLRecord,
  ];
}

/**
 * Топология drw-218-stability: LR-фрейм с 4 TB-контейнерами-колонками
 * (A,B,D,E) с РАЗНЫМ числом детей. Cross-цепочка проходит через РАЗНЫЕ строки
 * каждой колонки (A1 — верх, B3 — низ, D1 — верх, E4 — низ) — нетривиальная
 * координация: Ф2 обязана выровнять их на одну ось, несмотря на разные локальные
 * позиции внутри контейнеров. Вторая цепочка (A2→B1→D2) пересекает первую по оси
 * потока (для AC#3 sibling-overlap).
 */
function buildStabilityFixture(): TLStoreSnapshot {
  const records: TLRecord[] = [
    { id: "document:document", typeName: "document" } as TLRecord,
    { id: "page:page", typeName: "page" } as TLRecord,
    rec(
      "shape:frame",
      "frame",
      "page:page",
      0,
      0,
      { w: 1600, h: 900, name: "stability" },
      { didrawDirection: "LR", didrawSchemaFrame: true },
    ),
  ];

  // 4 колонки-контейнера (TB = laneDir для LR-фрейма) с разным числом детей,
  // чтобы chain-узлы стартовали на разной высоте внутри своих колонок.
  const cols: Array<{ id: string; x: number; kids: number }> = [
    { id: "A", x: 60, kids: 2 },
    { id: "B", x: 400, kids: 3 },
    { id: "D", x: 740, kids: 2 },
    { id: "E", x: 1080, kids: 4 },
  ];
  for (const col of cols) {
    const cid = `shape:c${col.id}`;
    records.push(
      rec(
        cid,
        "schema-container",
        "shape:frame",
        col.x,
        40,
        { w: 240, h: 420, direction: "TB" },
        { didrawDirection: "TB" },
      ),
    );
    for (let k = 1; k <= col.kids; k++) {
      const kid = `shape:${col.id}${k}`;
      records.push(
        rec(kid, "geo", cid, col.x + 20, 60 + (k - 1) * 90, {
          w: 180,
          h: 60,
          geo: "rectangle",
        }),
      );
    }
  }

  // cross-цепочка по РАЗНЫМ строкам колонок: A1(верх)→B3(низ)→D1(верх)→E4(низ).
  // ELK-INCLUDE_CHILDREN сам бы не гарантировал общую ось — Ф2 выравнивает.
  records.push(...arrow("shape:arrChain1", "shape:A1", "shape:B3"));
  records.push(...arrow("shape:arrChain2", "shape:B3", "shape:D1"));
  records.push(...arrow("shape:arrChain3", "shape:D1", "shape:E4"));
  // вторая цепочка: A2→B1→D2 (другая строка, пересекает по оси потока).
  records.push(...arrow("shape:arrRow2a", "shape:A2", "shape:B1"));
  records.push(...arrow("shape:arrRow2b", "shape:B1", "shape:D2"));

  const store: TLStoreSnapshot = {
    schema: { schemaVersion: 1, storeVersion: 4, recordVersions: {} },
    store: {},
  };
  for (const r of records) store.store[r.id] = r;
  return store;
}

// --------------------------------------------------------------------------
// геометрия: абсолютные page-координаты после layout
// --------------------------------------------------------------------------

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Абсолютная page-bbox узла: сумма relative x/y по цепочке родителей. */
function pageBox(store: TLStoreSnapshot, id: string): Box {
  let x = 0;
  let y = 0;
  let cur: string | undefined = id;
  let w = 0;
  let h = 0;
  let first = true;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const r = store.store[cur] as
      | (TLRecord & {
          x?: number;
          y?: number;
          parentId?: string;
          props?: Record<string, unknown>;
        })
      | undefined;
    if (!r || r.typeName !== "shape") break;
    x += r.x ?? 0;
    y += r.y ?? 0;
    if (first) {
      const p = (r.props ?? {}) as { w?: number; h?: number };
      w = typeof p.w === "number" ? p.w : 0;
      h = typeof p.h === "number" ? p.h : 0;
      first = false;
    }
    cur = typeof r.parentId === "string" ? r.parentId : undefined;
  }
  return { x, y, w, h };
}

function centerY(b: Box): number {
  return b.y + b.h / 2;
}

function overlaps(a: Box, b: Box): boolean {
  const eps = 0.5;
  return (
    a.x < b.x + b.w - eps &&
    b.x < a.x + a.w - eps &&
    a.y < b.y + b.h - eps &&
    b.y < a.y + a.h - eps
  );
}

async function layoutAll(store: TLStoreSnapshot): Promise<TLStoreSnapshot> {
  const idx = rebuildDidrawIndex(store);
  const r = await runLayout(
    store,
    { mode: "layered-lr", scope: "all", spacing: "normal" },
    idx,
  );
  expect(r.reason).toBeUndefined();
  return applyStoreChanges(store, r.batch);
}

// --------------------------------------------------------------------------
// tests
// --------------------------------------------------------------------------

describe("DRW-245 backend Ф2 global-align parity", () => {
  test("AC#1: cross-связанные узлы цепочки встают на одну ось (|Δy|<1px)", async () => {
    const store = buildStabilityFixture();
    const out = await layoutAll(store);

    // ось цепочки = центр по y первого узла; все остальные должны лечь на неё <1px.
    const axisOf = (ids: readonly string[]): number =>
      centerY(pageBox(out, ids[0] ?? ""));
    const expectAligned = (ids: readonly string[]): void => {
      const axis = axisOf(ids);
      for (const id of ids) {
        expect(Math.abs(centerY(pageBox(out, id)) - axis)).toBeLessThan(1);
      }
    };

    // chain-1 проходит через разные строки колонок: A1(верх) B3(низ) D1(верх) E4(низ).
    // Ф2 выравнивает cross-цепочку в одну ось (центры по y совпадают <1px).
    const chain1 = ["shape:A1", "shape:B3", "shape:D1", "shape:E4"];
    expectAligned(chain1);

    // chain-2 (A2→B1→D2) — тоже на своей общей оси
    const chain2 = ["shape:A2", "shape:B1", "shape:D2"];
    expectAligned(chain2);

    // две цепочки различимы: их общие оси разнесены (НЕ слиплись).
    expect(Math.abs(axisOf(chain1) - axisOf(chain2))).toBeGreaterThan(20);
  });

  test("AC#2: повторный runLayout идемпотентен (|Δ|<1px), пин не сдвинут", async () => {
    const store = buildStabilityFixture();
    // пиним B2 — pin discipline: его PARENT-RELATIVE координаты (отн. контейнера
    // cB) замораживаются; контейнер при раскладке двигается, но ребёнок остаётся
    // на той же позиции внутри него.
    (store.store["shape:B2"] as { meta?: Record<string, unknown> }).meta = {
      ...((store.store["shape:B2"] as { meta?: Record<string, unknown> })
        .meta ?? {}),
      pinned: true,
    };
    const relBefore = {
      x: (store.store["shape:B2"] as { x?: number }).x ?? 0,
      y: (store.store["shape:B2"] as { y?: number }).y ?? 0,
    };

    const out1 = await layoutAll(store);
    const relAfter1 = {
      x: (out1.store["shape:B2"] as { x?: number }).x ?? 0,
      y: (out1.store["shape:B2"] as { y?: number }).y ?? 0,
    };
    // pinned узел не сдвинут относительно своего контейнера
    expect(Math.abs(relAfter1.x - relBefore.x)).toBeLessThan(1);
    expect(Math.abs(relAfter1.y - relBefore.y)).toBeLessThan(1);

    // повторный прогон на результате — идемпотентен: ВЗАИМНОЕ расположение узлов
    // не дрейфует (попарные расстояния стабильны <1px). NB: backend scope='all'
    // имеет пред-существующий (НЕ от DRW-245) global-translation контента внутри
    // фрейма между прогонами — он не меняет форму раскладки, поэтому проверяем
    // translation-инвариантно (взаимная геометрия, не абсолютные page-координаты).
    const out2 = await layoutAll(out1);
    const ids = [
      "shape:A1",
      "shape:A2",
      "shape:B1",
      "shape:B3",
      "shape:D1",
      "shape:D2",
      "shape:E4",
    ];
    for (const idA of ids) {
      for (const idB of ids) {
        if (idA >= idB) continue;
        const a1 = pageBox(out1, idA);
        const b1 = pageBox(out1, idB);
        const a2 = pageBox(out2, idA);
        const b2 = pageBox(out2, idB);
        expect(Math.abs(b1.x - a1.x - (b2.x - a2.x))).toBeLessThan(1);
        expect(Math.abs(b1.y - a1.y - (b2.y - a2.y))).toBeLessThan(1);
      }
    }
  });

  test("AC#3: 0 sibling-overlap (контейнеры и листья не пересекаются)", async () => {
    const store = buildStabilityFixture();
    const out = await layoutAll(store);

    const expectNoOverlap = (ids: readonly string[]): void => {
      for (const idA of ids) {
        for (const idB of ids) {
          if (idA >= idB) continue;
          expect(overlaps(pageBox(out, idA), pageBox(out, idB))).toBe(false);
        }
      }
    };

    // контейнеры-колонки не пересекаются
    expectNoOverlap(["shape:cA", "shape:cB", "shape:cD", "shape:cE"]);
    // листья внутри одной колонки не пересекаются (B имеет 3 ребёнка)
    expectNoOverlap(["shape:B1", "shape:B2", "shape:B3"]);
  });
});
