// Probe варианта (c)-global-y для DRW-235: x-раскладка от root-прогона
// (контейнеры-колонки), а y — ГЛОБАЛЬНАЯ координация всех узлов сразу:
// минимизация |Δcy| по cross-рёбрам при separation-ограничениях внутри
// контейнера (порядок строк + мин. зазор). Контейнеры обтягивают результат.
// Модель эталона юзера (etalon2-chain-topline): все cross-рёбра горизонтальны,
// контейнеры растягиваются (разрыв A2..A3 в C1).
const NODE_H = 62, ROW_GAP = 46, PAD_TOP = 44, PAD_BOTTOM = 16;

const ORDERS = {
  C1: ["A1", "A2", "A3"],
  C2: ["B1", "B2"],
  C3: ["D1", "D2", "D3"],
  C4: ["E1", "E2"],
};
const CROSS = [
  ["A1", "B1"], ["A2", "B2"], ["B1", "D1"], ["B2", "D2"],
  ["D1", "E1"], ["A3", "E2"],
];
// внутренние рёбра вдоль колонки уже выражены порядком строк (topo)
const parentOf = {};
for (const [cid, kids] of Object.entries(ORDERS))
  for (const k of kids) parentOf[k] = cid;

// y = верх узла; стартовое приближение — равномерный стек
const y = {};
for (const kids of Object.values(ORDERS)) {
  let cur = PAD_TOP;
  for (const k of kids) {
    y[k] = cur;
    cur += NODE_H + ROW_GAP;
  }
}

const nbrs = {};
for (const [s, t] of CROSS) {
  (nbrs[s] ??= []).push(t);
  (nbrs[t] ??= []).push(s);
}
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// итеративно: median-цель по соседям → проекция separation внутри колонки
const updateOrder = Object.entries(nbrs);
for (let it = 0; it < 60; it++) {
  let moved = 0;
  // чередуем направление обхода: лечит взаимную погоню пар (A3⇄E2);
  // настоящий VPSC решает это слиянием выровненных узлов в блок.
  const ord = it % 2 === 0 ? updateOrder : [...updateOrder].reverse();
  for (const [k, ns] of ord) {
    const target = median(ns.map((n) => y[n]));
    moved = Math.max(moved, Math.abs(target - y[k]));
    y[k] = target;
  }
  // проекция: внутри контейнера сохранить порядок и зазор ≥ ROW_GAP
  for (const kids of Object.values(ORDERS)) {
    for (let i = 1; i < kids.length; i++) {
      const lo = y[kids[i - 1]] + NODE_H + ROW_GAP;
      if (y[kids[i]] < lo) y[kids[i]] = lo;
    }
    for (let i = kids.length - 2; i >= 0; i--) {
      const hi = y[kids[i + 1]] - NODE_H - ROW_GAP;
      if (y[kids[i]] > hi) y[kids[i]] = hi;
    }
  }
  if (moved < 0.01) {
    console.log(`сошлось за ${it + 1} итераций`);
    break;
  }
}

const cy = (k) => y[k] + NODE_H / 2;
console.log("\n===== ВАРИАНТ (c)-global-y =====");
for (const [cid, kids] of Object.entries(ORDERS)) {
  const top = Math.min(...kids.map((k) => y[k])) - PAD_TOP;
  const bot = Math.max(...kids.map((k) => y[k] + NODE_H)) + PAD_BOTTOM;
  console.log(
    `${cid}: обтянутый бокс y=${top.toFixed(0)} h=${(bot - top).toFixed(0)} | строки: ${kids.map((k) => `${k}@${cy(k).toFixed(0)}`).join(" ")}`,
  );
}
const chain = ["A1", "B1", "D1", "E1"].map(cy);
const dev = Math.max(...chain) - Math.min(...chain);
console.log(
  `\nЦепочка A1→B1→D1→E1: cy=[${chain.map((v) => v.toFixed(0)).join(", ")}] разброс=${dev.toFixed(1)}px ${dev <= 2 ? "✅ ТОЧНАЯ ЛИНИЯ" : dev <= 10 ? "✅ линия" : "❌"}`,
);
const row2 = ["A2", "B2", "D2"].map(cy);
const dev2 = Math.max(...row2) - Math.min(...row2);
console.log(`Ряд A2→B2→D2: cy=[${row2.map((v) => v.toFixed(0)).join(", ")}] разброс=${dev2.toFixed(1)}px ${dev2 <= 2 ? "✅" : "❌"}`);
const d3 = Math.abs(cy("A3") - cy("E2"));
console.log(`A3 vs E2: |Δcy|=${d3.toFixed(1)}px ${d3 <= 2 ? "✅" : "❌"}`);
console.log(`D3 (свободный хвост): cy=${cy("D3").toFixed(0)}`);
