import type { ConnectionKind, LayoutMode, Role, Spacing } from "@didraw/domain";
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
  ids: ElementId[];
  as: "network" | "boundary";
  name: ElementId;
  label?: string;
};

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
