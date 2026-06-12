// Probe варианта (a) для DRW-235: текущая 2-уровневая схема
// (контейнеры = чёрные ящики в root-прогоне, внутренности — отдельно)
// + barycenter-постпасс: порядок строк внутри контейнера по средней
// позиции внешних соседей, итеративные свипы до неподвижной точки.
// Сравниваем те же метрики, что в probe-b: коллинеарность цепочки,
// порядок строк, пара A3/E2.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ELK = require(
  "/Users/tretyakov_dv/Projects/sandbox/di.draw/node_modules/.bun/elkjs@0.11.1/node_modules/elkjs/lib/main.js",
);
const elk = new ELK({
  workerUrl:
    "/Users/tretyakov_dv/Projects/sandbox/di.draw/node_modules/.bun/elkjs@0.11.1/node_modules/elkjs/lib/elk-worker.min.js",
});

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
const NODE_EDGES = [
  ["A1", "B1"], ["A2", "B2"], ["B1", "D1"], ["B2", "D2"],
  ["D1", "E1"], ["A3", "E2"],
  ["A1", "A2"], ["D2", "D3"],
  ["X1", "X2"], ["X2", "X3"], ["X3", "X4"], ["X4", "X5"],
];

const SP = { nodeNode: 92, between: 200, edgeNode: 38, edgeEdge: 26 };
const CF = 0.5;
const PAD_TOP = 44, PAD = 16;
const ROW_GAP = Math.round(SP.nodeNode * CF); // вертикальный зазор строк в контейнере

const parentOf = {};
for (const [cid, kids] of Object.entries(CONTAINERS))
  for (const k of kids) parentOf[k] = cid;

// Внутренняя раскладка контейнера: вертикальный столбец (как в идеале юзера,
// контейнеры — узкие колонки) в заданном порядке строк.
function stackColumn(kids) {
  let y = PAD_TOP;
  const pos = {};
  let maxW = 0;
  for (const k of kids) {
    const [w, h] = NODE[k];
    pos[k] = { x: PAD, y };
    y += h + ROW_GAP;
    maxW = Math.max(maxW, w);
  }
  return { pos, w: maxW + 2 * PAD, h: y - ROW_GAP + PAD };
}

// Root-прогон: контейнеры как boxes + X-узлы; рёбра схлопнуты на пары.
async function rootPass(boxes) {
  const collapsed = new Map();
  for (const [s, t] of NODE_EDGES) {
    const cs = parentOf[s] ?? s;
    const ct = parentOf[t] ?? t;
    if (cs === ct) continue;
    collapsed.set(`${cs}>${ct}`, [cs, ct]);
  }
  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
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
    },
    children: Object.entries(boxes).map(([id, b]) => ({
      id, width: b.w, height: b.h,
    })),
    edges: [...collapsed.entries()].map(([id, [s, t]]) => ({
      id, sources: [s], targets: [t],
    })),
  };
  const out = await elk.layout(graph);
  const pos = {};
  for (const c of out.children) pos[c.id] = { x: c.x, y: c.y };
  return pos;
}

// Barycenter-свипы: порядок строк по средней АБСОЛЮТНОЙ cy внешних соседей.
function sweepOrders(rootPos, orders, absCy) {
  const next = {};
  for (const [cid, kids] of Object.entries(CONTAINERS)) {
    const scored = kids.map((k) => {
      const nbrs = [];
      for (const [s, t] of NODE_EDGES) {
        if (s === k && parentOf[t] && parentOf[t] !== cid) nbrs.push(t);
        if (t === k && parentOf[s] && parentOf[s] !== cid) nbrs.push(s);
      }
      const score = nbrs.length
        ? nbrs.reduce((a, n) => a + absCy[n], 0) / nbrs.length
        : absCy[k]; // без внешних связей — остаёмся где были
      return { k, score };
    });
    scored.sort((a, b) => a.score - b.score || a.k.localeCompare(b.k));
    next[cid] = scored.map((s) => s.k);
  }
  return next;
}

function computeAbs(rootPos, orders) {
  const absCy = {}, absY = {};
  for (const [cid, kids] of Object.entries(CONTAINERS)) {
    const { pos } = stackColumn(orders[cid]);
    for (const k of kids) {
      absY[k] = rootPos[cid].y + pos[k].y;
      absCy[k] = absY[k] + NODE[k][1] / 2;
    }
  }
  for (const k of ["X1", "X2", "X3", "X4", "X5"]) {
    absY[k] = rootPos[k].y;
    absCy[k] = rootPos[k].y + NODE[k][1] / 2;
  }
  return { absCy, absY };
}

// Итерация: стартовый порядок = как в CONTAINERS (текущее поведение),
// boxes по нему → root pass → свипы barycenter до неподвижной точки.
let orders = Object.fromEntries(
  Object.entries(CONTAINERS).map(([cid, kids]) => [cid, [...kids]]),
);
let boxes = {};
for (const [cid] of Object.entries(CONTAINERS)) {
  const { w, h } = stackColumn(orders[cid]);
  boxes[cid] = { w, h };
}
for (const k of ["X1", "X2", "X3", "X4", "X5"])
  boxes[k] = { w: NODE[k][0], h: NODE[k][1] };

const rootPos = await rootPass(boxes);
let { absCy } = computeAbs(rootPos, orders);

for (let i = 0; i < 6; i++) {
  const next = sweepOrders(rootPos, orders, absCy);
  const same = JSON.stringify(next) === JSON.stringify(orders);
  orders = next;
  ({ absCy } = computeAbs(rootPos, orders));
  if (same) {
    console.log(`barycenter сошёлся за ${i + 1} свип(ов)`);
    break;
  }
}

console.log("\n===== ВАРИАНТ (a): 2-уровневая схема + barycenter =====");
console.log("-- контейнеры (root pass) --");
for (const cid of Object.keys(CONTAINERS)) {
  console.log(
    `${cid}: x=${rootPos[cid].x.toFixed(0)} y=${rootPos[cid].y.toFixed(0)} h=${boxes[cid].h}`,
  );
}
console.log("-- порядок строк --");
for (const [cid, kids] of Object.entries(orders)) {
  console.log(`порядок в ${cid} (сверху вниз): ${kids.join(", ")}`);
}
console.log("-- узлы (abs cy) --");
for (const [k, cy] of Object.entries(absCy)) {
  console.log(`${k}: cy=${cy.toFixed(0)}`);
}
const chain = ["A1", "B1", "D1", "E1"];
const cys = chain.map((id) => absCy[id]);
const dev = Math.max(...cys) - Math.min(...cys);
console.log(
  `\nЦепочка A1→B1→D1→E1: cy = [${cys.map((v) => v.toFixed(0)).join(", ")}], разброс = ${dev.toFixed(0)}px ${dev <= 10 ? "✅ ЛИНИЯ" : dev <= 80 ? "≈ почти" : "❌ зигзаг"}`,
);
const d2 = Math.abs(absCy.A3 - absCy.E2);
console.log(`A3 vs E2: |Δcy| = ${d2.toFixed(0)}px ${d2 <= 10 ? "✅" : "❌"}`);
