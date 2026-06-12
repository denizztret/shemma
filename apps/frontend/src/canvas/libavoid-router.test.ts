import { describe, expect, test } from "bun:test";
import type { RouteBox, RouteEdge } from "./edge-routing-core";
import {
  buildBoxIndex,
  classifyEdges,
  foreignCrossings,
  sideOfExit,
} from "./edge-routing-core";
import { loadAvoid, routeClasses } from "./libavoid-router";

describe("libavoid-router (WASM smoke)", () => {
  test("грузится в bun и обходит препятствие", async () => {
    const Avoid = await loadAvoid();
    expect(Avoid).not.toBeNull();
    const boxes: RouteBox[] = [
      { id: "a", kind: "leaf", parent: null, x: 0, y: 340, w: 60, h: 60 },
      { id: "wall", kind: "leaf", parent: null, x: 580, y: 0, w: 90, h: 480 },
      { id: "b", kind: "leaf", parent: null, x: 900, y: 340, w: 60, h: 60 },
    ];
    const edges: RouteEdge[] = [{ id: "e", from: "a", to: "b" }];
    const { classes } = classifyEdges(boxes, edges);
    const routes = routeClasses(Avoid, boxes, classes, {
      bufferDistance: 12,
      nudgeDistance: 16,
      pinsPerSide: 2,
    });
    const route = routes.get("e");
    expect(route).toBeDefined();
    expect(
      foreignCrossings(route ?? [], edges[0], boxes, buildBoxIndex(boxes)),
    ).toEqual([]);
  });

  test("детерминизм: два прогона — идентичные полилинии", async () => {
    const Avoid = await loadAvoid();
    const boxes: RouteBox[] = [
      { id: "a", kind: "leaf", parent: null, x: 0, y: 0, w: 60, h: 60 },
      { id: "w", kind: "leaf", parent: null, x: 200, y: -40, w: 80, h: 140 },
      { id: "b", kind: "leaf", parent: null, x: 500, y: 0, w: 60, h: 60 },
    ];
    const edges: RouteEdge[] = [{ id: "e", from: "a", to: "b" }];
    const { classes } = classifyEdges(boxes, edges);
    const opts = { bufferDistance: 12, nudgeDistance: 16, pinsPerSide: 2 };
    const r1 = routeClasses(Avoid, boxes, classes, opts).get("e");
    const r2 = routeClasses(Avoid, boxes, classes, opts).get("e");
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});

describe("libavoid-router flow-aware", () => {
  test("flow-aware: TB-поток, src над dst → вход через TOP (регрессия dl-test)", async () => {
    const Avoid = await loadAvoid();
    expect(Avoid).not.toBeNull();
    const boxes: RouteBox[] = [
      {
        id: "src",
        kind: "leaf",
        parent: null,
        x: 200,
        y: 0,
        w: 60,
        h: 60,
        flowAxis: "v" as const,
      },
      {
        id: "dst",
        kind: "leaf",
        parent: null,
        x: 180,
        y: 200,
        w: 60,
        h: 60,
        flowAxis: "v" as const,
      },
    ];
    const edges: RouteEdge[] = [{ id: "e", from: "src", to: "dst" }];
    const { classes } = classifyEdges(boxes, edges);
    const routes = routeClasses(Avoid, boxes, classes, {
      bufferDistance: 12,
      nudgeDistance: 16,
      pinsPerSide: 3,
    });
    const route = routes.get("e");
    expect(route).toBeDefined();
    if (route && route.length >= 2) {
      const dstBox = boxes.find((b) => b.id === "dst");
      if (dstBox) {
        const dstSide = sideOfExit(route, dstBox, false);
        expect(dstSide).toBe("T");
      }
    }
  });
});
