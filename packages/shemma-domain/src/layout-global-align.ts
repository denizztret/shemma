/**
 * DRW-235 — глобальная координация строк поперёк контейнеров
 * («(c)-global-y» из notes задачи).
 *
 * Модель эталона юзера (etalon2-chain-topline): на LR/RL-доске контейнеры —
 * вертикальные колонки; узлы, связанные cross-container рёбрами, должны стоять
 * на ОДНОЙ горизонтали (ребро — прямая линия), а контейнер обтягивает результат,
 * растягиваясь при необходимости (разрыв между строками допустим).
 *
 * Два шага, оба детерминированы:
 *  1. ordering — порядок строк в каждой колонке: топология внутренних рёбер
 *     задаёт частичный порядок (Kahn), внешние связи дают score (median cy
 *     соседей); итеративные свипы до неподвижной точки.
 *  2. alignment — глобальное 1D-выравнивание: VPSC-решатель `solve1D` из
 *     `@shemma/domain` (цели по cross-рёбрам, separation внутри колонок и
 *     между top-level элементами одной компоненты, fixed-вары для пинов);
 *     тот же решатель предназначен для 2D-пуша DRW-242.
 */

import { solve1D } from "./layout-solver";
import type {
  AlignmentGoal,
  SeparationConstraint,
  SolverVar,
} from "./layout-solver";

export interface ColumnKid {
  id: string;
  /** y относительно контейнера (вход) */
  y: number;
  h: number;
}

export interface GlobalAlignInput {
  /** колонки: контейнер → дети (порядок входа не важен — сортируем по y) */
  columns: Record<string, ColumnKid[]>;
  /** y контейнера (frame-relative) — для абсолютизации детей */
  columnY: Record<string, number>;
  /**
   * x контейнера — порядок колонок вдоль оси потока. Первый ordering-свип
   * идёт слева направо и скорит узлы ТОЛЬКО об уже переупорядоченные колонки:
   * иначе зеркально-равноценное решение «главная цепочка не по верху»
   * затягивается из произвольного исходного состояния правых колонок.
   */
  columnX: Record<string, number>;
  /** x-интервал колонки [minX, maxX] — для top-level separation-пар */
  columnSpanX: Record<string, [number, number]>;
  /** свободные top-level узлы: + x/w для интервалов */
  loose: Array<{ id: string; y: number; h: number; x: number; w: number }>;
  /** непартиципирующие top-level элементы (контейнеры вдоль потока,
   *  sizePinned, не-geo) — двигаются как целые боксы */
  passive?: Array<{ id: string; y: number; h: number; x: number; w: number }>;
  /**
   * Пины: id узлов, которые решатель не должен двигать (meta.pinned).
   * - orderingSweep пропускает колонку целиком, если хотя бы один её ребёнок pinned;
   * - align() выставляет fixed:true для каждой такой переменной.
   */
  pinned?: ReadonlySet<string>;
  /**
   * Метка компоненты для каждого top-level id (контейнеров, loose, passive).
   * Top-level separation-constraint создаётся только между элементами ОДНОЙ
   * компоненты: `componentOf[a] === componentOf[b]`.
   * При отсутствии поля (или если для конкретного id метки нет) — прежнее
   * поведение: ограничений по компоненте не накладывается (обратная совместимость).
   */
  componentOf?: Readonly<Record<string, number>>;
  /** рёбра между узлами ОДНОЙ колонки (порядок: from выше to) */
  internalEdges: Array<{ from: string; to: string }>;
  /** рёбра между узлами разных колонок / loose-узлами */
  crossEdges: Array<{ from: string; to: string }>;
  /** мин. вертикальный зазор строк в колонке */
  rowGap: number;
  /** отступ первой строки от верха контейнера (заголовок) */
  padTop: number;
  /** отступ последней строки до низа контейнера */
  padBottom: number;
}

export interface GlobalAlignResult {
  /** новый порядок строк по колонкам (сверху вниз) */
  order: Record<string, string[]>;
  /** новые абсолютные (frame-relative) y всех участвующих узлов */
  absY: Record<string, number>;
  /** новые боксы колонок: y + h (обтяжка по строкам) */
  columnBox: Record<string, { y: number; h: number }>;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2
    ? (s[m] as number)
    : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

/** append к bucket'у map<key, T[]>, создавая массив при первом обращении */
function pushTo<K, T>(map: Map<K, T[]>, key: K, value: T): void {
  const bucket = map.get(key);
  if (bucket !== undefined) {
    bucket.push(value);
  } else {
    map.set(key, [value]);
  }
}

/**
 * Порядок строк колонки: Kahn по внутренним рёбрам, среди доступных — узел с
 * меньшим score (median cy внешних соседей; без внешних связей — текущий cy).
 * Цикл во внутренних рёбрах → исходный порядок (вырожденный случай).
 */
export function orderColumn(
  kids: ReadonlyArray<{ id: string; score: number }>,
  internalEdges: ReadonlyArray<{ from: string; to: string }>,
): string[] {
  const ids = new Set(kids.map((k) => k.id));
  const score = new Map(kids.map((k) => [k.id, k.score]));
  const indeg = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const id of ids) indeg.set(id, 0);
  for (const e of internalEdges) {
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
    pushTo(out, e.from, e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const result: string[] = [];
  const ready = [...ids].filter((id) => (indeg.get(id) ?? 0) === 0);
  while (ready.length > 0) {
    ready.sort(
      (a, b) => (score.get(a) ?? 0) - (score.get(b) ?? 0) || a.localeCompare(b),
    );
    const id = ready.shift() as string;
    result.push(id);
    for (const t of out.get(id) ?? []) {
      const d = (indeg.get(t) ?? 1) - 1;
      indeg.set(t, d);
      if (d === 0) ready.push(t);
    }
  }
  // цикл → топологический порядок невозможен, оставляем как есть
  return result.length === ids.size ? result : kids.map((k) => k.id);
}

const ORDER_SWEEPS = 4;

/** Полный пасс: ordering + global-y alignment + обтяжка колонок. */
export function globalAlign(input: GlobalAlignInput): GlobalAlignResult {
  const { rowGap, padTop, padBottom } = input;
  const pinned = input.pinned ?? new Set<string>();
  const h = new Map<string, number>();
  const colOf = new Map<string, string>();
  for (const [cid, kids] of Object.entries(input.columns)) {
    for (const k of kids) {
      h.set(k.id, k.h);
      colOf.set(k.id, cid);
    }
  }
  for (const l of input.loose) h.set(l.id, l.h);
  for (const p of input.passive ?? []) {
    h.set(p.id, p.h);
  }

  // абсолютные y (frame-relative) как стартовое состояние
  const y = new Map<string, number>();
  for (const [cid, kids] of Object.entries(input.columns)) {
    const base = input.columnY[cid] ?? 0;
    for (const k of kids) y.set(k.id, base + k.y);
  }
  for (const l of input.loose) y.set(l.id, l.y);
  for (const p of input.passive ?? []) {
    y.set(p.id, p.y);
  }
  const cy = (id: string): number => (y.get(id) ?? 0) + (h.get(id) ?? 0) / 2;

  // внешние соседи по cross-рёбрам
  const nbrs = new Map<string, string[]>();
  for (const e of input.crossEdges) {
    if (!h.has(e.from) || !h.has(e.to)) continue;
    pushTo(nbrs, e.from, e.to);
    pushTo(nbrs, e.to, e.from);
  }

  // ---- шаг 1: ordering — свипы до неподвижной точки ----
  const order: Record<string, string[]> = {};
  for (const [cid, kids] of Object.entries(input.columns)) {
    order[cid] = [...kids].sort((a, b) => a.y - b.y).map((k) => k.id);
  }
  const internalByCol = new Map<string, Array<{ from: string; to: string }>>();
  for (const e of input.internalEdges) {
    const cid = colOf.get(e.from);
    if (!cid || colOf.get(e.to) !== cid) continue;
    pushTo(internalByCol, cid, e);
  }
  const colIds = Object.keys(input.columns).sort(
    (a, b) =>
      (input.columnX[a] ?? 0) - (input.columnX[b] ?? 0) || a.localeCompare(b),
  );
  const looseIds = new Set(input.loose.map((l) => l.id));
  const orderingSweep = (directional: boolean): boolean => {
    let changed = false;
    // направленный первый свип: учитываем соседей только из колонок левее
    // (уже переупорядоченных) и loose-узлов; дальше — полные свипы
    const settled = new Set<string>(looseIds);
    for (const cid of colIds) {
      // Колонка с pinned-ребёнком не переупорядочивается: её ребята уже стоят
      // там, где положил юзер, — свип пропускается целиком.
      if ((order[cid] ?? []).some((id) => pinned.has(id))) {
        settled.add(cid);
        continue;
      }
      const scored = (order[cid] ?? []).map((id) => {
        const ns = (nbrs.get(id) ?? []).filter(
          (n) =>
            !directional || settled.has(n) || settled.has(colOf.get(n) ?? ""),
        );
        return { id, score: ns.length > 0 ? median(ns.map(cy)) : cy(id) };
      });
      const next = orderColumn(scored, internalByCol.get(cid) ?? []);
      if (next.join(" ") !== (order[cid] ?? []).join(" ")) {
        changed = true;
        order[cid] = next;
      }
      // строки занимают прежние слоты колонки в новом порядке —
      // следующие колонки свипа видят обновлённые cy
      const slots = (order[cid] ?? [])
        .map((id) => y.get(id) ?? 0)
        .sort((a, b) => a - b);
      (order[cid] ?? []).forEach((id, i) => y.set(id, slots[i] as number));
      settled.add(cid);
    }
    return changed;
  };

  // ---- шаг 2: global-y — solve1D (VPSC: separation + alignment goals) ----
  const align = (): void => {
    const vars: SolverVar[] = [];
    for (const [id, hh] of h) {
      vars.push({
        id,
        pos: (y.get(id) ?? 0) + hh / 2,
        size: hh,
        fixed: pinned.has(id) || undefined,
      });
    }
    const constraints: SeparationConstraint[] = [];
    for (const cid of colIds) {
      const kids = order[cid] ?? [];
      for (let i = 1; i < kids.length; i++) {
        const prev = kids[i - 1] as string;
        const cur = kids[i] as string;
        constraints.push({
          left: prev,
          right: cur,
          gap: (h.get(prev) ?? 0) / 2 + (h.get(cur) ?? 0) / 2 + rowGap,
        });
      }
    }
    // top-level separation: элементы с пересекающимися x-интервалами получают
    // separation по оси y
    type TopItem = {
      id: string;
      lowVar: string;
      highVar: string;
      topPad: number;
      bottomPad: number;
      span: [number, number];
      cross: [number, number];
    };
    const tops: TopItem[] = [];
    for (const cid of colIds) {
      const kids = order[cid] ?? [];
      const first = kids[0];
      const last = kids[kids.length - 1];
      if (!first || !last) continue;
      tops.push({
        id: cid,
        highVar: first,
        lowVar: last,
        topPad: (h.get(first) ?? 0) / 2 + padTop,
        bottomPad: (h.get(last) ?? 0) / 2 + padBottom,
        span: input.columnSpanX[cid] ?? [0, 0],
        cross: [
          (y.get(first) ?? 0) - padTop,
          (y.get(last) ?? 0) + (h.get(last) ?? 0) + padBottom,
        ],
      });
    }
    for (const it of [...input.loose, ...(input.passive ?? [])]) {
      tops.push({
        id: it.id,
        highVar: it.id,
        lowVar: it.id,
        topPad: it.h / 2,
        bottomPad: it.h / 2,
        span: [it.x, it.x + it.w],
        cross: [y.get(it.id) ?? 0, (y.get(it.id) ?? 0) + it.h],
      });
    }
    tops.sort((p, q) => p.cross[0] - q.cross[0] || p.id.localeCompare(q.id));
    const topGap = rowGap;
    const componentOf = input.componentOf;
    for (let i = 0; i < tops.length; i++) {
      for (let j = i + 1; j < tops.length; j++) {
        const a = tops[i] as TopItem;
        const b = tops[j] as TopItem;
        if (a.id === b.id) continue;
        const xOverlap = a.span[0] < b.span[1] && b.span[0] < a.span[1];
        if (!xOverlap) continue;
        if (a.highVar === b.highVar) continue;
        // пара создаётся только внутри одной компоненты; если componentOf
        // задан и метки различаются (или у одного есть, у другого нет) — пропуск
        if (componentOf !== undefined) {
          const ca = componentOf[a.id];
          const cb = componentOf[b.id];
          if (ca !== cb) continue;
        }
        constraints.push({
          left: a.lowVar,
          right: b.highVar,
          gap: a.bottomPad + topGap + b.topPad,
        });
      }
    }
    const goals: AlignmentGoal[] = input.crossEdges
      .filter((e) => h.has(e.from) && h.has(e.to))
      .map((e) => ({ a: e.from, b: e.to }));
    const solved = solve1D(vars, constraints, goals);
    for (const [id, hh] of h) {
      const c = solved[id];
      if (c != null) y.set(id, c - hh / 2);
    }
  };

  // «порядок → выравнивание» с чередованием: решения о порядке принимаются по
  // ВЫРОВНЕННЫМ позициям. Слоты до выравнивания врут: узел, которого alignment
  // уведёт вниз ради далёкого партнёра, в слотах ещё стоит высоко — и утянутое
  // за ним длинное ребро тоннелирует сквозь чужие боксы.
  for (let sweep = 0; sweep < ORDER_SWEEPS; sweep++) {
    const changed = orderingSweep(sweep === 0);
    align();
    if (sweep > 0 && !changed && sweep >= 2) break;
  }

  // ---- обтяжка колонок ----
  const columnBox: Record<string, { y: number; h: number }> = {};
  for (const cid of colIds) {
    const kids = order[cid] ?? [];
    if (kids.length === 0) continue;
    let top = Number.POSITIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (const id of kids) {
      top = Math.min(top, y.get(id) ?? 0);
      bottom = Math.max(bottom, (y.get(id) ?? 0) + (h.get(id) ?? 0));
    }
    columnBox[cid] = { y: top - padTop, h: bottom - top + padTop + padBottom };
  }
  const absY: Record<string, number> = {};
  for (const [id, v] of y) absY[id] = v;
  return { order, absY, columnBox };
}

/**
 * Адаптер оси: читает из flat-записи «решаемую» (main) и «перпендикулярную» (perp)
 * координаты в зависимости от ориентации пасса.
 * axisVertical=true  → решаем y (LR/RL-доска), main=y, perp=x.
 * axisVertical=false → решаем x (TB/BT-доска), main=x, perp=y.
 */
export function readAxisBox(
  p: { x: number; y: number; w?: number; h?: number },
  axisVertical: boolean,
): { main: number; size: number; perp: number; perpSize: number } {
  return axisVertical
    ? { main: p.y, size: p.h ?? 0, perp: p.x, perpSize: p.w ?? 0 }
    : { main: p.x, size: p.w ?? 0, perp: p.y, perpSize: p.h ?? 0 };
}

/**
 * Адаптер оси: пишет main/size обратно в flat-запись.
 * axisVertical=true  → пишет в y/h.
 * axisVertical=false → пишет в x/w.
 */
export function writeAxisBox(
  p: { x: number; y: number; w?: number; h?: number },
  axisVertical: boolean,
  main: number,
  size?: number,
): void {
  if (axisVertical) {
    p.y = main;
    if (size !== undefined) p.h = size;
  } else {
    p.x = main;
    if (size !== undefined) p.w = size;
  }
}

export interface GlobalAlignPassArgs {
  /** parent-relative позиции пайплайна (МУТИРУЕТСЯ): дети — отн. контейнера,
   *  top-level — отн. фрейма */
  flat: Record<string, { x: number; y: number; w?: number; h?: number }>;
  /** колонки, прошедшие гейты caller'а (TB при axisVertical, LR при !axisVertical) */
  columns: ReadonlyArray<{ id: string; kidIds: string[] }>;
  /** top-level geo-участники */
  looseIds: ReadonlyArray<string>;
  nodeEdges: ReadonlyArray<{ from: string; to: string }>;
  /** ranked top-level ids по компонентам — для re-pack после роста боксов */
  components: ReadonlyArray<ReadonlyArray<string>>;
  rowGap: number;
  compGap: number;
  padTop: number;
  padBottom: number;
  /** интервалы колонок по перпендикулярной оси (из flat: [perp, perp + perpSize]) */
  columnSpanX?: Record<string, [number, number]>;
  /** непартиципирующие top-level элементы: только id, x/y/w/h читаются из flat */
  passive?: ReadonlyArray<{ id: string }>;
  /**
   * Пины: id узлов, которые решатель не должен двигать.
   * При forceUnpin — передавать пустой Set.
   */
  pinned?: ReadonlySet<string>;
  /**
   * true (default) → решаем ось y (LR/RL-доска, вертикальные колонки).
   * false           → решаем ось x (TB/BT-доска, горизонтальные лейны).
   */
  axisVertical?: boolean;
  /**
   * Инвертировать порядок свипа вдоль потока (columnX *= -1).
   * Нужно для инвертированных направлений (RL, BT): поток идёт от большей
   * perp-координаты к меньшей, и ordering-свип должен начинаться с «дальнего»
   * конца потока (т.е. с большего perp), а не с ближнего.
   */
  invertColumnOrder?: boolean;
}

export interface GlobalAlignPassResult {
  /** cross-рёбра, выровненные в линию (|Δцентров по решаемой оси| < 0.5):
   *  ключ "from>to" (id узлов), точки в координатах flat (frame-relative) */
  portHints: Map<
    string,
    { source: { x: number; y: number }; target: { x: number; y: number } }
  >;
}

/**
 * Orchestrator для autoLayoutFrame: собирает вход globalAlign из flat,
 * пишет результат обратно (дети — в координатах контейнера, контейнеры —
 * новый main/size по оси) и re-pack'ает компоненты по cross-оси (выравнивание
 * меняет размер компонента — пересборка пакета взамен offset'ов packComponents).
 *
 * axisVertical=true (default): решаем y (LR/RL-доска).
 * axisVertical=false:          решаем x (TB/BT-доска).
 */
export function runGlobalAlignPass(
  args: GlobalAlignPassArgs,
): GlobalAlignPassResult {
  const { flat } = args;
  const av = args.axisVertical !== false; // default true
  const rb = (p: { x: number; y: number; w?: number; h?: number }) =>
    readAxisBox(p, av);
  const kidOf = new Map<string, string>();
  const columns: Record<string, ColumnKid[]> = {};
  const columnY: Record<string, number> = {};
  const columnX: Record<string, number> = {};
  for (const c of args.columns) {
    const box = flat[c.id];
    if (!box) continue;
    const boxA = rb(box);
    const kids: ColumnKid[] = [];
    for (const kid of c.kidIds) {
      const p = flat[kid];
      if (!p) continue;
      const pA = rb(p);
      kids.push({ id: kid, y: pA.main, h: pA.size });
      kidOf.set(kid, c.id);
    }
    if (kids.length === 0) continue;
    columns[c.id] = kids;
    columnY[c.id] = boxA.main;
    columnX[c.id] = args.invertColumnOrder ? -boxA.perp : boxA.perp;
  }
  const loose: Array<{
    id: string;
    y: number;
    h: number;
    x: number;
    w: number;
  }> = [];
  const looseSet = new Set<string>();
  for (const id of args.looseIds) {
    const p = flat[id];
    if (!p) continue;
    const pA = rb(p);
    loose.push({ id, y: pA.main, h: pA.size, x: pA.perp, w: pA.perpSize });
    looseSet.add(id);
  }
  const columnSpanX: Record<string, [number, number]> = args.columnSpanX ?? {};
  if (!args.columnSpanX) {
    for (const c of args.columns) {
      const box = flat[c.id];
      if (!box) continue;
      const bA = rb(box);
      columnSpanX[c.id] = [bA.perp, bA.perp + bA.perpSize];
    }
  }
  const passive: Array<{
    id: string;
    y: number;
    h: number;
    x: number;
    w: number;
  }> = [];
  for (const p of args.passive ?? []) {
    const box = flat[p.id];
    if (!box) continue;
    const bA = rb(box);
    passive.push({
      id: p.id,
      y: bA.main,
      h: bA.size,
      x: bA.perp,
      w: bA.perpSize,
    });
  }
  const participates = (id: string): boolean =>
    kidOf.has(id) || looseSet.has(id);
  const internalEdges: Array<{ from: string; to: string }> = [];
  const crossEdges: Array<{ from: string; to: string }> = [];
  for (const e of args.nodeEdges) {
    if (!participates(e.from) || !participates(e.to)) continue;
    const a = kidOf.get(e.from);
    const b = kidOf.get(e.to);
    if (a != null && a === b) internalEdges.push(e);
    else crossEdges.push(e);
  }
  if (crossEdges.length === 0) return { portHints: new Map() }; // нечего координировать

  // исходные bbox компонентов по решаемой оси (для anchor/re-pack) — до мутации
  const bboxOf = (
    ids: ReadonlyArray<string>,
  ): { top: number; bottom: number } => {
    let top = Number.POSITIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (const id of ids) {
      const p = flat[id];
      if (!p) continue;
      const pA = rb(p);
      top = Math.min(top, pA.main);
      bottom = Math.max(bottom, pA.main + pA.size);
    }
    return { top, bottom };
  };
  const origTops = args.components.map((ids) => bboxOf(ids).top);

  // componentOf: метка компоненты для каждого top-level id (колонки, loose, passive)
  // чтобы top-level separation не пересекала границы компонент (§3.5)
  const componentOf: Record<string, number> = {};
  args.components.forEach((ids, compIdx) => {
    for (const id of ids) {
      componentOf[id] = compIdx;
      // для колонок помечаем и их детей (дети — не top-level, но метка не лишняя)
      const col = columns[id];
      if (col) {
        for (const kid of col) componentOf[kid.id] = compIdx;
      }
    }
  });

  const res = globalAlign({
    columns,
    columnY,
    columnX,
    columnSpanX,
    loose,
    passive,
    internalEdges,
    crossEdges,
    rowGap: args.rowGap,
    padTop: args.padTop,
    padBottom: args.padBottom,
    pinned: args.pinned,
    componentOf,
  });

  const pinnedSet = args.pinned ?? new Set<string>();
  // writeback: контейнеры (новый main/size по оси), дети (отн. нового края), loose/passive
  // Pinned id пропускаются — их позиция apply-пасс всё равно не применяет
  // (двойная защита: fixed-вар не двинулся, и writeback не трогаем flat).
  for (const [cid, box] of Object.entries(res.columnBox)) {
    const p = flat[cid];
    if (!p) continue;
    writeAxisBox(p, av, box.y, box.h);
    for (const kid of columns[cid] ?? []) {
      if (pinnedSet.has(kid.id)) continue;
      const kp = flat[kid.id];
      const ay = res.absY[kid.id];
      if (kp && ay != null) writeAxisBox(kp, av, ay - box.y);
    }
  }
  for (const l of loose) {
    if (pinnedSet.has(l.id)) continue;
    const p = flat[l.id];
    const ay = res.absY[l.id];
    if (p && ay != null) writeAxisBox(p, av, ay);
  }
  for (const p of passive) {
    if (pinnedSet.has(p.id)) continue;
    const box = flat[p.id];
    const ay = res.absY[p.id];
    if (box && ay != null) writeAxisBox(box, av, ay);
  }

  // re-pack компонентов по cross-оси: главный держит исходный край,
  // следующие — последовательно с зазором compGap
  let cursor = Number.NEGATIVE_INFINITY;
  args.components.forEach((ids, i) => {
    const box = bboxOf(ids);
    if (!Number.isFinite(box.top)) return;
    const targetTop = i === 0 ? (origTops[0] ?? box.top) : cursor;
    const delta = (Number.isFinite(targetTop) ? targetTop : box.top) - box.top;
    if (delta !== 0) {
      for (const id of ids) {
        const p = flat[id];
        if (p) writeAxisBox(p, av, rb(p).main + delta);
      }
    }
    cursor = box.bottom + delta + args.compGap;
  });

  // ---- portHints: выровненные cross-рёбра ----
  // Вычисляем ПОСЛЕ writeback + re-pack (flat содержит финальные позиции).
  // Участник = kid колонки или loose; passive — не участники.
  const portHints: GlobalAlignPassResult["portHints"] = new Map();
  for (const e of crossEdges) {
    // абсолютный центр по решаемой оси (main) и перп. оси (perp) узла
    const mainCenterOf = (id: string): number | undefined => {
      const col = kidOf.get(id);
      if (col != null) {
        // kid: absMain = контейнер.main + kid.main (относительное)
        const container = flat[col];
        const kid = flat[id];
        if (!container || !kid) return undefined;
        return rb(container).main + rb(kid).main + rb(kid).size / 2;
      }
      if (looseSet.has(id)) {
        const p = flat[id];
        if (!p) return undefined;
        return rb(p).main + rb(p).size / 2;
      }
      return undefined;
    };
    const fromMain = mainCenterOf(e.from);
    const toMain = mainCenterOf(e.to);
    if (fromMain === undefined || toMain === undefined) continue;
    if (Math.abs(fromMain - toMain) >= 0.5) continue;

    // ребро выровнено — строим точки на границах owner'ов
    const ownerFlatBox = (
      id: string,
    ): { x: number; y: number; w?: number; h?: number } | undefined => {
      const col = kidOf.get(id);
      return col != null ? flat[col] : flat[id];
    };
    const fromOwner = ownerFlatBox(e.from);
    const toOwner = ownerFlatBox(e.to);
    if (!fromOwner || !toOwner) continue;

    const fromBox = rb(fromOwner);
    const toBox = rb(toOwner);

    // грань owner'а, обращённая к target: по перп. оси
    // если toBox.perp > fromBox.perp → target правее/ниже → дальняя грань (perp + perpSize)
    // иначе → ближняя грань (perp)
    const fromFacePerp =
      toBox.perp > fromBox.perp
        ? fromBox.perp + fromBox.perpSize
        : fromBox.perp;
    const toFacePerp =
      fromBox.perp > toBox.perp ? toBox.perp + toBox.perpSize : toBox.perp;

    // точки в координатах flat (frame-relative)
    // main-компонент = центр узла по решаемой оси (= fromMain ≈ toMain)
    // perp-компонент = грань owner'а
    const toPoint = (
      facePerp: number,
      mainCenter: number,
    ): { x: number; y: number } =>
      av ? { x: facePerp, y: mainCenter } : { x: mainCenter, y: facePerp };

    portHints.set(`${e.from}>${e.to}`, {
      source: toPoint(fromFacePerp, fromMain),
      target: toPoint(toFacePerp, toMain),
    });
  }

  return { portHints };
}
