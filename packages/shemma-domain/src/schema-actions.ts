import type { NodeId } from "./identity";
import type { Role } from "./roles";
import type { ConnectionKind } from "./connections";
import type { OverlayEntry } from "./schema-meta";

/** Добавить или upsert узел в RAW schema-frame.
 *  `nodeId` опционален: если не передан — backend генерирует. */
export type SchemaDefineAction = {
  kind: "schema-define";
  nodeId?: NodeId;
  role: Role;
  label?: string;
  in?: NodeId;            // subgraph parent
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
  name?: NodeId;          // ID самой группы
  label?: string;
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

/** Discriminated union всех incremental schema-actions. */
export type SchemaAction =
  | SchemaDefineAction
  | SchemaConnectAction
  | SchemaRenameAction
  | SchemaSetRoleAction
  | SchemaGroupAction
  | SchemaDisconnectAction
  | SchemaDeleteNodeAction
  | SchemaSetOverlayAction;

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
];
