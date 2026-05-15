import type { Edge, Node } from "./types";

// Import elk-worker as an embedded asset — works in both dev mode (file path)
// and bun build --compile mode ($bunfs/... internal path).
import elkWorkerPath from "../node_modules/elkjs/lib/elk-worker.min.js" with {
  type: "file",
};

// Use require() so bun statically bundles elkjs into the compiled binary.
// createRequire(import.meta.url) is NOT used because import.meta.url resolves
// to /$bunfs/root/... inside a compiled executable, breaking module lookup.
// biome-ignore lint/suspicious/noExplicitAny: third-party CJS module
const ELK = require("elkjs/lib/main.js") as any;

// Singleton ELK instance — worker path comes from embedded asset
// biome-ignore lint/suspicious/noExplicitAny: third-party CJS module instance
const elk = new ELK({ workerUrl: elkWorkerPath }) as any;

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
