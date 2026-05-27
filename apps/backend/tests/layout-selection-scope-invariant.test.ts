import { describe, expect, it } from "bun:test";
import { runLayout } from "../src/domain/layout";
import type { TLRecord, TLStoreSnapshot } from "../src/store-types";

// Task #0/#5 (frame-container-direction-layout plan):
// Regression suite locking the scope:"self" invariant.
//
// Baseline (Task #0) проверил, что с containerScope='self' backend
// runLayoutSubgraph early-return'ит BEFORE Pass B (layout.ts ~913),
// и родительский frame НЕ попадает в batch.updated.
//
// Task #5 расширяет suite двумя дополнительными кейсами с
// containerScope='auto', фиксируя что:
//   • backend не падает на auto-scope multi-pass,
//   • frame resize в Pass B — legitimate behaviour для auto-scope
//     (frontend Tidy fix через scope='self' в tidy-layout.ts).
//
// Все 3 кейса используют общую fixture (1 frame + 1 schema-container
// + N leaves) с разной формой hint.

/**
 * Build a minimal store: one tldraw frame with one schema-container that
 * holds N leaf rectangles. Leaf coords ставятся последовательно слева-направо.
 */
function makeFrameContainerStore(leafCount: number): TLStoreSnapshot {
  const store: Record<string, TLRecord> = {
    "document:document": {
      id: "document:document",
      typeName: "document",
    } as TLRecord,
    "page:page": { id: "page:page", typeName: "page" } as TLRecord,
    "shape:frameA": {
      id: "shape:frameA",
      typeName: "shape",
      type: "frame",
      parentId: "page:page",
      x: 0,
      y: 0,
      props: { w: 600, h: 400, name: "frame A", color: "black" },
      meta: {},
    } as TLRecord,
    "shape:container1": {
      id: "shape:container1",
      typeName: "shape",
      type: "schema-container",
      parentId: "shape:frameA",
      x: 20,
      y: 60,
      props: { w: 200, h: 200, direction: "TB" },
      meta: {},
    } as TLRecord,
  };

  for (let i = 0; i < leafCount; i++) {
    const id = `shape:leaf${i + 1}`;
    store[id] = {
      id,
      typeName: "shape",
      type: "geo",
      parentId: "shape:container1",
      x: 10 + i * 90,
      y: 10,
      props: { w: 80, h: 40, geo: "rectangle" },
      meta: {},
    } as TLRecord;
  }

  return {
    schema: { schemaVersion: 1, storeVersion: 4, recordVersions: {} },
    store,
  };
}

describe("DRW: scope:'self' invariant — frame size preservation", () => {
  it("repro: scope:'self' + ids=[container inside frame] → batch must NOT contain frame props.w/h update", async () => {
    // Setup: outer tldraw frame containing a schema-container with 2 leaves.
    const store = makeFrameContainerStore(2);

    const result = await runLayout(
      store,
      {
        mode: "layered-tb",
        scope: "affected",
        affectedIds: new Set(["shape:container1"]),
        containerScope: "self",
      },
      new Map(),
    );

    // ASSERTION: outer frame size MUST NOT be in batch.updated.
    // batch.updated is Record<id, [oldRec, newRec]> — undefined means
    // the frame was not touched by this layout pass (desired).
    const frameUpdate = result.batch.updated["shape:frameA"];
    expect(frameUpdate).toBeUndefined();
  });

  it("scope:'auto' + ids=[container inside frame] → layout completes without throwing; frame update is allowed (Pass B legitimate)", async () => {
    // Setup идентичен first case, но containerScope='auto' разрешает Pass B.
    // Цель: задокументировать, что auto-scope не падает и возвращает batch;
    // frame size update — допустим, тест НЕ запрещает его.
    const store = makeFrameContainerStore(2);

    const result = await runLayout(
      store,
      {
        mode: "layered-tb",
        scope: "affected",
        affectedIds: new Set(["shape:container1"]),
        containerScope: "auto",
      },
      new Map(),
    );

    // Backend завершил layout с валидным batch (без elk-error reason).
    expect(result.reason).toBeUndefined();
    expect(result.batch).toBeDefined();
    expect(result.batch.updated).toBeDefined();

    // frame size update legitimate (либо есть, либо нет) — оба варианта OK.
    // Если присутствует — структура должна быть [oldRec, newRec].
    const frameUpdate = result.batch.updated["shape:frameA"];
    if (frameUpdate !== undefined) {
      expect(Array.isArray(frameUpdate)).toBe(true);
      expect(frameUpdate).toHaveLength(2);
    }
  });

  it("scope:'auto' + ids=[leaf1, leaf2] (multi-leaf inside frame) → leaves participate in layout; frame resize is legitimate", async () => {
    // Setup: frame + container с 2 leaves. Affect = оба leaf'а напрямую
    // (не container). containerScope='auto' разрешает Pass B на верхнем уровне.
    const store = makeFrameContainerStore(2);

    const result = await runLayout(
      store,
      {
        mode: "layered-tb",
        scope: "affected",
        affectedIds: new Set(["shape:leaf1", "shape:leaf2"]),
        containerScope: "auto",
      },
      new Map(),
    );

    // Backend завершил layout без ошибок.
    expect(result.reason).toBeUndefined();
    expect(result.batch).toBeDefined();

    // affected list содержит хотя бы один из переданных leaf'ов (Pass A прошёл).
    const affectedSet = new Set(result.affected);
    const leafTouched = affectedSet.has("shape:leaf1") || affectedSet.has("shape:leaf2");
    expect(leafTouched).toBe(true);

    // Frame resize в этом auto-scope сценарии — legitimate Pass B behaviour;
    // тест не enforce'ит наличие/отсутствие, лишь well-formedness структуры.
    const frameUpdate = result.batch.updated["shape:frameA"];
    if (frameUpdate !== undefined) {
      expect(Array.isArray(frameUpdate)).toBe(true);
      expect(frameUpdate).toHaveLength(2);
    }
  });
});
