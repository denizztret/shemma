// apps/backend/src/domain/validate.ts
//
// Phase 3.0: validate DomainAction[] поверх TLStoreSnapshot + didrawIndex.
// Известные элементы (name → { role, isContainer }) собираются по shape-records
// через meta.didrawName + meta.role / type === "frame".
import {
  isContainerRole,
  isValidConnectionKind,
  isValidName,
  isValidRole,
  type Role,
} from "@shemma/domain";
import type { TLStoreSnapshot } from "../store-types";
import type { ActionError, DeleteAction, DomainAction, ElementId } from "./types";

function isDeleteWithIds(
  a: DeleteAction,
): a is { kind: "delete"; ids: ElementId[]; cascade?: boolean } {
  return "ids" in a;
}

type KnownElement = { role: Role; isContainer: boolean };

function seedKnown(
  store: TLStoreSnapshot,
  index: Map<string, string>,
): Map<string, KnownElement> {
  const m = new Map<string, KnownElement>();
  for (const [name, id] of index) {
    const rec = store.store[id];
    if (!rec || rec.typeName !== "shape") continue;
    const isFrame = (rec as { type?: string }).type === "frame";
    const metaRole = (rec.meta as { role?: unknown } | undefined)?.role;
    const role: Role = typeof metaRole === "string" ? (metaRole as Role) : (isFrame ? "network" : "service");
    m.set(name, { role, isContainer: isFrame });
  }
  return m;
}

export function validateBatch(
  actions: DomainAction[],
  store: TLStoreSnapshot,
  index: Map<string, string>,
): { ok: true } | { ok: false; errors: ActionError[] } {
  const errors: ActionError[] = [];
  // Sequential working state — mutates as actions are processed so a later
  // action sees the result of an earlier add/remove. This makes `delete a`
  // followed by `connect a b` correctly fail at validation time.
  const known = seedKnown(store, index);

  for (const [i, a] of actions.entries()) {
    switch (a.kind) {
      case "define": {
        if (!isValidRole(a.role)) {
          errors.push({ actionIndex: i, field: "role", code: "unknown-role", message: `unknown role "${a.role}"` });
          break;
        }
        // Container roles (network/boundary) must come through `group`,
        // not `define` — spec §3.1 makes Group.children the canonical container model.
        if (isContainerRole(a.role)) {
          errors.push({
            actionIndex: i,
            field: "role",
            code: "invalid-shape",
            message: `container role "${a.role}" must be created via group action, not define`,
          });
          break;
        }
        if (!isValidName(a.name)) {
          errors.push({ actionIndex: i, field: "name", code: "invalid-shape", message: `invalid name "${a.name}"` });
          break;
        }
        const existing = known.get(a.name);
        if (existing && existing.role !== a.role) {
          errors.push({ actionIndex: i, field: "role", code: "role-conflict", message: `"${a.name}" already exists as ${existing.role}` });
          break;
        }
        if (a.in !== undefined) {
          const container = known.get(a.in);
          if (!container) {
            errors.push({ actionIndex: i, field: "in", code: "unknown-ref", message: `container "${a.in}" not found` });
            break;
          }
          if (!container.isContainer) {
            errors.push({ actionIndex: i, field: "in", code: "invalid-shape", message: `"${a.in}" is ${container.role}, not a container` });
            break;
          }
        }
        known.set(a.name, { role: a.role, isContainer: false });
        break;
      }
      case "connect": {
        if (a.connectionKind !== undefined && !isValidConnectionKind(a.connectionKind)) {
          errors.push({ actionIndex: i, field: "connectionKind", code: "invalid-shape", message: `unknown connection kind "${a.connectionKind}"` });
          break;
        }
        if (!known.has(a.from)) {
          errors.push({ actionIndex: i, field: "from", code: "unknown-ref", message: `from "${a.from}" not found` });
        }
        if (!known.has(a.to)) {
          errors.push({ actionIndex: i, field: "to", code: "unknown-ref", message: `to "${a.to}" not found` });
        }
        break;
      }
      case "group": {
        if (a.as !== "network" && a.as !== "boundary") {
          errors.push({ actionIndex: i, field: "as", code: "invalid-shape", message: `group.as must be network|boundary` });
          break;
        }
        if (!isValidName(a.name)) {
          errors.push({ actionIndex: i, field: "name", code: "invalid-shape", message: `invalid name "${a.name}"` });
          break;
        }
        for (const id of a.ids) {
          if (!known.has(id)) {
            errors.push({ actionIndex: i, field: "ids", code: "unknown-ref", message: `child "${id}" not found` });
          }
        }
        known.set(a.name, { role: a.as, isContainer: true });
        break;
      }
      case "note": {
        if (a.name && !isValidName(a.name)) {
          errors.push({ actionIndex: i, field: "name", code: "invalid-shape", message: `invalid name "${a.name}"` });
          break;
        }
        if (a.about && !known.has(a.about)) {
          errors.push({ actionIndex: i, field: "about", code: "unknown-ref", message: `about "${a.about}" not found` });
        }
        if (a.name) known.set(a.name, { role: "note", isContainer: false });
        break;
      }
      case "layout":
        // Always valid; mode/scope/spacing checked downstream (modeToElkOptions handles invalid mode).
        break;
      case "delete": {
        const ids = isDeleteWithIds(a) ? a.ids : [a.id];
        for (const id of ids) {
          if (!known.has(id)) {
            errors.push({ actionIndex: i, field: "id", code: "unknown-ref", message: `delete target "${id}" not found` });
          }
          known.delete(id);
        }
        break;
      }
      default:
        errors.push({ actionIndex: i, code: "unknown-action", message: `unknown action kind "${(a as { kind: string }).kind}"` });
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
