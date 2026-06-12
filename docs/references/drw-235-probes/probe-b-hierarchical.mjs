// Probe варианта (b) для DRW-235: один иерархический прогон ELK
// (INCLUDE_CHILDREN) на эталонной топологии комнаты drw-218-stability.
// Вопросы: 1) выпрямляется ли сквозная цепочка A1→B1→D1→E1;
//          2) согласован ли порядок строк в контейнерах с внешними рёбрами;
//          3) стабилен ли повторный прогон (semiInteractive + elk.position).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ELK = require(
  "/Users/tretyakov_dv/Projects/sandbox/di.draw/node_modules/.bun/elkjs@0.11.1/node_modules/elkjs/lib/main.js",
);
const elk = new ELK({
  workerUrl:
    "/Users/tretyakov_dv/Projects/sandbox/di.draw/node_modules/.bun/elkjs@0.11.1/node_modules/elkjs/lib/elk-worker.min.js",
});

// Размеры из комнаты drw-218-stability (фактические w/h фигур).
const NODE = {
  A1: [60, 62], A2: [64, 62], A3: [64, 62],
  B1: [61, 62], B2: [60, 62],
  D1: [60, 62], D2: [62, 62], D3: [62, 62],
  E1: [60, 62], E2: [62, 62],
  X1: [60, 62], X2: [62, 62], X3: [62, 62], X4: [62, 62], X5: [60, 62],
};
const CONTAINERS = {
  C1: ["A1", "A2", "A3"],
  C2: ["B1", "B2"],
  C3: ["D1", "D2", "D3"],
  C4: ["E1", "E2"],
};
const EDGES = [
  ["A1", "B1"], ["A2", "B2"], ["B1", "D1"], ["B2", "D2"],
  ["D1", "E1"], ["A3", "E2"],
  ["A1", "A2"], ["D2", "D3"],
  ["X1", "X2"], ["X2", "X3"], ["X3", "X4"], ["X4", "X5"],
];

const SP = { nodeNode: 92, between: 200, edgeNode: 38, edgeEdge: 26 }; // normal
const CF = 0.5; // контейнерная доля spacing (как в layoutContainerInternal)

function mkNode(id) {
  const [w, h] = NODE[id];
  return { id, width: w, height: h };
}

function buildGraph({ positions, semiInteractive } = {}) {
  const containerNodes = Object.entries(CONTAINERS).map(([cid, kids]) => ({
    id: cid,
    layoutOptions: {
      "elk.padding": "[top=44,left=16,bottom=16,right=16]",
      "elk.spacing.nodeNode": String(Math.round(SP.nodeNode * CF)),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(
        Math.round(SP.between * CF),
      ),
    },
    children: kids.map((k) => {
      const n = mkNode(k);
      if (positions?.[k]) {
        n.layoutOptions = {
          "elk.position": `(${positions[k][0]},${positions[k][1]})`,
        };
      }
      return n;
    }),
  }));
  const flat = ["X1", "X2", "X3", "X4", "X5"].map((k) => {
    const n = mkNode(k);
    if (positions?.[k]) {
      n.layoutOptions = {
        "elk.position": `(${positions[k][0]},${positions[k][1]})`,
      };
    }
    return n;
  });
  const rootOpts = {
    "elk.algorithm": "layered",
    "elk.direction": "RIGHT",
    "elk.hierarchyHandling": "INCLUDE_CHILDREN",
    "elk.edgeRouting": "ORTHOGONAL",
    "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
    "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
    "elk.layered.thoroughness": "12",
    "elk.separateConnectedComponents": "false",
    "elk.spacing.nodeNode": String(SP.nodeNode),
    "elk.spacing.edgeNode": String(SP.edgeNode),
    "elk.spacing.edgeEdge": String(SP.edgeEdge),
    "elk.layered.spacing.nodeNodeBetweenLayers": String(SP.between),
    "elk.layered.spacing.edgeNodeBetweenLayers": String(SP.edgeNode),
  };
  if (semiInteractive) {
    rootOpts["elk.layered.crossingMinimization.semiInteractive"] = "true";
  }
  return {
    id: "root",
    layoutOptions: rootOpts,
    children: [...containerNodes, ...flat],
    edges: EDGES.map(([s, t]) => ({ id: `${s}>${t}`, sources: [s], targets: [t] })),
  };
}

function collectAbs(graph) {
  // абсолютные координаты всех узлов (контейнеры + дети + flat)
  const abs = {};
  for (const top of graph.children) {
    abs[top.id] = {
      x: top.x, y: top.y, w: top.width, h: top.height,
      cy: top.y + top.height / 2,
    };
    for (const kid of top.children ?? []) {
      abs[kid.id] = {
        x: top.x + kid.x, y: top.y + kid.y, w: kid.width, h: kid.height,
        cy: top.y + kid.y + kid.height / 2,
        parent: top.id,
      };
    }
  }
  return abs;
}

function report(label, abs) {
  console.log(`\n===== ${label} =====`);
  console.log("-- контейнеры --");
  for (const cid of Object.keys(CONTAINERS)) {
    const c = abs[cid];
    console.log(
      `${cid}: x=${c.x.toFixed(0)} y=${c.y.toFixed(0)} w=${c.w.toFixed(0)} h=${c.h.toFixed(0)}`,
    );
  }
  console.log("-- узлы (abs) --");
  for (const [id, n] of Object.entries(abs)) {
    if (CONTAINERS[id]) continue;
    console.log(
      `${id}: x=${n.x.toFixed(0)} y=${n.y.toFixed(0)} cy=${n.cy.toFixed(0)}${n.parent ? ` [${n.parent}]` : ""}`,
    );
  }
  // метрика 1: коллинеарность сквозной цепочки
  const chain = ["A1", "B1", "D1", "E1"];
  const cys = chain.map((id) => abs[id].cy);
  const dev = Math.max(...cys) - Math.min(...cys);
  console.log(
    `\nЦепочка A1→B1→D1→E1: cy = [${cys.map((v) => v.toFixed(0)).join(", ")}], разброс = ${dev.toFixed(0)}px ${dev <= 10 ? "✅ ЛИНИЯ" : dev <= 80 ? "≈ почти" : "❌ зигзаг"}`,
  );
  // метрика 2: порядок строк внутри контейнеров (по y)
  for (const [cid, kids] of Object.entries(CONTAINERS)) {
    const order = [...kids].sort((a, b) => abs[a].y - abs[b].y);
    console.log(`порядок в ${cid} (сверху вниз): ${order.join(", ")}`);
  }
  // метрика 3: пара A3/E2 (диагональ должна стать горизонталью)
  const d2 = Math.abs(abs.A3.cy - abs.E2.cy);
  console.log(`A3 vs E2: |Δcy| = ${d2.toFixed(0)}px ${d2 <= 10 ? "✅" : "❌"}`);
  return abs;
}

const run1 = await elk.layout(buildGraph());
const abs1 = report("RUN 1: холодный иерархический прогон", collectAbs(run1));

// RUN 2: стабильность — подаём координаты run1 как elk.position + semiInteractive
const positions = Object.fromEntries(
  Object.entries(abs1)
    .filter(([id]) => !CONTAINERS[id] || true)
    .map(([id, n]) => [id, [n.x, n.y]]),
);
// детям позиции нужны в координатах родителя — пересчёт
const relPositions = {};
for (const [cid, kids] of Object.entries(CONTAINERS)) {
  for (const k of kids) {
    relPositions[k] = [abs1[k].x - abs1[cid].x, abs1[k].y - abs1[cid].y];
  }
}
for (const k of ["X1", "X2", "X3", "X4", "X5"]) relPositions[k] = [abs1[k].x, abs1[k].y];

const run2 = await elk.layout(buildGraph({ positions: relPositions, semiInteractive: true }));
const abs2 = report("RUN 2: повтор с elk.position + semiInteractive", collectAbs(run2));

let maxDrift = 0;
for (const id of Object.keys(abs1)) {
  const d = Math.hypot(abs1[id].x - abs2[id].x, abs1[id].y - abs2[id].y);
  if (d > maxDrift) maxDrift = d;
}
console.log(`\nДрейф run1→run2 (max |Δ|): ${maxDrift.toFixed(1)}px ${maxDrift < 1 ? "✅ стабильно" : "⚠️"}`);

// RUN 3: тот же холодный прогон с ОБРАТНЫМ порядком детей во входе —
// проверка чувствительности к порядку входа (детерминизм DRW-218).
const g3 = buildGraph();
g3.children.reverse();
for (const c of g3.children) c.children?.reverse();
g3.edges.reverse();
const run3 = await elk.layout(g3);
const abs3 = collectAbs(run3);
let maxPerm = 0;
for (const id of Object.keys(abs1)) {
  const d = Math.hypot(abs1[id].x - abs3[id].x, abs1[id].y - abs3[id].y);
  if (d > maxPerm) maxPerm = d;
}
console.log(`Чувствительность к порядку входа run1→run3 (max |Δ|): ${maxPerm.toFixed(1)}px ${maxPerm < 1 ? "✅ инвариантно" : "⚠️ зависит от порядка входа"}`);
