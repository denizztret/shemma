// apps/frontend/src/canvas/libavoid-router.ts
// DRW-199: тонкая обёртка libavoid-js (WASM). Грузится лениво; недоступна → null
// (пасс деградирует к текущему elbow-поведению). embind-грабли: см. отчёт DRW-244.
import type {
  Polyline,
  RouteBox,
  RouteEdge,
  RoutingClass,
} from "./edge-routing-core";
import {
  buildParentIndex,
  separatedAlongAxis,
  visibleSetFor,
} from "./edge-routing-core";

// Типы libavoid-js даны интерфейсами без структуры — работаем через unknown-обёртку.
// biome-ignore lint/suspicious/noExplicitAny: emscripten-модуль без честных типов
type AvoidModule = any;

let avoidPromise: Promise<AvoidModule | null> | null = null;

/** Vite: bare-specifier wasm заблокирован exports-картой пакета (грабля DRW-244) —
 * берём файл относительным путём, `new URL(..., import.meta.url)` работает в dev и build.
 * В bun (node-entry): если URL не резолвится — fallback без аргумента: node-entry
 * находит wasm сам через `locateFile` рядом с index-node.mjs. */
export function loadAvoid(): Promise<AvoidModule | null> {
  avoidPromise ??= (async () => {
    try {
      const { AvoidLib } = await import("libavoid-js");
      const wasmUrl = new URL(
        "../../node_modules/libavoid-js/dist/libavoid.wasm",
        import.meta.url,
      ).href;
      try {
        await AvoidLib.load(wasmUrl);
      } catch {
        // bun: URL может не резолвиться — node-entry найдёт wasm рядом с собой
        await AvoidLib.load();
      }
      return AvoidLib.getInstance();
    } catch (err) {
      console.warn("[shemma] libavoid недоступен — edge-routing пропущен", err);
      return null;
    }
  })();
  return avoidPromise;
}

/** Только для тестов: сброс singleton'а. */
export function resetAvoidForTests(): void {
  avoidPromise = null;
}

export interface RouterOpts {
  readonly bufferDistance: number; // 12
  readonly nudgeDistance: number; // 16
  readonly pinsPerSide: number; // ≥2
}

const SIDE_DIRS: ReadonlyArray<{
  dx: number;
  dy: number;
  visDir: number;
}> = [
  { dx: 0.5, dy: 0, visDir: 1 }, // top (ConnDirUp)
  { dx: 0.5, dy: 1, visDir: 2 }, // bottom (ConnDirDown)
  { dx: 0, dy: 0.5, visDir: 4 }, // left (ConnDirLeft)
  { dx: 1, dy: 0.5, visDir: 8 }, // right (ConnDirRight)
];
/** Классы пинов: семантика старого sideOf (DRW-172) — ребро, чьи концы разделены
 * вдоль оси потока, ОБЯЗАНО входить/выходить по сторонам вдоль потока (для TB —
 * top/bottom); same-layer рёбра — по поперечным. Мягкий cost этого не давал:
 * выигрыш длины бокового входа перевешивал любой разумный штраф (приёмка dl-test). */
const PIN_ALONG = 1; // стороны вдоль оси потока бокса (или ВСЕ стороны, если оси нет)
const PIN_CROSS = 2; // поперечные стороны (создаются только при наличии оси)

/** Какой класс пинов нужен терминалу: разделение пары вдоль оси конца → вдоль-пины. */
function pinClassFor(self: RouteBox, other: RouteBox): number {
  if (!self.flowAxis) return PIN_ALONG;
  return separatedAlongAxis(self, other, self.flowAxis) ? PIN_ALONG : PIN_CROSS;
}

/** Роутит классы V-H; возвращает полилинии в абсолютных координатах входных боксов. */
export function routeClasses(
  Avoid: AvoidModule,
  boxes: ReadonlyArray<RouteBox>,
  classes: ReadonlyArray<RoutingClass>,
  opts: RouterOpts,
): Map<string, Polyline> {
  const byParent = buildParentIndex(boxes);
  const out = new Map<string, Polyline>();
  for (const cls of classes) {
    const router = new Avoid.Router(Avoid.RouterFlag.OrthogonalRouting.value);
    // Временные value-объекты (Point/Rectangle/ConnEnd) — embind копирует их в
    // конструкторах; после передачи их можно удалять. ConnRef/ShapeRef/пины
    // принадлежат router — их удалять не нужно (удалятся вместе с ним).
    const temps: Array<{ delete?: () => void }> = [];
    try {
      router.setRoutingParameter(
        Avoid.RoutingParameter.shapeBufferDistance,
        opts.bufferDistance,
      );
      router.setRoutingParameter(
        Avoid.RoutingParameter.idealNudgingDistance,
        opts.nudgeDistance,
      );
      router.setRoutingOption(
        Avoid.RoutingOption.nudgeOrthogonalSegmentsConnectedToShapes,
        true,
      );
      const endpointIds = new Set(cls.edges.flatMap((e) => [e.from, e.to]));
      const refs = new Map<string, unknown>();
      for (const b of visibleSetFor(byParent, cls.excl)) {
        const topLeft = new Avoid.Point(b.x, b.y);
        const botRight = new Avoid.Point(b.x + b.w, b.y + b.h);
        const rect = new Avoid.Rectangle(topLeft, botRight);
        temps.push(topLeft, botRight, rect);
        const ref = new Avoid.ShapeRef(router, rect);
        if (endpointIds.has(b.id)) {
          // Сетка exclusive-пинов по сторонам; classId группирует стороны:
          // вдоль оси потока → PIN_ALONG, поперечные → PIN_CROSS; без оси —
          // все стороны в PIN_ALONG (терминал свободен).
          for (const side of SIDE_DIRS) {
            const crossFlow =
              b.flowAxis === "v"
                ? side.visDir === 4 || side.visDir === 8 // left/right поперечны вертикальному потоку
                : b.flowAxis === "h"
                  ? side.visDir === 1 || side.visDir === 2 // top/bottom поперечны горизонтальному потоку
                  : false;
            const classId = crossFlow ? PIN_CROSS : PIN_ALONG;
            for (let i = 1; i <= opts.pinsPerSide; i++) {
              const t = i / (opts.pinsPerSide + 1);
              const px = side.dx === 0.5 ? t : side.dx;
              const py = side.dy === 0.5 ? t : side.dy;
              const pin = new Avoid.ShapeConnectionPin(
                ref,
                classId,
                px,
                py,
                true,
                0,
                side.visDir,
              );
              pin.setExclusive(true);
            }
          }
        }
        refs.set(b.id, ref);
      }
      const byIdAll = new Map(boxes.map((bx) => [bx.id, bx]));
      const conns: Array<{ edge: RouteEdge; conn: unknown }> = [];
      for (const e of cls.edges) {
        const src = refs.get(e.from);
        const dst = refs.get(e.to);
        const srcBox = byIdAll.get(e.from);
        const dstBox = byIdAll.get(e.to);
        if (!src || !dst || !srcBox || !dstBox) continue;
        const endSrc = new Avoid.ConnEnd(src, pinClassFor(srcBox, dstBox));
        const endDst = new Avoid.ConnEnd(dst, pinClassFor(dstBox, srcBox));
        temps.push(endSrc, endDst);
        conns.push({
          edge: e,
          conn: new Avoid.ConnRef(router, endSrc, endDst),
        });
      }
      router.processTransaction();
      for (const { edge, conn } of conns) {
        // biome-ignore lint/suspicious/noExplicitAny: emscripten-объект
        const pl = (conn as any).displayRoute();
        const pts: Array<readonly [number, number]> = [];
        for (let i = 0; i < pl.size(); i++) {
          const p = pl.at(i);
          pts.push([p.x, p.y]);
        }
        out.set(edge.id, pts);
      }
    } finally {
      // Удаляем временные value-объекты до router.delete()
      for (const t of temps) t.delete?.();
      router.delete();
    }
  }
  return out;
}
