import type { ConnectionKind, LayoutMode, Role } from "@didraw/domain";
import type { PatchOp } from "../types";

export type ElementId = string;
export type Spacing = "compact" | "normal" | "loose";

export type LayoutHint = {
  mode?: LayoutMode;
  scope?: "all" | "affected" | ElementId;
  spacing?: Spacing;
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
  generatedOps?: PatchOp[];
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
