import type { NodeId } from "./identity";
import type { Role } from "./roles";
import type {
  ArrowKind,
  Arrowhead,
  EdgeDash,
  StyleDash,
  StyleFill,
  StyleFont,
  StyleSize,
} from "./style-defaults";

/** Overlay-запись для конкретного узла schema-frame.
 *  Хранится в `frame.meta.didrawOverlays[nodeId]`.
 *  Содержит user-правки поверх render'а из RAW: позицию, label-override и
 *  полный style-блок (color/labelColor/fill/dash/size/font) — DRW-205:
 *  явный set-overlay со style-полями перекрашивает существующий шейп. */
export type OverlayEntry = {
  position?: { x: number; y: number };
  color?: string;
  labelColor?: string;
  fill?: StyleFill;
  dash?: StyleDash;
  size?: StyleSize;
  font?: StyleFont;
  label?: string;
  role?: Role;
  pinned?: boolean;
  styleOwnedBy?: "user";
};

/** Overlay-запись для конкретного РЕБРА schema-frame (DRW-211).
 *  Хранится в `frame.meta.didrawEdgeOverlays[edgeOverlayKey(from,to)]`.
 *  Полный style-блок стрелки: цвет/штрих/толщина/тип/наконечники/лейбл.
 *  NB: домен держит ОДНО ребро на пару from→to — restyle затрагивает все
 *  стрелки этой пары на доске (параллельные дубли неразличимы). */
export type EdgeOverlayEntry = {
  color?: string;
  labelColor?: string;
  dash?: EdgeDash;
  size?: StyleSize;
  font?: StyleFont;
  kind?: ArrowKind;
  arrowheadStart?: Arrowhead;
  arrowheadEnd?: Arrowhead;
  label?: string;
};

/** Ключ edge-overlay записи: направленная пара NodeId. */
export function edgeOverlayKey(from: NodeId, to: NodeId): string {
  return `${from}→${to}`;
}

/** Meta-поля tldraw frame shape, помеченного как schema-frame.
 *  Discriminator: `meta.didrawSchemaFrame === true`.
 *  Spec §Schema-frame as unit (DRW-134). */
export type SchemaFrameMeta = {
  didrawSchemaFrame: true;
  didrawProtocol: "v2";
  schemaProtocolVersion: string; // "1.0" для 0.23.0
  mermaidSource: string;
  didrawOverlays: Record<NodeId, OverlayEntry>;
  /** Edge-overlays (DRW-211): ключ — edgeOverlayKey(from, to). */
  didrawEdgeOverlays?: Record<string, EdgeOverlayEntry>;
  didrawDestructiveCount?: number;
};

/** Meta-поля shape'а — прямого ребёнка schema-frame.
 *  `didrawId` — stable identity для overlay-addressing; immutable после create.
 *  `didrawLabel` — mutable display label; rename меняет только это поле.
 *  Spec §Identity model (DRW-134). */
export type SchemaChildMeta = {
  didrawId: NodeId;
  didrawLabel: string;
  didrawSchemaParent: string; // frame tldraw id (shape:xxx)
  /** @deprecated v1 legacy slug-as-identity. Сохраняется для backward compat,
   *  не используется в v2 identity. */
  didrawName?: string;
};

/** Read-response для `GET /api/canvas/view` на v2 room. */
export type CanvasViewResponse = {
  schemaVersion: "v2";
  frames: Array<{
    id: string;
    label: string;
    bbox: { x: number; y: number; w: number; h: number };
    raw: string;
    overlays: Record<NodeId, OverlayEntry>;
  }>;
  free: Array<{
    id: string;
    type: string;
    label?: string;
    bbox: { x: number; y: number; w: number; h: number };
  }>;
};

/** Ошибка валидации одного action в `SchemaPatchRequest`. */
export type SchemaActionError = {
  actionIndex: number;
  code:
    | "unknown-node"
    | "unknown-edge"
    | "unknown-shape"
    | "not-adoptable"
    | "duplicate-node"
    | "invalid-id"
    | "invalid-mermaid"
    | "invalid-role"
    | "invalid-connection-kind"
    | "frame-not-found"
    | "overlay-user-owned"
    | "outside-frame-not-allowed"
    | "layout-failed";
  message: string;
};

/** Позиция узла/контейнера для Stage-1 import position-injection.
 *  Координаты — layout-flat (как отдаёт mermaid blueprint); backend сам
 *  конвертирует детей subgraph'а в parent-relative. w/h обязательны для
 *  subgraph-ключей (для sizing контейнера), опциональны для leaf. */
export type NodePos = { x: number; y: number; w?: number; h?: number };

/** Request body для `POST /api/schema/create`. */
export type SchemaCreateRequest =
  | { label: string; raw: string; positionsOverride?: Record<string, NodePos> }
  | { label: string; actions: import("./schema-actions").SchemaAction[] };

/** Response для `POST /api/schema/create`. */
export type SchemaCreateResponse =
  | { ok: true; frameId: string; nodeIds: NodeId[]; version: number }
  | { ok: false; errors: SchemaActionError[] };

/** Request body для `POST /api/schema/{frameId}/patch`. */
export type SchemaPatchRequest = {
  actions: import("./schema-actions").SchemaAction[];
  clientOpId?: string;
};

/** Response для `POST /api/schema/{frameId}/patch`. */
export type SchemaPatchResponse =
  | {
      ok: true;
      frameId: string;
      version: number;
      orphanedOverlays?: number;
      addedNodeIds?: NodeId[];
      removedNodeIds?: NodeId[];
    }
  | { ok: false; errors: SchemaActionError[] };

/** Request body для `POST /api/schema/{frameId}/duplicate`. */
export type SchemaDuplicateRequest = {
  newLabel: string;
};

/** Response для `POST /api/schema/{frameId}/duplicate`. */
export type SchemaDuplicateResponse =
  | { ok: true; newFrameId: string; nodeIdMap: Record<NodeId, NodeId> }
  | { ok: false; error: string };

/** Версия protocol модели schema-frame для текущего release. */
export const SCHEMA_PROTOCOL_VERSION = "1.0";
