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

    const geoShapes = frameChildren.filter((r) => r?.type === "geo");
    const arrowShapes = frameChildren.filter((r) => r?.type === "arrow");

    // 3 geo nodes + 2 arrows (a→b, b→c) + 1 group boundary = 6 frame children
    expect(geoShapes.length).toBe(4); // 3 nodes + 1 subgraph boundary
    expect(arrowShapes.length).toBe(2);

    // Bindings: 2 arrows × 2 bindings = 4 binding records
    const bindings = Object.values(room.store.store).filter((r) => r?.typeName === "binding");
    expect(bindings.length).toBe(4);

    // Verify didrawRole is stored on node geo shapes.
    const nodeGeos = geoShapes.filter((r) => (r?.meta as { didrawId?: unknown })?.didrawId);
    expect(nodeGeos.every((r) => (r?.meta as { didrawRole?: unknown })?.didrawRole !== undefined)).toBe(true);
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
