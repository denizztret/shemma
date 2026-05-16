// DRW-003: pin discipline + no-collision at layout pass.
// Coverage:
//  AC1: layout уважает pin только при meta.pinned === true (не при meta.position).
//  AC2: AI-defined nodes без meta.pinned свободно двигаются.
//  AC3: define 3+ nodes + layout → no two nodes share (x,y).

import { describe, expect, test } from "bun:test";
import { makeApp } from "../src/index";

type Canvas = {
  nodes: Array<{ id: string; x: number; y: number; meta?: Record<string, unknown> }>;
};

async function applyDomain(
  app: ReturnType<typeof makeApp>,
  room: string,
  actions: unknown[],
): Promise<{ status: number; body: unknown }> {
  const req = new Request(`http://x/api/domain?room=${room}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actions }),
  });
  const r = await app.fetch(req);
  return { status: r.status, body: await r.json() };
}

async function getCanvas(app: ReturnType<typeof makeApp>, room: string): Promise<Canvas> {
  const r = await app.fetch(new Request(`http://x/api/state?room=${room}&fmt=full`));
  const j = (await r.json()) as { canvas: Canvas };
  return j.canvas;
}

async function applyPatch(
  app: ReturnType<typeof makeApp>,
  room: string,
  ops: unknown[],
  source: "ai" | "user" = "user",
): Promise<{ status: number; body: unknown }> {
  const req = new Request(`http://x/api/patch?room=${room}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ops, source }),
  });
  const r = await app.fetch(req);
  return { status: r.status, body: await r.json() };
}

describe("DRW-005: children coords внутри group bbox (absolute)", () => {
  test("group + 2 children + layout → children лежат внутри group bbox", async () => {
    const { app } = makeApp({ inMemory: true });
    await applyDomain(app, "drw005", [
      { kind: "define", role: "service", name: "a" },
      { kind: "define", role: "service", name: "b" },
      { kind: "group", ids: ["a", "b"], as: "boundary", name: "sys" },
      { kind: "layout", mode: "layered-lr", scope: "all" },
    ]);

    const r = await app.fetch(new Request("http://x/api/state?room=drw005&fmt=full"));
    const j = (await r.json()) as {
      canvas: {
        nodes: Array<{ id: string; x: number; y: number; w?: number; h?: number }>;
        groups: Array<{ id: string; x?: number; y?: number; w?: number; h?: number; children: string[] }>;
      };
    };
    const group = j.canvas.groups[0];
    expect(group).toBeDefined();
    const groupRight = group.x! + group.w!;
    const groupBottom = group.y! + group.h!;

    for (const childId of group.children) {
      const child = j.canvas.nodes.find((n) => n.id === childId);
      expect(child).toBeDefined();
      const cw = child!.w ?? 120;
      const ch = child!.h ?? 60;
      // Absolute coords: child должен помещаться целиком в bbox группы.
      expect(child!.x).toBeGreaterThanOrEqual(group.x!);
      expect(child!.y).toBeGreaterThanOrEqual(group.y!);
      expect(child!.x + cw).toBeLessThanOrEqual(groupRight);
      expect(child!.y + ch).toBeLessThanOrEqual(groupBottom);
    }
  });

  test("group + children + другая независимая node (репро D5)", async () => {
    // Воспроизводит сценарий из D5: group с детьми + узел вне группы.
    // Узлы вне группы не должны быть внутри group bbox (mixed-content artefact).
    const { app } = makeApp({ inMemory: true });
    await applyDomain(app, "drw005b", [
      { kind: "define", role: "service", name: "worker" },
      { kind: "define", role: "queue", name: "queue" },
      { kind: "define", role: "service", name: "api" },
      { kind: "connect", from: "api", to: "queue" },
      { kind: "group", ids: ["worker", "queue"], as: "boundary", name: "async-side" },
      { kind: "layout", mode: "layered-lr", scope: "all" },
    ]);

    const r = await app.fetch(new Request("http://x/api/state?room=drw005b&fmt=full"));
    const j = (await r.json()) as {
      canvas: {
        nodes: Array<{ id: string; x: number; y: number }>;
        groups: Array<{ id: string; x?: number; y?: number; w?: number; h?: number; children: string[] }>;
      };
    };
    const group = j.canvas.groups[0];
    const workerNode = j.canvas.nodes.find((n) => n.id === "shape:e_worker");
    const queueNode = j.canvas.nodes.find((n) => n.id === "shape:e_queue");
    const apiNode = j.canvas.nodes.find((n) => n.id === "shape:e_api");

    // Children группы — внутри bbox.
    for (const child of [workerNode, queueNode]) {
      expect(child!.x).toBeGreaterThanOrEqual(group.x!);
      expect(child!.y).toBeGreaterThanOrEqual(group.y!);
    }
    // api — не в children — координаты вне (или хотя бы не идентичны children).
    const inside =
      apiNode!.x >= group.x! &&
      apiNode!.x < group.x! + group.w! &&
      apiNode!.y >= group.y! &&
      apiNode!.y < group.y! + group.h!;
    expect(inside).toBe(false);
  });
});

describe("DRW-004: group bbox writeback", () => {
  test("group action + layout → group получает w/h из ELK output, не null", async () => {
    const { app } = makeApp({ inMemory: true });
    const res = await applyDomain(app, "drw004", [
      { kind: "define", role: "service", name: "a" },
      { kind: "define", role: "service", name: "b" },
      { kind: "group", ids: ["a", "b"], as: "boundary", name: "sys1" },
      { kind: "layout", mode: "layered-lr", scope: "all" },
    ]);
    expect(res.status).toBe(200);

    const r = await app.fetch(new Request("http://x/api/state?room=drw004&fmt=full"));
    const j = (await r.json()) as { canvas: { groups: Array<{ w?: number; h?: number }> } };
    const group = j.canvas.groups[0];
    expect(group).toBeDefined();
    expect(typeof group.w).toBe("number");
    expect(typeof group.h).toBe("number");
    expect(group.w!).toBeGreaterThan(0);
    expect(group.h!).toBeGreaterThan(0);
  });
});

describe("DRW-003: layout pin discipline + no-collision", () => {
  test("AC3: batch с 3 defines + layout → все 3 узла на разных позициях", async () => {
    const { app } = makeApp({ inMemory: true });
    const res = await applyDomain(app, "ac3-batch", [
      { kind: "define", role: "service", name: "a" },
      { kind: "define", role: "service", name: "b" },
      { kind: "define", role: "service", name: "c" },
      { kind: "layout", mode: "layered-lr", scope: "all" },
    ]);
    expect(res.status).toBe(200);
    const canvas = await getCanvas(app, "ac3-batch");
    expect(canvas.nodes.length).toBe(3);
    const positions = canvas.nodes.map((n) => `${n.x},${n.y}`);
    const unique = new Set(positions);
    expect(unique.size).toBe(3);
  });

  test("AC3: incremental defines (3 batches) + final layout → 3 узла на разных позициях", async () => {
    const { app } = makeApp({ inMemory: true });
    await applyDomain(app, "ac3-inc", [{ kind: "define", role: "service", name: "a" }]);
    await applyDomain(app, "ac3-inc", [{ kind: "define", role: "service", name: "b" }]);
    await applyDomain(app, "ac3-inc", [{ kind: "define", role: "service", name: "c" }]);
    await applyDomain(app, "ac3-inc", [{ kind: "layout", mode: "layered-lr", scope: "all" }]);
    const canvas = await getCanvas(app, "ac3-inc");
    expect(canvas.nodes.length).toBe(3);
    const positions = canvas.nodes.map((n) => `${n.x},${n.y}`);
    const unique = new Set(positions);
    expect(unique.size).toBe(3);
  });

  test("AC3: incremental defines (3 batches) БЕЗ final layout — auto-layout scope=affected не должен overlap", async () => {
    // Этот сценарий — корень bug-репорта: каждый define запускает свой auto-layout
    // с scope=affected=[new]. Existing nodes pinned through scope-rule. Должен не overlap.
    const { app } = makeApp({ inMemory: true });
    await applyDomain(app, "ac3-auto", [{ kind: "define", role: "service", name: "a" }]);
    await applyDomain(app, "ac3-auto", [{ kind: "define", role: "service", name: "b" }]);
    await applyDomain(app, "ac3-auto", [{ kind: "define", role: "service", name: "c" }]);
    const canvas = await getCanvas(app, "ac3-auto");
    expect(canvas.nodes.length).toBe(3);
    const positions = canvas.nodes.map((n) => `${n.x},${n.y}`);
    const unique = new Set(positions);
    expect(unique.size).toBe(3);
  });

  test("AC1: pinned node (meta.pinned=true через user patch) НЕ двигается при layout", async () => {
    const { app } = makeApp({ inMemory: true });
    await applyDomain(app, "ac1", [
      { kind: "define", role: "service", name: "fixed" },
      { kind: "define", role: "service", name: "mobile" },
    ]);
    // Пинит "fixed" в (500, 500) через user patch (inference на /api/patch
    // выставляет meta.pinned=true + meta.position при source="user").
    const fixedShapeId = "shape:e_fixed";
    const pinRes = await applyPatch(
      app,
      "ac1",
      [
        {
          op: "update",
          target: "node",
          id: fixedShapeId,
          set: { x: 500, y: 500 },
        },
      ],
      "user",
    );
    expect(pinRes.status).toBe(200);

    // Forces re-layout. AC1 — pinned должен остаться в (500, 500).
    await applyDomain(app, "ac1", [{ kind: "layout", mode: "layered-lr", scope: "all" }]);
    const canvas = await getCanvas(app, "ac1");
    const fixed = canvas.nodes.find((n) => n.id === fixedShapeId);
    expect(fixed?.x).toBe(500);
    expect(fixed?.y).toBe(500);
    expect(fixed?.meta?.pinned).toBe(true);
  });

  test("AC2: AI-defined node БЕЗ meta.pinned свободно двигается при последующих layouts", async () => {
    const { app } = makeApp({ inMemory: true });
    await applyDomain(app, "ac2", [{ kind: "define", role: "service", name: "free" }]);

    const before = await getCanvas(app, "ac2");
    const beforeNode = before.nodes.find((n) => n.id === "shape:e_free");
    expect(beforeNode?.meta?.pinned).toBeUndefined();

    // Добавляем второй node — auto-layout должен иметь право подвинуть "free".
    await applyDomain(app, "ac2", [
      { kind: "define", role: "service", name: "second" },
      { kind: "connect", from: "free", to: "second" },
      { kind: "layout", mode: "layered-lr", scope: "all" },
    ]);

    const after = await getCanvas(app, "ac2");
    const afterFree = after.nodes.find((n) => n.id === "shape:e_free");
    // Не утверждаем конкретные координаты — только что "free" остался un-pinned.
    expect(afterFree?.meta?.pinned).toBeUndefined();
    // И что в коннект-конфигурации free !== second (sanity).
    const afterSecond = after.nodes.find((n) => n.id === "shape:e_second");
    expect(afterFree?.x !== afterSecond?.x || afterFree?.y !== afterSecond?.y).toBe(true);
  });
});
