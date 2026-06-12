// DRW-244 spike: libavoid-js (WASM) в bun — ortho-роутинг рёбер CI-фрейма (drw-235-probe2).
// Вопросы: грузится ли WASM в bun; форма маршрутов (сегменты); обход препятствий; nudging; перф.
import { readFileSync, writeFileSync } from "node:fs";
import { AvoidLib } from "libavoid-js";

const t0 = performance.now();
await AvoidLib.load(); // node-entry сам найдёт libavoid.wasm рядом с модулем
const Avoid = AvoidLib.getInstance();
const tLoad = performance.now() - t0;

const { boxes, edges } = JSON.parse(
  readFileSync(new URL("./boxes.json", import.meta.url), "utf8"),
);

// --- Router: orthogonal + nudging (как в Adaptagrams-рекомендациях)
// embind-enum'ы: статические свойства классов, в конструкторы идёт .value
const router = new Avoid.Router(Avoid.RouterFlag.OrthogonalRouting.value);
router.setRoutingParameter(Avoid.RoutingParameter.shapeBufferDistance, 12);
router.setRoutingParameter(Avoid.RoutingParameter.idealNudgingDistance, 16);
router.setRoutingOption(
  Avoid.RoutingOption.nudgeOrthogonalSegmentsConnectedToShapes,
  true,
);

// Препятствия: листовые боксы + контейнеры (контейнеры — отдельный вопрос вложенности, см. отчёт)
const CENTER_PIN = 1;
const refs = new Map();
for (const b of boxes) {
  const rect = new Avoid.Rectangle(
    new Avoid.Point(b.x, b.y),
    new Avoid.Point(b.x + b.w, b.y + b.h),
  );
  const ref = new Avoid.ShapeRef(router, rect);
  // Пин в центре, выход в любую сторону (ConnDirAll = 15) — аналог наших centre-anchors
  new Avoid.ShapeConnectionPin(ref, CENTER_PIN, 0.5, 0.5, true, 0, 15);
  refs.set(b.id, ref);
}

const conns = [];
for (const e of edges) {
  const src = refs.get(e.from);
  const dst = refs.get(e.to);
  if (!src || !dst) continue;
  const conn = new Avoid.ConnRef(
    router,
    new Avoid.ConnEnd(src, CENTER_PIN),
    new Avoid.ConnEnd(dst, CENTER_PIN),
  );
  conns.push({ edge: e, conn });
}

const t1 = performance.now();
router.processTransaction();
const tRoute = performance.now() - t1;

// --- Сбор результатов
const byId = new Map(boxes.map((b) => [b.id, b]));
const name = (id) => byId.get(id)?.label ?? id;
const results = [];
for (const { edge, conn } of conns) {
  const pl = conn.displayRoute();
  const pts = [];
  for (let i = 0; i < pl.size(); i++) {
    const p = pl.at(i);
    pts.push([Math.round(p.x), Math.round(p.y)]);
  }
  results.push({
    from: name(edge.from),
    to: name(edge.to),
    segments: pts.length - 1,
    points: pts,
  });
}

const segCounts = results.map((r) => r.segments);
const hist = {};
for (const s of segCounts) hist[s] = (hist[s] ?? 0) + 1;

console.log(
  `WASM load: ${tLoad.toFixed(0)}ms; route ${results.length} edges over ${boxes.length} obstacles: ${tRoute.toFixed(1)}ms`,
);
console.log("segments histogram:", hist);
for (const r of results.filter((x) => x.segments >= 3).slice(0, 6)) {
  console.log(
    `  ${r.from} -> ${r.to}: ${r.segments} seg`,
    JSON.stringify(r.points),
  );
}

writeFileSync(
  new URL("./routes-bun.json", import.meta.url),
  JSON.stringify(results, null, 2),
);
console.log("routes-bun.json written");

// --- Инкрементальный re-route: сдвиг ОДНОГО бокса, повторный processTransaction.
// Вопрос совместимости с no-auto-layout-on-AI-edit: пересчитываются ли только задетые маршруты.
const moved = boxes.find((b) => b.kind === "leaf");
router.moveShape_delta(refs.get(moved.id), 40, 25);
const t2 = performance.now();
router.processTransaction();
const tIncr = performance.now() - t2;

let changed = 0;
for (let i = 0; i < conns.length; i++) {
  const pl = conns[i].conn.displayRoute();
  const pts = [];
  for (let j = 0; j < pl.size(); j++) {
    const p = pl.at(j);
    pts.push([Math.round(p.x), Math.round(p.y)]);
  }
  if (JSON.stringify(pts) !== JSON.stringify(results[i].points)) changed++;
}
console.log(
  `incremental: moved "${moved.label}" by (40,25) → re-route ${tIncr.toFixed(1)}ms, changed routes: ${changed}/${conns.length}`,
);
