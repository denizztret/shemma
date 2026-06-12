// apps/frontend/src/canvas/edge-routing.ts
// DRW-199 T4: оркестратор edge-routing — сбор боксов, гейт, writeback, отчёт.
// Editor-зависимая часть тонкая; решающая логика — decideEdges (чистая функция).

import type { Editor, TLShapeId } from "tldraw";
import {
  type Polyline,
  type RouteBox,
  type RouteEdge,
  type RouteMetrics,
  type TransferPlan,
  anchorFor,
  assignPorts,
  axisOfDirection,
  buildBoxIndex,
  candidateBeatsCurrent,
  classifyEdges,
  countCrossFlowTerminals,
  countPolylineCrossings,
  foreignCrossings,
  maxEndpointDegree,
  pickArcBend,
  planTransfer,
  polylineLength,
  routeScore,
  sampleArc,
  sampledForeignCrossings,
} from "./edge-routing-core";
import { loadAvoid, routeClasses } from "./libavoid-router";

// ─── Константы ────────────────────────────────────────────────────────────────

const BUFFER_DISTANCE = 12;
const NUDGE_DISTANCE = 16;

// ─── Чистая решающая логика ───────────────────────────────────────────────────

export interface EdgeDecision {
  readonly edgeId: string;
  readonly action: "apply" | "arc" | "inexpressible" | "gate-skip";
  readonly plan?: TransferPlan;
  readonly route?: Polyline;
  readonly foreignBest?: number;
  readonly foreignRoute?: number;
  readonly arcBend?: number;
}

function metricsFor(
  pts: Polyline,
  edge: RouteEdge,
  boxes: ReadonlyArray<RouteBox>,
  byId: ReadonlyMap<string, RouteBox>,
  otherRoutes: ReadonlyMap<string, Polyline>,
): RouteMetrics {
  const foreign = foreignCrossings(pts, edge, boxes, byId).length;
  let edgeCross = 0;
  for (const [otherId, other] of otherRoutes) {
    if (otherId === edge.id) continue;
    edgeCross += countPolylineCrossings(pts, other);
  }
  const length = polylineLength(pts);
  const srcBox = byId.get(edge.from);
  const dstBox = byId.get(edge.to);
  const crossFlow =
    srcBox && dstBox ? countCrossFlowTerminals(pts, srcBox, dstBox) : 0;
  return { foreign, edgeCross, length, crossFlow };
}

export function decideEdges(
  boxes: ReadonlyArray<RouteBox>,
  edges: ReadonlyArray<RouteEdge>,
  routes: ReadonlyMap<string, Polyline>,
  currents: ReadonlyMap<string, Polyline>,
): EdgeDecision[] {
  const byId = buildBoxIndex(boxes);
  const decisions: EdgeDecision[] = [];

  for (const edge of edges) {
    const route = routes.get(edge.id);
    if (!route) continue;

    const srcBox = byId.get(edge.from);
    const dstBox = byId.get(edge.to);
    if (!srcBox || !dstBox) continue;

    const routeMetrics = metricsFor(route, edge, boxes, byId, routes);
    const plan = planTransfer(route, srcBox, dstBox);

    const current = currents.get(edge.id);
    const currentMetrics = current
      ? metricsFor(current, edge, boxes, byId, currents)
      : null;

    // U или detour — elbow не выразит; пробуем arc-кандидат
    if (plan.kind === "U" || plan.kind === "detour") {
      const bend = pickArcBend(route, edge, boxes, byId);
      if (bend !== null) {
        const start = route[0];
        const end = route[route.length - 1];
        if (start !== undefined && end !== undefined) {
          const arcSamples = sampleArc(start, end, bend);
          const arcForeign = sampledForeignCrossings(
            arcSamples,
            edge,
            boxes,
            byId,
          ).length; // 0 по построению pickArcBend
          const arcLength = polylineLength(arcSamples);
          // edgeCross для arc-кандидата считается консервативно — равен edgeCross
          // текущего маршрута (countPolylineCrossings рассчитан для ortho-полилиний
          // и даст неточный счёт для кривой; принимаем worst-case = current).
          const arcEdgeCross = currentMetrics
            ? currentMetrics.edgeCross
            : routeMetrics.edgeCross;
          const arcMetrics = {
            foreign: arcForeign,
            edgeCross: arcEdgeCross,
            length: arcLength,
            crossFlow: 0,
          };
          const shouldApplyArc = currentMetrics
            ? candidateBeatsCurrent(arcMetrics, currentMetrics)
            : true; // нет текущего — применяем дугу
          if (shouldApplyArc) {
            decisions.push({
              edgeId: edge.id,
              action: "arc",
              route,
              arcBend: bend,
            });
            continue;
          }
        }
      }
      const foreignBest = routeScore(currentMetrics ?? routeMetrics);
      const foreignRoute = routeScore(routeMetrics);
      decisions.push({
        edgeId: edge.id,
        action: "inexpressible",
        foreignBest,
        foreignRoute,
      });
      continue;
    }

    // Гейт: если текущий маршрут есть и кандидат не лучше — пропускаем
    if (
      currentMetrics &&
      !candidateBeatsCurrent(routeMetrics, currentMetrics)
    ) {
      decisions.push({ edgeId: edge.id, action: "gate-skip" });
      continue;
    }

    decisions.push({ edgeId: edge.id, action: "apply", plan, route });
  }

  return decisions;
}

// ─── Фильтрация роутабельных рёбер (чистая, тестируется отдельно) ─────────────

export interface FilterResult {
  readonly routable: RouteEdge[];
  /** id выровненных Ф2 рёбер — роутятся НАРАВНЕ с остальными: их прямая линия
   * участвует в гейте (чистая выживает сама, сквозь-боксовая проигрывает обходу).
   * Live-находка T5: безусловный skip сохранял дефектное ребро A3→E2. */
  readonly alignedIds: ReadonlySet<string>;
}

export function filterRoutableEdges(
  byArrow: Readonly<Record<string, { start?: string; end?: string }>>,
  inScope: ReadonlySet<string>,
  byId: ReadonlyMap<string, RouteBox>,
  alignedEdges?: ReadonlySet<string>,
): FilterResult {
  const alignedIds = new Set<string>();
  const routable: RouteEdge[] = [];

  for (const [aid, t] of Object.entries(byArrow)) {
    if (!t.start || !t.end) continue;
    // Scope по КОНЦАМ ребра (инвариант distributeArrowPorts: byArrow покрывает весь
    // store, стрелки в inScope не входят) — byId собран из inScope-боксов.
    if (!inScope.has(t.start) || !inScope.has(t.end)) continue;
    if (!byId.has(t.start) || !byId.has(t.end)) continue;
    const key = `${t.start}>${t.end}`;
    const keyRev = `${t.end}>${t.start}`;
    if (alignedEdges && (alignedEdges.has(key) || alignedEdges.has(keyRev))) {
      alignedIds.add(aid);
    }
    routable.push({ id: aid, from: t.start, to: t.end });
  }

  return { routable, alignedIds };
}

// ─── Editor-обвязка ───────────────────────────────────────────────────────────

export interface EdgeRoutingReport {
  routed: number;
  approximated: string[];
  /** gate-skip рёбра: маршрут не лучше текущего (гейт отклонил). */
  skipped: string[];
  /** classification-skip: лист→свой контейнер или битые концы —
   * пасс их не обслуживал; нуждаются в residual distributeArrowPorts. */
  unrouted: string[];
  alignedKept: number;
  inexpressible: Array<{
    edgeId: string;
    foreignBest: number;
    foreignRoute: number;
  }>;
}

export interface EdgeRoutingOpts {
  readonly alignedEdges?: ReadonlySet<string>;
  readonly pinsPerSide?: number;
  /** Направление потока scope-фрейма/контейнера ("TB"|"BT"|"LR"|"RL"). */
  readonly flowDir?: string;
}

/** Собирает RouteBox из editor по inScope.
 * geo → leaf, schema-container → container.
 * parent = ближайший schema-container-предок в inScope (подъём по parentId).
 */
export function collectRouteBoxes(
  editor: Editor,
  inScope: ReadonlySet<string>,
  opts?: EdgeRoutingOpts,
): RouteBox[] {
  const result: RouteBox[] = [];

  for (const id of inScope) {
    const shape = editor.getShape(id as TLShapeId);
    if (!shape) continue;
    if (shape.type === "arrow") continue;

    const bounds = editor.getShapePageBounds(id as TLShapeId);
    if (!bounds) continue;

    const kind: RouteBox["kind"] =
      shape.type === "schema-container" ? "container" : "leaf";

    // Ищем ближайшего schema-container-предка в scope
    let parent: string | null = null;
    // biome-ignore lint/suspicious/noExplicitAny: tldraw shape parentId строка
    let curParentId: string = (shape as any).parentId as string;
    while (curParentId && inScope.has(curParentId)) {
      const parentShape = editor.getShape(curParentId as TLShapeId);
      if (parentShape?.type === "schema-container") {
        parent = curParentId;
        break;
      }
      // biome-ignore lint/suspicious/noExplicitAny: tldraw shape parentId строка
      curParentId = (parentShape as any)?.parentId as string;
    }

    let flowAxis: "h" | "v" | undefined;
    if (parent !== null) {
      const parentShape = editor.getShape(parent as TLShapeId);
      // Канон направления контейнера — meta.didrawDirection (TB/BT/LR/RL);
      // props.direction при ручных правках вырождается в "custom" (DRW-150)
      // и осью не является. Фоллбэк — направление scope.
      // biome-ignore lint/suspicious/noExplicitAny: schema-container meta/props
      const metaDir = (parentShape as any)?.meta?.didrawDirection as
        | string
        | undefined;
      // biome-ignore lint/suspicious/noExplicitAny: schema-container props
      const propsDir = (parentShape as any)?.props?.direction as
        | string
        | undefined;
      flowAxis =
        axisOfDirection(metaDir) ??
        axisOfDirection(propsDir) ??
        axisOfDirection(opts?.flowDir);
    } else {
      flowAxis = axisOfDirection(opts?.flowDir);
    }

    result.push({
      id,
      kind,
      parent,
      x: bounds.x,
      y: bounds.y,
      w: bounds.w,
      h: bounds.h,
      flowAxis,
    });
  }

  return result;
}

/** Текущая полилиния стрелки в page-координатах.
 * null если недоступна или меньше 2 точек.
 */
export function currentArrowPolyline(
  editor: Editor,
  arrowId: string,
): Polyline | null {
  const g = editor.getShapeGeometry(arrowId as TLShapeId);
  const tr = editor.getShapePageTransform(arrowId as TLShapeId);
  if (!g || !tr) return null;

  const pts: Array<readonly [number, number]> = g.vertices.map((v) => {
    const p = tr.applyToPoint(v);
    return [p.x, p.y] as const;
  });

  if (pts.length < 2) return null;
  return pts;
}

// ─── Writeback-план (чистая функция, тестируется без WASM) ───────────────────

export interface BindingUpdate {
  readonly bindingId: string;
  readonly fromId: string;
  readonly toId: string;
  readonly props: Record<string, unknown> & { terminal: "start" | "end" };
  readonly normalizedAnchor: { x: number; y: number };
}

export interface ShapeUpdate {
  readonly shapeId: string;
  readonly props:
    | { kind: "elbow"; elbowMidPoint: number }
    | { kind: "arc"; bend: number };
}

export interface WritebackPlan {
  readonly bindingUpdates: BindingUpdate[];
  readonly shapeUpdates: ShapeUpdate[];
}

/** Строит план writeback из decisions и assignments — без editor. */
export function buildWritebackPlan(
  decisions: ReadonlyArray<EdgeDecision>,
  assignments: ReturnType<typeof assignPorts>,
  bindByKey: ReadonlyMap<
    string,
    {
      id: string;
      fromId: string;
      toId: string;
      props: Record<string, unknown> & { terminal: "start" | "end" };
    }
  >,
): WritebackPlan {
  const bindingUpdates: BindingUpdate[] = [];
  for (const assignment of assignments) {
    for (const slot of assignment.ports) {
      const rec = bindByKey.get(`${slot.edgeId}|${slot.terminal}`);
      if (!rec) continue;
      bindingUpdates.push({
        bindingId: rec.id,
        fromId: rec.fromId,
        toId: rec.toId,
        props: rec.props,
        normalizedAnchor: anchorFor(assignment.side, slot.frac),
      });
    }
  }

  const shapeUpdates: ShapeUpdate[] = [];
  for (const d of decisions) {
    if (d.action === "apply" && d.plan) {
      // Для straight/L: явно пишем elbowMidPoint: 0.5 — иначе stale значение
      // от прошлых прогонов остаётся (updateShape мержит props).
      shapeUpdates.push({
        shapeId: d.edgeId,
        props:
          d.plan.kind === "Z" && d.plan.elbowMidPoint !== undefined
            ? { kind: "elbow", elbowMidPoint: d.plan.elbowMidPoint }
            : { kind: "elbow", elbowMidPoint: 0.5 },
      });
    } else if (d.action === "arc" && d.arcBend !== undefined) {
      shapeUpdates.push({
        shapeId: d.edgeId,
        props: { kind: "arc", bend: d.arcBend },
      });
    }
  }

  return { bindingUpdates, shapeUpdates };
}

/** Читает все binding-записи store типа arrow; индексирует по `${fromId}|${terminal}`. */
function loadBindingIndex(editor: Editor): Map<
  string,
  {
    id: string;
    fromId: string;
    toId: string;
    props: Record<string, unknown> & { terminal: "start" | "end" };
  }
> {
  const bindings = editor.store.allRecords().filter((r) => {
    const x = r as { typeName: string; type?: string };
    return x.typeName === "binding" && x.type === "arrow";
  }) as unknown as Array<{
    id: string;
    fromId: string;
    toId: string;
    props: Record<string, unknown> & { terminal: "start" | "end" };
  }>;

  return new Map(bindings.map((b) => [`${b.fromId}|${b.props.terminal}`, b]));
}

/** Главный пасс. Возвращает null если libavoid недоступен или при ошибке. */
export async function runEdgeRoutingPass(
  editor: Editor,
  inScope: ReadonlySet<string>,
  byArrow: Readonly<Record<string, { start?: string; end?: string }>>,
  opts: EdgeRoutingOpts = {},
): Promise<EdgeRoutingReport | null> {
  const Avoid = await loadAvoid();
  if (!Avoid) return null;

  // Сбор боксов и фильтрация — вне try (нет WASM-объектов, падение маловероятно)
  const boxes = collectRouteBoxes(editor, inScope, opts);
  const byId = buildBoxIndex(boxes);

  const report: EdgeRoutingReport = {
    routed: 0,
    approximated: [],
    skipped: [],
    unrouted: [],
    alignedKept: 0,
    inexpressible: [],
  };

  const { routable, alignedIds } = filterRoutableEdges(
    byArrow,
    inScope,
    byId,
    opts.alignedEdges,
  );

  if (routable.length === 0) return report;

  try {
    const { classes, skipped } = classifyEdges(boxes, routable);
    // classification-skip → unrouted (residual-порты нужны)
    for (const e of skipped) report.unrouted.push(e.id);

    // pinsPerSide по максимальной степени узла — хаб с >3 рёбрами не упрётся в лимит
    const pinsPerSide =
      opts.pinsPerSide ?? Math.max(3, maxEndpointDegree(routable));

    const routes = routeClasses(Avoid, boxes, classes, {
      bufferDistance: BUFFER_DISTANCE,
      nudgeDistance: NUDGE_DISTANCE,
      pinsPerSide,
    });

    // Собираем рёбра с маршрутами (только те, что реально маршрутизированы)
    const routedEdges = routable.filter((e) => routes.has(e.id));

    // Текущие полилинии для гейта
    const currents = new Map<string, Polyline>();
    for (const e of routedEdges) {
      const poly = currentArrowPolyline(editor, e.id);
      if (poly) currents.set(e.id, poly);
    }

    const decisions = decideEdges(boxes, routedEdges, routes, currents);

    const appliedEdges: RouteEdge[] = [];
    const appliedRoutes = new Map<string, Polyline>();

    for (const d of decisions) {
      if (d.action === "apply" && d.plan && d.route) {
        const found = routedEdges.find((e) => e.id === d.edgeId);
        if (found) appliedEdges.push(found);
        appliedRoutes.set(d.edgeId, d.route);
      } else if (d.action === "arc" && d.route) {
        // arc-рёбра участвуют в раздаче портов наравне с applied:
        // стороны выхода у дуги те же, что у маршрута libavoid.
        const found = routedEdges.find((e) => e.id === d.edgeId);
        if (found) appliedEdges.push(found);
        appliedRoutes.set(d.edgeId, d.route);
        report.approximated.push(d.edgeId);
      } else if (d.action === "gate-skip") {
        // gate-skip → skipped (осознанный пропуск гейтом, якоря не трогаем)
        if (alignedIds.has(d.edgeId)) report.alignedKept++;
        else report.skipped.push(d.edgeId);
      } else if (d.action === "inexpressible") {
        report.inexpressible.push({
          edgeId: d.edgeId,
          foreignBest: d.foreignBest ?? 0,
          foreignRoute: d.foreignRoute ?? 0,
        });
      }
    }

    const assignments = assignPorts(appliedRoutes, appliedEdges, byId);

    // Writeback в одной транзакции
    editor.run(
      () => {
        const bindByKey = loadBindingIndex(editor);
        const plan = buildWritebackPlan(decisions, assignments, bindByKey);

        // Анкоры через updateBinding — тем же механизмом, что distributeArrowPorts
        for (const bu of plan.bindingUpdates) {
          editor.updateBinding({
            id: bu.bindingId,
            type: "arrow",
            fromId: bu.fromId,
            toId: bu.toId,
            props: {
              ...bu.props,
              isPrecise: true,
              normalizedAnchor: bu.normalizedAnchor,
            },
          } as never);
        }

        // Props стрелок
        for (const su of plan.shapeUpdates) {
          editor.updateShape({
            id: su.shapeId as TLShapeId,
            type: "arrow",
            props: su.props,
          });
        }
      },
      { history: "ignore" },
    );

    report.routed = appliedEdges.length;
  } catch (err) {
    console.warn(
      "[shemma] edge-routing pass failed — fallback к elbow-пассу",
      err,
    );
    return null;
  }

  return report;
}
