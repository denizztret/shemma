import type { ConnectionKind, LayoutMode, Role, Spacing } from "@shemma/domain";
import type { StoreChangeBatch } from "../store-types";

export type ElementId = string;

// LayoutHint.scope ("all" | "affected" | ElementId) is wider than LayoutAction.scope ("all" | ElementId):
// "affected" is the orchestrator default (layout only what changed in this batch), never emitted by AI.
//
// affectedIds: orchestrator-provided set of shape record IDs that are «in scope»
// for the current layout pass. When scope === "affected", any user shape OUTSIDE
// affectedIds is pinned as-is — keeps user-drawn freehand/images from being
// reshuffled when AI adds a new node via /api/domain. См. layout.ts.
export type LayoutHint = {
  mode?: LayoutMode;
  scope?: "all" | "affected" | ElementId;
  spacing?: Spacing;
  affectedIds?: Set<string>;
  /** When "self": skip anchor-frame expansion and Pass B — only re-layout
   * the internal children of the directly selected containers (DRW-166/167). */
  containerScope?: "self" | "auto";
  /** Settings popover "Force re-layout": ignore meta.pinned for this layout pass.
   * Pin flags on shapes are NOT cleared — they're just bypassed once. */
  forceUnpin?: boolean;
};

export type DefineAction = {
  kind: "define";
  role: Role;
  name: ElementId;
  label?: string;
  in?: ElementId;
  meta?: Record<string, unknown>;
};

export type ConnectAction = {
  kind: "connect";
  from: ElementId;
  to: ElementId;
  connectionKind?: ConnectionKind;
  label?: string;
  meta?: Record<string, unknown>;
};

export type GroupAction = {
  kind: "group";
  /**
   * Canonical member list — matches the MCP `GroupArgs.children` field and the
   * container-model invariant (`Group.children: ElementId[]`).
   */
  children?: ElementId[];
  /** @deprecated DRW-220 legacy alias for `children` (CLI + back-compat). */
  ids?: ElementId[];
  as: "network" | "boundary";
  name: ElementId;
  label?: string;
};

/**
 * DRW-220: resolve a group action's member list. Members may arrive as
 * `children` (canonical, sent by MCP/shemma_group) or `ids` (legacy CLI alias).
 * Returns the member array, or `null` when neither is a valid array — callers
 * emit a structured validation error instead of crashing on `undefined`.
 */
export function groupMembers(a: GroupAction): ElementId[] | null {
  if (Array.isArray(a.children)) return a.children;
  if (Array.isArray(a.ids)) return a.ids;
  return null;
}

export type NoteAction = {
  kind: "note";
  about?: ElementId;
  text: string;
  name?: ElementId;
};

export type LayoutAction = {
  kind: "layout";
  mode?: LayoutMode;
  scope?: "all" | ElementId;
  spacing?: Spacing;
};

export type DeleteAction =
  | { kind: "delete"; id: ElementId }
  | { kind: "delete"; ids: ElementId[]; cascade?: boolean };

export type DomainAction =
  | DefineAction
  | ConnectAction
  | GroupAction
  | NoteAction
  | LayoutAction
  | DeleteAction;

export type DomainRequest = {
  actions: DomainAction[];
  clientOpId?: string;
  dryRun?: boolean;
  layoutHint?: LayoutHint | null;
};

export type ActionError = {
  actionIndex: number;
  field?: string;
  code:
    | "unknown-role"
    | "unknown-ref"
    | "name-conflict"
    | "role-conflict"
    | "cascade-confirm-required"
    | "invalid-shape"
    | "compile-error"
    | "validate-error"
    | "unknown-action";
  message: string;
  affected?: ElementId[];
};

export type ActionResult = {
  actionIndex: number;
  elementId?: ElementId;
  generatedOps?: StoreChangeBatch;
};

export type DomainResponse =
  | {
      ok: true;
      version: number;
      idempotent?: true;
      results: ActionResult[];
      layout?: { applied: boolean; affected?: ElementId[]; reason?: string };
    }
  | { ok: false; errors: ActionError[] };
