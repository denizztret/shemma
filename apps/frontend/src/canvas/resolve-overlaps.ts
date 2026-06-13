// DRW-232: точечное устранение наезда после обтяжки текста.
//
// Когда обтяжка (apply-text-fit) увеличивает узел внутри контейнера/фрейма, он
// может наехать на соседа вдоль направления потока. В отличие от density-респреда
// (respread.ts), который масштабирует ВСЕ интервалы пропорционально, здесь мы
// двигаем ТОЛЬКО реально наезжающие узлы вперёд по оси потока на минимально
// необходимую величину — остальные интервалы не трогаем (минимальное возмущение,
// не раскладка). Связанные стрелки следуют за узлами сами.
//
// Чистая геометрия (без editor) — editor-обёртка живёт в elk-layout.ts.

/** Узел на одной оси: позиция начала вдоль оси + размер вдоль оси. */
export type Overlap1DItem = {
  id: string;
  /** Координата левого/верхнего края вдоль оси потока (после применения mirror). */
  start: number;
  /** Размер вдоль оси (w для горизонтали, h для вертикали). */
  size: number;
  /** Закреплён пользователем (meta.pinned) → неподвижная опора, не двигаем. */
  pinned: boolean;
};

/**
 * 1D-устранение наезда вдоль оси потока (вперёд = возрастание `start`).
 *
 * Идём по узлам в порядке потока; держим `cursor` = правый край предыдущего +
 * `gap`. Узел двигаем ВПЕРЁД до `cursor` ТОЛЬКО если он наезжает (его start <
 * cursor); узлы с достаточным зазором остаются на месте. `pinned`-узлы никогда не
 * двигаются (неподвижные опоры), но их правый край сдвигает cursor для
 * последующих. Возвращает новый `start` только для СДВИНУТЫХ узлов.
 */
export function resolveOverlaps1D(
  items: ReadonlyArray<Overlap1DItem>,
  gap: number,
): Array<{ id: string; start: number }> {
  const ordered = [...items].sort((a, b) => a.start - b.start);
  const moved: Array<{ id: string; start: number }> = [];
  let cursor = Number.NEGATIVE_INFINITY;
  for (const it of ordered) {
    if (it.pinned) {
      // Неподвижная опора: на месте, но последующие должны её обойти.
      cursor = Math.max(cursor, it.start + it.size + gap);
      continue;
    }
    if (it.start < cursor) {
      // Наезд на предшественника → сдвигаем вперёд ровно до зазора.
      moved.push({ id: it.id, start: cursor });
      cursor = cursor + it.size + gap;
    } else {
      // Зазор достаточный — не трогаем.
      cursor = it.start + it.size + gap;
    }
  }
  return moved;
}

/** Узел в плоскости: parent-relative top-left + размеры + pin. */
export type FlowNode = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  pinned: boolean;
};

/** Ось потока: горизонталь (x/w) или вертикаль (y/h) + reverse (RL/BT). */
export type FlowAxis = { axis: "x" | "y"; reverse: boolean };

/**
 * Ось потока из направления контейнера/фрейма. Cardinal-направление задаёт ось и
 * сторону явно; для не-cardinal (inherit/custom/auto/unset) ось выводится из
 * геометрии — по координате с бо́льшим разбросом центров (одна линия → очевидно).
 */
export function flowAxis(
  dir: string | null | undefined,
  nodes: ReadonlyArray<FlowNode>,
): FlowAxis {
  switch (dir) {
    case "LR":
      return { axis: "x", reverse: false };
    case "RL":
      return { axis: "x", reverse: true };
    case "TB":
      return { axis: "y", reverse: false };
    case "BT":
      return { axis: "y", reverse: true };
    default: {
      // Не-cardinal: вывести ось по разбросу центров.
      let minCx = Number.POSITIVE_INFINITY;
      let maxCx = Number.NEGATIVE_INFINITY;
      let minCy = Number.POSITIVE_INFINITY;
      let maxCy = Number.NEGATIVE_INFINITY;
      for (const n of nodes) {
        const cx = n.x + n.w / 2;
        const cy = n.y + n.h / 2;
        minCx = Math.min(minCx, cx);
        maxCx = Math.max(maxCx, cx);
        minCy = Math.min(minCy, cy);
        maxCy = Math.max(maxCy, cy);
      }
      const spreadX = maxCx - minCx;
      const spreadY = maxCy - minCy;
      return { axis: spreadX >= spreadY ? "x" : "y", reverse: false };
    }
  }
}

/** Поперечная ось относительно оси потока: flow="x" → cross="y", и наоборот. */
export type CrossAxis = "x" | "y";

/** Минимальное поперечное перекрытие (px), чтобы считать узлы одной полосой. */
export const LANE_EPS = 1;

function crossInterval(n: FlowNode, cross: CrossAxis): [number, number] {
  return cross === "y" ? [n.y, n.y + n.h] : [n.x, n.x + n.w];
}

/** Начало поперечного интервала узла (для сортировки — без аллокации tuple). */
function crossStart(n: FlowNode, cross: CrossAxis): number {
  return cross === "y" ? n.y : n.x;
}

/**
 * DRW-242: группирует узлы в поперечные полосы. Два узла в одной полосе ⟺ их
 * интервалы по поперечной оси перекрываются больше чем на {@link LANE_EPS}.
 * Связность транзитивна (полоса = связная компонента графа перекрытий). Узлы
 * сортируются по началу поперечного интервала (tie-break по `id`); поскольку
 * отсортированы по началу, покрытие полосы непрерывно, и связные компоненты =
 * слитые перекрывающиеся интервалы. Слияние происходит ТОЛЬКО при `s < curEnd`
 * (узел касается покрытия), поэтому по индукции покрытие — непрерывный интервал
 * `[firstStart, curEnd]`; ложных слияний через зазор быть не может. Детерминирован.
 */
export function groupLanes(
  nodes: ReadonlyArray<FlowNode>,
  cross: CrossAxis,
): FlowNode[][] {
  const sorted = [...nodes].sort(
    (a, b) =>
      crossStart(a, cross) - crossStart(b, cross) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const lanes: FlowNode[][] = [];
  let cur: FlowNode[] = [];
  let curEnd = Number.NEGATIVE_INFINITY;
  for (const n of sorted) {
    const [s, e] = crossInterval(n, cross);
    // Перекрытие с покрытием текущей полосы = curEnd - s (узлы отсортированы по s).
    if (cur.length > 0 && curEnd - s > LANE_EPS) {
      cur.push(n);
      curEnd = Math.max(curEnd, e);
    } else {
      if (cur.length > 0) lanes.push(cur);
      cur = [n];
      curEnd = e;
    }
  }
  if (cur.length > 0) lanes.push(cur);
  return lanes;
}

/**
 * Устранение наезда вдоль направления потока. Выбирает ось (cardinal или из
 * геометрии), для reverse-направлений (RL/BT) зеркалит координату так, что
 * «вперёд по потоку» = возрастание, зовёт {@link resolveOverlaps1D}, и
 * возвращает новые позиции вдоль оси только для СДВИНУТЫХ узлов (другая
 * координата не меняется). `pinned`-узлы не двигаются.
 *
 * DRW-242: наезд устраняется НЕЗАВИСИМО в каждой поперечной полосе
 * ({@link groupLanes}) — узлы из разных полос не толкают друг друга по проекции
 * оси потока (несвязный компонент в соседнем ряду фрейма остаётся на месте).
 */
export function resolveOverlapsAlongFlow(
  nodes: ReadonlyArray<FlowNode>,
  dir: string | null | undefined,
  gap: number,
): Array<{ id: string; x?: number; y?: number }> {
  if (nodes.length < 2) return [];
  const { axis, reverse } = flowAxis(dir, nodes);
  const horizontal = axis === "x";
  const cross: CrossAxis = horizontal ? "y" : "x";

  const moves: Array<{ id: string; x?: number; y?: number }> = [];
  for (const lane of groupLanes(nodes, cross)) {
    if (lane.length < 2) continue; // одиночка в полосе никогда не двигается
    const items: Overlap1DItem[] = lane.map((n) => {
      const pos = horizontal ? n.x : n.y;
      const size = horizontal ? n.w : n.h;
      // reverse: зеркалим в u = -(pos + size) так, что поток идёт в +u.
      const start = reverse ? -(pos + size) : pos;
      return { id: n.id, start, size, pinned: n.pinned };
    });
    const sizeOf = new Map(lane.map((n) => [n.id, horizontal ? n.w : n.h]));
    for (const m of resolveOverlaps1D(items, gap)) {
      const size = sizeOf.get(m.id) ?? 0;
      // Обратное преобразование зеркала.
      const pos = reverse ? -m.start - size : m.start;
      moves.push(horizontal ? { id: m.id, x: pos } : { id: m.id, y: pos });
    }
  }
  return moves;
}

/**
 * DRW-232: grow-only envelope size for a wrapper (container/frame). Given the
 * wrapper's current size, the far edges of its content (rightmost child right
 * edge / bottommost child bottom edge, in parent-relative coords) and a padding,
 * returns the new size needed so the content fits — but ONLY larger (never
 * shrinks; top-left stays fixed). Returns `null` when the wrapper already
 * contains the content (no change) — callers skip the write, which makes the
 * auto-envelope pass idempotent (and therefore loop-safe).
 *
 * Pure counterpart of `refitWrapperGrowOnly` (elk-layout) — auto-grow never
 * shrinks (AC #7: shrinking a child must not shrink its parent).
 */
export function growOnlyBox(
  current: { w: number; h: number },
  content: { right: number; bottom: number },
  pad: number,
): { w: number; h: number } | null {
  const w = Math.max(current.w, content.right + pad);
  const h = Math.max(current.h, content.bottom + pad);
  if (w === current.w && h === current.h) return null;
  return { w, h };
}
