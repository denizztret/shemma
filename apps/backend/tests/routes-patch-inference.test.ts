import { describe, expect, test } from "bun:test";
import { makeApp } from "../src/index";

async function postPatch(app: ReturnType<typeof makeApp>["app"], ops: unknown[], source: "ai" | "user") {
  return app.fetch(
    new Request("http://localhost/api/patch?room=test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ops, source }),
    }),
  );
}

describe("POST /api/patch — inference for source:user", () => {
  test("user move sets meta.pinned + meta.position", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const r = await rooms.get("test");
    r.canvas.nodes.push({ id: "shape:e_x", kind: "rect", x: 0, y: 0, label: "x", meta: { name: "x", role: "service" } });

    const res = await postPatch(app, [{ op: "update", target: "node", id: "shape:e_x", set: { x: 200, y: 300 } }], "user");
    expect(res.status).toBe(200);

    const n = (await rooms.get("test")).canvas.nodes.find((x) => x.id === "shape:e_x")!;
    expect(n.meta?.pinned).toBe(true);
    expect(n.meta?.position).toEqual({ x: 200, y: 300 });
  });

  test("ai move does NOT pin", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const r = await rooms.get("test");
    r.canvas.nodes.push({ id: "shape:e_y", kind: "rect", x: 0, y: 0, label: "y" });

    await postPatch(app, [{ op: "update", target: "node", id: "shape:e_y", set: { x: 200, y: 300 } }], "ai");
    const n = (await rooms.get("test")).canvas.nodes.find((x) => x.id === "shape:e_y")!;
    expect(n.meta?.pinned).toBeUndefined();
  });

  test("user style change sets meta.styleOwnedBy=user", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const r = await rooms.get("test");
    r.canvas.nodes.push({ id: "shape:e_z", kind: "rect", x: 0, y: 0, label: "z" });

    await postPatch(app, [{ op: "update", target: "node", id: "shape:e_z", set: { style: { color: "red" } } }], "user");
    const n = (await rooms.get("test")).canvas.nodes.find((x) => x.id === "shape:e_z")!;
    expect(n.meta?.styleOwnedBy).toBe("user");
  });

  test("user position update preserves other existing meta fields", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const r = await rooms.get("test");
    r.canvas.nodes.push({ id: "shape:e_q", kind: "rect", x: 0, y: 0, label: "q", meta: { name: "q", role: "service" } });

    await postPatch(app, [{ op: "update", target: "node", id: "shape:e_q", set: { x: 50, y: 60 } }], "user");
    const n = (await rooms.get("test")).canvas.nodes.find((x) => x.id === "shape:e_q")!;
    expect(n.meta?.name).toBe("q");
    expect(n.meta?.role).toBe("service");
    expect(n.meta?.pinned).toBe(true);
  });

  test("partial move (only y) preserves the unchanged x in meta.position", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const r = await rooms.get("test");
    r.canvas.nodes.push({
      id: "shape:e_p",
      kind: "rect",
      x: 100,
      y: 200,
      label: "p",
      meta: { name: "p", role: "service", pinned: true, position: { x: 100, y: 200 } },
    });

    await postPatch(app, [{ op: "update", target: "node", id: "shape:e_p", set: { y: 350 } }], "user");
    const n = (await rooms.get("test")).canvas.nodes.find((x) => x.id === "shape:e_p")!;
    expect(n.meta?.position).toEqual({ x: 100, y: 350 });
    expect(n.meta?.pinned).toBe(true);
  });
});
