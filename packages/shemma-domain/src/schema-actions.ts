import type { ConnectionKind } from "./connections";
import type { NodeId } from "./identity";
import type { Role } from "./roles";
import type { EdgeOverlayEntry, OverlayEntry } from "./schema-meta";

/** Добавить или upsert узел в RAW schema-frame.
 *  `nodeId` опционален: если не передан — backend генерирует. */
export type SchemaDefineAction = {
  kind: "schema-define";
  nodeId?: NodeId;
  role: Role;
  label?: string;
  in?: NodeId; // subgraph parent
};

/** Добавить ребро между двумя узлами. */
export type SchemaConnectAction = {
  kind: "schema-connect";
  from: NodeId;
  to: NodeId;
  connectionKind?: ConnectionKind;
  label?: string;
};

/** Изменить display label узла; identity (nodeId) остаётся прежним. */
export type SchemaRenameAction = {
  kind: "schema-rename";
  nodeId: NodeId;
  label: string;
};

/** Изменить role узла (re-render shape с новым style preset). */
export type SchemaSetRoleAction = {
  kind: "schema-set-role";
  nodeId: NodeId;
  role: Role;
};

/** Обернуть набор узлов в subgraph.
 *  `as: "boundary"` → logical boundary, `as: "network"` → deployment network. */
export type SchemaGroupAction = {
  kind: "schema-group";
  nodeIds: NodeId[];
  as: "boundary" | "network";
  name?: NodeId; // ID самой группы
  label?: string;
  /** Per-subgraph layout direction from mermaid `direction TB|LR|BT|RL` line. */
  direction?: "TB" | "LR" | "BT" | "RL";
  /** Raw mermaid id of the subgraph (e.g. "INPUT") — used for style lookup.
   *  Distinct from `name` which is the resolved NodeId (e.g. "входa1b2c3").
   *  DRW-150 C1: callsite must use this key against subgraphStyles map. */
  mermaidId?: string;
};

/** Удалить ребро между двумя узлами. */
export type SchemaDisconnectAction = {
  kind: "schema-disconnect";
  from: NodeId;
  to: NodeId;
};

/** Удалить узел и все его смежные рёбра из RAW. */
export type SchemaDeleteNodeAction = {
  kind: "schema-delete-node";
  nodeId: NodeId;
};

/** Записать overlay-правку для конкретного узла напрямую.
 *  Типичное использование: frontend при user drag / color change. */
export type SchemaSetOverlayAction = {
  kind: "schema-set-overlay";
  nodeId: NodeId;
  overlay: OverlayEntry;
};

/** Записать style-правку для конкретного РЕБРА (DRW-211): ребро адресуется
 *  направленной парой from→to; стиль применяется к живой стрелке сразу и
 *  персистится в frame.meta.didrawEdgeOverlays. */
export type SchemaSetEdgeOverlayAction = {
  kind: "schema-set-edge-overlay";
  from: NodeId;
  to: NodeId;
  overlay: EdgeOverlayEntry;
};

/** Усыновить нарисованный руками шейп в схему (DRW-212): шейп получает
 *  identity (didrawId)/role/label и появляется в raw как define — БЕЗ
 *  пересоздания: позиция/размер/вид сохраняются. */
export type SchemaAdoptShapeAction = {
  kind: "schema-adopt-shape";
  /** tldraw shape id (например "shape:abc123"). */
  shapeId: string;
  role: Role;
  /** Display label; по умолчанию — текст шейпа, иначе nodeId. */
  label?: string;
  /** Явный NodeId; по умолчанию генерируется из label. */
  nodeId?: NodeId;
};

/** Удалить НЕ-схемный шейп по tldraw shape-id (DRW-212), с каскадом
 *  биндингов/висячих стрелок. Для didraw-узлов — schema-delete-node. */
export type SchemaDeleteShapeAction = {
  kind: "schema-delete-shape";
  shapeId: string;
};

/** Discriminated union всех incremental schema-actions. */
export type SchemaAction =
  | SchemaDefineAction
  | SchemaConnectAction
  | SchemaRenameAction
  | SchemaSetRoleAction
  | SchemaGroupAction
  | SchemaDisconnectAction
  | SchemaDeleteNodeAction
  | SchemaSetOverlayAction
  | SchemaSetEdgeOverlayAction
  | SchemaAdoptShapeAction
  | SchemaDeleteShapeAction;

/** String-литерал kind для всех SchemaAction типов. */
export type SchemaActionKind = SchemaAction["kind"];

/** Список всех валидных kind'ов (runtime constant для validation). */
export const ALL_SCHEMA_ACTION_KINDS: readonly SchemaActionKind[] = [
  "schema-define",
  "schema-connect",
  "schema-rename",
  "schema-set-role",
  "schema-group",
  "schema-disconnect",
  "schema-delete-node",
  "schema-set-overlay",
  "schema-set-edge-overlay",
  "schema-adopt-shape",
  "schema-delete-shape",
];
