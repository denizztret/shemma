import { Hono } from "hono";
import type { Rooms } from "../rooms";
import type { CanvasState, Edge, Node } from "../types";

export function stateRoutes(rooms: Rooms) {
  return new Hono().get("/api/state", async (c) => {
    const id = c.req.query("room") ?? "default";
    const sinceRaw = c.req.query("since");
    const fmt = c.req.query("fmt") ?? "full";
    const r = await rooms.get(id);
    rooms.touch(id);

    if (sinceRaw !== undefined && !Number.isNaN(Number(sinceRaw))) {
      const since = Number(sinceRaw);
      return c.json({
        since,
        version: r.version,
        diff: r.opLog.filter((e) => e.version > since),
      });
    }
    const canvas = fmt === "compact" ? compact(r.canvas) : r.canvas;
    return c.json({ version: r.version, canvas, prompts: r.prompts });
  });
}

function compact(s: CanvasState): CanvasState {
  return {
    version: s.version,
    nodes: s.nodes.map(compactNode),
    edges: s.edges.map(compactEdge),
    groups: s.groups,
  };
}

function compactNode(n: Node): Node {
  const o: Node = { id: n.id, kind: n.kind, x: round(n.x), y: round(n.y) };
  if (n.label) o.label = n.label;
  if (n.w !== undefined) o.w = round(n.w);
  if (n.h !== undefined) o.h = round(n.h);
  if (n.style && Object.keys(n.style).length) o.style = n.style;
  if (n.meta && Object.keys(n.meta).length) o.meta = n.meta;
  return o;
}

function compactEdge(e: Edge): Edge {
  const o: Edge = { id: e.id, from: e.from, to: e.to };
  if (e.label) o.label = e.label;
  if (e.style && Object.keys(e.style).length) o.style = e.style;
  if (e.meta && Object.keys(e.meta).length) o.meta = e.meta;
  return o;
}

function round(n: number) {
  return Math.round(n * 10) / 10;
}
