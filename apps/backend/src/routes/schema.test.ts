/**
 * Tests для schema HTTP routes (DRW-134 Task 2.5).
 *
 * POST /api/schema/create         — Mode A (raw mermaid), Mode B (actions), error cases.
 * POST /api/schema/:frameId/patch  — apply actions, idempotency, error cases.
 * POST /api/schema/:frameId/overlay — overlay write, ownership guard.
 *
 * Использует makeApp({ inMemory: true }) аналогично routes-domain.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { makeApp } from "../index";
import { normalizeDirection } from "./schema";

// ---- Helpers ----

type AppInstance = ReturnType<typeof makeApp>;

async function postCreate(
  app: AppInstance["app"],
  body: unknown,
  room = "schema-test",
) {
  return app.fetch(
    new Request(`http://localhost/api/schema/create?room=${room}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function postPatch(
  app: AppInstance["app"],
  frameId: string,
  body: unknown,
  room = "schema-test",
) {
  return app.fetch(
    new Request(
      `http://localhost/api/schema/${encodeURIComponent(frameId)}/patch?room=${room}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  );
}

async function postOverlay(
  app: AppInstance["app"],
  frameId: string,
  body: unknown,
  room = "schema-test",
) {
  return app.fetch(
    new Request(
      `http://localhost/api/schema/${encodeURIComponent(frameId)}/overlay?room=${room}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  );
}

async function getCanvasView(
  app: AppInstance["app"],
  room = "schema-test",
) {
  return app.fetch(
    new Request(`http://localhost/api/canvas/view?room=${room}`),
  );
}

function getShapesByMeta<T = Record<string, unknown>>(
  rooms: AppInstance["rooms"],
  roomId: string,
) {
  return async () => {
    const r = await rooms.get(roomId);
    return Object.values(r.store.store).filter(
      (s) => s?.typeName === "shape",
    ) as T[];
  };
}

// ---- POST /api/schema/create ----

describe("POST /api/schema/create", () => {
  test("Mode A: valid mermaid → 200, frameId + nodeIds, room upgraded to v2", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const res = await postCreate(app, {
      label: "Auth flow",
      raw: "graph LR\n  user[User] --> api[API]",
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      ok: boolean;
      frameId: string;
      nodeIds: string[];
      version: number;
    };
    expect(body.ok).toBe(true);
    expect(typeof body.frameId).toBe("string");
    expect(body.frameId).toMatch(/^shape:/);
    expect(Array.isArray(body.nodeIds)).toBe(true);
    expect(body.nodeIds.length).toBe(2);
    expect(typeof body.version).toBe("number");

    // Room должна быть помечена v2.
    const room = await rooms.get("schema-test");
    expect(room.meta?.didrawProtocol).toBe("v2");
  });

  // DRW-159: tldraw v5 TLFrameShape.props.color стал required. Без него
  // mergeRemoteChanges/applyDiff на frontend бросает ValidationError и блокирует
  // apply всего WS batch'а. Regression test проверяет что schema-frame создаётся
  // с valid props per tldraw v5 schema.
  test("DRW-159: created schema-frame has valid tldraw v5 props (color set)", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const res = await postCreate(app, {
      label: "v5 frame test",
      raw: "graph LR\n  a --> b",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { frameId: string };
    const room = await rooms.get("schema-test");
    const frame = room.store.store[body.frameId] as
      | { type?: string; props?: { color?: string; name?: string; w?: number; h?: number } }
      | undefined;
    expect(frame?.type).toBe("frame");
    expect(frame?.props?.color).toBeDefined();
    // tldraw v5 valid TLDefaultColorStyle values
    expect([
      "black", "grey", "light-violet", "violet", "blue", "light-blue",
      "yellow", "orange", "green", "light-green", "light-red", "red", "white",
    ]).toContain(frame?.props?.color);
    expect(typeof frame?.props?.name).toBe("string");
    expect(typeof frame?.props?.w).toBe("number");
    expect(typeof frame?.props?.h).toBe("number");
  });

  test("Mode A: edges + subgraph → arrow shapes + group boundary shapes created", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const res = await postCreate(app, {
      label: "Test graph",
      raw: "graph LR\n  a[A] --> b(B)\n  b --> c[(DB)]\n  subgraph X\n    a\n    b\n  end",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; frameId: string; nodeIds: string[] };
    expect(body.ok).toBe(true);
    expect(body.nodeIds.length).toBe(3);

    const room = await rooms.get("schema-test");
    const allShapes = Object.values(room.store.store).filter((r) => r?.typeName === "shape");
    const frameChildren = allShapes.filter((r) => r?.parentId === body.frameId);

    // DRW-156 / DRW-150: nodes a and b belong to subgraph X → parented to group boundary shape, not frame.
    // Frame direct children: 1 schema-container (subgraph X) + 1 node geo (c) + 2 arrows = 4 shapes.
    const geoShapes = frameChildren.filter((r) => r?.type === "geo");
    const arrowShapes = frameChildren.filter((r) => r?.type === "arrow");
    const containerShapes = frameChildren.filter((r) => r?.type === "schema-container");

    expect(geoShapes.length).toBe(1); // 1 free node (c) — boundary is now schema-container
    expect(containerShapes.length).toBe(1); // 1 subgraph boundary (DRW-150)
    expect(arrowShapes.length).toBe(2);

    // The subgraph boundary shape is a frame child (DRW-150: schema-container).
    const boundaryShape = frameChildren.find(
      (r) => r?.type === "schema-container" && (r?.meta as { didrawSubgraph?: unknown })?.didrawSubgraph === true,
    );
    expect(boundaryShape).toBeDefined();

    // Nodes a and b must be children of the subgraph boundary, not the frame.
    const groupShapeId = boundaryShape?.id;
    const groupChildren = allShapes.filter((r) => r?.parentId === groupShapeId);
    const groupNodeGeos = groupChildren.filter((r) => r?.type === "geo" && (r?.meta as { didrawId?: unknown })?.didrawId);
    expect(groupNodeGeos.length).toBe(2); // a and b

    // Bindings: 2 arrows × 2 bindings = 4 binding records
    const bindings = Object.values(room.store.store).filter((r) => r?.typeName === "binding");
    expect(bindings.length).toBe(4);

    // All node geo shapes (across entire room) have didrawRole.
    const allNodeGeos = allShapes.filter((r) => r?.type === "geo" && (r?.meta as { didrawId?: unknown })?.didrawId);
    expect(allNodeGeos.every((r) => (r?.meta as { didrawRole?: unknown })?.didrawRole !== undefined)).toBe(true);
  });

  // DRW-156: Services should be parented to their subgraph wrappers, not the schema-frame.
  test("DRW-156: subgraph members parented to group boundary shape, not frame", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const res = await postCreate(app, {
      label: "Multi-group schema",
      raw: [
        "graph LR",
        "  subgraph GroupA",
        "    svc1[Service1]",
        "    svc2[Service2]",
        "  end",
        "  subgraph GroupB",
        "    svc3[Service3]",
        "  end",
        "  freeNode[FreeNode]",
        "  svc1 --> svc3",
      ].join("\n"),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; frameId: string; nodeIds: string[] };
    expect(body.ok).toBe(true);
    expect(body.nodeIds.length).toBe(4); // svc1, svc2, svc3, freeNode

    const room = await rooms.get("schema-test");
    const allShapes = Object.values(room.store.store).filter((r) => r?.typeName === "shape");

    // Find both group boundary shapes (DRW-150: now schema-container type).
    const boundaries = allShapes.filter(
      (r) => r?.type === "schema-container" && (r?.meta as { didrawSubgraph?: unknown })?.didrawSubgraph === true,
    );
    expect(boundaries.length).toBe(2); // GroupA and GroupB wrappers

    // Both boundaries must be direct children of the frame.
    expect(boundaries.every((b) => b?.parentId === body.frameId)).toBe(true);

    // Find GroupA boundary by name.
    const groupA = boundaries.find(
      (b) => (b?.meta as { didrawSubgraphName?: unknown })?.didrawSubgraphName === "GroupA",
    );
    const groupB = boundaries.find(
      (b) => (b?.meta as { didrawSubgraphName?: unknown })?.didrawSubgraphName === "GroupB",
    );
    expect(groupA).toBeDefined();
    expect(groupB).toBeDefined();

    // svc1 and svc2 must be children of GroupA.
    const groupAChildren = allShapes.filter((r) => r?.parentId === groupA?.id);
    const groupANodeLabels = groupAChildren
      .filter((r) => r?.type === "geo" && (r?.meta as { didrawId?: unknown })?.didrawId)
      .map((r) => (r?.meta as { didrawLabel?: unknown })?.didrawLabel);
    expect(groupANodeLabels.sort()).toEqual(["Service1", "Service2"]);

    // svc3 must be a child of GroupB.
    const groupBChildren = allShapes.filter((r) => r?.parentId === groupB?.id);
    const groupBNodeLabels = groupBChildren
      .filter((r) => r?.type === "geo" && (r?.meta as { didrawId?: unknown })?.didrawId)
      .map((r) => (r?.meta as { didrawLabel?: unknown })?.didrawLabel);
    expect(groupBNodeLabels).toEqual(["Service3"]);

    // freeNode must be a direct child of the frame (not any group).
    const freeNode = allShapes.find(
      (r) => r?.type === "geo" && (r?.meta as { didrawLabel?: unknown })?.didrawLabel === "FreeNode",
    );
    expect(freeNode).toBeDefined();
    expect(freeNode?.parentId).toBe(body.frameId);

    // Arrows are always parented to the frame (not groups).
    const arrows = allShapes.filter((r) => r?.type === "arrow");
    expect(arrows.every((a) => a?.parentId === body.frameId)).toBe(true);
  });

  test("Mode A: GET /api/canvas/view после create показывает frame", async () => {
    const { app } = makeApp({ inMemory: true });
    const createRes = await postCreate(app, {
      label: "My service",
      raw: "graph LR\n  svc[Service] --> db[(DB)]",
    });
    expect(createRes.status).toBe(200);
    const { frameId } = (await createRes.json()) as { frameId: string };

    const viewRes = await getCanvasView(app);
    expect(viewRes.status).toBe(200);
    const view = (await viewRes.json()) as {
      schemaVersion: string;
      frames: Array<{ id: string; raw: string }>;
    };
    expect(view.schemaVersion).toBe("v2");
    expect(view.frames.some((f) => f.id === frameId)).toBe(true);
  });

  test("Mode A: sequenceDiagram → 422 unsupported-diagram-type", async () => {
    const { app } = makeApp({ inMemory: true });
    const res = await postCreate(app, {
      label: "Sequence",
      raw: "sequenceDiagram\n  A->>B: Hi",
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { ok: boolean; errors: Array<{ code: string }> };
    expect(body.ok).toBe(false);
    expect(body.errors[0]?.code).toBe("unsupported-diagram-type");
  });

  test("Mode B: valid actions → frame created, RAW generated correctly", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const res = await postCreate(app, {
      label: "My schema",
      actions: [
        { kind: "schema-define", role: "service", label: "API" },
        { kind: "schema-define", role: "datastore", label: "DB" },
      ],
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      ok: boolean;
      frameId: string;
      nodeIds: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.nodeIds.length).toBe(2);

    // Verify frame in store has mermaidSource.
    const room = await rooms.get("schema-test");
    const frame = room.store.store[body.frameId];
    expect(frame).toBeDefined();
    expect(typeof (frame?.meta as { mermaidSource?: unknown })?.mermaidSource).toBe("string");
    const raw = (frame?.meta as { mermaidSource?: string })?.mermaidSource ?? "";
    expect(raw.length).toBeGreaterThan(0);
  });

  test("Mode B: actions array — пустой массив создаёт frame без children", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const res = await postCreate(app, {
      label: "Empty schema",
      actions: [],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; frameId: string; nodeIds: string[] };
    expect(body.ok).toBe(true);
    expect(body.nodeIds).toHaveLength(0);

    // Frame должен существовать.
    const room = await rooms.get("schema-test");
    const frame = room.store.store[body.frameId];
    expect(frame).toBeDefined();
    expect((frame?.meta as { didrawSchemaFrame?: boolean })?.didrawSchemaFrame).toBe(true);
  });

  test("missing body → 400", async () => {
    const { app } = makeApp({ inMemory: true });
    const res = await app.fetch(
      new Request("http://localhost/api/schema/create?room=r1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json!!!",
      }),
    );
    expect(res.status).toBe(400);
  });

  test("body без raw и без actions → 400", async () => {
    const { app } = makeApp({ inMemory: true });
    const res = await postCreate(app, { label: "only label" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  test("positionsOverride writes injected coords (frame-relative), skips ELK, sizes frame to union", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const res = await postCreate(app, {
      label: "T",
      raw: "flowchart LR\n  api[API] --> db[DB]",
      positionsOverride: {
        api: { x: 0, y: 0, w: 120, h: 60 },
        db: { x: 400, y: 0, w: 120, h: 60 },
      },
    }, "pos-override-room");
    expect(res.status).toBe(200);

    const room = await rooms.get("pos-override-room");
    const shapes = Object.values(room.store.store).filter((s) => s?.typeName === "shape") as Array<{
      type: string; x: number; y: number; meta?: Record<string, unknown>; props?: Record<string, unknown>;
    }>;
    const byLabel = (lbl: string) => shapes.find((s) => (s.meta?.didrawLabel as string | undefined) === lbl);

    const apiShape = byLabel("API");
    const dbShape = byLabel("DB");
    expect(apiShape).toBeDefined();
    expect(dbShape).toBeDefined();
    // injected coords landed (frame-relative; no subgraph here → flat == frame-relative)
    expect(apiShape!.x).toBe(0);
    expect(dbShape!.x).toBe(400); // NOT ELK-computed → proves ELK was skipped
    // frame sized to union (db right = 520) + pad 40
    const frame = shapes.find((s) => s.type === "frame");
    expect(frame).toBeDefined();
    expect((frame!.props!.w as number)).toBeGreaterThanOrEqual(520);
  });
});

// ---- POST /api/schema/:frameId/patch ----

describe("POST /api/schema/:frameId/patch", () => {
  /** Helper: создаём room с одним schema-frame и возвращаем frameId. */
  async function setupV2RoomWithFrame(app: AppInstance["app"], room = "patch-room") {
    const res = await app.fetch(
      new Request(`http://localhost/api/schema/create?room=${room}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: "Base",
          raw: "graph LR\n  api[API] --> db[(DB)]",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const { frameId, nodeIds } = (await res.json()) as { frameId: string; nodeIds: string[] };
    return { frameId, nodeIds };
  }

  test("AC-2: valid add action → addedNodeIds, RAW updated", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const { frameId } = await setupV2RoomWithFrame(app);

    const res = await postPatch(
      app,
      frameId,
      {
        actions: [
          { kind: "schema-define", role: "service", label: "Cache" },
        ],
      },
      "patch-room",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      addedNodeIds: string[];
      removedNodeIds: string[];
      orphanedOverlays: number;
      destructiveScore: number;
    };
    expect(body.ok).toBe(true);
    expect(body.addedNodeIds.length).toBe(1);
    expect(body.removedNodeIds.length).toBe(0);

    // Проверяем что RAW обновился.
    const room = await rooms.get("patch-room");
    const frame = room.store.store[frameId];
    const raw = (frame?.meta as { mermaidSource?: string })?.mermaidSource ?? "";
    expect(raw).toContain("Cache");
  });

  test("AC-3: unknown nodeId reference → errors: [{code:'unknown-node'}], RAW unchanged", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const { frameId } = await setupV2RoomWithFrame(app);

    const room = await rooms.get("patch-room");
    const frameBefore = room.store.store[frameId];
    const rawBefore = (frameBefore?.meta as { mermaidSource?: string })?.mermaidSource ?? "";

    const res = await postPatch(
      app,
      frameId,
      {
        actions: [
          { kind: "schema-connect", from: "nonexistent-id-xxx", to: "nonexistent-id-yyy" },
        ],
      },
      "patch-room",
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { ok: boolean; errors: Array<{ code: string }> };
    expect(body.ok).toBe(false);
    expect(body.errors[0]?.code).toBe("unknown-node");

    // RAW должен остаться нетронутым.
    const roomAfter = await rooms.get("patch-room");
    const frameAfter = roomAfter.store.store[frameId];
    const rawAfter = (frameAfter?.meta as { mermaidSource?: string })?.mermaidSource ?? "";
    expect(rawAfter).toBe(rawBefore);
  });

  test("Idempotency: повторный запрос с тем же clientOpId возвращает кешированный ответ", async () => {
    const { app } = makeApp({ inMemory: true });
    const { frameId } = await setupV2RoomWithFrame(app);

    const patchBody = {
      actions: [{ kind: "schema-define", role: "service", label: "Worker" }],
      clientOpId: "unique-op-id-111",
    };

    const res1 = await postPatch(app, frameId, patchBody, "patch-room");
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { ok: boolean; version: number; idempotent?: boolean };
    expect(body1.ok).toBe(true);
    expect(body1.idempotent).toBeUndefined(); // первый запрос — не из кеша

    const res2 = await postPatch(app, frameId, patchBody, "patch-room");
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { ok: boolean; version: number; idempotent?: boolean };
    expect(body2.ok).toBe(true);
    expect(body2.idempotent).toBe(true); // второй запрос — из кеша
    expect(body2.version).toBe(body1.version); // версия не изменилась
  });

  test("frame-not-found → 404", async () => {
    const { app } = makeApp({ inMemory: true });
    // Создаём v2 room через create.
    await postCreate(app, { label: "X", raw: "graph LR\n  a[A]" });

    const res = await postPatch(
      app,
      "shape:nonexistent999",
      { actions: [{ kind: "schema-define", role: "service", label: "X" }] },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; errors: Array<{ code: string }> };
    expect(body.ok).toBe(false);
    expect(body.errors[0]?.code).toBe("frame-not-found");
  });

  test("legacy-room-not-v2 → 422", async () => {
    const { app } = makeApp({ inMemory: true });
    // Не делаем create — room остаётся v1.
    const res = await postPatch(
      app,
      "shape:someid",
      { actions: [{ kind: "schema-define", role: "service", label: "X" }] },
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { ok: boolean; errors: Array<{ code: string }> };
    expect(body.ok).toBe(false);
    expect(body.errors[0]?.code).toBe("legacy-room-not-v2");
  });

  test("AC-6: schema-delete-node для node с overlay → orphanedOverlays: 1, entry preserved", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const { frameId, nodeIds } = await setupV2RoomWithFrame(app);
    const targetNodeId = nodeIds[0]!;

    // Сначала ставим overlay для первого nodeId.
    await postOverlay(
      app,
      frameId,
      { nodeId: targetNodeId, overlay: { position: { x: 100, y: 200 }, styleOwnedBy: "user" } },
      "patch-room",
    );

    // Удаляем ноду.
    const res = await postPatch(
      app,
      frameId,
      { actions: [{ kind: "schema-delete-node", nodeId: targetNodeId }] },
      "patch-room",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; orphanedOverlays: number; removedNodeIds: string[] };
    expect(body.ok).toBe(true);
    expect(body.orphanedOverlays).toBe(1);
    expect(body.removedNodeIds).toContain(targetNodeId);

    // Проверяем что orphan overlay сохранился в frame.meta.didrawOverlays.
    const room = await rooms.get("patch-room");
    const frame = room.store.store[frameId];
    const overlays = (frame?.meta as { didrawOverlays?: Record<string, unknown> })?.didrawOverlays ?? {};
    expect(overlays[targetNodeId]).toBeDefined();
  });

  test("rollback: batch of 3 actions, 2nd invalid → {ok:false}, RAW unchanged", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const { frameId } = await setupV2RoomWithFrame(app);

    const room = await rooms.get("patch-room");
    const frameBefore = room.store.store[frameId];
    const rawBefore = (frameBefore?.meta as { mermaidSource?: string })?.mermaidSource ?? "";

    const res = await postPatch(
      app,
      frameId,
      {
        actions: [
          { kind: "schema-define", role: "service", label: "OK1" },
          { kind: "schema-connect", from: "nope1-xxx123", to: "nope2-xxx456" }, // invalid: unknown nodes
          { kind: "schema-define", role: "service", label: "OK3" },
        ],
      },
      "patch-room",
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);

    // RAW должен остаться нетронутым.
    const roomAfter = await rooms.get("patch-room");
    const frameAfter = roomAfter.store.store[frameId];
    const rawAfter = (frameAfter?.meta as { mermaidSource?: string })?.mermaidSource ?? "";
    expect(rawAfter).toBe(rawBefore);
  });
});

// ---- POST /api/schema/:frameId/overlay ----

describe("POST /api/schema/:frameId/overlay", () => {
  /** Helper: создаём room с frame и первый nodeId. */
  async function setupV2WithOverlayTarget(app: AppInstance["app"], room = "overlay-room") {
    const res = await app.fetch(
      new Request(`http://localhost/api/schema/create?room=${room}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: "Overlay base",
          raw: "graph LR\n  target[Target node]",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const { frameId, nodeIds } = (await res.json()) as { frameId: string; nodeIds: string[] };
    const nodeId = nodeIds[0]!;
    return { frameId, nodeId };
  }

  test("write new overlay → 200, meta.didrawOverlays[nodeId] updated", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const { frameId, nodeId } = await setupV2WithOverlayTarget(app);

    const res = await postOverlay(
      app,
      frameId,
      {
        nodeId,
        overlay: { position: { x: 300, y: 150 }, color: "blue" },
      },
      "overlay-room",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Проверяем что overlay записался.
    const room = await rooms.get("overlay-room");
    const frame = room.store.store[frameId];
    const overlays = (frame?.meta as { didrawOverlays?: Record<string, unknown> })?.didrawOverlays ?? {};
    const entry = overlays[nodeId] as { position?: { x: number; y: number }; color?: string };
    expect(entry).toBeDefined();
    expect(entry?.position?.x).toBe(300);
    expect(entry?.position?.y).toBe(150);
    expect(entry?.color).toBe("blue");
  });

  test("ownership guard: user-owned overlay блокирует AI write (без styleOwnedBy:user)", async () => {
    const { app } = makeApp({ inMemory: true });
    const { frameId, nodeId } = await setupV2WithOverlayTarget(app);

    // Записываем user-owned overlay.
    const setRes = await postOverlay(
      app,
      frameId,
      { nodeId, overlay: { position: { x: 50, y: 50 }, styleOwnedBy: "user" } },
      "overlay-room",
    );
    expect(setRes.status).toBe(200);

    // Пытаемся перезаписать без styleOwnedBy:user (имитация AI write).
    const aiRes = await postOverlay(
      app,
      frameId,
      { nodeId, overlay: { position: { x: 999, y: 999 } } }, // нет styleOwnedBy
      "overlay-room",
    );
    expect(aiRes.status).toBe(422);
    const body = (await aiRes.json()) as { ok: boolean; errors: Array<{ code: string }> };
    expect(body.ok).toBe(false);
    expect(body.errors[0]?.code).toBe("overlay-user-owned");
  });

  test("ownership guard: user write поверх user-owned → 200 OK (user может перезаписать)", async () => {
    const { app } = makeApp({ inMemory: true });
    const { frameId, nodeId } = await setupV2WithOverlayTarget(app);

    // Записываем user-owned.
    await postOverlay(
      app,
      frameId,
      { nodeId, overlay: { position: { x: 50, y: 50 }, styleOwnedBy: "user" } },
      "overlay-room",
    );

    // Перезаписываем с styleOwnedBy:user — должно пройти.
    const res = await postOverlay(
      app,
      frameId,
      { nodeId, overlay: { position: { x: 100, y: 100 }, styleOwnedBy: "user" } },
      "overlay-room",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("frame-not-found → 404", async () => {
    const { app } = makeApp({ inMemory: true });
    // Создаём v2 room.
    await postCreate(app, { label: "Room", raw: "graph LR\n  a[A]" });

    const res = await postOverlay(
      app,
      "shape:nonexistent",
      { nodeId: "some-node", overlay: { color: "red" } },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; errors: Array<{ code: string }> };
    expect(body.ok).toBe(false);
    expect(body.errors[0]?.code).toBe("frame-not-found");
  });

  test("invalid body → 400", async () => {
    const { app } = makeApp({ inMemory: true });
    await postCreate(app, { label: "Room", raw: "graph LR\n  a[A]" });

    const res = await app.fetch(
      new Request("http://localhost/api/schema/shape:frame1/overlay?room=schema-test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ missing: "fields" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

// ---- DRW-174: POST /api/schema/:frameId/measured-bounds ----

describe("POST /api/schema/:frameId/measured-bounds (DRW-174)", () => {
  async function postBounds(
    app: AppInstance["app"],
    frameId: string,
    body: unknown,
    room = "bounds-room",
  ) {
    return app.fetch(
      new Request(
        `http://localhost/api/schema/${encodeURIComponent(frameId)}/measured-bounds?room=${room}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      ),
    );
  }

  /** Setup: create v2 frame с 1 нодой и вернуть {frameId, childShapeId}. */
  async function setupFrameWithChild(
    app: AppInstance["app"],
    rooms: AppInstance["rooms"],
    room = "bounds-room",
  ) {
    const res = await postCreate(
      app,
      { label: "Bounds base", raw: "graph TB\n  a[Node A]" },
      room,
    );
    expect(res.status).toBe(200);
    const { frameId } = (await res.json()) as { frameId: string };

    const r = await rooms.get(room);
    const child = Object.values(r.store.store).find(
      (s) =>
        s?.typeName === "shape" &&
        s?.type === "geo" &&
        (s.meta as { didrawSchemaParent?: string } | undefined)?.didrawSchemaParent === frameId,
    );
    if (!child) throw new Error("child shape not created");
    return { frameId, childShapeId: child.id };
  }

  test("apply measured bounds → 200, child.h updated, frame.h grew via re-layout", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const { frameId, childShapeId } = await setupFrameWithChild(app, rooms);

    const r1 = await rooms.get("bounds-room");
    const frameBefore = r1.store.store[frameId];
    const childBefore = r1.store.store[childShapeId];
    const childOldH = (childBefore?.props as { h?: number } | undefined)?.h ?? 0;
    const frameOldH = (frameBefore?.props as { h?: number } | undefined)?.h ?? 0;

    const measuredH = childOldH + 60; // simulate autosize growing child by 60px

    const res = await postBounds(app, frameId, {
      bounds: { [childShapeId]: { h: measuredH } },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      applied: number;
      skipped: number;
    };
    expect(body.ok).toBe(true);
    expect(body.applied).toBe(1);
    expect(body.skipped).toBe(0);

    const r2 = await rooms.get("bounds-room");
    const childAfter = r2.store.store[childShapeId];
    expect((childAfter?.props as { h?: number }).h).toBeCloseTo(measuredH, 1);

    const frameAfter = r2.store.store[frameId];
    const frameNewH = (frameAfter?.props as { h?: number } | undefined)?.h ?? 0;
    expect(frameNewH).toBeGreaterThan(frameOldH);
  });

  test("shape not descendant of frame → skipped, applied=0", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const { frameId } = await setupFrameWithChild(app, rooms);

    const res = await postBounds(app, frameId, {
      bounds: { "shape:nonexistent": { h: 200 } },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { applied: number; skipped: number };
    expect(body.applied).toBe(0);
    expect(body.skipped).toBe(1);
  });

  test("no-op bounds (same as current) → applied=0, no re-layout", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const { frameId, childShapeId } = await setupFrameWithChild(app, rooms);

    const r0 = await rooms.get("bounds-room");
    const versionBefore = r0.version;
    const child = r0.store.store[childShapeId];
    const currentH = (child?.props as { h?: number } | undefined)?.h ?? 0;

    const res = await postBounds(app, frameId, {
      bounds: { [childShapeId]: { h: currentH } },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { applied: number; skipped: number };
    expect(body.applied).toBe(0);
    expect(body.skipped).toBe(1);

    const r1 = await rooms.get("bounds-room");
    expect(r1.version).toBe(versionBefore);
  });

  test("bounds without numeric w/h → skipped", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const { frameId, childShapeId } = await setupFrameWithChild(app, rooms);

    const res = await postBounds(app, frameId, {
      bounds: { [childShapeId]: { w: "not-a-number" } },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { applied: number; skipped: number };
    expect(body.applied).toBe(0);
    expect(body.skipped).toBe(1);
  });

  test("frame-not-found → 404", async () => {
    const { app } = makeApp({ inMemory: true });
    await postCreate(app, { label: "Room", raw: "graph LR\n  a[A]" }, "bounds-room");

    const res = await postBounds(app, "shape:nonexistent", { bounds: {} });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; errors: Array<{ code: string }> };
    expect(body.ok).toBe(false);
    expect(body.errors[0]?.code).toBe("frame-not-found");
  });

  test("legacy room (not v2) → 422", async () => {
    const { app } = makeApp({ inMemory: true });
    // Don't call postCreate → room stays v1.
    const res = await postBounds(app, "shape:any", { bounds: {} }, "legacy-room");
    expect(res.status).toBe(422);
    const body = (await res.json()) as { ok: boolean; errors: Array<{ code: string }> };
    expect(body.ok).toBe(false);
    expect(body.errors[0]?.code).toBe("legacy-room-not-v2");
  });

  test("bad-request (no bounds field) → 400", async () => {
    const { app } = makeApp({ inMemory: true });
    await postCreate(app, { label: "Room", raw: "graph LR\n  a[A]" }, "bounds-room");

    const res = await postBounds(app, "shape:any", { foo: "bar" });
    expect(res.status).toBe(400);
  });

  test("multiple children measured at once → all applied, re-layout once", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const res = await postCreate(
      app,
      { label: "Multi", raw: "graph TB\n  a[Node A]\n  b[Node B]\n  c[Node C]" },
      "bounds-room",
    );
    expect(res.status).toBe(200);
    const { frameId } = (await res.json()) as { frameId: string };

    const r0 = await rooms.get("bounds-room");
    const children = Object.values(r0.store.store).filter(
      (s) =>
        s?.typeName === "shape" &&
        s?.type === "geo" &&
        (s.meta as { didrawSchemaParent?: string } | undefined)?.didrawSchemaParent === frameId,
    );
    expect(children.length).toBe(3);

    const bounds: Record<string, { h: number }> = {};
    for (const c of children) {
      const oldH = (c.props as { h?: number } | undefined)?.h ?? 0;
      bounds[c.id] = { h: oldH + 50 };
    }

    const res2 = await postBounds(app, frameId, { bounds });
    expect(res2.status).toBe(200);
    const body = (await res2.json()) as { applied: number; skipped: number };
    expect(body.applied).toBe(3);
    expect(body.skipped).toBe(0);
  });
});

// ---- DRW-178: arrow kind defaults ----

describe("POST /api/schema/create — DRW-178 arrow kind defaults to elbow", () => {
  test("mermaid-imported arrows default to kind='elbow'", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const res = await postCreate(
      app,
      { label: "Arrow kind test", raw: "graph LR\n  a[A] --> b[B]" },
      "arrow-kind-room",
    );
    expect(res.status).toBe(200);

    const room = await rooms.get("arrow-kind-room");
    const arrows = Object.values(room.store.store).filter(
      (r) => r?.typeName === "shape" && r?.type === "arrow",
    );
    expect(arrows.length).toBe(1);
    const arrow = arrows[0]!;
    const props = arrow.props as Record<string, unknown>;
    expect(props.kind).toBe("elbow");
  });
});

// ---- DRW-172: post-layout anchor distribution ----

describe("POST /api/schema/create — DRW-172 per-edge anchors", () => {
  test("hub-spoke mermaid → bindings get isPrecise=true with distributed anchors, arrows get port meta", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const res = await postCreate(
      app,
      {
        label: "Hub",
        raw: `flowchart LR
  hub[Hub]
  hub --> a[Target A]
  hub --> b[Target B]
  hub --> c[Target C]`,
      },
      "anchors-room",
    );
    expect(res.status).toBe(200);
    const { frameId } = (await res.json()) as { frameId: string };
    expect(frameId).toBeDefined();

    const room = await rooms.get("anchors-room");
    const records = Object.values(room.store.store);

    const bindings = records.filter((r) => r?.typeName === "binding");
    expect(bindings.length).toBe(6); // 3 arrows × 2 bindings each

    // All bindings should have isPrecise=true after anchor pass.
    const allPrecise = bindings.every(
      (b) =>
        (b!.props as { isPrecise?: boolean } | undefined)?.isPrecise === true,
    );
    expect(allPrecise).toBe(true);

    // Anchors should NOT all be center (0.5, 0.5) — distribution applied.
    const allCentered = bindings.every((b) => {
      const a = (b!.props as { normalizedAnchor?: { x: number; y: number } })
        ?.normalizedAnchor;
      return a?.x === 0.5 && a?.y === 0.5;
    });
    expect(allCentered).toBe(false);

    // Arrows should have port meta written.
    const arrows = records.filter(
      (r) => r?.typeName === "shape" && r?.type === "arrow",
    );
    expect(arrows.length).toBe(3);
    for (const a of arrows) {
      const meta = a!.meta as Record<string, unknown>;
      expect(meta.didrawSourcePort).toBeDefined();
      expect(meta.didrawTargetPort).toBeDefined();
    }
  });

  test("single arrow A → B (B east of A) → source anchor on right, target on left", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const res = await postCreate(
      app,
      { label: "Simple", raw: "graph LR\n  a[A] --> b[B]" },
      "simple-room",
    );
    expect(res.status).toBe(200);

    const room = await rooms.get("simple-room");
    const arrows = Object.values(room.store.store).filter(
      (r) => r?.typeName === "shape" && r?.type === "arrow",
    );
    expect(arrows.length).toBe(1);
    const arrow = arrows[0]!;
    const meta = arrow.meta as Record<string, unknown>;
    expect(meta.didrawSourcePort).toBe("right");
    expect(meta.didrawTargetPort).toBe("left");
  });

  test("idempotent: anchors are not re-written if already correct (verified via version stability)", async () => {
    // Trigger a re-layout via measured-bounds with no-op bounds.
    // The anchor pass should detect already-correct anchors and not bump version further.
    const { app, rooms } = makeApp({ inMemory: true });
    const createRes = await postCreate(
      app,
      { label: "Idempotent", raw: "graph LR\n  a[A] --> b[B]" },
      "idem-room",
    );
    expect(createRes.status).toBe(200);
    const { frameId } = (await createRes.json()) as { frameId: string };

    const r0 = await rooms.get("idem-room");
    const versionAfterCreate = r0.version;

    // POST measured-bounds with empty bounds → should be a no-op (no layout, no anchors).
    const boundsRes = await app.fetch(
      new Request(
        `http://localhost/api/schema/${encodeURIComponent(frameId)}/measured-bounds?room=idem-room`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ bounds: {} }),
        },
      ),
    );
    expect(boundsRes.status).toBe(200);
    const body = (await boundsRes.json()) as { applied: number };
    expect(body.applied).toBe(0);

    const r1 = await rooms.get("idem-room");
    // Version should be unchanged: no applied bounds, no re-layout, anchors already correct.
    expect(r1.version).toBe(versionAfterCreate);
  });
});

// ---- DRW-153: mermaid style directives → shape props ----

describe("POST /api/schema/create — DRW-153 mermaid style directives applied to shapes", () => {
  test("style fill:#e3f2fd on node → shape props.fill is not 'none' (solid/semi) and color is mapped", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const res = await postCreate(app, {
      label: "Styled",
      raw: `graph LR
  api[API Gateway]
  style api fill:#e3f2fd,stroke:#1565c0`,
    }, "drw153-style-test");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; frameId: string; nodeIds: string[] };
    expect(body.ok).toBe(true);

    const room = await rooms.get("drw153-style-test");
    const allShapes = Object.values(room.store.store);
    const apiNode = allShapes.find(
      (s) => s?.typeName === "shape" && s?.type === "geo" &&
        (s?.meta as { didrawLabel?: unknown })?.didrawLabel === "API Gateway"
    ) as { props?: { fill?: string; color?: string; labelColor?: string } } | undefined;

    expect(apiNode).toBeDefined();
    // fill style should be non-none (solid/semi) because mermaid fill was set
    expect(apiNode?.props?.fill).not.toBe("none");
    // color should be a valid tldraw named color (mapped from the hex)
    const validTldrawColors = ["black", "grey", "light-violet", "violet", "blue", "light-blue", "yellow", "orange", "green", "light-green", "light-red", "red"];
    expect(validTldrawColors).toContain(apiNode?.props?.color);
  });

  test("style fill without stroke → fill applied, color from fill mapping", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const res = await postCreate(app, {
      label: "FillOnly",
      raw: `graph TD
  EventRouter[Event Router]
  style EventRouter fill:#fff3e0`,
    }, "drw153-fillonly");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; frameId: string };
    expect(body.ok).toBe(true);

    const room = await rooms.get("drw153-fillonly");
    const allShapes = Object.values(room.store.store);
    const node = allShapes.find(
      (s) => s?.typeName === "shape" && s?.type === "geo" &&
        (s?.meta as { didrawLabel?: unknown })?.didrawLabel === "Event Router"
    ) as { props?: { fill?: string; color?: string } } | undefined;

    expect(node).toBeDefined();
    expect(node?.props?.fill).toBe("solid"); // fill was set → solid mode
  });

  test("style color (text) → shape labelColor mapped from hex", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const res = await postCreate(app, {
      label: "TextColor",
      raw: `graph LR
  svc[Service]
  style svc fill:#e8f5e9,color:#1b5e20`,
    }, "drw153-textcolor");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const room = await rooms.get("drw153-textcolor");
    const allShapes = Object.values(room.store.store);
    const node = allShapes.find(
      (s) => s?.typeName === "shape" && s?.type === "geo" &&
        (s?.meta as { didrawLabel?: unknown })?.didrawLabel === "Service"
    ) as { props?: { labelColor?: string } } | undefined;

    expect(node).toBeDefined();
    // labelColor should be a valid tldraw named color
    const validTldrawColors = ["black", "grey", "light-violet", "violet", "blue", "light-blue", "yellow", "orange", "green", "light-green", "light-red", "red"];
    expect(validTldrawColors).toContain(node?.props?.labelColor);
    // color #1b5e20 is a dark color — it maps to a valid tldraw color (nearest-neighbor)
    // (nearest by RGB; green/black family depending on exact tldraw palette)
    expect(node?.props?.labelColor).toBeDefined();
  });

  test("node without style directive → default preset color/fill unchanged", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const res = await postCreate(app, {
      label: "NoStyle",
      raw: `graph LR
  a[Service A] --> b[Service B]`,
    }, "drw153-nostyle");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const room = await rooms.get("drw153-nostyle");
    const allShapes = Object.values(room.store.store);
    const nodeA = allShapes.find(
      (s) => s?.typeName === "shape" && s?.type === "geo" &&
        (s?.meta as { didrawLabel?: unknown })?.didrawLabel === "Service A"
    ) as { props?: { fill?: string; labelColor?: string } } | undefined;

    expect(nodeA).toBeDefined();
    // Without style directive, labelColor defaults to "black"
    expect(nodeA?.props?.labelColor).toBe("black");
  });

  test("DRW-150: subgraph wrapper создаётся как schema-container shape", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const res = await postCreate(app, {
      raw: `flowchart TB
 subgraph INPUT["Вход"]
   SE["SourceEvent"]
 end
 style INPUT fill:#e3f2fd,stroke:#1565c0
`,
    });
    expect(res.status).toBe(200);
    const room = await rooms.get("schema-test");
    const wrapper = Object.values(room.store.store).find(
      (r: any) => r?.type === "schema-container",
    ) as any;
    expect(wrapper).toBeDefined();
    expect(wrapper.type).toBe("schema-container");
    expect(wrapper.props.name).toBe("Вход");
    expect(wrapper.props.direction).toBe("TB");
    expect(wrapper.props.titlePosition).toBe("inside-center");
    expect(wrapper.props.dash).toBe("dashed");
    expect(wrapper.meta.didrawSubgraph).toBe(true);
  });

  test("DRW-150 AC-8: subgraph С style directive → wrapper получает non-default color (не grey)", async () => {
    // stroke:#1565c0 (dark blue) → hexToTldrawColor → "blue" (nearest in tldraw palette).
    // Default factory color is "grey" — if style lookup fails, test will catch it.
    const { app, rooms } = makeApp({ inMemory: true });
    const res = await postCreate(app, {
      raw: `flowchart TB
 subgraph INPUT["Вход"]
   SE["SourceEvent"]
 end
 style INPUT fill:#e3f2fd,stroke:#1565c0
`,
    }, "drw150-styled");
    expect(res.status).toBe(200);
    const room = await rooms.get("drw150-styled");
    const wrapper = Object.values(room.store.store).find(
      (r: any) => r?.type === "schema-container",
    ) as any;
    expect(wrapper).toBeDefined();
    // Must NOT be default grey — proves style lookup (C1 fix) actually worked
    expect(wrapper.props.color).not.toBe("grey");
    // stroke:#1565c0 → nearest tldraw color is "blue"
    expect(["blue", "light-blue"]).toContain(wrapper.props.color);
  });

  test("DRW-150 AC-8: subgraph БЕЗ style directive → wrapper получает default grey", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const res = await postCreate(app, {
      raw: `flowchart TB
 subgraph INPUT["Вход"]
   SE["SourceEvent"]
 end
`,
    }, "drw150-unstyled");
    expect(res.status).toBe(200);
    const room = await rooms.get("drw150-unstyled");
    const wrapper = Object.values(room.store.store).find(
      (r: any) => r?.type === "schema-container",
    ) as any;
    expect(wrapper).toBeDefined();
    // No style directive → factory default
    expect(wrapper.props.color).toBe("grey");
  });

  test("mixed styled and unstyled nodes in same diagram", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const res = await postCreate(app, {
      label: "Mixed",
      raw: `graph LR
  a[API] --> b[(DB)] --> c[Cache]
  style a fill:#e3f2fd,stroke:#1565c0`,
    }, "drw153-mixed");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; nodeIds: string[] };
    expect(body.ok).toBe(true);
    expect(body.nodeIds).toHaveLength(3);

    const room = await rooms.get("drw153-mixed");
    const allShapes = Object.values(room.store.store);
    const nodeA = allShapes.find(
      (s) => s?.typeName === "shape" && s?.type === "geo" &&
        (s?.meta as { didrawLabel?: unknown })?.didrawLabel === "API"
    ) as { props?: { fill?: string } } | undefined;
    const nodeC = allShapes.find(
      (s) => s?.typeName === "shape" && s?.type === "geo" &&
        (s?.meta as { didrawLabel?: unknown })?.didrawLabel === "Cache"
    ) as { props?: { fill?: string } } | undefined;

    expect(nodeA).toBeDefined();
    expect(nodeC).toBeDefined();
    // 'a' was styled with fill → solid
    expect(nodeA?.props?.fill).toBe("solid");
    // 'c' was not styled → default fill from rolePreset (service preset uses "semi")
    expect(nodeC?.props?.fill).toBe("semi");
  });
});

// ---- DRW-178: 4-way direction survival ----

describe("normalizeDirection — DRW-178 4-way preservation", () => {
  test("TB → TB", () => expect(normalizeDirection("TB")).toBe("TB"));
  test("LR → LR", () => expect(normalizeDirection("LR")).toBe("LR"));
  test("BT → BT (not collapsed to TB)", () => expect(normalizeDirection("BT")).toBe("BT"));
  test("RL → RL (not collapsed to LR)", () => expect(normalizeDirection("RL")).toBe("RL"));
  test("undefined → TB (default)", () => expect(normalizeDirection(undefined)).toBe("TB"));
});

describe("POST /api/schema/create — DRW-178 subgraph direction RL survives", () => {
  test("subgraph with `direction RL` keeps meta props.direction='RL' after create", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const res = await postCreate(
      app,
      {
        label: "RL test",
        raw: `flowchart TB
  subgraph S1["S1"]
    direction RL
    A["A"]
    B["B"]
  end
  A --> B`,
      },
      "drw178-rl-room",
    );
    expect(res.status).toBe(200);

    const room = await rooms.get("drw178-rl-room");
    const shapes = Object.values(room.store.store);
    const container = shapes.find(
      (s) =>
        s?.typeName === "shape" &&
        s?.type === "schema-container" &&
        (s?.meta as { didrawSubgraphName?: string })?.didrawSubgraphName === "S1",
    );
    expect(container).toBeDefined();
    const props = container!.props as Record<string, unknown>;
    expect(props.direction).toBe("RL");
  });
});

describe("POST /api/schema/create — DRW-178 subgraph without explicit direction → inference", () => {
  test("subgraph WITHOUT explicit direction gets meta.didrawDirectionInherited=true", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const res = await postCreate(
      app,
      {
        label: "inherited direction test",
        raw: `flowchart TB
  subgraph S1["S1"]
    A["A"]
    B["B"]
  end
  subgraph S2["S2"]
    C["C"]
    D["D"]
  end
  A --> C
  B --> D`,
      },
      "drw178-inherited-room",
    );
    expect(res.status).toBe(200);

    const room = await rooms.get("drw178-inherited-room");
    const shapes = Object.values(room.store.store);

    // Containers without explicit direction must have didrawDirectionInherited=true
    // so inferContainerDirections can auto-infer the best layout direction.
    const s1 = shapes.find(
      (s) =>
        s?.typeName === "shape" &&
        s?.type === "schema-container" &&
        (s?.meta as { didrawSubgraphName?: string })?.didrawSubgraphName === "S1",
    );
    expect(s1).toBeDefined();
    expect((s1!.meta as Record<string, unknown>).didrawDirectionInherited).toBe(true);

    const s2 = shapes.find(
      (s) =>
        s?.typeName === "shape" &&
        s?.type === "schema-container" &&
        (s?.meta as { didrawSubgraphName?: string })?.didrawSubgraphName === "S2",
    );
    expect(s2).toBeDefined();
    expect((s2!.meta as Record<string, unknown>).didrawDirectionInherited).toBe(true);
  });

  test("subgraph WITH explicit direction does NOT get meta.didrawDirectionInherited", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const res = await postCreate(
      app,
      {
        label: "explicit direction test",
        raw: `flowchart TB
  subgraph S1["S1"]
    direction LR
    A["A"]
    B["B"]
  end`,
      },
      "drw178-explicit-room",
    );
    expect(res.status).toBe(200);

    const room = await rooms.get("drw178-explicit-room");
    const shapes = Object.values(room.store.store);
    const s1 = shapes.find(
      (s) =>
        s?.typeName === "shape" &&
        s?.type === "schema-container" &&
        (s?.meta as { didrawSubgraphName?: string })?.didrawSubgraphName === "S1",
    );
    expect(s1).toBeDefined();
    // Explicit direction → no inherited flag → inference skips this container.
    expect((s1!.meta as Record<string, unknown>).didrawDirectionInherited).toBeUndefined();
    // props.direction must be preserved as user specified.
    expect((s1!.props as Record<string, unknown>).direction).toBe("LR");
  });
});
