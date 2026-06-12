import { describe, expect, it } from "bun:test";
import { solve1D } from "./layout-solver";
import type {
  AlignmentGoal,
  SeparationConstraint,
  SolverVar,
} from "./layout-solver";

const v = (id: string, pos: number, size = 62, extra?: Partial<SolverVar>) =>
  ({ id, pos, size, ...extra }) as SolverVar;

describe("solve1D — проекция (constraints, без goals)", () => {
  it("ничего не двигает, если ограничения выполнены", () => {
    const r = solve1D(
      [v("a", 0), v("b", 200)],
      [{ left: "a", right: "b", gap: 108 }],
      [],
    );
    expect(r.a).toBeCloseTo(0, 4);
    expect(r.b).toBeCloseTo(200, 4);
  });

  it("раздвигает нарушенную пару с минимальным суммарным смещением (блок)", () => {
    // желаемые позиции совпадают → блок, центр сохраняется: a=-54, b=+54
    const r = solve1D(
      [v("a", 0), v("b", 0)],
      [{ left: "a", right: "b", gap: 108 }],
      [],
    );
    expect(r.b - r.a).toBeCloseTo(108, 4);
    expect((r.a + r.b) / 2).toBeCloseTo(0, 4);
  });

  it("цепочка из трёх — PAV-поведение (общий блок вокруг среднего)", () => {
    const r = solve1D(
      [v("a", 100), v("b", 100), v("c", 100)],
      [
        { left: "a", right: "b", gap: 100 },
        { left: "b", right: "c", gap: 100 },
      ],
      [],
    );
    expect(r.b - r.a).toBeCloseTo(100, 4);
    expect(r.c - r.b).toBeCloseTo(100, 4);
    expect(r.b).toBeCloseTo(100, 4); // центр блока = средневзвешенное желаний
  });

  it("fixed-переменная не двигается, движется сосед", () => {
    const r = solve1D(
      [v("a", 0, 62, { fixed: true }), v("b", 0)],
      [{ left: "a", right: "b", gap: 108 }],
      [],
    );
    expect(r.a).toBeCloseTo(0, 2);
    expect(r.b).toBeGreaterThanOrEqual(108 - 0.01);
  });
});

describe("solve1D — goals (выравнивание)", () => {
  it("пара без конфликтов сливается в одну координату", () => {
    const r = solve1D([v("a", 0), v("b", 100)], [], [{ a: "a", b: "b" }]);
    expect(Math.abs(r.a - r.b)).toBeLessThan(0.5);
  });

  it("взаимная пара (погоня A3⇄E2): обе садятся на общую координату с учётом floor-ограничения", () => {
    // a заперт снизу ограничением floor→a (gap 260): партнёр обязан подняться к нему
    const r = solve1D(
      [v("floor", 0, 62, { fixed: true }), v("a", 260), v("b", 100)],
      [{ left: "floor", right: "a", gap: 260 }],
      [{ a: "a", b: "b" }],
    );
    expect(r.a).toBeGreaterThanOrEqual(260 - 0.01);
    expect(Math.abs(r.a - r.b)).toBeLessThan(0.5);
  });

  it("goal с offset: pos(a)+offA == pos(b)+offB", () => {
    const r = solve1D(
      [v("box", 0), v("n", 500)],
      [],
      [{ a: "box", b: "n", offsetA: 75 }], // желание: box+75 === n
    );
    expect(Math.abs(r.box + 75 - r.n)).toBeLessThan(0.5);
  });

  it("эталонная топология: три линии при separation внутри колонок", () => {
    // колонки-цепочки C1 (a1<a2<a3) и C4 (e1<e2), цели: a1–e1 (верх) и a3–e2;
    // у C4 две строки против трёх у C1 → e2 обязан «оторваться» от e1 вниз
    const vars = [
      v("a1", 75),
      v("a2", 183),
      v("a3", 291),
      v("e1", 100),
      v("e2", 208),
    ];
    const cons: SeparationConstraint[] = [
      { left: "a1", right: "a2", gap: 108 },
      { left: "a2", right: "a3", gap: 108 },
      { left: "e1", right: "e2", gap: 108 },
    ];
    const goals: AlignmentGoal[] = [
      { a: "a1", b: "e1" },
      { a: "a3", b: "e2" },
    ];
    const r = solve1D(vars, cons, goals);
    expect(Math.abs(r.a1 - r.e1)).toBeLessThan(0.5);
    expect(Math.abs(r.a3 - r.e2)).toBeLessThan(0.5);
    expect(r.e2 - r.e1).toBeGreaterThanOrEqual(108 - 0.01); // C4 «растянулся»
  });
});

describe("solve1D — детерминизм и устойчивость", () => {
  it("перестановка входа не меняет результат", () => {
    const vars = [v("a", 10), v("b", 40), v("c", 70)];
    const cons: SeparationConstraint[] = [
      { left: "a", right: "b", gap: 100 },
      { left: "b", right: "c", gap: 100 },
    ];
    const goals: AlignmentGoal[] = [{ a: "a", b: "c" }];
    const r1 = solve1D(vars, cons, goals);
    const r2 = solve1D(
      [...vars].reverse(),
      [...cons].reverse(),
      [...goals].reverse(),
    );
    for (const id of ["a", "b", "c"]) {
      expect(
        Math.abs((r1[id] ?? Number.NaN) - (r2[id] ?? Number.NaN)),
      ).toBeLessThan(1e-6);
    }
  });

  it("цикл в constraints не зацикливает и не роняет (вырожденный случай)", () => {
    const r = solve1D(
      [v("a", 0), v("b", 50)],
      [
        { left: "a", right: "b", gap: 100 },
        { left: "b", right: "a", gap: 100 },
      ],
      [],
    );
    expect(Number.isFinite(r.a)).toBe(true);
    expect(Number.isFinite(r.b)).toBe(true);
  });

  it("ссылки на неизвестные id игнорируются", () => {
    const r = solve1D(
      [v("a", 0)],
      [{ left: "a", right: "ghost", gap: 10 }],
      [{ a: "a", b: "ghost" }],
    );
    expect(r.a).toBeCloseTo(0, 4);
  });
});

describe("solve1D — интерфейс DRW-242 (overlap removal)", () => {
  it("снимает перекрытия минимальным смещением без goals", () => {
    // три бокса h=100 в одной точке; constraints из пересечения интервалов
    const vars = [v("a", 0, 100), v("b", 10, 100), v("c", 20, 100)];
    const cons: SeparationConstraint[] = [
      { left: "a", right: "b", gap: 100 },
      { left: "b", right: "c", gap: 100 },
      { left: "a", right: "c", gap: 200 },
    ];
    const r = solve1D(vars, cons, []);
    expect(r.b - r.a).toBeGreaterThanOrEqual(100 - 0.01);
    expect(r.c - r.b).toBeGreaterThanOrEqual(100 - 0.01);
    // центр масс сохранён (минимальное суммарное смещение)
    expect((r.a + r.b + r.c) / 3).toBeCloseTo(10, 1);
  });
});

describe("solve1D — транзитивные цепочки goals", () => {
  it("узел с двумя партнёрами не залипает на своей позиции (цепочка тянется к якорю)", () => {
    // m имеет двух партнёров (anchor и n); n совпадает с own-позицией m —
    // медиана с включённой own-позицией навечно выбирала own (залипание)
    const r = solve1D(
      [v("anchor", 0, 62, { fixed: true }), v("m", 100), v("n", 100)],
      [],
      [
        { a: "anchor", b: "m" },
        { a: "m", b: "n" },
      ],
    );
    expect(Math.abs(r.m ?? Number.NaN)).toBeLessThan(0.5);
    expect(Math.abs(r.n ?? Number.NaN)).toBeLessThan(0.5);
  });

  it("сквозная цепочка из четырёх узлов сходится в одну линию", () => {
    const r = solve1D(
      [v("a", 231, 62, { fixed: true }), v("b", 231), v("c", 246), v("d", 246)],
      [],
      [
        { a: "a", b: "b" },
        { a: "b", b: "c" },
        { a: "c", b: "d" },
      ],
    );
    for (const id of ["b", "c", "d"]) {
      expect(Math.abs((r[id] ?? Number.NaN) - 231)).toBeLessThan(0.5);
    }
  });
});
