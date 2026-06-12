// apps/frontend/src/canvas/edge-routing-core.ts
// DRW-199: чистое ядро edge-routing — без tldraw, без libavoid (юниты в bun).
// Модель V-H («иерархическая видимость per-class») — спека §2-3.

export type Side = "L" | "R" | "T" | "B";
export type RoutePoint = readonly [number, number];
export type Polyline = ReadonlyArray<RoutePoint>;

export interface RouteBox {
  readonly id: string;
  readonly kind: "leaf" | "container";
  /** Контейнер-родитель в scope; null — top-level бокс фрейма. */
  readonly parent: string | null;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Ось потока родительского контейнера: "v" → TB/BT (top/bottom-стороны предпочтительны),
   * "h" → LR/RL (left/right-стороны предпочтительны). */
  readonly flowAxis?: "h" | "v";
}

/** Маппинг направления потока к оси: TB/BT → "v", LR/RL → "h", иначе undefined. */
export function axisOfDirection(
  dir: string | undefined,
): "h" | "v" | undefined {
  if (dir === "TB" || dir === "BT") return "v";
  if (dir === "LR" || dir === "RL") return "h";
  return undefined;
}

export interface RouteEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

export interface RoutingClass {
  readonly key: string;
  readonly excl: ReadonlySet<string>;
  readonly edges: RouteEdge[];
}

export function buildBoxIndex(
  boxes: ReadonlyArray<RouteBox>,
): Map<string, RouteBox> {
  return new Map(boxes.map((b) => [b.id, b]));
}

export function buildParentIndex(
  boxes: ReadonlyArray<RouteBox>,
): Map<string | null, RouteBox[]> {
  const out = new Map<string | null, RouteBox[]>();
  for (const b of boxes) {
    const key = b.parent ?? null;
    const list = out.get(key);
    if (list) list.push(b);
    else out.set(key, [b]);
  }
  return out;
}

export function ancestorsOf(
  byId: ReadonlyMap<string, RouteBox>,
  id: string,
): Set<string> {
  const out = new Set<string>();
  let cur = byId.get(id);
  while (cur?.parent) {
    out.add(cur.parent);
    cur = byId.get(cur.parent);
  }
  return out;
}

/** Предки обоих концов ребра — боксы, через которые маршрут проходит легально. */
function edgeAncestors(
  byId: ReadonlyMap<string, RouteBox>,
  edge: RouteEdge,
): Set<string> {
  return new Set([
    ...ancestorsOf(byId, edge.from),
    ...ancestorsOf(byId, edge.to),
  ]);
}

export interface Classification {
  readonly classes: RoutingClass[];
  /** Рёбра лист→свой контейнер и рёбра с отсутствующим концом — не роутим. */
  readonly skipped: RouteEdge[];
}

export function classifyEdges(
  boxes: ReadonlyArray<RouteBox>,
  edges: ReadonlyArray<RouteEdge>,
): Classification {
  const byId = buildBoxIndex(boxes);
  const classes = new Map<string, { excl: Set<string>; edges: RouteEdge[] }>();
  const skipped: RouteEdge[] = [];
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) {
      skipped.push(e);
      continue;
    }
    const excl = edgeAncestors(byId, e);
    // конец = предок другого конца (лист → свой контейнер): V-H не моделирует
    if (excl.has(e.from) || excl.has(e.to)) {
      skipped.push(e);
      continue;
    }
    const key = [...excl].sort().join("|");
    const cls = classes.get(key);
    if (cls) cls.edges.push(e);
    else classes.set(key, { excl, edges: [e] });
  }
  return {
    classes: [...classes.entries()].map(([key, c]) => ({ key, ...c })),
    skipped,
  };
}

/** Набор препятствий класса БЕЗ overlap: исключённые контейнеры раскрыты до детей,
 * прочие контейнеры опаковые (их дети не входят). */
export function visibleSetFor(
  byParent: ReadonlyMap<string | null, RouteBox[]>,
  excl: ReadonlySet<string>,
): RouteBox[] {
  const out: RouteBox[] = [];
  const expand = (b: RouteBox): void => {
    if (b.kind === "container" && excl.has(b.id)) {
      for (const child of byParent.get(b.id) ?? []) expand(child);
    } else {
      out.push(b);
    }
  };
  for (const b of byParent.get(null) ?? []) expand(b);
  return out;
}

/** Допуск ортогональности: вершины реальных стрелок — float'ы с микро-дрейфом
 * (live-находка T5: прямая A3→E2 имела Δy≈0.01 и не считалась горизонтальной). */
const ORTHO_EPS = 0.5;

/** Ortho-сегмент пересекает ВНУТРЕННОСТЬ прямоугольника (касание границы — нет). */
export function segCrossesBox(
  p1: RoutePoint,
  p2: RoutePoint,
  b: RouteBox,
): boolean {
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  const left = b.x;
  const right = b.x + b.w;
  const top = b.y;
  const bottom = b.y + b.h;
  if (Math.abs(y1 - y2) <= ORTHO_EPS) {
    const y = (y1 + y2) / 2;
    return (
      y > top &&
      y < bottom &&
      Math.max(x1, x2) > left &&
      Math.min(x1, x2) < right
    );
  }
  if (Math.abs(x1 - x2) <= ORTHO_EPS) {
    const x = (x1 + x2) / 2;
    return (
      x > left &&
      x < right &&
      Math.max(y1, y2) > top &&
      Math.min(y1, y2) < bottom
    );
  }
  return false; // не-ortho сегменты ядро не считает
}

/** Чужие боксы, через которые проходит маршрут (концы и их предки исключены).
 * Ortho-сегменты ловятся пересечением; КРИВЫЕ полилинии (текущая геометрия
 * arc-стрелок — диагональные сегменты с плотными вершинами) ловятся проверкой
 * вершин внутри бокса — live-находка T7: ortho-only метрика была слепа к грязной
 * дуге, и гейт считал её чистой. Точки НА границе (пины) не считаются. */
export function foreignCrossings(
  points: Polyline,
  edge: RouteEdge,
  boxes: ReadonlyArray<RouteBox>,
  byId: ReadonlyMap<string, RouteBox>,
): string[] {
  const skip = edgeAncestors(byId, edge);
  skip.add(edge.from);
  skip.add(edge.to);
  const hit: string[] = [];
  for (const b of boxes) {
    if (skip.has(b.id)) continue;
    let crosses = false;
    for (let i = 0; i + 1 < points.length && !crosses; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];
      if (p1 !== undefined && p2 !== undefined && segCrossesBox(p1, p2, b)) {
        crosses = true;
      }
    }
    for (let i = 0; i < points.length && !crosses; i++) {
      const p = points[i];
      if (
        p !== undefined &&
        p[0] > b.x &&
        p[0] < b.x + b.w &&
        p[1] > b.y &&
        p[1] < b.y + b.h
      ) {
        crosses = true;
      }
    }
    if (crosses) hit.push(b.id);
  }
  return hit;
}

/** Пересечение H-сегмента и V-сегмента (строгое, без касаний). */
function orthoSegsCross(
  h1: RoutePoint,
  h2: RoutePoint,
  v1: RoutePoint,
  v2: RoutePoint,
): boolean {
  const y = h1[1];
  const x = v1[0];
  return (
    y > Math.min(v1[1], v2[1]) &&
    y < Math.max(v1[1], v2[1]) &&
    x > Math.min(h1[0], h2[0]) &&
    x < Math.max(h1[0], h2[0])
  );
}

export function countPolylineCrossings(a: Polyline, b: Polyline): number {
  let n = 0;
  for (let i = 0; i + 1 < a.length; i++) {
    const ai = a[i];
    const ai1 = a[i + 1];
    if (ai === undefined || ai1 === undefined) continue;
    const aH = Math.abs(ai[1] - ai1[1]) <= ORTHO_EPS;
    for (let j = 0; j + 1 < b.length; j++) {
      const bj = b[j];
      const bj1 = b[j + 1];
      if (bj === undefined || bj1 === undefined) continue;
      const bH = Math.abs(bj[1] - bj1[1]) <= ORTHO_EPS;
      if (aH === bH) continue;
      const crossed = aH
        ? orthoSegsCross(ai, ai1, bj, bj1)
        : orthoSegsCross(bj, bj1, ai, ai1);
      if (crossed) n++;
    }
  }
  return n;
}

export function polylineLength(points: Polyline): number {
  let len = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    if (p0 === undefined || p1 === undefined) continue;
    len += Math.abs(p1[0] - p0[0]) + Math.abs(p1[1] - p0[1]);
  }
  return len;
}

export interface RouteMetrics {
  readonly foreign: number;
  readonly edgeCross: number;
  readonly length: number;
  readonly crossFlow: number;
}

const FOREIGN_WEIGHT = 1.0;
const EDGE_CROSS_WEIGHT = 0.15;
const CROSS_FLOW_WEIGHT = 0.1;
/** Тай-брейк по длине требует ≥5% выигрыша — иначе действующий маршрут остаётся. */
const LENGTH_MARGIN = 0.95;

export function routeScore(m: RouteMetrics): number {
  return (
    m.foreign * FOREIGN_WEIGHT +
    m.edgeCross * EDGE_CROSS_WEIGHT +
    (m.crossFlow ?? 0) * CROSS_FLOW_WEIGHT
  );
}

export function candidateBeatsCurrent(
  candidate: RouteMetrics,
  current: RouteMetrics,
): boolean {
  const cs = routeScore(candidate);
  const cu = routeScore(current);
  if (cs < cu) return true;
  if (cs > cu) return false;
  return candidate.length < current.length * LENGTH_MARGIN;
}

// ─── Step 1: определение сторон и план переноса ────────────────────────────

/** Сторона бокса, на которой лежит точка (eps для координат пинов libavoid). */
export function sideOfPoint(
  p: RoutePoint,
  b: RouteBox,
  eps = 1.5,
): Side | null {
  const [x, y] = p;
  if (Math.abs(x - b.x) <= eps) return "L";
  if (Math.abs(x - (b.x + b.w)) <= eps) return "R";
  if (Math.abs(y - b.y) <= eps) return "T";
  if (Math.abs(y - (b.y + b.h)) <= eps) return "B";
  return null;
}

/** Сторона по направлению первого/последнего сегмента (фоллбэк для центр-пинов). */
export function sideOfExit(
  points: Polyline,
  b: RouteBox,
  fromStart: boolean,
): Side {
  const p0 = fromStart ? points[0] : points[points.length - 1];
  const onSide = p0 !== undefined ? sideOfPoint(p0, b) : null;
  if (onSide) return onSide;
  const p1 = fromStart ? points[1] : points[points.length - 2];
  if (p0 === undefined || p1 === undefined) return "R";
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "R" : "L";
  return dy >= 0 ? "B" : "T";
}

/** Боксы разделены вдоль оси (их проекции на ось не перекрываются). */
export function separatedAlongAxis(
  a: RouteBox,
  b: RouteBox,
  axis: "h" | "v",
): boolean {
  return axis === "v"
    ? a.y + a.h <= b.y || b.y + b.h <= a.y
    : a.x + a.w <= b.x || b.x + b.w <= a.x;
}

/** Число терминалов ребра, выходящих/входящих через поперечную потоку сторону.
 * Штрафуется ТОЛЬКО терминал пары, разделённой вдоль оси потока этого конца:
 * same-layer рёбра (соседи в одном ряду) легально ходят боком — иначе гейт
 * выдавливал бы их в вертикальные детуры. Боксы без flowAxis не штрафуются.
 * Результат 0..2. */
export function countCrossFlowTerminals(
  points: Polyline,
  src: RouteBox,
  dst: RouteBox,
): number {
  let count = 0;
  if (
    src.flowAxis !== undefined &&
    separatedAlongAxis(src, dst, src.flowAxis)
  ) {
    const side = sideOfExit(points, src, true);
    if (isTransverse(side, src.flowAxis)) count++;
  }
  if (
    dst.flowAxis !== undefined &&
    separatedAlongAxis(dst, src, dst.flowAxis)
  ) {
    const side = sideOfExit(points, dst, false);
    if (isTransverse(side, dst.flowAxis)) count++;
  }
  return count;
}

function isTransverse(side: Side, axis: "h" | "v"): boolean {
  // "v" (вертикальный поток, TB/BT) — поперечные стороны: L, R
  // "h" (горизонтальный поток, LR/RL) — поперечные стороны: T, B
  return axis === "v"
    ? side === "L" || side === "R"
    : side === "T" || side === "B";
}

export type TransferKind = "straight" | "L" | "Z" | "U" | "detour";

export interface TransferPlan {
  readonly kind: TransferKind;
  readonly srcSide: Side;
  readonly dstSide: Side;
  /** Нормированная позиция средней линии Z-маршрута (0..1 между фасадами боксов). */
  readonly elbowMidPoint?: number;
}

const OPPOSITE: Record<Side, Side> = { L: "R", R: "L", T: "B", B: "T" };

/** Координата фасада бокса на заданной стороне (X для L/R, Y для T/B). */
function facadeCoord(b: RouteBox, side: Side): number {
  switch (side) {
    case "L":
      return b.x;
    case "R":
      return b.x + b.w;
    case "T":
      return b.y;
    case "B":
      return b.y + b.h;
  }
}

export function planTransfer(
  points: Polyline,
  src: RouteBox,
  dst: RouteBox,
): TransferPlan {
  const srcSide = sideOfExit(points, src, true);
  const dstSide = sideOfExit(points, dst, false);
  const segs = points.length - 1;
  if (segs <= 1) return { kind: "straight", srcSide, dstSide };
  if (segs === 2) return { kind: "L", srcSide, dstSide };
  if (segs === 3 && OPPOSITE[srcSide] === dstSide) {
    // Z: средняя линия перпендикулярна сторонам; нормируем между фасадами
    const horizontalFlow = srcSide === "L" || srcSide === "R";
    const p1 = points[1];
    const mid = p1 !== undefined ? (horizontalFlow ? p1[0] : p1[1]) : 0;
    const srcFacade = facadeCoord(src, srcSide);
    const dstFacade = facadeCoord(dst, dstSide);
    const span = dstFacade - srcFacade;
    const t = span === 0 ? 0.5 : (mid - srcFacade) / span;
    if (t > 0 && t < 1) {
      return { kind: "Z", srcSide, dstSide, elbowMidPoint: t };
    }
    return { kind: "detour", srcSide, dstSide }; // средняя линия вне фасадов — ручка не достанет
  }
  if (segs === 3 && srcSide === dstSide) return { kind: "U", srcSide, dstSide };
  return { kind: "detour", srcSide, dstSide };
}

// ─── Step 2: глобальная раздача портов ────────────────────────────────────

export interface PortSlot {
  readonly edgeId: string;
  readonly terminal: "start" | "end";
  readonly frac: number;
}

export interface PortAssignment {
  readonly shapeId: string;
  readonly side: Side;
  readonly ports: PortSlot[];
}

/** Порядок портов на стороне = порядок прилегающих точек маршрутов вдоль стороны.
 * Позиции (i+1)/(n+1). Детерминизм: тай-брейк по edgeId. */
export function assignPorts(
  routes: ReadonlyMap<string, Polyline>,
  edges: ReadonlyArray<RouteEdge>,
  byId: ReadonlyMap<string, RouteBox>,
): PortAssignment[] {
  type Item = { edgeId: string; terminal: "start" | "end"; orderKey: number };
  const groups = new Map<string, Item[]>(); // `${shapeId}|${side}`
  for (const e of edges) {
    const pts = routes.get(e.id);
    if (!pts || pts.length < 2) continue;
    const ends: Array<{ shapeId: string; terminal: "start" | "end" }> = [
      { shapeId: e.from, terminal: "start" },
      { shapeId: e.to, terminal: "end" },
    ];
    for (const { shapeId, terminal } of ends) {
      const b = byId.get(shapeId);
      if (!b) continue;
      const side = sideOfExit(pts, b, terminal === "start");
      // ключ порядка: координата СОСЕДНЕЙ точки маршрута вдоль оси стороны
      const adj = terminal === "start" ? pts[1] : pts[pts.length - 2];
      if (adj === undefined) continue;
      const orderKey = side === "L" || side === "R" ? adj[1] : adj[0];
      const key = `${shapeId}|${side}`;
      const list = groups.get(key);
      const item: Item = { edgeId: e.id, terminal, orderKey };
      if (list) list.push(item);
      else groups.set(key, [item]);
    }
  }
  const out: PortAssignment[] = [];
  for (const [key, items] of [...groups.entries()].sort()) {
    // shape id содержат `:` но не `|` — последний `|` разделяет side
    const lastPipe = key.lastIndexOf("|");
    const shapeId = key.slice(0, lastPipe);
    const side = key.slice(lastPipe + 1) as Side;
    items.sort(
      (a, b) => a.orderKey - b.orderKey || a.edgeId.localeCompare(b.edgeId),
    );
    out.push({
      shapeId,
      side,
      ports: items.map((it, i) => ({
        edgeId: it.edgeId,
        terminal: it.terminal,
        frac: (i + 1) / (items.length + 1),
      })),
    });
  }
  return out;
}

/** Максимальная степень концевого бокса по набору рёбер.
 * Нужна для расчёта pinsPerSide — чтобы exclusive-пины не закончились у хаба. */
export function maxEndpointDegree(edges: ReadonlyArray<RouteEdge>): number {
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  let max = 0;
  for (const count of degree.values()) {
    if (count > max) max = count;
  }
  return max;
}

export function anchorFor(side: Side, frac: number): { x: number; y: number } {
  if (side === "R") return { x: 1, y: frac };
  if (side === "L") return { x: 0, y: frac };
  if (side === "B") return { x: frac, y: 1 };
  return { x: frac, y: 0 };
}

// ─── Arc-кандидат для детуров ──────────────────────────────────────────────────

/** Сэмплирует дугу tldraw (bend = САГИТТА: отклонение СЕРЕДИНЫ дуги от хорды)
 * как ТОЧНУЮ круговую дугу. Live-находки T6/T7: Безье-аппроксимация сначала вдвое
 * занижала сагитту, затем расходилась с круговой формой между серединой и концами
 * (реальная дуга задевала бокс при «чистой» модели). Радиус из сагитты:
 * R = s/2 + L²/(8s); центр — на нормали с противоположной от apex стороны;
 * направление обхода выбирается так, чтобы середина дуги совпала с apex.
 * Нормаль к хорде: nx = -dy/len, ny = dx/len; горизонтальная хорда (dy=0) при
 * bend>0 выгибается в +y. */
export function sampleArc(
  start: RoutePoint,
  end: RoutePoint,
  bend: number,
  samples = 16,
): Polyline {
  const [x1, y1] = start;
  const [x2, y2] = end;
  if (bend === 0) return [start, end];
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const s = Math.abs(bend);
  const sign = Math.sign(bend);
  const r = s / 2 + (len * len) / (8 * s);
  const apexX = mx + nx * sign * s;
  const apexY = my + ny * sign * s;
  const cx = mx - nx * sign * (r - s);
  const cy = my - ny * sign * (r - s);
  const a1 = Math.atan2(y1 - cy, x1 - cx);
  const a2 = Math.atan2(y2 - cy, x2 - cx);
  // CCW-свип 0..2π и его CW-альтернатива; берём тот, чья середина ближе к apex
  const TWO_PI = 2 * Math.PI;
  const ccw = (((a2 - a1) % TWO_PI) + TWO_PI) % TWO_PI;
  const midAt = (sweep: number): readonly [number, number] => [
    cx + r * Math.cos(a1 + sweep / 2),
    cy + r * Math.sin(a1 + sweep / 2),
  ];
  const dCcw = Math.hypot(midAt(ccw)[0] - apexX, midAt(ccw)[1] - apexY);
  const dCw = Math.hypot(
    midAt(ccw - TWO_PI)[0] - apexX,
    midAt(ccw - TWO_PI)[1] - apexY,
  );
  const sweep = dCcw <= dCw ? ccw : ccw - TWO_PI;
  const pts: RoutePoint[] = [];
  for (let i = 0; i <= samples; i++) {
    const a = a1 + (sweep * i) / samples;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/** Пересечения сэмплированной (не-ortho) полилинии с чужими боксами:
 * проверка точек внутри бокса (консервативно при достаточном числе сэмплов). */
export function sampledForeignCrossings(
  points: Polyline,
  edge: RouteEdge,
  boxes: ReadonlyArray<RouteBox>,
  byId: ReadonlyMap<string, RouteBox>,
): string[] {
  const skip = edgeAncestors(byId, edge);
  skip.add(edge.from);
  skip.add(edge.to);
  const hit: string[] = [];
  // Клиренс против дискретности сэмплирования: между сэмплами кривая может
  // зацепить угол бокса — проверяем слегка раздутые прямоугольники (live T7).
  const ARC_CLEARANCE = 4;
  for (const b of boxes) {
    if (skip.has(b.id)) continue;
    const left = b.x - ARC_CLEARANCE;
    const right = b.x + b.w + ARC_CLEARANCE;
    const top = b.y - ARC_CLEARANCE;
    const bottom = b.y + b.h + ARC_CLEARANCE;
    const inside = points.some(
      ([x, y]) => x > left && x < right && y > top && y < bottom,
    );
    if (inside) hit.push(b.id);
  }
  return hit;
}

/** Множители глубины для кандидатов bend. Дуга отклоняется от хорды на
 * 2t(1-t)·bend — вне центра хорды этого мало (live T6: C3 на t≈0.69 требовал
 * ~2.5d), поэтому хвост множителей длинный. Порядок = минимальный |bend| первым. */
const ARC_BEND_MULTIPLIERS: ReadonlyArray<number> = [1, 1.5, 2, 2.5, 3, 4];

/** Подбор bend для детура: кандидаты ±multipliers·d, d = max отклонение маршрута
 * libavoid от хорды. Первый чистый (0 чужих пересечений) с минимальным |bend|.
 * null — дуга не нашлась. */
export function pickArcBend(
  route: Polyline,
  edge: RouteEdge,
  boxes: ReadonlyArray<RouteBox>,
  byId: ReadonlyMap<string, RouteBox>,
): number | null {
  const start = route[0];
  const end = route[route.length - 1];
  if (start === undefined || end === undefined) return null;
  const [x1, y1] = start;
  const [x2, y2] = end;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  let depth = 0;
  for (const p of route) {
    const d = Math.abs(((p[0] - x1) * dy - (p[1] - y1) * dx) / len);
    depth = Math.max(depth, d);
  }
  if (depth === 0) return null;
  const candidates = ARC_BEND_MULTIPLIERS.flatMap((m) => [
    depth * m,
    -depth * m,
  ]);
  for (const bend of candidates) {
    const arc = sampleArc(start, end, bend);
    if (sampledForeignCrossings(arc, edge, boxes, byId).length === 0) {
      return bend;
    }
  }
  return null;
}
