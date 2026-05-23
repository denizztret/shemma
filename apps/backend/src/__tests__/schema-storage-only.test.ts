/**
 * DRW-134 Task 3.3 — Storage-only E2E test: full DRW-127 closure verification.
 *
 * Verifies that the complete schema-frame write API works **without any WS
 * subscriber** (no open browser tab). All operations must succeed and the
 * resulting state must be coherent, closing DRW-127.
 *
 * Scenarios:
 *   1. AC-11: POST /api/schema/create → frame persisted (no WS subscriber).
 *   2. Headless pipeline: create → patch → overlay → duplicate → delete.
 *   3. WS reconnect: storage-only writes surface to a subscriber that joins later.
 */

import { describe, expect, test } from "bun:test";
import { WsHub, type Sock } from "../ws";
import { makeApp } from "../index";

// ---- Helpers ----

type AppInstance = ReturnType<typeof makeApp>;

async function postCreate(
  app: AppInstance["app"],
  body: unknown,
  room = "storage-only-room",
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
  room = "storage-only-room",
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
  room = "storage-only-room",
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

async function postDuplicate(
  app: AppInstance["app"],
  frameId: string,
  body: unknown = {},
  room = "storage-only-room",
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
  room = "storage-only-room",
) {
  return app.fetch(
    new Request(
      `http://localhost/api/schema/${encodeURIComponent(frameId)}?room=${room}`,
      { method: "DELETE" },
    ),
  );
}

async function getCanvasView(
  app: AppInstance["app"],
  room = "storage-only-room",
) {
  return app.fetch(
    new Request(`http://localhost/api/canvas/view?room=${room}`),
  );
}

// ---- Scenario 1 — AC-11: single create без WS subscriber ----

describe("DRW-134 storage-only path — AC-11 (closes DRW-127)", () => {
  test("AC-11: POST /api/schema/create без WS subscriber → frame persisted, view reflects", async () => {
    const { app, rooms, bus } = makeApp({ inMemory: true });

    // Critical: нет bus.attach → нет WS subscriber в этом room.
    expect(bus.subscriberCount(rooms["space"]?.id ?? "", "storage-only-room")).toBe(0);

    // Step 1: POST /api/schema/create с mermaid source.
    const createRes = await postCreate(app, {
      label: "Auth flow",
      raw: "graph LR\n  api[API] --> db[(Database)]",
    });

    // Step 2: Assert response status 200, frameId returned.
    expect(createRes.status).toBe(200);
    const createBody = (await createRes.json()) as {
      ok: boolean;
      frameId: string;
      nodeIds: string[];
      version: number;
    };
    expect(createBody.ok).toBe(true);
    expect(typeof createBody.frameId).toBe("string");
    expect(createBody.frameId).toMatch(/^shape:/);
    expect(createBody.nodeIds.length).toBe(2);

    // Step 3: Reload room state (in-memory) — assert frame + 2 children persisted.
    const room = await rooms.get("storage-only-room");
    const frameRecord = room.store.store[createBody.frameId];
    expect(frameRecord).toBeDefined();
    expect((frameRecord?.meta as { didrawSchemaFrame?: boolean })?.didrawSchemaFrame).toBe(true);
    expect((frameRecord?.meta as { mermaidSource?: string })?.mermaidSource).toContain("API");

    // Children exist in store: 2 geo nodes + 1 arrow for the edge.
    const children = Object.values(room.store.store).filter(
      (r) => r?.typeName === "shape" && r.parentId === createBody.frameId,
    );
    expect(children.length).toBe(3);

    // Step 4: GET /api/canvas/view returns the frame.
    const viewRes = await getCanvasView(app);
    expect(viewRes.status).toBe(200);
    const view = (await viewRes.json()) as {
      schemaVersion: string;
      frames: Array<{ id: string; raw: string }>;
    };
    expect(view.schemaVersion).toBe("v2");
    const frame = view.frames.find((f) => f.id === createBody.frameId);
    expect(frame).toBeDefined();
    expect(frame!.raw).toContain("API");
  });

  test("AC-11: room upgraded to v2 автоматически без WS subscriber", async () => {
    const { app, rooms } = makeApp({ inMemory: true });

    // Room начинается как v1 (нет didrawProtocol).
    const roomBefore = await rooms.get("storage-only-room");
    expect((roomBefore.meta as { didrawProtocol?: string })?.didrawProtocol).toBeUndefined();

    await postCreate(app, {
      label: "Schema",
      raw: "graph LR\n  a[A]",
    });

    // После create — room помечена как v2.
    const roomAfter = await rooms.get("storage-only-room");
    expect((roomAfter.meta as { didrawProtocol?: string })?.didrawProtocol).toBe("v2");
  });
});

// ---- Scenario 2 — Headless pipeline без браузера ----

describe("Headless scenario: create → patch → overlay → duplicate → delete", () => {
  test("полный pipeline без единого WS subscriber", async () => {
    const { app, rooms } = makeApp({ inMemory: true });

    // === Шаг 1: Create ===
    const createRes = await postCreate(app, {
      label: "Service mesh",
      raw: "graph LR\n  gw[Gateway] --> svc[Service] --> db[(DB)]",
    });
    expect(createRes.status).toBe(200);
    const { frameId, nodeIds } = (await createRes.json()) as {
      frameId: string;
      nodeIds: string[];
    };
    expect(nodeIds.length).toBe(3);

    // View shows frame after create.
    let view = (await (await getCanvasView(app)).json()) as {
      schemaVersion: string;
      frames: Array<{ id: string; raw: string; children: unknown[] }>;
    };
    expect(view.frames).toHaveLength(1);
    expect(view.frames[0]!.id).toBe(frameId);

    // === Шаг 2: Patch — добавляем Cache node ===
    const patchRes = await postPatch(app, frameId, {
      actions: [{ kind: "schema-define", role: "service", label: "Cache" }],
    });
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as {
      ok: boolean;
      addedNodeIds: string[];
    };
    expect(patchBody.ok).toBe(true);
    expect(patchBody.addedNodeIds.length).toBe(1);

    // RAW содержит Cache.
    const roomAfterPatch = await rooms.get("storage-only-room");
    const frameAfterPatch = roomAfterPatch.store.store[frameId];
    expect((frameAfterPatch?.meta as { mermaidSource?: string })?.mermaidSource).toContain("Cache");

    // === Шаг 3: Overlay — ставим позицию для Gateway ===
    const gatewayNodeId = nodeIds[0]!;
    const overlayRes = await postOverlay(app, frameId, {
      nodeId: gatewayNodeId,
      overlay: { position: { x: 200, y: 100 } },
    });
    expect(overlayRes.status).toBe(200);
    const overlayBody = (await overlayRes.json()) as { ok: boolean };
    expect(overlayBody.ok).toBe(true);

    // Overlay persisted in frame.meta.didrawOverlays.
    const roomAfterOverlay = await rooms.get("storage-only-room");
    const frameWithOverlay = roomAfterOverlay.store.store[frameId];
    const overlays = (frameWithOverlay?.meta as { didrawOverlays?: Record<string, unknown> })?.didrawOverlays ?? {};
    expect(overlays[gatewayNodeId]).toBeDefined();

    // === Шаг 4: View показывает overlays после patch + overlay ===
    view = (await (await getCanvasView(app)).json()) as {
      schemaVersion: string;
      frames: Array<{ id: string; raw: string; children: unknown[]; overlays: Record<string, unknown> }>;
    };
    const viewFrame = view.frames.find((f) => f.id === frameId);
    expect(viewFrame).toBeDefined();
    // overlays поле в frame view — проверяем что ключ присутствует.
    const viewOverlays = viewFrame!.overlays as Record<string, unknown>;
    expect(viewOverlays[gatewayNodeId]).toBeDefined();

    // === Шаг 5: Duplicate — дублируем frame ===
    const dupRes = await postDuplicate(app, frameId, { newLabel: "Service mesh v2" });
    expect(dupRes.status).toBe(200);
    const dupBody = (await dupRes.json()) as {
      ok: boolean;
      newFrameId: string;
      nodeIdMap: Record<string, string>;
    };
    expect(dupBody.ok).toBe(true);
    expect(dupBody.newFrameId).not.toBe(frameId);

    // Оба frame'а теперь в view.
    const viewAfterDup = (await (await getCanvasView(app)).json()) as {
      frames: Array<{ id: string; label: string }>;
    };
    expect(viewAfterDup.frames).toHaveLength(2);

    // === Шаг 6: Delete — удаляем оригинальный frame ===
    const delRes = await deleteFrame(app, frameId);
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as { ok: boolean };
    expect(delBody.ok).toBe(true);

    // View: только копия осталась.
    const viewAfterDel = (await (await getCanvasView(app)).json()) as {
      frames: Array<{ id: string; label: string }>;
    };
    expect(viewAfterDel.frames).toHaveLength(1);
    expect(viewAfterDel.frames[0]!.id).toBe(dupBody.newFrameId);

    // Оригинальный frame отсутствует в store.
    const roomFinal = await rooms.get("storage-only-room");
    expect(roomFinal.store.store[frameId]).toBeUndefined();
  });

  test("orphan overlay preserved при schema-delete-node (AC-6 + storage-only)", async () => {
    const { app } = makeApp({ inMemory: true });

    const createRes = await postCreate(app, {
      label: "Overlay test",
      raw: "graph LR\n  target[Target]",
    });
    const { frameId, nodeIds } = (await createRes.json()) as {
      frameId: string;
      nodeIds: string[];
    };
    const targetNodeId = nodeIds[0]!;

    // Ставим overlay.
    await postOverlay(app, frameId, {
      nodeId: targetNodeId,
      overlay: { position: { x: 50, y: 50 }, styleOwnedBy: "user" },
    });

    // Удаляем ноду через patch.
    const patchRes = await postPatch(app, frameId, {
      actions: [{ kind: "schema-delete-node", nodeId: targetNodeId }],
    });
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as {
      ok: boolean;
      orphanedOverlays: number;
    };
    expect(patchBody.ok).toBe(true);
    // orphanedOverlays === 1 — overlay для удалённой ноды сохраняется.
    expect(patchBody.orphanedOverlays).toBe(1);
  });

  test("identity remap в duplicate корректен (nodeIdMap ключи = оригинальные IDs)", async () => {
    const { app } = makeApp({ inMemory: true });

    const createRes = await postCreate(app, {
      label: "Remap test",
      raw: "graph LR\n  a[Alpha] --> b[Beta]",
    });
    const { frameId, nodeIds } = (await createRes.json()) as {
      frameId: string;
      nodeIds: string[];
    };
    expect(nodeIds.length).toBe(2);

    const dupRes = await postDuplicate(app, frameId, { newLabel: "Copy" });
    expect(dupRes.status).toBe(200);
    const { nodeIdMap } = (await dupRes.json()) as {
      newFrameId: string;
      nodeIdMap: Record<string, string>;
    };

    // nodeIdMap содержит маппинг для каждого оригинального nodeId.
    for (const origId of nodeIds) {
      expect(nodeIdMap[origId]).toBeDefined();
      // Новый ID — отличается от оригинального.
      expect(nodeIdMap[origId]).not.toBe(origId);
    }

    // Все новые IDs уникальны.
    const newIds = Object.values(nodeIdMap);
    expect(new Set(newIds).size).toBe(newIds.length);
  });
});

// ---- Scenario 3 — WS reconnect surfaces persisted state ----

describe("WS reconnect: storage-only writes surface persisted state to late subscriber", () => {
  test("после storage-only writes симулированный WS subscriber получает актуальное состояние", async () => {
    const { app, rooms, bus, legacyBundle } = makeApp({ inMemory: true });
    const roomId = "reconnect-room";

    // === Этап 1: storage-only writes (нет WS subscriber) ===
    expect(bus.subscriberCount(legacyBundle.space.id, roomId)).toBe(0);

    const createRes = await postCreate(app, {
      label: "Reconnect test",
      raw: "graph LR\n  frontend[Frontend] --> backend[Backend]",
    }, roomId);
    expect(createRes.status).toBe(200);
    const { frameId, nodeIds } = (await createRes.json()) as {
      frameId: string;
      nodeIds: string[];
    };

    await postPatch(app, frameId, {
      actions: [
        { kind: "schema-define", role: "datastore", label: "Storage" },
      ],
    }, roomId);

    // === Этап 2: WS subscriber присоединяется (симуляция reconnect) ===
    const received: string[] = [];
    const mockSock: Sock = {
      readyState: 1, // OPEN
      send: (data: string) => { received.push(data); },
    };
    bus.attach(legacyBundle.space.id, roomId, mockSock);

    // subscriber видим.
    expect(bus.subscriberCount(legacyBundle.space.id, roomId)).toBe(1);

    // === Этап 3: Новый storage-only write после reconnect — subscriber получает сообщение ===
    await postPatch(app, frameId, {
      actions: [
        { kind: "schema-define", role: "service", label: "Cache" },
      ],
    }, roomId);

    // Subscriber получил broadcast.
    expect(received.length).toBeGreaterThan(0);
    const lastMsg = JSON.parse(received[received.length - 1]!) as {
      kind: string;
      changes: unknown;
      version: number;
    };
    expect(lastMsg.kind).toBe("store-change");
    expect(typeof lastMsg.version).toBe("number");

    // === Этап 4: room state в памяти содержит все 3 nodes (включая добавленные до reconnect) ===
    const room = await rooms.get(roomId);
    const frameMeta = room.store.store[frameId]?.meta as { mermaidSource?: string };
    const raw = frameMeta?.mermaidSource ?? "";
    // Все nodes присутствуют в RAW.
    expect(raw).toContain("Frontend");
    expect(raw).toContain("Backend");
    expect(raw).toContain("Storage");
    expect(raw).toContain("Cache");

    // nodeIds из create — 2 ноды.
    expect(nodeIds.length).toBe(2);

    // Отключаем subscriber.
    bus.detach(legacyBundle.space.id, roomId, mockSock);
    expect(bus.subscriberCount(legacyBundle.space.id, roomId)).toBe(0);
  });

  test("GET /api/canvas/view всегда отражает актуальное состояние store (без WS)", async () => {
    const { app } = makeApp({ inMemory: true });
    const roomId = "view-consistency-room";

    // Create frame.
    const createRes = await postCreate(app, {
      label: "Consistency check",
      raw: "graph LR\n  svc[Service]",
    }, roomId);
    const { frameId } = (await createRes.json()) as { frameId: string };

    // Три последовательных patch.
    await postPatch(app, frameId, {
      actions: [{ kind: "schema-define", role: "queue", label: "Queue1" }],
    }, roomId);
    await postPatch(app, frameId, {
      actions: [{ kind: "schema-define", role: "queue", label: "Queue2" }],
    }, roomId);
    await postPatch(app, frameId, {
      actions: [{ kind: "schema-define", role: "queue", label: "Queue3" }],
    }, roomId);

    // canvas/view показывает все изменения.
    const viewRes = await getCanvasView(app, roomId);
    expect(viewRes.status).toBe(200);
    const view = (await viewRes.json()) as {
      schemaVersion: string;
      frames: Array<{ id: string; raw: string }>;
    };

    expect(view.schemaVersion).toBe("v2");
    expect(view.frames).toHaveLength(1);
    const raw = view.frames[0]!.raw;
    expect(raw).toContain("Service");
    expect(raw).toContain("Queue1");
    expect(raw).toContain("Queue2");
    expect(raw).toContain("Queue3");
  });
});
