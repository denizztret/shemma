import { createRequire } from "node:module";
import type { Edge, Node } from "./types";

const cjsRequire = createRequire(import.meta.url);

// elkjs requires CJS-style require and a workerUrl for Bun/Node compatibility.
// web-worker package handles the actual worker thread creation.
// biome-ignore lint/suspicious/noExplicitAny: third-party CJS module
const ELK = cjsRequire("elkjs/lib/main.js") as any;

// Path to the elkjs GWT worker bundle.
// import.meta.url is apps/backend/src/layout-engine.ts → ../node_modules is apps/backend/node_modules
const ELK_WORKER_URL = new URL(
  "../node_modules/elkjs/lib/elk-worker.min.js",
  import.meta.url,
).pathname;

// Singleton ELK instance — worker thread is reused across calls
// biome-ignore lint/suspicious/noExplicitAny: third-party CJS module instance
const elk = new ELK({ workerUrl: ELK_WORKER_URL }) as any;

type NodeEndpoint = { kind: "node"; id: string };

export async function layoutNodes(
  nodes: Pick<Node, "id" | "w" | "h">[],
  edges: Pick<Edge, "id" | "from" | "to">[],
  algorithm: "elk-layered" | "dagre" = "elk-layered",
): Promise<Record<string, { x: number; y: number }>> {
  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": algorithm === "elk-layered" ? "layered" : "force",
    },
    children: nodes.map((n) => ({
      id: n.id,
      width: n.w ?? 120,
      height: n.h ?? 60,
    })),
    edges: edges
      .filter((e) => e.from.kind === "node" && e.to.kind === "node")
      .map((e) => ({
        id: e.id,
        sources: [(e.from as NodeEndpoint).id],
        targets: [(e.to as NodeEndpoint).id],
      })),
  };
  // biome-ignore lint/suspicious/noExplicitAny: elkjs types don't match plain object
  const res = await elk.layout(graph as any);
  const out: Record<string, { x: number; y: number }> = {};
  for (const c of res.children ?? []) {
    if (c.id != null) out[c.id] = { x: c.x ?? 0, y: c.y ?? 0 };
  }
  return out;
}
