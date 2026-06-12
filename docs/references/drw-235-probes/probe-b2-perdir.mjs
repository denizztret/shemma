// Probe: уважает ли INCLUDE_CHILDREN per-node elk.direction?
// C1 получает direction=DOWN при root direction=RIGHT.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ELK = require(
  "/Users/tretyakov_dv/Projects/sandbox/di.draw/node_modules/.bun/elkjs@0.11.1/node_modules/elkjs/lib/main.js",
);
const elk = new ELK({
  workerUrl:
    "/Users/tretyakov_dv/Projects/sandbox/di.draw/node_modules/.bun/elkjs@0.11.1/node_modules/elkjs/lib/elk-worker.min.js",
});
const graph = {
  id: "root",
  layoutOptions: {
    "elk.algorithm": "layered",
    "elk.direction": "RIGHT",
    "elk.hierarchyHandling": "INCLUDE_CHILDREN",
    "elk.edgeRouting": "ORTHOGONAL",
  },
  children: [
    {
      id: "C1",
      layoutOptions: {
        "elk.direction": "DOWN",
        "elk.padding": "[top=44,left=16,bottom=16,right=16]",
      },
      children: [
        { id: "A1", width: 60, height: 62 },
        { id: "A2", width: 64, height: 62 },
        { id: "A3", width: 64, height: 62 },
      ],
    },
    { id: "B1", width: 61, height: 62 },
  ],
  edges: [
    { id: "e1", sources: ["A1"], targets: ["A2"] },
    { id: "e2", sources: ["A1"], targets: ["B1"] },
  ],
};
const out = await elk.layout(graph);
const c1 = out.children.find((c) => c.id === "C1");
for (const k of c1.children) console.log(`${k.id}: x=${k.x} y=${k.y}`);
const a1 = c1.children.find((c) => c.id === "A1");
const a2 = c1.children.find((c) => c.id === "A2");
console.log(
  a2.y > a1.y + 31 && Math.abs(a2.x - a1.x) < 40
    ? "✅ A1→A2 разложено ВНИЗ — per-node direction уважается"
    : "❌ A1→A2 разложено вбок — per-node direction ИГНОРИРУЕТСЯ при INCLUDE_CHILDREN",
);
