import { describe, expect, test } from "bun:test";
import {
  type FlowNode,
  type Overlap1DItem,
  flowAxis,
  growOnlyBox,
  resolveOverlaps1D,
  resolveOverlapsAlongFlow,
} from "./resolve-overlaps";

const item = (
  id: string,
  start: number,
  size: number,
  pinned = false,
): Overlap1DItem => ({ id, start, size, pinned });

describe("resolveOverlaps1D — точечный 1D push вперёд", () => {
  test("непересекающиеся узлы не двигаются", () => {
    const r = resolveOverlaps1D([item("a", 0, 60), item("b", 100, 60)], 24);
    expect(r).toEqual([]);
  });

  test("наезжающий сосед сдвигается ровно до min-зазора", () => {
    // a[0,90] (вырос), b[70,170] наезжает → b.left должен стать 90+24=114
    const r = resolveOverlaps1D([item("a", 0, 90), item("b", 70, 100)], 24);
    expect(r).toEqual([{ id: "b", start: 114 }]);
  });

  test("сдвигается ТОЛЬКО наезжающий; выросший узел остаётся на месте", () => {
    const r = resolveOverlaps1D([item("a", 0, 90), item("b", 70, 100)], 24);
    expect(r.find((m) => m.id === "a")).toBeUndefined();
  });

  test("каскад: сдвиг распространяется на последующих, каждый минимально", () => {
    // a[0,160] вырос; b[110,210], c[230,330]
    const r = resolveOverlaps1D(
      [item("a", 0, 160), item("b", 110, 100), item("c", 230, 100)],
      24,
    );
    expect(r).toEqual([
      { id: "b", start: 184 },
      { id: "c", start: 308 },
    ]);
  });

  test("порядок сохранён и зазор ≥ gap после сдвига", () => {
    const items = [item("a", 0, 160), item("b", 110, 100), item("c", 230, 100)];
    const moved = new Map(
      resolveOverlaps1D(items, 24).map((m) => [m.id, m.start]),
    );
    const finalStart = (id: string, orig: number) => moved.get(id) ?? orig;
    const aEnd = finalStart("a", 0) + 160;
    const bStart = finalStart("b", 110);
    const bEnd = bStart + 100;
    const cStart = finalStart("c", 230);
    expect(bStart - aEnd).toBeGreaterThanOrEqual(24);
    expect(cStart - bEnd).toBeGreaterThanOrEqual(24);
    expect(aEnd).toBeLessThan(bStart); // порядок a→b→c сохранён
    expect(bEnd).toBeLessThan(cStart);
  });

  test("pinned-узел не двигается, но последующие его обходят", () => {
    // a[0,90] вырос (наедет на p, но a не двигаем); p закреплён [70,130]; b[100,160]
    const r = resolveOverlaps1D(
      [item("a", 0, 90), item("p", 70, 60, true), item("b", 100, 60)],
      24,
    );
    expect(r.find((m) => m.id === "p")).toBeUndefined(); // p не двинут
    expect(r.find((m) => m.id === "a")).toBeUndefined(); // выросший не двинут
    // b обходит закреплённый p: p.right=130 → b.left=130+24=154
    expect(r.find((m) => m.id === "b")).toEqual({ id: "b", start: 154 });
  });
});

describe("flowAxis — ось потока из направления", () => {
  const empty: FlowNode[] = [];
  test("cardinal направления задают ось и сторону", () => {
    expect(flowAxis("LR", empty)).toEqual({ axis: "x", reverse: false });
    expect(flowAxis("RL", empty)).toEqual({ axis: "x", reverse: true });
    expect(flowAxis("TB", empty)).toEqual({ axis: "y", reverse: false });
    expect(flowAxis("BT", empty)).toEqual({ axis: "y", reverse: true });
  });

  test("не-cardinal: ось из геометрии (бо́льший разброс центров)", () => {
    const horizontalRow: FlowNode[] = [
      { id: "a", x: 0, y: 0, w: 50, h: 50, pinned: false },
      { id: "b", x: 200, y: 0, w: 50, h: 50, pinned: false },
    ];
    expect(flowAxis("custom", horizontalRow).axis).toBe("x");
    expect(flowAxis(null, horizontalRow).axis).toBe("x");

    const verticalCol: FlowNode[] = [
      { id: "a", x: 0, y: 0, w: 50, h: 50, pinned: false },
      { id: "b", x: 0, y: 200, w: 50, h: 50, pinned: false },
    ];
    expect(flowAxis(undefined, verticalCol).axis).toBe("y");
  });
});

describe("resolveOverlapsAlongFlow — устранение наезда по направлению", () => {
  const node = (
    id: string,
    x: number,
    y: number,
    w: number,
    h: number,
    pinned = false,
  ): FlowNode => ({ id, x, y, w, h, pinned });

  test("LR: правый сосед сдвигается вправо, другая координата не меняется", () => {
    // a[x0,w90] вырос, b[x70] наезжает → b.x = 114; y не трогаем
    const r = resolveOverlapsAlongFlow(
      [node("a", 0, 5, 90, 40), node("b", 70, 5, 100, 40)],
      "LR",
      24,
    );
    expect(r).toEqual([{ id: "b", x: 114 }]);
  });

  test("RL: реверс — сосед слева сдвигается влево", () => {
    // поток справа-налево: a справа [200,300], b слева [80,180] наезжает
    // нужно b.right ≤ a.left-24=176 → b.x=76
    const r = resolveOverlapsAlongFlow(
      [node("a", 200, 0, 100, 40), node("b", 80, 0, 100, 40)],
      "RL",
      24,
    );
    expect(r).toEqual([{ id: "b", x: 76 }]);
  });

  test("TB: нижний сосед сдвигается вниз", () => {
    // a[y0,h60], b[y70,h60] наезжает (зазор 10) → b.y = 84
    const r = resolveOverlapsAlongFlow(
      [node("a", 0, 0, 50, 60), node("b", 0, 70, 50, 60)],
      "TB",
      24,
    );
    expect(r).toEqual([{ id: "b", y: 84 }]);
  });

  test("BT: реверс — верхний сосед сдвигается вверх", () => {
    // поток снизу-вверх: a снизу [y200,h60], b сверху [y80,h100] наезжает
    // b.bottom ≤ a.top-24=176 → b.y=76
    const r = resolveOverlapsAlongFlow(
      [node("a", 0, 200, 50, 60), node("b", 0, 80, 50, 100)],
      "BT",
      24,
    );
    expect(r).toEqual([{ id: "b", y: 76 }]);
  });

  test("без наезда → ничего не двигается", () => {
    const r = resolveOverlapsAlongFlow(
      [node("a", 0, 0, 50, 50), node("b", 200, 0, 50, 50)],
      "LR",
      24,
    );
    expect(r).toEqual([]);
  });

  test("один узел или пусто → нет работы", () => {
    expect(
      resolveOverlapsAlongFlow([node("a", 0, 0, 50, 50)], "LR", 24),
    ).toEqual([]);
    expect(resolveOverlapsAlongFlow([], "LR", 24)).toEqual([]);
  });

  test("pinned уважается: закреплённый сосед не двигается", () => {
    const r = resolveOverlapsAlongFlow(
      [node("a", 0, 0, 90, 40), node("p", 70, 0, 60, 40, true)],
      "LR",
      24,
    );
    // p закреплён — не двигаем, даже при наезде выросшего a
    expect(r.find((m) => m.id === "p")).toBeUndefined();
  });
});

describe("DRW-232 growOnlyBox — envelope grow-only", () => {
  test("content exceeds current width → grows width, keeps larger height", () => {
    // needW = 200 + 16 = 216 > 100; needH = 50 + 16 = 66 < 100 → keep 100.
    expect(
      growOnlyBox({ w: 100, h: 100 }, { right: 200, bottom: 50 }, 16),
    ).toEqual({ w: 216, h: 100 });
  });

  test("content exceeds both axes → grows both", () => {
    expect(
      growOnlyBox({ w: 100, h: 100 }, { right: 300, bottom: 200 }, 56),
    ).toEqual({ w: 356, h: 256 });
  });

  test("content already fits → null (never shrinks)", () => {
    expect(
      growOnlyBox({ w: 400, h: 400 }, { right: 100, bottom: 100 }, 16),
    ).toBeNull();
  });

  test("exact fit (needed === current) → null (no spurious write)", () => {
    // needW = 100 + 16 = 116; needH = 100 + 16 = 116.
    expect(
      growOnlyBox({ w: 116, h: 116 }, { right: 100, bottom: 100 }, 16),
    ).toBeNull();
  });

  test("grows only the overflowing axis → null check is per-box, not per-axis", () => {
    // width needs to grow (216 > 100), height fits (66 < 300) → returns box.
    expect(
      growOnlyBox({ w: 100, h: 300 }, { right: 200, bottom: 50 }, 16),
    ).toEqual({ w: 216, h: 300 });
  });
});
