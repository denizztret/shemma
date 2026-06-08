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

/**
 * Устранение наезда вдоль направления потока. Выбирает ось (cardinal или из
 * геометрии), для reverse-направлений (RL/BT) зеркалит координату так, что
 * «вперёд по потоку» = возрастание, зовёт {@link resolveOverlaps1D}, и
 * возвращает новые позиции вдоль оси только для СДВИНУТЫХ узлов (другая
 * координата не меняется). `pinned`-узлы не двигаются.
 */
export function resolveOverlapsAlongFlow(
  nodes: ReadonlyArray<FlowNode>,
  dir: string | null | undefined,
  gap: number,
): Array<{ id: string; x?: number; y?: number }> {
  if (nodes.length < 2) return [];
  const { axis, reverse } = flowAxis(dir, nodes);
  const horizontal = axis === "x";

  const items: Overlap1DItem[] = nodes.map((n) => {
    const pos = horizontal ? n.x : n.y;
    const size = horizontal ? n.w : n.h;
    // reverse: зеркалим в u = -(pos + size) так, что поток идёт в +u.
    const start = reverse ? -(pos + size) : pos;
    return { id: n.id, start, size, pinned: n.pinned };
  });

  const sizeOf = new Map(nodes.map((n) => [n.id, horizontal ? n.w : n.h]));
  return resolveOverlaps1D(items, gap).map((m) => {
    const size = sizeOf.get(m.id) ?? 0;
    // Обратное преобразование зеркала.
    const pos = reverse ? -m.start - size : m.start;
    return horizontal ? { id: m.id, x: pos } : { id: m.id, y: pos };
  });
}
