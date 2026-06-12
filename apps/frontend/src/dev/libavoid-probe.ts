// DRW-244 spike: загрузка libavoid-js (WASM) в Vite/браузере + ortho-роутинг.
// НЕ импортируется приложением: вызывается из browser-консоли dev-стенда:
//   const m = await import("/src/dev/libavoid-probe.ts"); await m.runLibavoidProbe();
// Файл живёт только на spike-ветке.
import { AvoidLib } from "libavoid-js";

// ГРАБЛЯ (Vite): exports-карта libavoid-js описывает только ".", поэтому
// `import wasmUrl from "libavoid-js/dist/libavoid.wasm?url"` падает с
// `Missing "./dist/libavoid.wasm" specifier`. Для продакшена — resolve.alias
// или копирование wasm в static assets; для dev-пробы хватает /@fs-пути.
const wasmUrl =
  "/@fs/Users/tretyakov_dv/Projects/sandbox/di.draw/apps/frontend/node_modules/libavoid-js/dist/libavoid.wasm";

interface ProbeBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ProbeRoute {
  from: string;
  to: string;
  segments: number;
  points: ReadonlyArray<readonly [number, number]>;
}

export interface ProbeResult {
  wasmLoadMs: number;
  routeMs: number;
  routes: ProbeRoute[];
}

// Мини-топология с обходом: A → C, прямая проходит сквозь B (препятствие).
const BOXES: ProbeBox[] = [
  { id: "A", x: 0, y: 0, w: 120, h: 60 },
  { id: "B", x: 220, y: -20, w: 160, h: 100 },
  { id: "C", x: 480, y: 10, w: 120, h: 60 },
  { id: "D", x: 220, y: 180, w: 120, h: 60 },
];

const EDGES: ReadonlyArray<readonly [string, string]> = [
  ["A", "C"],
  ["A", "D"],
  ["D", "C"],
];

export async function runLibavoidProbe(): Promise<ProbeResult> {
  const t0 = performance.now();
  await AvoidLib.load(wasmUrl);
  const wasmLoadMs = performance.now() - t0;
  const Avoid = AvoidLib.getInstance();

  const router = new Avoid.Router(Avoid.RouterFlag.OrthogonalRouting.value);
  router.setRoutingParameter(Avoid.RoutingParameter.shapeBufferDistance, 12);
  router.setRoutingParameter(Avoid.RoutingParameter.idealNudgingDistance, 16);

  const CENTER_PIN = 1;
  type ShapeRefLike = ConstructorParameters<typeof Avoid.ConnEnd>[0];
  const refs = new Map<string, ShapeRefLike>();
  for (const b of BOXES) {
    const rect = new Avoid.Rectangle(
      new Avoid.Point(b.x, b.y),
      new Avoid.Point(b.x + b.w, b.y + b.h),
    );
    const ref = new Avoid.ShapeRef(router, rect);
    new Avoid.ShapeConnectionPin(ref, CENTER_PIN, 0.5, 0.5, true, 0, 15);
    refs.set(b.id, ref);
  }

  const refOf = (id: string): ShapeRefLike => {
    const ref = refs.get(id);
    if (!ref) throw new Error(`probe box not found: ${id}`);
    return ref;
  };
  const conns = EDGES.map(([from, to]) => ({
    from,
    to,
    conn: new Avoid.ConnRef(
      router,
      new Avoid.ConnEnd(refOf(from), CENTER_PIN),
      new Avoid.ConnEnd(refOf(to), CENTER_PIN),
    ),
  }));

  const t1 = performance.now();
  router.processTransaction();
  const routeMs = performance.now() - t1;

  const routes: ProbeRoute[] = conns.map(({ from, to, conn }) => {
    const pl = conn.displayRoute();
    const points: Array<readonly [number, number]> = [];
    for (let i = 0; i < pl.size(); i++) {
      const p = pl.at(i);
      points.push([Math.round(p.x), Math.round(p.y)]);
    }
    return { from, to, segments: points.length - 1, points };
  });

  const result: ProbeResult = { wasmLoadMs, routeMs, routes };
  console.log("[drw-244] libavoid probe:", JSON.stringify(result));
  return result;
}
