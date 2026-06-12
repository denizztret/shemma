// DRW-199 probe: иерархия препятствий для глобального libavoid-роутера.
// Варианты:
//   A — препятствия: листья + контейнеры; пины на концевых боксах
//   B — препятствия: только листья
// Метрика per вариант: число пересечений маршрута с «чужими» боксами
// (не концевой бокс, не предок концевого) — это и есть дефект «стрелка сквозь бокс».
// usage: bun probe-hierarchy.mjs boxes-probe.json
import { readFileSync } from "node:fs";
import { AvoidLib } from "libavoid-js";

await AvoidLib.load();
const Avoid = AvoidLib.getInstance();

const dataPath = process.argv[2];
const { boxes, edges } = JSON.parse(readFileSync(dataPath, "utf8"));
const byId = new Map(boxes.map((b) => [b.id, b]));

const ancestorsOf = (id) => {
  const out = new Set();
  let cur = byId.get(id);
  while (cur?.parent) {
    out.add(cur.parent);
    cur = byId.get(cur.parent);
  }
  return out;
};

// Ortho-сегмент пересекает ВНУТРЕННОСТЬ прямоугольника?
const segCrossesBox = (p1, p2, b) => {
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  const lo = (a, c) => Math.min(a, c);
  const hi = (a, c) => Math.max(a, c);
  const L = b.x;
  const R = b.x + b.w;
  const T = b.y;
  const B = b.y + b.h;
  if (y1 === y2) {
    return y1 > T && y1 < B && hi(x1, x2) > L && lo(x1, x2) < R;
  }
  if (x1 === x2) {
    return x1 > L && x1 < R && hi(y1, y2) > T && lo(y1, y2) < B;
  }
  return false;
};

const routeViolations = (points, edge) => {
  const skip = new Set([edge.from, edge.to]);
  for (const a of ancestorsOf(edge.from)) skip.add(a);
  for (const a of ancestorsOf(edge.to)) skip.add(a);
  const hit = [];
  for (const b of boxes) {
    if (skip.has(b.id)) continue;
    for (let i = 0; i + 1 < points.length; i++) {
      if (segCrossesBox(points[i], points[i + 1], b)) {
        hit.push(b.label);
        break;
      }
    }
  }
  return hit;
};

const CENTER_PIN = 1;

const runVariant = (name, obstacleFilter) => {
  const router = new Avoid.Router(Avoid.RouterFlag.OrthogonalRouting.value);
  router.setRoutingParameter(Avoid.RoutingParameter.shapeBufferDistance, 12);
  router.setRoutingParameter(Avoid.RoutingParameter.idealNudgingDistance, 16);
  router.setRoutingOption(
    Avoid.RoutingOption.nudgeOrthogonalSegmentsConnectedToShapes,
    true,
  );

  const endpointIds = new Set(edges.flatMap((e) => [e.from, e.to]));
  const refs = new Map();
  for (const b of boxes) {
    if (!obstacleFilter(b) && !endpointIds.has(b.id)) continue;
    const rect = new Avoid.Rectangle(
      new Avoid.Point(b.x, b.y),
      new Avoid.Point(b.x + b.w, b.y + b.h),
    );
    const ref = new Avoid.ShapeRef(router, rect);
    new Avoid.ShapeConnectionPin(ref, CENTER_PIN, 0.5, 0.5, true, 0, 15);
    refs.set(b.id, ref);
  }

  const conns = [];
  for (const e of edges) {
    const src = refs.get(e.from);
    const dst = refs.get(e.to);
    if (!src || !dst) continue;
    conns.push({
      edge: e,
      conn: new Avoid.ConnRef(
        router,
        new Avoid.ConnEnd(src, CENTER_PIN),
        new Avoid.ConnEnd(dst, CENTER_PIN),
      ),
    });
  }
  router.processTransaction();

  let totalViolations = 0;
  const segHist = {};
  const details = [];
  for (const { edge, conn } of conns) {
    const pl = conn.displayRoute();
    const pts = [];
    for (let i = 0; i < pl.size(); i++) {
      const p = pl.at(i);
      pts.push([p.x, p.y]);
    }
    const segs = pts.length - 1;
    segHist[segs] = (segHist[segs] ?? 0) + 1;
    const viol = routeViolations(pts, edge);
    totalViolations += viol.length;
    if (viol.length) {
      details.push(
        `    ${byId.get(edge.from)?.label} -> ${byId.get(edge.to)?.label}: сквозь [${viol.join(", ")}]`,
      );
    }
  }
  console.log(
    `  ${name}: violations=${totalViolations}, segments=${JSON.stringify(segHist)}`,
  );
  for (const d of details) console.log(d);
  router.delete();
};

// V-F: роутер на класс рёбер; класс = множество исключаемых предков обоих концов.
// Препятствия класса = все боксы минус предки концов. Пины на листьях.
// Nudging работает внутри класса (параллельные пучки обычно одноклассовые).
const runPerClass = () => {
  const classes = new Map();
  for (const e of edges) {
    const excl = new Set([...ancestorsOf(e.from), ...ancestorsOf(e.to)]);
    const key = [...excl].sort().join("|");
    if (!classes.has(key)) classes.set(key, { excl, edges: [] });
    classes.get(key).edges.push(e);
  }

  let totalViolations = 0;
  const segHist = {};
  const details = [];
  const t0 = performance.now();
  for (const { excl, edges: classEdges } of classes.values()) {
    const router = new Avoid.Router(Avoid.RouterFlag.OrthogonalRouting.value);
    router.setRoutingParameter(Avoid.RoutingParameter.shapeBufferDistance, 12);
    router.setRoutingParameter(Avoid.RoutingParameter.idealNudgingDistance, 16);
    router.setRoutingOption(
      Avoid.RoutingOption.nudgeOrthogonalSegmentsConnectedToShapes,
      true,
    );
    const refs = new Map();
    for (const b of boxes) {
      if (excl.has(b.id)) continue;
      const rect = new Avoid.Rectangle(
        new Avoid.Point(b.x, b.y),
        new Avoid.Point(b.x + b.w, b.y + b.h),
      );
      const ref = new Avoid.ShapeRef(router, rect);
      new Avoid.ShapeConnectionPin(ref, CENTER_PIN, 0.5, 0.5, true, 0, 15);
      refs.set(b.id, ref);
    }
    const conns = [];
    for (const e of classEdges) {
      const src = refs.get(e.from);
      const dst = refs.get(e.to);
      if (!src || !dst) continue;
      conns.push({
        edge: e,
        conn: new Avoid.ConnRef(
          router,
          new Avoid.ConnEnd(src, CENTER_PIN),
          new Avoid.ConnEnd(dst, CENTER_PIN),
        ),
      });
    }
    router.processTransaction();
    for (const { edge, conn } of conns) {
      const pl = conn.displayRoute();
      const pts = [];
      for (let i = 0; i < pl.size(); i++) {
        const p = pl.at(i);
        pts.push([p.x, p.y]);
      }
      const segs = pts.length - 1;
      segHist[segs] = (segHist[segs] ?? 0) + 1;
      const viol = routeViolations(pts, edge);
      totalViolations += viol.length;
      if (viol.length) {
        details.push(
          `    ${byId.get(edge.from)?.label} -> ${byId.get(edge.to)?.label}: сквозь [${viol.join(", ")}]`,
        );
      }
    }
    router.delete();
  }
  const ms = (performance.now() - t0).toFixed(1);
  console.log(
    `  V-F (per-class, ${classes.size} классов, ${ms}ms): violations=${totalViolations}, segments=${JSON.stringify(segHist)}`,
  );
  for (const d of details) console.log(d);
};

// V-H: иерархическая видимость per-class. Для класса (множество предков-контейнеров
// обоих концов) набор препятствий строится БЕЗ overlap: исключённый контейнер
// «раскрывается» до детей, остальные контейнеры — опаковые боксы (дети не добавляются).
const byParent = new Map();
for (const b of boxes) {
  const key = b.parent ?? null;
  if (!byParent.has(key)) byParent.set(key, []);
  byParent.get(key).push(b);
}

const visibleSetFor = (excl) => {
  const out = [];
  const expand = (b) => {
    if (b.kind === "container" && excl.has(b.id)) {
      for (const child of byParent.get(b.id) ?? []) expand(child);
    } else {
      out.push(b);
    }
  };
  for (const b of byParent.get(null) ?? []) expand(b);
  return out;
};

const runHierarchical = () => {
  const classes = new Map();
  for (const e of edges) {
    const excl = new Set([...ancestorsOf(e.from), ...ancestorsOf(e.to)]);
    const key = [...excl].sort().join("|");
    if (!classes.has(key)) classes.set(key, { excl, edges: [] });
    classes.get(key).edges.push(e);
  }

  let totalViolations = 0;
  const segHist = {};
  const details = [];
  const t0 = performance.now();
  for (const { excl, edges: classEdges } of classes.values()) {
    const router = new Avoid.Router(Avoid.RouterFlag.OrthogonalRouting.value);
    router.setRoutingParameter(Avoid.RoutingParameter.shapeBufferDistance, 12);
    router.setRoutingParameter(Avoid.RoutingParameter.idealNudgingDistance, 16);
    router.setRoutingOption(
      Avoid.RoutingOption.nudgeOrthogonalSegmentsConnectedToShapes,
      true,
    );
    const refs = new Map();
    for (const b of visibleSetFor(excl)) {
      const rect = new Avoid.Rectangle(
        new Avoid.Point(b.x, b.y),
        new Avoid.Point(b.x + b.w, b.y + b.h),
      );
      const ref = new Avoid.ShapeRef(router, rect);
      new Avoid.ShapeConnectionPin(ref, CENTER_PIN, 0.5, 0.5, true, 0, 15);
      refs.set(b.id, ref);
    }
    const conns = [];
    for (const e of classEdges) {
      const src = refs.get(e.from);
      const dst = refs.get(e.to);
      if (!src || !dst) continue;
      conns.push({
        edge: e,
        conn: new Avoid.ConnRef(
          router,
          new Avoid.ConnEnd(src, CENTER_PIN),
          new Avoid.ConnEnd(dst, CENTER_PIN),
        ),
      });
    }
    router.processTransaction();
    for (const { edge, conn } of conns) {
      const pl = conn.displayRoute();
      const pts = [];
      for (let i = 0; i < pl.size(); i++) {
        const p = pl.at(i);
        pts.push([p.x, p.y]);
      }
      const segs = pts.length - 1;
      segHist[segs] = (segHist[segs] ?? 0) + 1;
      const viol = routeViolations(pts, edge);
      totalViolations += viol.length;
      if (viol.length) {
        details.push(
          `    ${byId.get(edge.from)?.label} -> ${byId.get(edge.to)?.label}: сквозь [${viol.join(", ")}]`,
        );
      }
    }
    router.delete();
  }
  const ms = (performance.now() - t0).toFixed(1);
  console.log(
    `  V-H (hierarchical per-class, ${classes.size} классов, ${ms}ms): violations=${totalViolations}, segments=${JSON.stringify(segHist)}`,
  );
  for (const d of details) console.log(d);
};

console.log(dataPath);
runVariant("V-A (листья+контейнеры)", () => true);
runVariant("V-B (только листья)", (b) => b.kind === "leaf");
runPerClass();
runHierarchical();
