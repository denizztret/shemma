import { describe, expect, test } from "bun:test";
import {
  absToFrameRelative,
  buildGlobalAlignArgs,
  elkDirToCardinal,
  frameRelativeToAbs,
} from "../src/domain/global-align-adapter";
import type { Positions } from "../src/domain/layout";
import type { TLRecord, TLStoreSnapshot } from "../src/store-types";

// --------------------------------------------------------------------------
// fixture helpers
// --------------------------------------------------------------------------

function shape(
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

function binding(
  id: string,
  arrowId: string,
  toId: string,
  terminal: "start" | "end",
): TLRecord {
  return {
    id,
    typeName: "binding",
    fromId: arrowId,
    toId,
    props: { terminal },
  } as TLRecord;
}

/**
 * Фикстура: LR-фрейм (axisVertical) с 4 контейнерами-колонками (direction=TB =
 * laneDir для LR-фрейма), у каждого 2 ребёнка, + loose geo. Cross-рёбра между
 * колонками (chain c1→c2→c3→c4 через детей). Один контейнер sizePinned → passive.
 */
function buildFixture(): {
  store: TLStoreSnapshot;
  positionsAbs: Positions;
} {
  const records: Record<string, TLRecord> = {
    "document:document": {
      id: "document:document",
      typeName: "document",
    } as TLRecord,
    "page:page": { id: "page:page", typeName: "page" } as TLRecord,
    "shape:frame": shape(
      "shape:frame",
      "frame",
      "page:page",
      100,
      100,
      { w: 1200, h: 600, name: "F" },
      { didrawDirection: "LR" },
    ),
  };

  // 4 контейнера-колонки (TB)
  const containerXs = [200, 500, 800, 1100];
  for (let i = 1; i <= 4; i++) {
    const cid = `shape:c${i}`;
    const meta: Record<string, unknown> = { didrawDirection: "TB" };
    // c4 — sizePinned → должен попасть в passive, не в columns
    if (i === 4) meta.didrawSizePinned = true;
    records[cid] = shape(
      cid,
      "schema-container",
      "shape:frame",
      containerXs[i - 1] as number,
      120,
      { w: 180, h: 260, direction: "TB" },
      meta,
    );
    // 2 ребёнка на контейнер
    for (let k = 1; k <= 2; k++) {
      const kid = `shape:c${i}n${k}`;
      records[kid] = shape(
        kid,
        "geo",
        cid,
        (containerXs[i - 1] as number) + 20,
        120 + 40 + (k - 1) * 100,
        { w: 140, h: 60, geo: "rectangle" },
      );
    }
  }

  // loose geo top-level
  records["shape:loose"] = shape(
    "shape:loose",
    "geo",
    "shape:frame",
    600,
    480,
    { w: 120, h: 50, geo: "rectangle" },
  );

  // cross-рёбра: c1n1→c2n1, c2n1→c3n1, c3n1→c4n1 (chain через детей колонок)
  const edges: Array<[string, string]> = [
    ["shape:c1n1", "shape:c2n1"],
    ["shape:c2n1", "shape:c3n1"],
    ["shape:c3n1", "shape:c4n1"],
  ];
  edges.forEach(([src, tgt], i) => {
    const aid = `shape:arr${i}`;
    records[aid] = shape(aid, "arrow", "shape:frame", 0, 0, {});
    records[`binding:${i}a`] = binding(`binding:${i}a`, aid, src, "start");
    records[`binding:${i}b`] = binding(`binding:${i}b`, aid, tgt, "end");
  });

  const store: TLStoreSnapshot = {
    schema: { schemaVersion: 1, storeVersion: 4, recordVersions: {} },
    store: records,
  };

  // ABSOLUTE positions (как backend collectPositions: дети — абс. координаты)
  const positionsAbs: Positions = {};
  for (const r of Object.values(records)) {
    if (r.typeName !== "shape" || r.type === "arrow") continue;
    const p = (r.props ?? {}) as { w?: number; h?: number };
    positionsAbs[r.id] = {
      x: r.x ?? 0,
      y: r.y ?? 0,
      w: p.w,
      h: p.h,
    };
  }
  return { store, positionsAbs };
}

// --------------------------------------------------------------------------
// elkDirToCardinal
// --------------------------------------------------------------------------

describe("elkDirToCardinal", () => {
  test("маппинг ELK-токенов в cardinal", () => {
    expect(elkDirToCardinal("DOWN")).toBe("TB");
    expect(elkDirToCardinal("UP")).toBe("BT");
    expect(elkDirToCardinal("RIGHT")).toBe("LR");
    expect(elkDirToCardinal("LEFT")).toBe("RL");
    expect(elkDirToCardinal(undefined)).toBeUndefined();
    expect(elkDirToCardinal("WAT")).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// координатная нормализация abs ↔ frame-relative (РИСК №1)
// --------------------------------------------------------------------------

describe("координатная нормализация abs ↔ frame-relative", () => {
  test("дети контейнеров — отн. контейнера; top-level — отн. фрейма", () => {
    const { store, positionsAbs } = buildFixture();
    const rel = absToFrameRelative(positionsAbs, store, "shape:frame");

    // top-level контейнер c1: abs(200,120) − frame(100,100) = (100,20)
    expect(rel["shape:c1"]).toEqual({ x: 100, y: 20, w: 180, h: 260 });

    // ребёнок c1n1: abs(220,160) − container c1 abs(200,120) = (20,40)
    expect(rel["shape:c1n1"]).toEqual({ x: 20, y: 40, w: 140, h: 60 });
    // ребёнок c1n2: abs(220,260) − (200,120) = (20,140)
    expect(rel["shape:c1n2"]).toEqual({ x: 20, y: 140, w: 140, h: 60 });

    // loose top-level: abs(600,480) − frame(100,100) = (500,380)
    expect(rel["shape:loose"]).toEqual({ x: 500, y: 380, w: 120, h: 50 });

    // сам фрейм остаётся origin (не нормализуется)
    expect(rel["shape:frame"]).toEqual({ x: 100, y: 100, w: 1200, h: 600 });
  });

  test("round-trip abs → rel → abs идемпотентен", () => {
    const { store, positionsAbs } = buildFixture();
    const rel = absToFrameRelative(positionsAbs, store, "shape:frame");
    const back = frameRelativeToAbs(rel, store, "shape:frame");
    for (const id of Object.keys(positionsAbs)) {
      expect(back[id]).toEqual(positionsAbs[id]);
    }
  });

  test("round-trip rel → abs → rel идемпотентен", () => {
    const { store, positionsAbs } = buildFixture();
    const rel = absToFrameRelative(positionsAbs, store, "shape:frame");
    const abs = frameRelativeToAbs(rel, store, "shape:frame");
    const relAgain = absToFrameRelative(abs, store, "shape:frame");
    for (const id of Object.keys(rel)) {
      expect(relAgain[id]).toEqual(rel[id]);
    }
  });

  test("frameless (frameId undefined): page-root контейнер абс., дети отн. контейнера", () => {
    // frameless = контейнеры/loose сидят прямо на странице (нет scope-фрейма).
    const records: Record<string, TLRecord> = {
      "page:page": { id: "page:page", typeName: "page" } as TLRecord,
      "shape:c1": shape(
        "shape:c1",
        "schema-container",
        "page:page",
        200,
        120,
        { w: 180, h: 260, direction: "TB" },
        {},
      ),
      "shape:c1n1": shape("shape:c1n1", "geo", "shape:c1", 220, 160, {
        w: 140,
        h: 60,
      }),
      "shape:loose": shape("shape:loose", "geo", "page:page", 600, 480, {
        w: 120,
        h: 50,
      }),
    };
    const store: TLStoreSnapshot = {
      schema: { schemaVersion: 1, storeVersion: 4, recordVersions: {} },
      store: records,
    };
    const positionsAbs: Positions = {};
    for (const r of Object.values(records)) {
      if (r.typeName !== "shape") continue;
      const p = (r.props ?? {}) as { w?: number; h?: number };
      positionsAbs[r.id] = { x: r.x ?? 0, y: r.y ?? 0, w: p.w, h: p.h };
    }
    const rel = absToFrameRelative(positionsAbs, store);
    // page-root контейнер не сдвигается (origin 0,0)
    expect(rel["shape:c1"]).toEqual({ x: 200, y: 120, w: 180, h: 260 });
    // ребёнок — отн. контейнера: abs(220,160) − (200,120) = (20,40)
    expect(rel["shape:c1n1"]).toEqual({ x: 20, y: 40, w: 140, h: 60 });
    // loose page-root — абсолютный
    expect(rel["shape:loose"]).toEqual({ x: 600, y: 480, w: 120, h: 50 });
    // round-trip
    const back = frameRelativeToAbs(rel, store);
    for (const id of Object.keys(positionsAbs)) {
      expect(back[id]).toEqual(positionsAbs[id]);
    }
  });

  test("чистота: входной positions не мутируется", () => {
    const { store, positionsAbs } = buildFixture();
    const snapshot = JSON.parse(JSON.stringify(positionsAbs));
    absToFrameRelative(positionsAbs, store, "shape:frame");
    expect(positionsAbs).toEqual(snapshot);
  });
});

// --------------------------------------------------------------------------
// buildGlobalAlignArgs
// --------------------------------------------------------------------------

describe("buildGlobalAlignArgs", () => {
  test("LR-фрейм: TB-контейнеры → columns, sizePinned → passive", () => {
    const { store, positionsAbs } = buildFixture();
    const rel = absToFrameRelative(positionsAbs, store, "shape:frame");
    const args = buildGlobalAlignArgs(store, rel, {
      frameDir: "LR",
      frameId: "shape:frame",
      spacing: "normal",
    });

    const colIds = args.columns.map((c) => c.id).sort();
    // c1..c3 — TB-колонки; c4 — sizePinned → passive
    expect(colIds).toEqual(["shape:c1", "shape:c2", "shape:c3"]);
    expect(args.passive?.map((p) => p.id)).toEqual(["shape:c4"]);

    // каждая колонка несёт своих детей
    const c1 = args.columns.find((c) => c.id === "shape:c1");
    expect(c1?.kidIds.sort()).toEqual(["shape:c1n1", "shape:c1n2"]);
  });

  test("axisVertical=true для LR-фрейма; flat — та же ссылка", () => {
    const { store, positionsAbs } = buildFixture();
    const rel = absToFrameRelative(positionsAbs, store, "shape:frame");
    const args = buildGlobalAlignArgs(store, rel, {
      frameDir: "LR",
      frameId: "shape:frame",
      spacing: "normal",
    });
    expect(args.axisVertical).toBe(true);
    expect(args.invertColumnOrder).toBe(false);
    expect(args.flat).toBe(rel); // мутируется на месте
  });

  test("rowGap/compGap совпадают с фронтом (round(92*0.62)=57, comp=130)", () => {
    const { store, positionsAbs } = buildFixture();
    const rel = absToFrameRelative(positionsAbs, store, "shape:frame");
    const args = buildGlobalAlignArgs(store, rel, {
      frameDir: "LR",
      frameId: "shape:frame",
      spacing: "normal",
    });
    expect(args.rowGap).toBe(57); // Math.round(92 * 0.62)
    expect(args.compGap).toBe(130);
    expect(args.padTop).toBe(44); // axisVertical
    expect(args.padBottom).toBe(16);
  });

  test("looseIds содержит top-level loose geo", () => {
    const { store, positionsAbs } = buildFixture();
    const rel = absToFrameRelative(positionsAbs, store, "shape:frame");
    const args = buildGlobalAlignArgs(store, rel, {
      frameDir: "LR",
      frameId: "shape:frame",
      spacing: "normal",
    });
    expect(args.looseIds).toContain("shape:loose");
    // дети колонок не попадают в loose
    expect(args.looseIds).not.toContain("shape:c1n1");
  });

  test("nodeEdges собраны из bindings", () => {
    const { store, positionsAbs } = buildFixture();
    const rel = absToFrameRelative(positionsAbs, store, "shape:frame");
    const args = buildGlobalAlignArgs(store, rel, {
      frameDir: "LR",
      frameId: "shape:frame",
      spacing: "normal",
    });
    const edgeKeys = args.nodeEdges.map((e) => `${e.from}>${e.to}`).sort();
    expect(edgeKeys).toEqual([
      "shape:c1n1>shape:c2n1",
      "shape:c2n1>shape:c3n1",
      "shape:c3n1>shape:c4n1",
    ]);
  });

  test("components: cross-chain через 4 контейнера → одна компонента", () => {
    const { store, positionsAbs } = buildFixture();
    const rel = absToFrameRelative(positionsAbs, store, "shape:frame");
    const args = buildGlobalAlignArgs(store, rel, {
      frameDir: "LR",
      frameId: "shape:frame",
      spacing: "normal",
    });
    // c1..c4 связаны цепочкой (через детей, поднятых до контейнеров) → 1 компонента;
    // loose — отдельная компонента.
    const mainComp = args.components.find((ids) => ids.includes("shape:c1"));
    expect(mainComp).toBeDefined();
    expect([...(mainComp ?? [])].sort()).toEqual([
      "shape:c1",
      "shape:c2",
      "shape:c3",
      "shape:c4",
    ]);
    // loose в своей компоненте
    const looseComp = args.components.find((ids) =>
      ids.includes("shape:loose"),
    );
    expect(looseComp).toEqual(["shape:loose"]);
  });

  test("пин ребёнка колонки попадает в pinned", () => {
    const { store, positionsAbs } = buildFixture();
    // пиним c1n1
    (store.store["shape:c1n1"] as { meta?: Record<string, unknown> }).meta = {
      pinned: true,
    };
    const rel = absToFrameRelative(positionsAbs, store, "shape:frame");
    const args = buildGlobalAlignArgs(store, rel, {
      frameDir: "LR",
      frameId: "shape:frame",
      spacing: "normal",
    });
    expect(args.pinned?.has("shape:c1n1")).toBe(true);
  });

  test("forceUnpin → pinned пуст, sizePinned-контейнер становится колонкой", () => {
    const { store, positionsAbs } = buildFixture();
    (store.store["shape:c1n1"] as { meta?: Record<string, unknown> }).meta = {
      pinned: true,
    };
    const rel = absToFrameRelative(positionsAbs, store, "shape:frame");
    const args = buildGlobalAlignArgs(store, rel, {
      frameDir: "LR",
      frameId: "shape:frame",
      spacing: "normal",
      forceUnpin: true,
    });
    expect(args.pinned?.size).toBe(0);
    // c4 был sizePinned → при forceUnpin это игнорируется, становится колонкой
    const colIds = args.columns.map((c) => c.id).sort();
    expect(colIds).toEqual(["shape:c1", "shape:c2", "shape:c3", "shape:c4"]);
    expect(args.passive?.length).toBe(0);
  });

  test("TB-фрейм: axisVertical=false, laneDir=LR контейнеры → columns", () => {
    // фрейм TB, контейнеры LR (= laneDir поперёк TB-потока)
    const records: Record<string, TLRecord> = {
      "page:page": { id: "page:page", typeName: "page" } as TLRecord,
      "shape:frame": shape(
        "shape:frame",
        "frame",
        "page:page",
        0,
        0,
        { w: 800, h: 800 },
        { didrawDirection: "TB" },
      ),
      "shape:cLR": shape(
        "shape:cLR",
        "schema-container",
        "shape:frame",
        50,
        50,
        { w: 300, h: 120, direction: "LR" },
        {},
      ),
      "shape:cLRn1": shape("shape:cLRn1", "geo", "shape:cLR", 60, 70, {
        w: 100,
        h: 60,
      }),
      "shape:cTB": shape(
        "shape:cTB",
        "schema-container",
        "shape:frame",
        50,
        300,
        { w: 120, h: 300, direction: "TB" },
        {},
      ),
      "shape:cTBn1": shape("shape:cTBn1", "geo", "shape:cTB", 60, 320, {
        w: 100,
        h: 60,
      }),
    };
    const store: TLStoreSnapshot = {
      schema: { schemaVersion: 1, storeVersion: 4, recordVersions: {} },
      store: records,
    };
    const positionsAbs: Positions = {};
    for (const r of Object.values(records)) {
      if (r.typeName !== "shape" || r.type === "arrow") continue;
      const p = (r.props ?? {}) as { w?: number; h?: number };
      positionsAbs[r.id] = { x: r.x ?? 0, y: r.y ?? 0, w: p.w, h: p.h };
    }
    const rel = absToFrameRelative(positionsAbs, store, "shape:frame");
    const args = buildGlobalAlignArgs(store, rel, {
      frameDir: "TB",
      frameId: "shape:frame",
      spacing: "normal",
    });
    expect(args.axisVertical).toBe(false);
    // cLR — laneDir для TB-фрейма → колонка; cTB — вдоль потока → passive
    expect(args.columns.map((c) => c.id)).toEqual(["shape:cLR"]);
    expect(args.passive?.map((p) => p.id)).toEqual(["shape:cTB"]);
  });

  test("RL-фрейм: invertColumnOrder=true, axisVertical=true", () => {
    const { store, positionsAbs } = buildFixture();
    const rel = absToFrameRelative(positionsAbs, store, "shape:frame");
    const args = buildGlobalAlignArgs(store, rel, {
      frameDir: "RL",
      frameId: "shape:frame",
      spacing: "normal",
    });
    expect(args.axisVertical).toBe(true);
    expect(args.invertColumnOrder).toBe(true);
  });
});
