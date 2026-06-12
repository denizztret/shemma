import { describe, expect, it } from "bun:test";
import { globalAlign, orderColumn, runGlobalAlignPass } from "./global-align";

// Эталонная топология drw-218-stability (etalon2-chain-topline):
// C1{A1→A2, A3} C2{B1,B2} C3{D1, D2→D3} C4{E1,E2};
// cross: A1→B1→D1→E1 (цепочка), A2→B2→D2, A3→E2.
// Вход — порядок/позиции как у текущего движка (zigzag-скрин):
// C2=[B2,B1], C3=[D2,D3,D1] — цепочка зигзагом.
const H = 62;
const GAP = 46;
const PITCH = H + GAP;
const row = (i: number): number => 44 + i * PITCH;

function etalonInput() {
  return {
    columns: {
      C1: [
        { id: "A1", y: row(0), h: H },
        { id: "A2", y: row(1), h: H },
        { id: "A3", y: row(2), h: H },
      ],
      C2: [
        { id: "B2", y: row(0), h: H },
        { id: "B1", y: row(1), h: H },
      ],
      C3: [
        { id: "D2", y: row(0), h: H },
        { id: "D3", y: row(1), h: H },
        { id: "D1", y: row(2), h: H },
      ],
      C4: [
        { id: "E1", y: row(0), h: H },
        { id: "E2", y: row(1), h: H },
      ],
    },
    columnY: { C1: 0, C2: 110, C3: 60, C4: 80 },
    columnX: { C1: 0, C2: 300, C3: 600, C4: 900 },
    columnSpanX: {
      C1: [0, 96],
      C2: [300, 396],
      C3: [600, 696],
      C4: [900, 996],
    },
    loose: [],
    internalEdges: [
      { from: "A1", to: "A2" },
      { from: "D2", to: "D3" },
    ],
    crossEdges: [
      { from: "A1", to: "B1" },
      { from: "A2", to: "B2" },
      { from: "B1", to: "D1" },
      { from: "B2", to: "D2" },
      { from: "D1", to: "E1" },
      { from: "A3", to: "E2" },
    ],
    rowGap: GAP,
    padTop: 44,
    padBottom: 16,
  };
}

describe("orderColumn", () => {
  it("orders by external score when there is no internal topo", () => {
    expect(
      orderColumn(
        [
          { id: "B2", score: 200 },
          { id: "B1", score: 100 },
        ],
        [],
      ),
    ).toEqual(["B1", "B2"]);
  });

  it("internal topo wins over score", () => {
    expect(
      orderColumn(
        [
          { id: "A1", score: 300 },
          { id: "A2", score: 100 },
        ],
        [{ from: "A1", to: "A2" }],
      ),
    ).toEqual(["A1", "A2"]);
  });

  it("keeps the input order when internal edges form a cycle", () => {
    expect(
      orderColumn(
        [
          { id: "x", score: 2 },
          { id: "y", score: 1 },
        ],
        [
          { from: "x", to: "y" },
          { from: "y", to: "x" },
        ],
      ),
    ).toEqual(["x", "y"]);
  });

  it("slots a free node between topo-ordered ones by score", () => {
    expect(
      orderColumn(
        [
          { id: "D2", score: 150 },
          { id: "D3", score: 260 },
          { id: "D1", score: 75 },
        ],
        [{ from: "D2", to: "D3" }],
      ),
    ).toEqual(["D1", "D2", "D3"]);
  });
});

describe("globalAlign — эталон etalon2-chain-topline", () => {
  const res = globalAlign(etalonInput());
  const at = (m: Record<string, number>, id: string): number =>
    m[id] ?? Number.NaN;
  const boxOf = (
    m: Record<string, { y: number; h: number }>,
    id: string,
  ): { y: number; h: number } => m[id] ?? { y: Number.NaN, h: Number.NaN };
  const cy = (id: string): number => at(res.absY, id) + H / 2;

  it("восстанавливает порядок строк идеала во всех колонках", () => {
    expect(res.order.C1).toEqual(["A1", "A2", "A3"]);
    expect(res.order.C2).toEqual(["B1", "B2"]);
    expect(res.order.C3).toEqual(["D1", "D2", "D3"]);
    expect(res.order.C4).toEqual(["E1", "E2"]);
  });

  it("цепочка A1→B1→D1→E1 — строго одна горизонталь", () => {
    const cys = ["A1", "B1", "D1", "E1"].map(cy);
    expect(Math.max(...cys) - Math.min(...cys)).toBeLessThan(0.5);
  });

  it("ряд A2→B2→D2 — строго одна горизонталь", () => {
    const cys = ["A2", "B2", "D2"].map(cy);
    expect(Math.max(...cys) - Math.min(...cys)).toBeLessThan(0.5);
  });

  it("диагональ A3→E2 становится горизонталью (C4 растягивается)", () => {
    expect(Math.abs(cy("A3") - cy("E2"))).toBeLessThan(0.5);
    // E2 ушёл вниз → бокс C4 вырос против исходных двух строк
    expect(boxOf(res.columnBox, "C4").h).toBeGreaterThan(44 + 2 * H + GAP + 16);
  });

  it("обтяжка: бокс колонки покрывает строки с padding", () => {
    for (const [cid, kids] of Object.entries(res.order)) {
      const box = boxOf(res.columnBox, cid);
      for (const id of kids) {
        expect(at(res.absY, id)).toBeGreaterThanOrEqual(box.y + 44 - 0.01);
        expect(at(res.absY, id) + H).toBeLessThanOrEqual(
          box.y + box.h - 16 + 0.01,
        );
      }
    }
  });

  it("зазор строк внутри колонки не нарушен", () => {
    for (const kids of Object.values(res.order)) {
      for (let i = 1; i < kids.length; i++) {
        const gap =
          at(res.absY, kids[i] ?? "") - (at(res.absY, kids[i - 1] ?? "") + H);
        expect(gap).toBeGreaterThanOrEqual(GAP - 0.01);
      }
    }
  });

  it("идемпотентность: повторный пасс от результата ничего не двигает", () => {
    const first = globalAlign(etalonInput());
    const again = globalAlign({
      ...etalonInput(),
      columns: Object.fromEntries(
        Object.entries(first.order).map(([cid, kids]) => [
          cid,
          kids.map((id) => ({
            id,
            y: (first.absY[id] ?? 0) - (first.columnBox[cid]?.y ?? 0),
            h: H,
          })),
        ]),
      ),
      columnY: Object.fromEntries(
        Object.entries(first.columnBox).map(([cid, b]) => [cid, b.y]),
      ),
      columnSpanX: etalonInput().columnSpanX,
    });
    for (const [id, v] of Object.entries(first.absY)) {
      expect(Math.abs((again.absY[id] ?? Number.NaN) - v)).toBeLessThan(0.5);
    }
  });

  it("loose-узлы участвуют в выравнивании (цепочка X в линию)", () => {
    const r = globalAlign({
      columns: {},
      columnY: {},
      columnX: {},
      columnSpanX: {},
      loose: [
        { id: "X1", y: 0, h: H, x: 0, w: 62 },
        { id: "X2", y: 40, h: H, x: 300, w: 62 },
        { id: "X3", y: 80, h: H, x: 600, w: 62 },
      ],
      internalEdges: [],
      crossEdges: [
        { from: "X1", to: "X2" },
        { from: "X2", to: "X3" },
      ],
      rowGap: GAP,
      padTop: 44,
      padBottom: 16,
    });
    const cys = ["X1", "X2", "X3"].map(
      (id) => (r.absY[id] ?? Number.NaN) + H / 2,
    );
    expect(Math.max(...cys) - Math.min(...cys)).toBeLessThan(0.5);
  });
});

describe("globalAlign — top-level separation", () => {
  it("выравнивание не вносит перекрытий между loose-узлами с пересечением по x", () => {
    // n1 и n2 в одном x-интервале; цели тянут обоих к одной координате
    const r = globalAlign({
      columns: {
        L: [
          { id: "s1", y: 44, h: 62 },
          { id: "s2", y: 152, h: 62 },
        ],
      },
      columnY: { L: 0 },
      columnX: { L: 0 },
      columnSpanX: { L: [0, 96] },
      loose: [
        { id: "n1", y: 40, h: 62, x: 300, w: 62 },
        { id: "n2", y: 160, h: 62, x: 310, w: 62 },
      ],
      internalEdges: [],
      crossEdges: [
        { from: "s1", to: "n1" },
        { from: "s1", to: "n2" }, // оба тянутся к строке s1
      ],
      rowGap: 46,
      padTop: 44,
      padBottom: 16,
    });
    const top = Math.min(r.absY.n1 ?? 0, r.absY.n2 ?? 0);
    const bot = Math.max(r.absY.n1 ?? 0, r.absY.n2 ?? 0);
    expect(bot - top).toBeGreaterThanOrEqual(62 + 46 - 0.01); // не слиплись
  });

  it("loose-узлы БЕЗ пересечения по x могут встать на одну линию", () => {
    const r = globalAlign({
      columns: {},
      columnY: {},
      columnX: {},
      columnSpanX: {},
      loose: [
        { id: "n1", y: 0, h: 62, x: 0, w: 62 },
        { id: "n2", y: 200, h: 62, x: 400, w: 62 },
      ],
      internalEdges: [],
      crossEdges: [{ from: "n1", to: "n2" }],
      rowGap: 46,
      padTop: 44,
      padBottom: 16,
    });
    expect(Math.abs((r.absY.n1 ?? 0) - (r.absY.n2 ?? 0))).toBeLessThan(0.5);
  });

  it("непартиципирующий top-level бокс не перекрывается растущей колонкой (passive)", () => {
    const r = globalAlign({
      columns: {
        C: [
          { id: "k1", y: 44, h: 62 },
          { id: "k2", y: 152, h: 62 },
        ],
      },
      columnY: { C: 0 },
      columnX: { C: 0 },
      columnSpanX: { C: [0, 96] },
      loose: [],
      passive: [{ id: "P", y: 300, h: 100, x: 10, w: 80 }], // под колонкой, x пересекается
      internalEdges: [],
      crossEdges: [],
      rowGap: 46,
      padTop: 44,
      padBottom: 16,
    });
    // P получил separation от низа колонки: если колонка не росла — P не двигается
    expect(r.absY.P ?? 0).toBeGreaterThanOrEqual(300 - 0.01);
  });
});

describe("globalAlign — пины", () => {
  it("pinned-узел не двигается, партнёр выравнивается к нему", () => {
    const r = globalAlign({
      columns: {},
      columnY: {},
      columnX: {},
      columnSpanX: {},
      loose: [
        { id: "p", y: 500, h: 62, x: 0, w: 62 },
        { id: "m", y: 100, h: 62, x: 400, w: 62 },
      ],
      pinned: new Set(["p"]),
      internalEdges: [],
      crossEdges: [{ from: "p", to: "m" }],
      rowGap: 46,
      padTop: 44,
      padBottom: 16,
    });
    expect(Math.abs((r.absY.p ?? 0) - 500)).toBeLessThan(0.5);
    expect(Math.abs((r.absY.m ?? 0) - 500)).toBeLessThan(0.5);
  });

  it("колонка с pinned-ребёнком не переупорядочивается", () => {
    const r = globalAlign({
      columns: {
        C: [
          { id: "a", y: 44, h: 62 },
          { id: "b", y: 152, h: 62 },
        ],
      },
      columnY: { C: 0 },
      columnX: { C: 0 },
      columnSpanX: { C: [0, 96] },
      loose: [{ id: "ext", y: 40, h: 62, x: 300, w: 62 }],
      pinned: new Set(["b"]),
      internalEdges: [],
      crossEdges: [{ from: "b", to: "ext" }], // score тянет b наверх
      rowGap: 46,
      padTop: 44,
      padBottom: 16,
    });
    expect(r.order.C).toEqual(["a", "b"]); // порядок не изменился
  });
});

describe("globalAlign — componentOf (I1-регрессия)", () => {
  /**
   * Топология:
   *   Компонента 0: колонка C (x=[200,296]) с k1, k2 + loose L (x=[200,262]).
   *   Cross-ребро k1→L: выравнивание тянет k1 вниз (L стоит ниже k1).
   *   Компонента 1: X1 (y=50) и X2 (y=200) на x=[210,272] — пересекаются с C по x.
   *   Без componentOf: solver создаёт top-level separation между компонентой 0
   *   и X1/X2 → X1 сдвигается вниз, внутренняя разность (X2-X1) меняется.
   *   С componentOf: constraints не пересекают границы — X1/X2 не трогаются.
   */
  it("рост компоненты 0 не искажает внутренние разности компоненты 1", () => {
    const H2 = 62;
    const GAP2 = 46;

    // k2 ниже k1, L = loose ещё ниже k2; cross-ребро k1→L тянет k1 ВНИЗ
    // → колонка растягивается; без фикса бокс C толкает X1 (пересечение по x)
    const input = {
      columns: {
        C: [
          { id: "k1", y: 44, h: H2 }, // abs y = 44 (columnY[C]=0)
          { id: "k2", y: 152, h: H2 }, // abs y = 152
        ],
      },
      columnY: { C: 0 },
      columnX: { C: 200 },
      columnSpanX: { C: [200, 296] as [number, number] },
      loose: [
        { id: "L", y: 400, h: H2, x: 200, w: 62 }, // тянет k1 далеко вниз
      ],
      passive: [] as Array<{
        id: string;
        y: number;
        h: number;
        x: number;
        w: number;
      }>,
      internalEdges: [],
      crossEdges: [{ from: "k1", to: "L" }],
      rowGap: GAP2,
      padTop: 44,
      padBottom: 16,
      // компонента 0: C, k1, k2, L; компонента 1: X1, X2
      componentOf: {
        C: 0,
        k1: 0,
        k2: 0,
        L: 0,
        X1: 1,
        X2: 1,
      } as Record<string, number>,
    };

    // X1 и X2 — они НЕ участвуют в cross-рёбрах, поэтому не попадают в loose/columns.
    // Чтобы проверить I1, добавим X1/X2 как passive (движутся через top-level separation).
    const inputWithPassive = {
      ...input,
      passive: [
        { id: "X1", y: 50, h: H2, x: 210, w: 62 },
        { id: "X2", y: 200, h: H2, x: 210, w: 62 },
      ],
    };

    const diffBefore = 200 - 50; // X2.y - X1.y = 150

    const res = globalAlign(inputWithPassive);

    const x1After = res.absY.X1 ?? Number.NaN;
    const x2After = res.absY.X2 ?? Number.NaN;
    const diffAfter = x2After - x1After;

    // С фиксом: X1 и X2 не получают constraints от компоненты 0 →
    // их внутренняя разность не изменяется.
    expect(Math.abs(diffAfter - diffBefore)).toBeLessThan(0.5);
  });
});

describe("runGlobalAlignPass — re-pack компонент", () => {
  /**
   * Две компоненты в flat (полные боксы по оси Y).
   * Компонента 0: колонка C0 с одним ребёнком k0 + loose L0.
   *   Cross-ребро k0→L0 расположен далеко ниже → выравнивание растягивает C0.
   * Компонента 1: колонка C1 с одним ребёнком k1 (ниже C0).
   * Ожидаем: после globalAlignPass вся компонента 1 сдвинулась ЦЕЛИКОМ
   * (равный сдвиг C1 и k1), зазор между нижним краем C0-бокса и верхним C1 = compGap,
   * внутренние разности k1 внутри C1 сохранены.
   */
  it("рост первой компоненты сдвигает вторую целиком с зазором compGap", () => {
    const H3 = 62;
    const PAD_TOP = 44;
    const PAD_BOT = 16;
    const ROW_GAP = 46;
    const COMP_GAP = 100;

    // C0: y=0, h=200 (содержит k0 на y=44 rel); L0 на абс y=800 (далеко ниже)
    // → выравнивание k0 и L0 растянет C0 до ~800+H3/2
    // C1: y=300, h=150 (содержит k1 на y=PAD_TOP rel); стоит после C0

    const flat: Record<
      string,
      { x: number; y: number; w?: number; h?: number }
    > = {
      C0: { x: 0, y: 0, w: 96, h: 200 },
      k0: { x: 16, y: PAD_TOP, w: 62, h: H3 }, // rel
      L0: { x: 200, y: 800, w: 62, h: H3 }, // loose, abs y
      C1: { x: 0, y: 300, w: 96, h: 150 },
      k1: { x: 16, y: PAD_TOP, w: 62, h: H3 }, // rel
    };

    runGlobalAlignPass({
      flat,
      columns: [
        { id: "C0", kidIds: ["k0"] },
        { id: "C1", kidIds: ["k1"] },
      ],
      looseIds: ["L0"],
      nodeEdges: [{ from: "k0", to: "L0" }],
      // components содержат только top-level ids (колонки и loose, не детей)
      components: [["C0", "L0"], ["C1"]],
      rowGap: ROW_GAP,
      compGap: COMP_GAP,
      padTop: PAD_TOP,
      padBottom: PAD_BOT,
    });

    // C0 растянулся (k0 выровнялся с L0)
    const c0Bottom = (flat.C0?.y ?? 0) + (flat.C0?.h ?? 0);
    const c1Top = flat.C1?.y ?? 0;

    // зазор между компонентами = compGap
    expect(Math.abs(c1Top - c0Bottom - COMP_GAP)).toBeLessThan(1);

    // внутри C1: k1 стоит на PAD_TOP относительно C1
    const k1RelY = flat.k1?.y ?? 0;
    expect(Math.abs(k1RelY - PAD_TOP)).toBeLessThan(0.5);
  });
});

describe("runGlobalAlignPass — TB/BT-симметрия (axisVertical=false)", () => {
  /**
   * Два горизонтальных лейна (TB-доска: решаем x, перпендикуляр = y).
   * Lane0: y=0, h=96 — 1 ребёнок n0.
   * Lane1: y=200, h=96 — 1 ребёнок n1.
   * Cross-ребро n0→n1: должен выровнять центры по x (|Δcx| < 0.5).
   * Боксы лейнов должны обтянуться по x/w.
   */
  it("cross-ребро выравнивается по X, боксы лейнов обтянуты", () => {
    const H4 = 62;
    const PAD_TOP = 44;
    const PAD_BOT = 16;

    // axisVertical=false: main=x, size=w; perp=y, perpSize=h
    // Лейны: x=0, w=200 (начальная ширина). Дети — координаты rel по X.
    // n0: x=PAD_TOP(=44) rel, w=H4; n1: x=150 rel, w=H4 (разные X → выравнивание нужно)
    const flat: Record<
      string,
      { x: number; y: number; w?: number; h?: number }
    > = {
      Lane0: { x: 0, y: 0, w: 200, h: 96 },
      Lane1: { x: 0, y: 200, w: 200, h: 96 },
      n0: { x: PAD_TOP, y: 16, w: H4, h: 62 }, // rel в Lane0
      n1: { x: 150, y: 16, w: H4, h: 62 }, // rel в Lane1 (150 ≠ PAD_TOP)
    };

    runGlobalAlignPass({
      flat,
      columns: [
        { id: "Lane0", kidIds: ["n0"] },
        { id: "Lane1", kidIds: ["n1"] },
      ],
      looseIds: [],
      nodeEdges: [{ from: "n0", to: "n1" }],
      components: [["Lane0", "Lane1"]],
      rowGap: 46,
      compGap: 100,
      padTop: PAD_TOP,
      padBottom: PAD_BOT,
      axisVertical: false,
    });

    // n0 и n1 выровнялись по x (main-ось)
    const cx0 = (flat.Lane0?.x ?? 0) + (flat.n0?.x ?? 0) + H4 / 2;
    const cx1 = (flat.Lane1?.x ?? 0) + (flat.n1?.x ?? 0) + H4 / 2;
    expect(Math.abs(cx0 - cx1)).toBeLessThan(0.5);

    // Боксы лейнов обтянуты по x/w (колонка охватывает дочерние узлы + padding)
    for (const laneId of ["Lane0", "Lane1"]) {
      const lane = flat[laneId];
      const kid = flat[laneId === "Lane0" ? "n0" : "n1"];
      if (!lane || !kid) continue;
      // kid.x (rel) >= PAD_TOP (padTop по оси x), kid.x + H4 <= lane.w - PAD_BOT
      expect(kid.x ?? 0).toBeGreaterThanOrEqual(PAD_TOP - 0.1);
      expect((kid.x ?? 0) + H4).toBeLessThanOrEqual(
        (lane.w ?? 0) - PAD_BOT + 0.1,
      );
    }
  });
});

describe("runGlobalAlignPass — invertColumnOrder", () => {
  /**
   * Проверяем, что флаг invertColumnOrder меняет порядок обхода колонок
   * в ordering-свипе. Берём асимметричную топологию:
   *   C1 (x=0): k1 (score=100, нет internal edges)
   *   C2 (x=300): k2a (y=44) и k2b (y=152); cross-ребро k1→k2a (score k2a=~cy(k1))
   * При normal order (C1 → C2): C1 settled first; k2a получает score от k1, встаёт первой.
   * При invertColumnOrder=true: порядок свипа инвертирован (columnX*=-1 → C2 settled first).
   * В нашей простой топологии достаточно убедиться, что k2a и k2b стоят в правильном
   * порядке в обоих случаях (cross-ребро к k2a должно работать).
   * Дополнительно: проверяем через два разных columnX-набора вместо флага:
   * НЕТ — тестируем именно флаг invertColumnOrder через runGlobalAlignPass.
   */
  it("invertColumnOrder инвертирует направление первого свипа", () => {
    const H5 = 62;
    const PAD_TOP = 44;
    const PAD_BOT = 16;

    // Топология: C1 (x=0) — k1; C2 (x=300) — k2a, k2b (исходный порядок: k2b выше k2a).
    // cross: k1→k2a. При normal order: directional sweep C1→C2; k2a получает score от k1
    // и встаёт первой в C2 (выше k2b).
    // При invertColumnOrder=true: directional sweep C2→C1; k2a не имеет settled-соседей
    // в первом свипе (k1 ещё не settled) → score = текущий cy → k2b (y=44) < k2a (y=152)
    // → k2b первый (порядок иной).
    const makeFlat = () => ({
      C1: { x: 0, y: 0, w: 96, h: 300 },
      C2: { x: 300, y: 0, w: 96, h: 300 },
      k1: { x: 16, y: PAD_TOP, w: 62, h: H5 }, // rel C1
      k2a: { x: 16, y: 152, w: 62, h: H5 }, // rel C2, y=152 (ниже)
      k2b: { x: 16, y: PAD_TOP, w: 62, h: H5 }, // rel C2, y=44 (выше)
    });

    const flatNormal = makeFlat();
    runGlobalAlignPass({
      flat: flatNormal,
      columns: [
        { id: "C1", kidIds: ["k1"] },
        { id: "C2", kidIds: ["k2a", "k2b"] },
      ],
      looseIds: [],
      nodeEdges: [{ from: "k1", to: "k2a" }],
      components: [["C1", "C2"]],
      rowGap: 46,
      compGap: 100,
      padTop: PAD_TOP,
      padBottom: PAD_BOT,
    });

    const flatInverted = makeFlat();
    runGlobalAlignPass({
      flat: flatInverted,
      columns: [
        { id: "C1", kidIds: ["k1"] },
        { id: "C2", kidIds: ["k2a", "k2b"] },
      ],
      looseIds: [],
      nodeEdges: [{ from: "k1", to: "k2a" }],
      components: [["C1", "C2"]],
      rowGap: 46,
      compGap: 100,
      padTop: PAD_TOP,
      padBottom: PAD_BOT,
      invertColumnOrder: true,
    });

    // Normal: k2a связан с k1 (settled), score(k2a)=cy(k1) < cy(k2b в исх.)
    // → k2a первым (меньший y в C2 + C2.y)
    const k2aYNormal = (flatNormal.C2?.y ?? 0) + (flatNormal.k2a?.y ?? 0);
    const k2bYNormal = (flatNormal.C2?.y ?? 0) + (flatNormal.k2b?.y ?? 0);

    // Inverted: C2 обходится первым directionally; k2a не имеет settled-соседей
    // → score по текущему cy → k2b (y=44) < k2a (y=152) → k2b первым
    const k2aYInv = (flatInverted.C2?.y ?? 0) + (flatInverted.k2a?.y ?? 0);
    const k2bYInv = (flatInverted.C2?.y ?? 0) + (flatInverted.k2b?.y ?? 0);

    // Флаг должен менять порядок: в normal k2a < k2b, в inverted k2b < k2a
    expect(k2aYNormal).toBeLessThan(k2bYNormal);
    expect(k2bYInv).toBeLessThan(k2aYInv);
  });
});

describe("runGlobalAlignPass — portHints", () => {
  it("возвращает выровненные рёбра с точками на границах колонок", () => {
    const flat = {
      C1: { x: 0, y: 0, w: 96, h: 260 },
      C2: { x: 300, y: 40, w: 96, h: 260 },
      a: { x: 16, y: 44, w: 62, h: 62 },
      b: { x: 16, y: 44, w: 62, h: 62 },
    };
    const res = runGlobalAlignPass({
      flat,
      columns: [
        { id: "C1", kidIds: ["a"] },
        { id: "C2", kidIds: ["b"] },
      ],
      looseIds: [],
      nodeEdges: [{ from: "a", to: "b" }],
      components: [["C1", "C2"]],
      rowGap: 46,
      compGap: 130,
      padTop: 44,
      padBottom: 16,
    });
    const hint = res.portHints.get("a>b");
    expect(hint).toBeDefined();
    // после выравнивания a и b на одном cy: точки на правой грани C1 и левой C2
    expect(hint?.source.x).toBeCloseTo(96, 1);
    expect(hint?.target.x).toBeCloseTo(300, 1);
    expect(
      Math.abs((hint?.source.y ?? 0) - (hint?.target.y ?? 1)),
    ).toBeLessThan(0.5);
  });
});
