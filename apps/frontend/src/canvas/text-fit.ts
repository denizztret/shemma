// apps/frontend/src/canvas/text-fit.ts
//
// DRW-219: «обтяжка текста» — подбор оптимальной ширины объекта с текстом так,
// чтобы высота была минимальной, а перенос — сбалансированным (не одна длинная
// строка-простыня и не узкая высокая колонна).
//
// pickOptimalWidth — чистая функция (инжектируется measureH: ширина → effective
// высота). measureH монотонно НЕ возрастает по ширине (шире бокс → меньше или
// столько же строк → меньше или равная высота). Алгоритм:
//   1. minH = measureH(maxWidth) — минимально достижимая высота в диапазоне.
//   2. бинарным поиском найти НАИМЕНЬШУЮ ширину, при которой высота всё ещё minH
//      (плотная упаковка тех же строк — убирает рваный правый край).
// Короткий текст → одна строка, узкий плотный бокс. Длинный → ограничен maxWidth,
// строки сбалансированы, высота минимальна для этой ширины.

export type TextFitOptions = {
  minWidth: number;
  maxWidth: number;
  /** Допуск высоты (px) против sub-pixel дрожания measure. По умолчанию 0.5. */
  tolerance?: number;
};

export type TextFitResult = { width: number; height: number };

export function pickOptimalWidth(
  measureH: (width: number) => number,
  opts: TextFitOptions,
): TextFitResult {
  const { minWidth, maxWidth } = opts;
  const tol = opts.tolerance ?? 0.5;

  const minH = measureH(maxWidth);

  // Самый узкий бокс уже даёт минимальную высоту → не расширяем.
  if (measureH(minWidth) <= minH + tol) {
    return { width: minWidth, height: Math.ceil(measureH(minWidth)) };
  }

  // Инвариант: H(lo) > minH+tol, H(hi) <= minH+tol. Ищем границу.
  let lo = minWidth;
  let hi = maxWidth;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (measureH(mid) <= minH + tol) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return { width: hi, height: Math.ceil(measureH(hi)) };
}
