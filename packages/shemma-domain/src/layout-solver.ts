/**
 * solve1D — одномерный решатель «минимальное суммарное смещение при
 * separation-ограничениях» (VPSC, Dwyer/Marriott «Fast node overlap removal»)
 * с целями выравнивания. ОБЩИЙ для DRW-235 (глобальная координация строк)
 * и DRW-242 (2D-пуш / overlap removal). WebCola — референс алгоритма,
 * НЕ зависимость.
 *
 * Модель:
 *  - переменные = центры элементов по решаемой оси;
 *  - constraints: pos(right) − pos(left) ≥ gap (жёсткие);
 *  - goals: желание pos(a)+offsetA === pos(b)+offsetB (мягкие, веса);
 *  - fixed: переменная не двигается (вес BIG_WEIGHT + исходная позиция
 *    как желание).
 *
 * Алгоритм: внешний цикл «desired по goals (взвешенная медиана, включая
 * собственную позицию — гасит взаимную погоню пар) → project». project —
 * классический VPSC-satisfy: блоки с offset'ами, merge по нарушенным
 * ограничениям, позиция блока = взвешенное среднее желаний; конечность —
 * каждый merge уменьшает число блоков. Страховочный feasibility-пасс по
 * топопорядку закрывает вырожденные конфликты путей.
 *
 * Детерминизм: стабильные сортировки по id, Kahn с лексикографическим
 * tie-break, никакого рандома. Рёбра, замыкающие цикл, отбрасываются
 * детерминированно (вырожденный вход — best effort, не исключение).
 */

export interface SolverVar {
  id: string;
  /** стартовая координата ЦЕНТРА по решаемой оси */
  pos: number;
  /** протяжённость по оси — для построителей ограничений; сам решатель не использует */
  size: number;
  /** вес «желания» (остаться на месте / целей); по умолчанию 1 */
  weight?: number;
  /** pinned: позиция фактически не меняется */
  fixed?: boolean;
}

export interface SeparationConstraint {
  left: string;
  right: string;
  /** pos(right) − pos(left) ≥ gap; pos — центры */
  gap: number;
}

export interface AlignmentGoal {
  a: string;
  b: string;
  /** желание: pos(a) + offsetA === pos(b) + offsetB (по умолчанию 0) */
  offsetA?: number;
  offsetB?: number;
  weight?: number;
}

const BIG_WEIGHT = 1e9;
const EPS = 1e-6;
const MOVE_EPS = 0.01;
const DEFAULT_ROUNDS = 60;

interface Block {
  vars: string[];
  weight: number; // Σ w_i
  wsum: number; // Σ w_i · (desired_i − offset_i)
  pos: number; // wsum / weight
}

function weightedMedian(items: Array<{ v: number; w: number }>): number {
  const s = [...items].sort((p, q) => p.v - q.v);
  const total = s.reduce((acc, it) => acc + it.w, 0);
  const half = total / 2;
  let acc = 0;
  for (let i = 0; i < s.length; i++) {
    acc += s[i]?.w ?? 0;
    if (acc > half) return s[i]?.v ?? 0;
    if (Math.abs(acc - half) < 1e-12) {
      // граница двух групп — среднее соседних значений
      const cur = s[i]?.v ?? 0;
      const next = s[i + 1]?.v ?? cur;
      return (cur + next) / 2;
    }
  }
  return s[s.length - 1]?.v ?? 0;
}

/** Kahn по constraint-графу; рёбра, замыкающие цикл, отброшены детерминированно. */
function topoOrder(
  ids: ReadonlyArray<string>,
  constraints: ReadonlyArray<SeparationConstraint>,
): { order: string[]; usable: SeparationConstraint[] } {
  const idSet = new Set(ids);
  const sorted = [...constraints]
    .filter(
      (c) => idSet.has(c.left) && idSet.has(c.right) && c.left !== c.right,
    )
    .sort(
      (p, q) => p.left.localeCompare(q.left) || p.right.localeCompare(q.right),
    );
  // отбрасываем рёбра, замыкающие цикл: инкрементальная проверка достижимости
  const adj = new Map<string, string[]>();
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>([from]);
    const stack = [from];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (cur === to) return true;
      for (const nxt of adj.get(cur) ?? []) {
        if (!seen.has(nxt)) {
          seen.add(nxt);
          stack.push(nxt);
        }
      }
    }
    return false;
  };
  const usable: SeparationConstraint[] = [];
  for (const c of sorted) {
    if (reaches(c.right, c.left)) continue; // замкнул бы цикл — отброс
    usable.push(c);
    const existing = adj.get(c.left);
    if (existing !== undefined) {
      existing.push(c.right);
    } else {
      adj.set(c.left, [c.right]);
    }
  }
  // Kahn со стабильным tie-break
  const indeg = new Map<string, number>();
  for (const id of ids) indeg.set(id, 0);
  for (const c of usable) indeg.set(c.right, (indeg.get(c.right) ?? 0) + 1);
  const ready = [...ids].filter((id) => (indeg.get(id) ?? 0) === 0).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift() as string;
    order.push(id);
    for (const nxt of adj.get(id) ?? []) {
      const d = (indeg.get(nxt) ?? 1) - 1;
      indeg.set(nxt, d);
      if (d === 0) {
        ready.push(nxt);
        ready.sort();
      }
    }
  }
  return { order, usable };
}

/** VPSC-satisfy: позиции, удовлетворяющие constraints, минимально удалённые от desired. */
function project(
  order: ReadonlyArray<string>,
  weights: ReadonlyMap<string, number>,
  desired: ReadonlyMap<string, number>,
  constraints: ReadonlyArray<SeparationConstraint>,
): Map<string, number> {
  const parent = new Map<string, string>();
  const offset = new Map<string, number>();
  const blocks = new Map<string, Block>();
  for (const id of order) {
    parent.set(id, id);
    offset.set(id, 0);
    const w = weights.get(id) ?? 1;
    const d = desired.get(id) ?? 0;
    blocks.set(id, { vars: [id], weight: w, wsum: w * d, pos: d });
  }
  const find = (id: string): string => {
    let r = id;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    return r;
  };
  const posOf = (id: string): number => {
    const b = blocks.get(find(id)) as Block;
    return b.pos + (offset.get(id) as number);
  };
  // merge до неподвижной точки; конечность: каждый merge уменьшает число блоков
  for (let guard = 0; guard <= order.length; guard++) {
    let merged = false;
    for (const c of constraints) {
      const rl = find(c.left);
      const rr = find(c.right);
      if (rl === rr) continue;
      if (posOf(c.left) + c.gap <= posOf(c.right) + EPS) continue;
      const bl = blocks.get(rl) as Block;
      const br = blocks.get(rr) as Block;
      const shift =
        (offset.get(c.left) as number) +
        c.gap -
        (offset.get(c.right) as number);
      for (const varId of br.vars) {
        offset.set(varId, (offset.get(varId) as number) + shift);
        parent.set(varId, rl);
        bl.vars.push(varId);
        const w = weights.get(varId) ?? 1;
        bl.weight += w;
        bl.wsum +=
          w * ((desired.get(varId) ?? 0) - (offset.get(varId) as number));
      }
      blocks.delete(rr);
      bl.pos = bl.wsum / bl.weight;
      merged = true;
    }
    if (!merged) break;
  }
  const out = new Map<string, number>();
  for (const id of order) out.set(id, posOf(id));
  // страховочный feasibility-пасс (вырожденные конфликты путей): вперёд по
  // топопорядку, fixed (вес BIG_WEIGHT) не двигаем
  const byLeft = new Map<string, SeparationConstraint[]>();
  for (const c of constraints) {
    const existing = byLeft.get(c.left);
    if (existing !== undefined) {
      existing.push(c);
    } else {
      byLeft.set(c.left, [c]);
    }
  }
  for (const id of order) {
    for (const c of byLeft.get(id) ?? []) {
      const lo = (out.get(c.left) as number) + c.gap;
      const cur = out.get(c.right) as number;
      if (cur < lo - EPS && (weights.get(c.right) ?? 1) < BIG_WEIGHT) {
        out.set(c.right, lo);
      }
    }
  }
  return out;
}

export function solve1D(
  vars: ReadonlyArray<SolverVar>,
  constraints: ReadonlyArray<SeparationConstraint>,
  goals: ReadonlyArray<AlignmentGoal>,
  opts?: { rounds?: number },
): Record<string, number> {
  // нормализация: стабильный порядок по id, отсев ссылок на неизвестные id
  const sortedVars = [...vars].sort((p, q) => p.id.localeCompare(q.id));
  const ids = sortedVars.map((it) => it.id);
  const idSet = new Set(ids);
  const start = new Map<string, number>();
  const weights = new Map<string, number>();
  for (const it of sortedVars) {
    start.set(it.id, it.pos);
    weights.set(it.id, it.fixed === true ? BIG_WEIGHT : (it.weight ?? 1));
  }
  const { order, usable } = topoOrder(ids, constraints);
  const goalList = [...goals]
    .filter((g) => idSet.has(g.a) && idSet.has(g.b) && g.a !== g.b)
    .sort((p, q) => p.a.localeCompare(q.a) || p.b.localeCompare(q.b));
  const partners = new Map<
    string,
    Array<{ other: string; selfOff: number; otherOff: number; w: number }>
  >();
  for (const g of goalList) {
    const w = g.weight ?? 1;
    const offA = g.offsetA ?? 0;
    const offB = g.offsetB ?? 0;
    const listA = partners.get(g.a);
    if (listA !== undefined) {
      listA.push({ other: g.b, selfOff: offA, otherOff: offB, w });
    } else {
      partners.set(g.a, [{ other: g.b, selfOff: offA, otherOff: offB, w }]);
    }
    const listB = partners.get(g.b);
    if (listB !== undefined) {
      listB.push({ other: g.a, selfOff: offB, otherOff: offA, w });
    } else {
      partners.set(g.b, [{ other: g.a, selfOff: offB, otherOff: offA, w }]);
    }
  }

  let x = new Map(start);
  const rounds = opts?.rounds ?? DEFAULT_ROUNDS;
  for (let round = 0; round < rounds; round++) {
    const desired = new Map<string, number>();
    // Гаусс-Зейдель: соседи, уже обработанные в ЭТОМ раунде, читаются из
    // desired — якорь протягивается через цепочку goals за один проход;
    // чередование направления обхода закрывает обе стороны цепочки
    const sweep = round % 2 === 0 ? order : [...order].reverse();
    const cur = (oid: string): number => desired.get(oid) ?? x.get(oid) ?? 0;
    for (const id of sweep) {
      const w = weights.get(id) ?? 1;
      if (w >= BIG_WEIGHT) {
        desired.set(id, start.get(id) ?? 0); // fixed: желание = исходная позиция
        continue;
      }
      const ps = partners.get(id);
      if (ps === undefined || ps.length === 0) {
        desired.set(id, x.get(id) ?? 0); // без целей — остаться на месте
        continue;
      }
      // целевая позиция из каждой цели: pos(other)+otherOff−selfOff.
      // Собственная позиция добавляется ТОЛЬКО при единственном партнёре —
      // гасит взаимную погоню пар. При ≥2 партнёрах включать её нельзя:
      // когда один партнёр уже совпал с собственной позицией, медиана из
      // [чужой, партнёр==own, own] вечно выбирает own — узел залипает и
      // цепочка распадается на выровненные пары (live-находка Task 8).
      const items = ps.map((p) => ({
        v: cur(p.other) + p.otherOff - p.selfOff,
        w: p.w,
      }));
      if (items.length === 1) items.push({ v: x.get(id) ?? 0, w });
      desired.set(id, weightedMedian(items));
    }
    const next = project(order, weights, desired, usable);
    let moved = 0;
    for (const id of order) {
      moved = Math.max(moved, Math.abs((next.get(id) ?? 0) - (x.get(id) ?? 0)));
    }
    x = next;
    if (moved < MOVE_EPS) break;
  }
  const out: Record<string, number> = {};
  for (const id of order) out[id] = x.get(id) ?? 0;
  return out;
}
