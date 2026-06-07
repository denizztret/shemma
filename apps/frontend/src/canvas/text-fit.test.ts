import { describe, expect, test } from "bun:test";
import { pickOptimalWidth } from "./text-fit";

// measureH(w) — synthetic monotone-non-increasing step function:
// узкий бокс → больше строк → выше; широкий → меньше строк → ниже.
function stepMeasure(thresholds: Array<[number, number]>): (w: number) => number {
  // thresholds: sorted by width asc; each [minWidthForThisHeight, height].
  // returns height for the widest threshold whose minWidth <= w.
  return (w: number) => {
    let h = thresholds[0]![1];
    for (const [minW, height] of thresholds) {
      if (w >= minW) h = height;
    }
    return h;
  };
}

describe("pickOptimalWidth", () => {
  test("single-line text → narrowest width that keeps one line", () => {
    // одна строка (40px) достижима при w>=100; уже — две строки (80px).
    const measureH = stepMeasure([
      [0, 80],
      [100, 40],
    ]);
    const r = pickOptimalWidth(measureH, { minWidth: 60, maxWidth: 400 });
    expect(r.height).toBe(40);
    expect(r.width).toBe(100); // плотно облегает, не 400
  });

  test("long text → balanced width at minimal height (no ragged extra width)", () => {
    // при 400 → 2 строки (90px, минимум); при >=250 ещё 2 строки; уже 250 → 3 строки (135px).
    const measureH = stepMeasure([
      [0, 135],
      [250, 90],
    ]);
    const r = pickOptimalWidth(measureH, { minWidth: 60, maxWidth: 400 });
    expect(r.height).toBe(90);
    expect(r.width).toBe(250); // минимальная ширина с минимальной высотой
  });

  test("height is the minimal achievable within [minWidth, maxWidth]", () => {
    const measureH = stepMeasure([
      [0, 200],
      [150, 120],
      [320, 60],
    ]);
    const r = pickOptimalWidth(measureH, { minWidth: 60, maxWidth: 400 });
    expect(r.height).toBe(60);
    expect(r.width).toBe(320);
  });

  test("constant height (e.g. empty/short) → returns minWidth", () => {
    const measureH = () => 40;
    const r = pickOptimalWidth(measureH, { minWidth: 80, maxWidth: 400 });
    expect(r.width).toBe(80);
    expect(r.height).toBe(40);
  });

  test("width never exceeds maxWidth nor goes below minWidth", () => {
    const measureH = stepMeasure([
      [0, 300],
      [600, 40], // минимум достижим только за пределами maxWidth
    ]);
    const r = pickOptimalWidth(measureH, { minWidth: 60, maxWidth: 400 });
    // в пределах [60,400] высота всегда 300 → берём minWidth
    expect(r.width).toBe(60);
    expect(r.height).toBe(300);
  });

  test("tolerance absorbs sub-pixel jitter", () => {
    const measureH = (w: number) => (w >= 200 ? 50.0 : 50.4);
    const r = pickOptimalWidth(measureH, {
      minWidth: 60,
      maxWidth: 400,
      tolerance: 1,
    });
    // 50.4 <= 50.0 + 1 → весь диапазон «минимум» → minWidth
    expect(r.width).toBe(60);
  });
});
