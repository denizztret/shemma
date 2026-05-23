/**
 * Tests для schema duplicate + delete HTTP routes — DRW-134 Task 3.1.
 *
 * POST /api/schema/:frameId/duplicate — дубликация frame с ID remap.
 * DELETE /api/schema/:frameId         — удаление frame + детей.
 *
 * Использует makeApp({ inMemory: true }) аналогично schema.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { makeApp } from "../index";

// ---- Helpers ----

type AppInstance = ReturnType<typeof makeApp>;

async function postCreate(
  app: AppInstance["app"],
  body: unknown,
  room = "dup-test",
) {
  return app.fetch(
    new Request(`http://localhost/api/schema/create?room=${room}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function postDuplicate(
  app: AppInstance["app"],
  frameId: string,
  body: unknown = {},
  room = "dup-test",
) {
  return app.fetch(
    new Request(
      `http://localhost/api/schema/${encodeURIComponent(frameId)}/duplicate?room=${room}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  );
}

async function deleteFrame(
  app: AppInstance["app"],
  frameId: string,
  room = "dup-test",
) {
  return app.fetch(
    new Request(
      `http://localhost/api/schema/${encodeURIComponent(frameId)}?room=${room}`,
      {
        method: "DELETE",
      },
    ),
  );
}

async function getCanvasView(
  app: AppInstance["app"],
  room = "dup-test",
) {
  return app.fetch(
    new Request(`http://localhost/api/canvas/view?room=${room}`),
  );
}

// ---- POST /api/schema/:frameId/duplicate ----

describe("POST /api/schema/:frameId/duplicate", () => {
  test("happy path: дубликация frame → 200, newFrameId + nodeIdMap", async () => {
    const { app } = makeApp({ inMemory: true });

    // Создаём frame
    const createRes = await postCreate(app, {
      label: "Auth flow",
      raw: "graph LR\n  user[User] --> api[API]",
    });
    expect(createRes.status).toBe(200);
    const createBody = (await createRes.json()) as { ok: boolean; frameId: string; nodeIds: string[] };
    expect(createBody.ok).toBe(true);
    const { frameId, nodeIds } = createBody;

    // Дублируем
    const dupRes = await postDuplicate(app, frameId, { newLabel: "Auth flow v2" });
    expect(dupRes.status).toBe(200);

    const dupBody = (await dupRes.json()) as {
      ok: boolean;
      newFrameId: string;
      nodeIdMap: Record<string, string>;
    };
    expect(dupBody.ok).toBe(true);
    expect(typeof dupBody.newFrameId).toBe("string");
    expect(dupBody.newFrameId).not.toBe(frameId);
    expect(dupBody.newFrameId).toMatch(/^shape:/);

    // nodeIdMap должен содержать маппинг для каждого nodeId
    expect(typeof dupBody.nodeIdMap).toBe("object");
    const mapKeys = Object.keys(dupBody.nodeIdMap);
    expect(mapKeys.length).toBe(nodeIds.length);

    // Все оригинальные nodeIds должны быть в ключах nodeIdMap
    for (const nId of nodeIds) {
      expect(dupBody.nodeIdMap[nId]).toBeDefined();
      expect(dupBody.nodeIdMap[nId]).not.toBe(nId); // новый ID
    }
  });

  test("duplicate увеличивает количество frames в canvas view", async () => {
    const { app } = makeApp({ inMemory: true });

    const createRes = await postCreate(app, {
      label: "Schema",
      raw: "graph LR\n  a[A] --> b[B]",
    });
    const { frameId } = (await createRes.json()) as { frameId: string };

    // Canvas view до дубликации
    const viewBefore = (await (await getCanvasView(app)).json()) as {
      schemaVersion: string;
      frames: Array<{ id: string; label: string }>;
    };
    expect(viewBefore.frames).toHaveLength(1);

    // Дублируем
    await postDuplicate(app, frameId, { newLabel: "Schema (copy)" });

    // Canvas view после дубликации
    const viewAfter = (await (await getCanvasView(app)).json()) as {
      schemaVersion: string;
      frames: Array<{ id: string; label: string }>;
    };
    expect(viewAfter.frames).toHaveLength(2);

    // Один из frames имеет label "Schema (copy)"
    const labels = viewAfter.frames.map((f) => f.label);
    expect(labels).toContain("Schema (copy)");
  });

  test("duplicate без newLabel: использует дефолтный label с суффиксом (copy)", async () => {
    const { app } = makeApp({ inMemory: true });

    const createRes = await postCreate(app, {
      label: "My Schema",
      raw: "graph LR\n  a[A]",
    });
    const { frameId } = (await createRes.json()) as { frameId: string };

    // Дублируем без передачи newLabel
    const dupRes = await postDuplicate(app, frameId, {});
    expect(dupRes.status).toBe(200);

    const dupBody = (await dupRes.json()) as { ok: boolean; newFrameId: string };
    expect(dupBody.ok).toBe(true);

    // Canvas view — найдём новый frame
    const view = (await (await getCanvasView(app)).json()) as {
      frames: Array<{ id: string; label: string }>;
    };
    const newFrame = view.frames.find((f) => f.id === dupBody.newFrameId);
    expect(newFrame).toBeDefined();
    // Label должен содержать "(copy)" или похожее
    expect(newFrame!.label).toContain("copy");
  });

  test("duplicate несуществующего frameId → 404", async () => {
    const { app } = makeApp({ inMemory: true });

    // Сначала создаём v2 room (через create)
    await postCreate(app, {
      label: "Schema",
      raw: "graph LR\n  a[A]",
    });

    const res = await postDuplicate(app, "shape:nonexistent", { newLabel: "Copy" });
    expect(res.status).toBe(404);

    const body = (await res.json()) as { ok: boolean; code?: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("frame-not-found");
  });

  test("duplicate non-schema shape → 422 not-schema-frame", async () => {
    const { app, rooms } = makeApp({ inMemory: true });

    // Создаём v2 room через schema create
    await postCreate(app, {
      label: "Schema",
      raw: "graph LR\n  a[A]",
    });

    // Добавляем обычный shape (не schema-frame) в store напрямую
    const room = await rooms.get("dup-test");
    const fakeShapeId = "shape:not-a-frame";
    (room.store.store as Record<string, unknown>)[fakeShapeId] = {
      id: fakeShapeId,
      typeName: "shape",
      type: "geo",
      x: 0,
      y: 0,
      parentId: "page:page",
      index: "a1",
      isLocked: false,
      opacity: 1,
      rotation: 0,
      props: { w: 100, h: 100, geo: "rectangle" },
      meta: { didrawSchemaFrame: false },
    };

    const res = await postDuplicate(app, fakeShapeId, { newLabel: "Copy" });
    expect(res.status).toBe(422);

    const body = (await res.json()) as { ok: boolean; code?: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("not-schema-frame");
  });
});

// ---- DELETE /api/schema/:frameId ----

describe("DELETE /api/schema/:frameId", () => {
  test("happy path: frame + children удалены из canvas view", async () => {
    const { app } = makeApp({ inMemory: true });

    // Создаём frame с несколькими nodes
    const createRes = await postCreate(app, {
      label: "To Delete",
      raw: "graph LR\n  a[A] --> b[B]",
    });
    const { frameId, nodeIds } = (await createRes.json()) as { frameId: string; nodeIds: string[] };
    expect(nodeIds.length).toBe(2);

    // Canvas view до удаления
    const viewBefore = (await (await getCanvasView(app)).json()) as {
      frames: Array<{ id: string }>;
    };
    expect(viewBefore.frames).toHaveLength(1);

    // Удаляем frame
    const delRes = await deleteFrame(app, frameId);
    expect(delRes.status).toBe(200);

    const delBody = (await delRes.json()) as { ok: boolean };
    expect(delBody.ok).toBe(true);

    // Canvas view после удаления
    const viewAfter = (await (await getCanvasView(app)).json()) as {
      frames: Array<{ id: string }>;
    };
    expect(viewAfter.frames).toHaveLength(0);
  });

  test("delete несуществующего frameId → 404", async () => {
    const { app } = makeApp({ inMemory: true });

    // Создаём v2 room
    await postCreate(app, {
      label: "Schema",
      raw: "graph LR\n  a[A]",
    });

    const res = await deleteFrame(app, "shape:nonexistent");
    expect(res.status).toBe(404);

    const body = (await res.json()) as { ok: boolean; code?: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("frame-not-found");
  });

  test("delete + duplicate: оригинал удалён, копия остаётся", async () => {
    const { app } = makeApp({ inMemory: true });

    const createRes = await postCreate(app, {
      label: "Schema",
      raw: "graph LR\n  a[A] --> b[B]",
    });
    const { frameId } = (await createRes.json()) as { frameId: string };

    // Дублируем
    const dupRes = await postDuplicate(app, frameId, { newLabel: "Copy" });
    const { newFrameId } = (await dupRes.json()) as { newFrameId: string };

    // Удаляем оригинал
    const delRes = await deleteFrame(app, frameId);
    expect(delRes.status).toBe(200);

    // Canvas view: только копия осталась
    const view = (await (await getCanvasView(app)).json()) as {
      frames: Array<{ id: string; label: string }>;
    };
    expect(view.frames).toHaveLength(1);
    expect(view.frames[0]!.id).toBe(newFrameId);
    expect(view.frames[0]!.label).toBe("Copy");
  });
});
