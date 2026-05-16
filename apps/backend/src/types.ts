// apps/backend/src/types.ts
import type {
  StoreChangeBatch,
  StoreOpLogEntry,
  TLStoreSnapshot,
} from "./store-types";

export const DEFAULT_ROOM = "default";
export type RoomId = string;

export type Prompt = {
  id: string;
  selection: string[];
  text: string;
  createdAt: number;
  status: "pending" | "resolved" | "dismissed";
  response?: string;
  resolvedAt?: number;
};

export type AiActivity = {
  actor: string;
  task: string;
  startedAt: number;
};

export type RoomState = {
  store: TLStoreSnapshot;
  opLog: StoreOpLogEntry[];
  prompts: Prompt[];
  version: number;
  dirty: boolean;
  lastTouched: number;
  aiActivity?: AiActivity;
  // Индекс meta.didrawName → shape.id для O(1) lookup в compile.ts.
  // Перестраивается при каждой apply через store-ops.rebuildDidrawIndex().
  didrawIndex: Map<string, string>;
};

export type WsClientMessage = { kind: "hello"; lastVersion: number };

export type WsMessage =
  | { kind: "hello"; version: number }
  | { kind: "sync-ack"; version: number }
  | { kind: "replay"; changes: StoreChangeBatch[]; version: number }
  | { kind: "truncated"; version: number }
  | {
      kind: "store-change";
      source: "ai" | "user";
      changes: StoreChangeBatch;
      version: number;
      originClientId?: string;
    }
  | { kind: "prompt-created"; prompt: Prompt }
  | { kind: "prompt-resolved"; id: string; response?: string }
  | { kind: "prompt-removed"; ids: string[] }
  | { kind: "ai-activity"; activity: AiActivity | null };

export type StoreChangeBus = {
  publish: (
    room: string,
    msg: {
      changes: StoreChangeBatch;
      source: "ai" | "user";
      version: number;
      originClientId?: string;
    },
  ) => void;
};

// ---- Legacy types (Phase 2.x), kept ONLY for migrate-v2.ts ----
// Не импортировать из новых модулей. Будут удалены в Task 20 кроме migrate-v2.

/** @deprecated v2 only — для migrate-v2 */
export type LegacyCanvasState = {
  version: 1;
  nodes: LegacyNode[];
  edges: LegacyEdge[];
  groups: LegacyGroup[];
};

/** @deprecated v2 only — для migrate-v2 */
export type LegacyNode = {
  id: string;
  kind: "rect" | "ellipse" | "diamond" | "sticky" | "text";
  label?: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  style?: { color?: string; fill?: string; stroke?: string; fontSize?: number; rotation?: number };
  meta?: Record<string, unknown>;
};

/** @deprecated v2 only — для migrate-v2 */
export type LegacyEndpoint = { kind: "node"; id: string } | { kind: "point"; x: number; y: number };

/** @deprecated v2 only — для migrate-v2 */
export type LegacyEdge = {
  id: string;
  from: LegacyEndpoint;
  to: LegacyEndpoint;
  label?: string;
  style?: { color?: string; dashed?: boolean; arrow?: "none" | "to" | "both" };
  meta?: Record<string, unknown>;
};

/** @deprecated v2 only — для migrate-v2 */
export type LegacyGroup = {
  id: string;
  kind: "frame" | "group";
  children: string[];
  label?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  style?: { fill?: string; stroke?: string };
  collapsed?: boolean;
};

/** @deprecated v2 only — для migrate-v2 */
export type LegacyOpLogEntry = {
  ops: unknown[]; // legacy PatchOp[] — не интерпретируется
  source: "ai" | "user";
  version: number;
  at: number;
  clientOpId?: string;
};
